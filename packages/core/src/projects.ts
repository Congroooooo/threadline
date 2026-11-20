// Projects and their configuration. A repository maps to exactly one active project per
// workspace, so findProjectByRepoUrl is unambiguous.
import { and, arrayContains, arrayOverlaps, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Tx } from "./db/client.js";
import { projectConfig, projects } from "./db/schema.js";
import { recordEvent } from "./events.js";
import { newId } from "./ids.js";
import { label, requirePermission } from "./tenancy.js";
import { UUID } from "./tokens.js";
import { type Actor, NotFoundError, ValidationError } from "./types.js";

export const PROJECT_KEY = /^[A-Z][A-Z0-9]{1,9}$/;
export const MAX_REPO_URLS = 20;
const MAX_URL_LENGTH = 500;

export type NotifierConfig = { kind: "mattermost" | "slack"; webhookUrl: string };

function isUniqueViolation(err: unknown): boolean {
  for (let e: any = err; e; e = e.cause) if (e.code === "23505") return true;
  return false;
}

/**
 * Canonical `host/path` for a repository URL, so ssh and https forms of one repository
 * compare equal: credentials, scheme, the port of ssh forms, query, `.git` and trailing
 * slashes are dropped and everything is lower-cased: GitHub and GitLab treat repo paths case-insensitively.
 */
export function normalizeRepoUrl(url: string): string {
  if (typeof url !== "string") throw new ValidationError("repository URL must be a string");
  let s = url.trim();
  if (s === "" || s.length > MAX_URL_LENGTH || /\s/.test(s)) throw new ValidationError("repository URL is not valid");
  let host: string;
  let path: string;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (scheme) {
    const keepPort = /^https?$/i.test(scheme[1]!);
    s = s.slice(scheme[0].length);
    const slash = s.search(/[/?#]/);
    let authority = slash === -1 ? s : s.slice(0, slash);
    path = slash === -1 ? "" : s.slice(slash);
    authority = authority.slice(authority.lastIndexOf("@") + 1);
    if (!keepPort) authority = authority.replace(/:\d*$/, "");
    host = authority;
  } else {
    // scp-like: [user@]host:path
    const m = /^(?:[^@/\s]+@)?([^:/\s]+):(.*)$/.exec(s);
    if (!m) throw new ValidationError("repository URL is not valid");
    host = m[1]!;
    path = "/" + m[2]!;
  }
  path = path
    .replace(/[?#].*$/, "")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  host = host.toLowerCase();
  if (!/^[a-z0-9._-]+(:\d+)?$/.test(host) || path.length < 2) throw new ValidationError("repository URL is not valid");
  return (host + path).toLowerCase();
}

function parseNotifier(n: NotifierConfig): NotifierConfig {
  if (n === null || typeof n !== "object" || (n.kind !== "mattermost" && n.kind !== "slack")) {
    throw new ValidationError("notifier kind must be mattermost or slack");
  }
  if (typeof n.webhookUrl !== "string" || n.webhookUrl.length > MAX_URL_LENGTH * 2) {
    throw new ValidationError("notifier webhookUrl must be an absolute https URL");
  }
  const bad = () => new ValidationError("notifier webhookUrl must be an absolute https URL");
  if (n.webhookUrl.includes("\\") || /\s/.test(n.webhookUrl)) throw bad();
  let u: InstanceType<typeof URL>;
  try {
    u = new URL(n.webhookUrl);
  } catch {
    throw bad();
  }
  if (u.username !== "" || u.password !== "") throw bad();
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (!(u.protocol === "https:" || (u.protocol === "http:" && local))) throw bad();
  return { kind: n.kind, webhookUrl: u.href };
}

/** NotFoundError unless every id is an existing, non-archived project of this workspace. */
export async function requireActiveProjects(tx: Tx, projectIds: string[]): Promise<void> {
  const ids = [...new Set(projectIds)];
  if (ids.length === 0) return;
  if (!ids.every((p) => UUID.test(p))) throw new NotFoundError("project not found");
  const rows = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(inArray(projects.id, ids), isNull(projects.archivedAt)));
  if (rows.length !== ids.length) throw new NotFoundError("project not found");
}

/** Creates a project with default configuration. Needs workspace.admin. */
export async function createProject(tx: Tx, actor: Actor, input: { key: string; name: string }): Promise<string> {
  await requirePermission(tx, actor, "workspace.admin");
  if (typeof input.key !== "string" || !PROJECT_KEY.test(input.key)) {
    throw new ValidationError("key must be 2 to 10 characters: A-Z, then A-Z or 0-9");
  }
  const name = label(input.name, "name");
  const id = newId();
  try {
    // Savepoint, so a duplicate key leaves the caller's transaction usable.
    await tx.transaction(async (sp) => {
      await sp.insert(projects).values({ id, workspaceId: actor.workspaceId, key: input.key, name });
      await sp.insert(projectConfig).values({
        projectId: id,
        workspaceId: actor.workspaceId,
        approval: { requirements: { roleKey: "approver", count: 1 } },
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ValidationError(`a project with key ${input.key} already exists`);
    throw err;
  }
  await recordEvent(tx, {
    actor,
    type: "project.created",
    subjectKind: "project",
    subjectId: id,
    projectId: id,
    data: { key: input.key, name },
  });
  return id;
}

/**
 * Changes the repositories and/or notifier of a project; omitted fields are unchanged and
 * `notifier: null` clears it. Needs workspace.admin. A repository may belong to only one
 * active project in the workspace. The webhook URL is never written to events.
 */
export async function updateProjectConfig(
  tx: Tx,
  actor: Actor,
  projectId: string,
  patch: { repoUrls?: string[]; notifier?: NotifierConfig | null },
): Promise<void> {
  await requirePermission(tx, actor, "workspace.admin");
  await requireActiveProjects(tx, [projectId]);
  if (patch.repoUrls === undefined && patch.notifier === undefined) throw new ValidationError("nothing to update");
  const set: Partial<typeof projectConfig.$inferInsert> = { updatedAt: new Date() };
  const data: Record<string, unknown> = {};

  if (patch.repoUrls !== undefined) {
    if (!Array.isArray(patch.repoUrls) || patch.repoUrls.length > MAX_REPO_URLS) {
      throw new ValidationError(`repoUrls must be a list of at most ${MAX_REPO_URLS} URLs`);
    }
    const repoUrls = [...new Set(patch.repoUrls.map(normalizeRepoUrl))].sort();
    // Serialise per workspace so two concurrent updates cannot both claim one repository.
    await tx.execute(
      sql`select 1 from workspaces where id = NULLIF(current_setting('app.workspace_id', true), '')::uuid for update`,
    );
    if (repoUrls.length > 0) {
      const taken = await tx
        .select({ projectId: projectConfig.projectId })
        .from(projectConfig)
        .innerJoin(projects, eq(projects.id, projectConfig.projectId))
        .where(
          and(
            isNull(projects.archivedAt),
            sql`${projectConfig.projectId} <> ${projectId}`,
            arrayOverlaps(projectConfig.repoUrls, repoUrls),
          ),
        )
        .limit(1);
      if (taken.length > 0) throw new ValidationError("a repository URL already belongs to another project");
    }
    set.repoUrls = repoUrls;
    data.repoUrls = repoUrls;
  }
  if (patch.notifier !== undefined) {
    const notifier = patch.notifier === null ? null : parseNotifier(patch.notifier);
    set.notifier = notifier;
    data.notifier = notifier === null ? { configured: false } : { kind: notifier.kind, configured: true };
  }
  await tx.update(projectConfig).set(set).where(eq(projectConfig.projectId, projectId));
  await recordEvent(tx, {
    actor,
    type: "project.config_updated",
    subjectKind: "project",
    subjectId: projectId,
    projectId,
    data,
  });
}

/** The active project that lists `repoUrl` (in any form) among its repositories, or null. */
export async function findProjectByRepoUrl(tx: Tx, repoUrl: string): Promise<string | null> {
  const normalized = normalizeRepoUrl(repoUrl);
  const [row] = await tx
    .select({ projectId: projectConfig.projectId })
    .from(projectConfig)
    .innerJoin(projects, eq(projects.id, projectConfig.projectId))
    .where(and(isNull(projects.archivedAt), arrayContains(projectConfig.repoUrls, [normalized])))
    .limit(1);
  return row?.projectId ?? null;
}

/** Needs project.read on the project. The webhook URL is never returned. */
export async function getProject(
  tx: Tx,
  actor: Actor,
  projectId: string,
): Promise<{ id: string; key: string; name: string; repoUrls: string[]; notifier: { kind: string; configured: true } | null }> {
  if (!UUID.test(projectId)) throw new NotFoundError("project not found");
  await requirePermission(tx, actor, "project.read", projectId);
  const [row] = await tx
    .select({
      id: projects.id,
      key: projects.key,
      name: projects.name,
      repoUrls: projectConfig.repoUrls,
      notifierKind: sql<string | null>`${projectConfig.notifier}->>'kind'`,
    })
    .from(projects)
    .innerJoin(projectConfig, eq(projectConfig.projectId, projects.id))
    .where(eq(projects.id, projectId));
  if (!row) throw new NotFoundError("project not found");
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    repoUrls: row.repoUrls,
    notifier: row.notifierKind === null ? null : { kind: row.notifierKind, configured: true },
  };
}
