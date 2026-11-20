import { and, asc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { type Db, type Tx, withSystem } from "./db/client.js";
import { agentIdentities, members, sessions, userIdentities, users, workspaces } from "./db/schema.js";
import { recordEvent } from "./events.js";
import { newId } from "./ids.js";
import { requireActiveProjects } from "./projects.js";
import { capText, cleanText } from "./safety.js";
import { isForeignKeyViolation, label, requirePermission } from "./tenancy.js";
import {
  AGENT_TOKEN_BYTES,
  AGENT_TOKEN_PREFIX,
  hashSecret,
  randomSecret,
  secretPattern,
  SESSION_BYTES,
  UUID,
} from "./tokens.js";
import { type Actor, ForbiddenError, NotFoundError, ValidationError } from "./types.js";

export const PROVIDERS = ["github", "gitlab", "local"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const SESSION_DAYS = 30;
const DAY_MS = 86_400_000;

const SESSION_TOKEN = secretPattern("", SESSION_BYTES);
const AGENT_TOKEN = secretPattern(AGENT_TOKEN_PREFIX, AGENT_TOKEN_BYTES);

function isUniqueViolation(err: unknown): boolean {
  for (let e: any = err; e; e = e.cause) if (e.code === "23505") return true;
  return false;
}

// ---------------------------------------------------------------------------------------
// Users and sessions (account data, so all of it runs under withSystem)

/**
 * The user signed in through this provider identity, created on first sign-in. Later
 * sign-ins return the same user and leave the stored display name and email unchanged.
 * `login` (GitHub login, GitLab username) is stored on the identity and refreshed whenever
 * a sign-in passes one, since providers let people rename themselves.
 */
export async function findOrCreateUser(
  db: Db,
  input: { provider: Provider; providerUserId: string; displayName: string; email?: string; login?: string },
): Promise<string> {
  const { provider } = input;
  if (!PROVIDERS.includes(provider)) throw new ValidationError(`unknown provider: ${String(provider)}`);
  const providerUserId = capText(input.providerUserId ?? "", "providerUserId");
  if (providerUserId === "") throw new ValidationError("providerUserId is required");
  const displayName = label(input.displayName, "displayName");
  const email = input.email === undefined ? null : cleanText(input.email, "email").trim() || null;
  const login = input.login === undefined ? null : label(input.login, "login");

  const find = async (tx: Tx) => {
    const [row] = await tx
      .select({ userId: userIdentities.userId, login: userIdentities.login })
      .from(userIdentities)
      .where(and(eq(userIdentities.provider, provider), eq(userIdentities.providerUserId, providerUserId)));
    return row;
  };
  const refreshLogin = async (tx: Tx, current: string | null) => {
    if (login === null || login === current) return;
    await tx
      .update(userIdentities)
      .set({ login })
      .where(and(eq(userIdentities.provider, provider), eq(userIdentities.providerUserId, providerUserId)));
  };

  return withSystem(db, async (tx) => {
    const existing = await find(tx);
    if (existing) {
      await refreshLogin(tx, existing.login);
      return existing.userId;
    }
    const userId = newId();
    try {
      // In a savepoint, so losing a race to a concurrent first sign-in leaves tx usable.
      await tx.transaction(async (sp) => {
        await sp.insert(users).values({ id: userId, displayName, email });
        await sp.insert(userIdentities).values({ id: newId(), provider, providerUserId, userId, login });
      });
      return userId;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const winner = await find(tx);
      if (!winner) throw err;
      await refreshLogin(tx, winner.login);
      return winner.userId;
    }
  });
}

/** The user's account and sign-in identities (provider and login), or null when unknown. */
export async function getUser(db: Db, userId: string): Promise<{
  id: string;
  displayName: string;
  email: string | null;
  identities: { provider: Provider; login: string | null }[];
} | null> {
  if (typeof userId !== "string" || !UUID.test(userId)) return null;
  return withSystem(db, async (tx) => {
    const [user] = await tx
      .select({ id: users.id, displayName: users.displayName, email: users.email })
      .from(users)
      .where(eq(users.id, userId));
    if (!user) return null;
    const identities = await tx
      .select({ provider: userIdentities.provider, login: userIdentities.login })
      .from(userIdentities)
      .where(eq(userIdentities.userId, userId))
      .orderBy(asc(userIdentities.provider), asc(userIdentities.id));
    return { ...user, identities };
  });
}

/** A new session for `userId`, valid for 30 days. The token is returned only here. */
export async function createSession(db: Db, userId: string): Promise<{ token: string; expiresAt: Date }> {
  if (!UUID.test(userId)) throw new NotFoundError("user not found");
  const token = randomSecret("", SESSION_BYTES);
  const tokenHash = await hashSecret(token);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * DAY_MS);
  try {
    await withSystem(db, (tx) => tx.insert(sessions).values({ tokenHash, userId, expiresAt }));
  } catch (err) {
    if (isForeignKeyViolation(err)) throw new NotFoundError("user not found");
    throw err;
  }
  return { token, expiresAt };
}

/** The session's user, or null when the token is unknown, malformed or expired. */
export async function resolveSession(db: Db, token: string): Promise<{ userId: string } | null> {
  if (typeof token !== "string" || !SESSION_TOKEN.test(token)) return null;
  const tokenHash = await hashSecret(token);
  const [row] = await withSystem(db, (tx) =>
    tx
      .select({ userId: sessions.userId })
      .from(sessions)
      .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, sql`now()`))),
  );
  return row ? { userId: row.userId } : null;
}

/** The user's active memberships, by workspace name. */
export async function listMemberships(
  db: Db,
  userId: string,
): Promise<{ workspaceId: string; memberId: string; workspaceName: string }[]> {
  if (!UUID.test(userId)) return [];
  return withSystem(db, async (tx) => {
    // Opens the members_system_own policy for this user's rows only.
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return tx
      .select({ workspaceId: members.workspaceId, memberId: members.id, workspaceName: workspaces.name })
      .from(members)
      .innerJoin(workspaces, eq(workspaces.id, members.workspaceId))
      .where(and(eq(members.userId, userId), eq(members.status, "active")))
      .orderBy(asc(workspaces.name), asc(workspaces.id));
  });
}

// ---------------------------------------------------------------------------------------
// Agent tokens (workspace data)

function requireHuman(actor: Actor, action: string): asserts actor is Actor & { kind: "member" } {
  if (actor.kind !== "member") throw new ForbiddenError(`only a member can ${action}`);
}

/**
 * A token for an agent working for the actor in `projectIds`, each of which the actor must
 * be able to read. The token is returned only here; it is stored as a hash.
 */
export async function createAgentToken(
  tx: Tx,
  actor: Actor,
  input: { name: string; projectIds: string[] },
): Promise<{ agentId: string; token: string }> {
  requireHuman(actor, "create agent tokens");
  const name = label(input.name, "name");
  const projectIds = [...new Set(input.projectIds)];
  if (projectIds.length === 0) throw new ValidationError("projectIds must not be empty");
  if (!projectIds.every((p) => UUID.test(p))) throw new ValidationError("projectIds must be UUIDs");
  for (const projectId of projectIds) await requirePermission(tx, actor, "project.read", projectId);
  await requireActiveProjects(tx, projectIds);

  const agentId = newId();
  const token = randomSecret(AGENT_TOKEN_PREFIX, AGENT_TOKEN_BYTES);
  await tx.insert(agentIdentities).values({
    id: agentId,
    workspaceId: actor.workspaceId,
    memberId: actor.memberId,
    name,
    tokenHash: await hashSecret(token),
    projectIds,
  });
  await recordEvent(tx, {
    actor,
    type: "agent_token.created",
    subjectKind: "agent",
    subjectId: agentId,
    data: { name, projectIds },
  });
  return { agentId, token };
}

/** Revokes the token. Its own member or a workspace admin may; revoking twice is a no-op. */
export async function revokeAgentToken(tx: Tx, actor: Actor, agentId: string): Promise<void> {
  requireHuman(actor, "revoke agent tokens");
  if (!UUID.test(agentId)) throw new NotFoundError("agent token not found");
  const [row] = await tx
    .select({ memberId: agentIdentities.memberId, revokedAt: agentIdentities.revokedAt })
    .from(agentIdentities)
    .where(eq(agentIdentities.id, agentId));
  if (!row) throw new NotFoundError("agent token not found");
  if (row.memberId !== actor.memberId) await requirePermission(tx, actor, "workspace.admin");
  if (row.revokedAt !== null) return;
  await tx.update(agentIdentities).set({ revokedAt: sql`now()` }).where(eq(agentIdentities.id, agentId));
  await recordEvent(tx, { actor, type: "agent_token.revoked", subjectKind: "agent", subjectId: agentId });
}

/**
 * The agent actor for a token, or null when the token is malformed, unknown, revoked or
 * its member is no longer active (which is how removing a member disables their tokens).
 */
export async function resolveAgentToken(db: Db, token: string): Promise<Actor | null> {
  if (typeof token !== "string" || !AGENT_TOKEN.test(token)) return null;
  const tokenHash = await hashSecret(token);
  return withSystem(db, async (tx) => {
    // Opens agent_identities_system_lookup for this one hash: system reads nothing else there.
    await tx.execute(sql`select set_config('app.lookup_hash', ${tokenHash}, true)`);
    const [row] = await tx
      .select({
        id: agentIdentities.id,
        workspaceId: agentIdentities.workspaceId,
        memberId: agentIdentities.memberId,
        projectIds: agentIdentities.projectIds,
      })
      .from(agentIdentities)
      .where(and(eq(agentIdentities.tokenHash, tokenHash), isNull(agentIdentities.revokedAt)));
    if (!row) return null;
    await tx.execute(sql`select set_config('app.workspace_id', ${row.workspaceId}, true)`);
    const [m] = await tx.select({ status: members.status }).from(members).where(eq(members.id, row.memberId));
    if (m?.status !== "active") return null;
    try {
      // Best effort, at most once a minute, in a savepoint so a failure cannot break sign-in.
      await tx.transaction((sp) =>
        sp
          .update(agentIdentities)
          .set({ lastUsedAt: sql`now()` })
          .where(and(
            eq(agentIdentities.id, row.id),
            or(isNull(agentIdentities.lastUsedAt), lt(agentIdentities.lastUsedAt, sql`now() - interval '1 minute'`)),
          )),
      );
    } catch {
      // ignored
    }
    return { kind: "agent", workspaceId: row.workspaceId, memberId: row.memberId, agentId: row.id, projectIds: row.projectIds };
  });
}
