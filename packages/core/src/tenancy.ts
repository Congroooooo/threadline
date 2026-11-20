import { and, asc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { type Db, type Tx, withSystem } from "./db/client.js";
import { agentIdentities, memberRoles, members, roles, users, workspaces } from "./db/schema.js";
import { recordEvent } from "./events.js";
import { newId } from "./ids.js";
import { requireActiveProjects } from "./projects.js";
import { cleanText } from "./safety.js";
import {
  type Actor,
  ForbiddenError,
  HUMAN_ONLY,
  NotFoundError,
  type Permission,
  PERMISSIONS,
  ValidationError,
} from "./types.js";

const CONTRIBUTOR: readonly Permission[] = [
  "project.read", "task.write", "handoff.create", "handoff.ack", "contract.ack", "blocker.write",
  "requirement.propose", "decision.propose",
];

/**
 * The roles every new workspace starts with. Final: later phases add no permissions to
 * these and run no role backfill migrations. Workspaces may edit their copies freely.
 */
export const ROLE_TEMPLATES = {
  owner: [...PERMISSIONS],
  approver: ["project.read", "requirement.propose", "requirement.approve", "decision.propose", "decision.approve", "task.accept"],
  pm: [...CONTRIBUTOR],
  lead: [...CONTRIBUTOR],
  frontend: [...CONTRIBUTOR],
  backend: [...CONTRIBUTOR],
} as const satisfies Record<string, readonly Permission[]>;

const TEMPLATE_NAMES: Record<keyof typeof ROLE_TEMPLATES, string> = {
  owner: "Owner",
  approver: "Approver",
  pm: "Product manager",
  lead: "Lead",
  frontend: "Frontend",
  backend: "Backend",
};

export const ROLE_KEY = /^[a-z][a-z0-9_]{1,30}$/;

export function label(text: string, field: string): string {
  const out = cleanText(text, field).trim();
  if (out === "") throw new ValidationError(`${field} is required`);
  return out;
}

export function isForeignKeyViolation(err: unknown): boolean {
  for (let e: any = err; e; e = e.cause) if (e.code === "23503") return true;
  return false;
}

// ---------------------------------------------------------------------------------------
// Permission checks

/** Assignments that currently grant: not revoked, role not archived, member active. */
function granting(permission: Permission, projectId: string | undefined): SQL {
  const scope = projectId === undefined
    ? isNull(memberRoles.projectId)
    : or(isNull(memberRoles.projectId), eq(memberRoles.projectId, projectId))!;
  return and(
    isNull(memberRoles.revokedAt),
    isNull(roles.archivedAt),
    eq(members.status, "active"),
    sql`${permission} = ANY(${roles.permissions})`,
    scope,
  )!;
}

function grantJoin(tx: Tx) {
  return tx
    .select({ memberId: members.id })
    .from(members)
    .innerJoin(memberRoles, eq(memberRoles.memberId, members.id))
    .innerJoin(roles, eq(roles.id, memberRoles.roleId));
}

async function memberHas(tx: Tx, memberId: string, permission: Permission, projectId?: string): Promise<boolean> {
  const rows = await grantJoin(tx).where(and(eq(members.id, memberId), granting(permission, projectId))).limit(1);
  return rows.length > 0;
}

/**
 * Whether `actor` holds `permission`, in `projectId` when given. Without a project only
 * workspace-wide assignments count. Agents never hold HUMAN_ONLY permissions, are limited
 * to their projects and never exceed their member; connections may only write blockers.
 */
export async function can(tx: Tx, actor: Actor, permission: Permission, projectId?: string): Promise<boolean> {
  switch (actor.kind) {
    case "connection":
      return permission === "blocker.write";
    case "agent":
      if (HUMAN_ONLY.includes(permission)) return false;
      if (projectId !== undefined && !actor.projectIds.includes(projectId)) return false;
      return memberHas(tx, actor.memberId, permission, projectId);
    case "member":
      return memberHas(tx, actor.memberId, permission, projectId);
  }
}

export async function requirePermission(tx: Tx, actor: Actor, permission: Permission, projectId?: string): Promise<void> {
  if (!(await can(tx, actor, permission, projectId))) {
    throw new ForbiddenError(`missing permission ${permission}`);
  }
}

async function workspaceAdminCount(tx: Tx): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(distinct ${members.id})::int` })
    .from(members)
    .innerJoin(memberRoles, eq(memberRoles.memberId, members.id))
    .innerJoin(roles, eq(roles.id, memberRoles.roleId))
    .where(granting("workspace.admin", undefined));
  return row?.n ?? 0;
}

/**
 * Runs an admin change in a savepoint and undoes it (ValidationError) if it would leave
 * the workspace without an active member holding workspace.admin workspace-wide.
 */
function keepingAnAdmin<T>(tx: Tx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return tx.transaction(async (sp) => {
    // Serialise admin-affecting changes per workspace. Under READ COMMITTED two concurrent
    // changes (say removing admin X and admin Y) would each still see the other admin and
    // both commit, leaving none. Locking the workspace row makes the second wait, and its
    // count below then sees the first one's committed change.
    await sp.execute(
      sql`select 1 from workspaces where id = NULLIF(current_setting('app.workspace_id', true), '')::uuid for update`,
    );
    const result = await fn(sp);
    if ((await workspaceAdminCount(sp)) === 0) {
      throw new ValidationError("the workspace must keep at least one member with workspace.admin");
    }
    return result;
  });
}

// ---------------------------------------------------------------------------------------
// Workspaces and members

/**
 * Creates a workspace with the template roles and makes `userId` its first member holding
 * every one of them, workspace-wide.
 */
export function createWorkspace(
  db: Db,
  input: { name: string; userId: string; displayName: string },
): Promise<{ workspaceId: string; memberId: string }> {
  const name = label(input.name, "name");
  const displayName = label(input.displayName, "displayName");
  return withSystem(db, async (tx) => {
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId));
    if (!user) throw new NotFoundError("user not found");
    const workspaceId = newId();
    const memberId = newId();
    await tx.insert(workspaces).values({ id: workspaceId, name });
    // Workspace-scoped rows (and the event) need the workspace policy open as well.
    await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
    const roleRows = Object.entries(ROLE_TEMPLATES).map(([key, permissions]) => ({
      id: newId(),
      workspaceId,
      key,
      name: TEMPLATE_NAMES[key as keyof typeof ROLE_TEMPLATES],
      permissions: [...permissions],
    }));
    await tx.insert(roles).values(roleRows);
    await tx.insert(members).values({ id: memberId, workspaceId, userId: input.userId, displayName });
    await assign(tx, workspaceId, memberId, roleRows.map((r) => r.id), null);
    await recordEvent(tx, {
      actor: { kind: "member", workspaceId, memberId },
      type: "workspace.created",
      subjectKind: "workspace",
      subjectId: workspaceId,
      data: { name },
    });
    return { workspaceId, memberId };
  });
}

/** Resolves role keys to ids; every key must name a role that is not archived. */
export async function activeRoleIds(tx: Tx, roleKeys: string[]): Promise<{ id: string; key: string }[]> {
  const keys = [...new Set(roleKeys)];
  if (keys.length === 0) return [];
  const rows = await tx
    .select({ id: roles.id, key: roles.key, archivedAt: roles.archivedAt })
    .from(roles)
    .where(inArray(roles.key, keys));
  const usable = rows.filter((r) => r.archivedAt === null);
  if (usable.length !== keys.length) {
    const found = new Set(usable.map((r) => r.key));
    throw new ValidationError(`unknown or archived roles: ${keys.filter((k) => !found.has(k)).join(", ")}`);
  }
  return usable.map(({ id, key }) => ({ id, key }));
}

export async function assign(
  tx: Tx,
  workspaceId: string,
  memberId: string,
  roleIds: string[],
  projectId: string | null,
): Promise<void> {
  if (roleIds.length === 0) return;
  await tx.insert(memberRoles).values(roleIds.map((roleId) => ({ id: newId(), workspaceId, memberId, roleId, projectId })));
}

/**
 * Adds `userId` to the actor's workspace with the given workspace-wide roles and returns
 * the member id. A removed member is reactivated with exactly these roles.
 */
export async function addMember(
  tx: Tx,
  actor: Actor,
  input: { userId: string; displayName: string; roleKeys: string[] },
): Promise<string> {
  await requirePermission(tx, actor, "workspace.admin");
  const displayName = label(input.displayName, "displayName");
  const roleIds = (await activeRoleIds(tx, input.roleKeys)).map((r) => r.id);
  const [existing] = await tx
    .select({ id: members.id, status: members.status })
    .from(members)
    .where(eq(members.userId, input.userId));
  let memberId: string;
  if (existing) {
    if (existing.status === "active") throw new ValidationError("already a member of this workspace");
    memberId = existing.id;
    await tx.update(members).set({ status: "active", displayName }).where(eq(members.id, memberId));
    await tx
      .update(memberRoles)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(memberRoles.memberId, memberId), isNull(memberRoles.revokedAt)));
  } else {
    memberId = newId();
    // In a savepoint, so an unknown user leaves the caller's transaction usable.
    try {
      await tx.transaction((sp) =>
        sp.insert(members).values({ id: memberId, workspaceId: actor.workspaceId, userId: input.userId, displayName }),
      );
    } catch (err) {
      if (isForeignKeyViolation(err)) throw new NotFoundError("user not found");
      throw err;
    }
  }
  await assign(tx, actor.workspaceId, memberId, roleIds, null);
  await recordEvent(tx, {
    actor,
    type: "member.added",
    subjectKind: "member",
    subjectId: memberId,
    data: { userId: input.userId, displayName, roleKeys: [...new Set(input.roleKeys)], reactivated: !!existing },
  });
  return memberId;
}

async function activeMember(tx: Tx, memberId: string): Promise<void> {
  const [m] = await tx.select({ status: members.status }).from(members).where(eq(members.id, memberId));
  if (!m) throw new NotFoundError("member not found");
  if (m.status !== "active") throw new ValidationError("member has been removed");
}

/**
 * Replaces the member's roles in one scope: workspace-wide when `projectId` is omitted,
 * otherwise that project only. Assignments in other scopes are untouched.
 */
export async function setMemberRoles(
  tx: Tx,
  actor: Actor,
  input: { memberId: string; roleKeys: string[]; projectId?: string },
): Promise<void> {
  await requirePermission(tx, actor, "workspace.admin");
  await activeMember(tx, input.memberId);
  const found = await activeRoleIds(tx, input.roleKeys);
  const projectId = input.projectId ?? null;
  // Clearing roles stays allowed for an archived project; granting needs a live one.
  if (projectId !== null && found.length > 0) await requireActiveProjects(tx, [projectId]);
  await keepingAnAdmin(tx, async (sp) => {
    await sp
      .update(memberRoles)
      .set({ revokedAt: sql`now()` })
      .where(and(
        eq(memberRoles.memberId, input.memberId),
        isNull(memberRoles.revokedAt),
        projectId === null ? isNull(memberRoles.projectId) : eq(memberRoles.projectId, projectId),
      ));
    await assign(sp, actor.workspaceId, input.memberId, found.map((r) => r.id), projectId);
    await recordEvent(sp, {
      actor,
      type: "member.roles_set",
      subjectKind: "member",
      subjectId: input.memberId,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      data: { roleKeys: found.map((r) => r.key).sort(), projectId },
    });
  });
}

/**
 * Revokes every open agent token of `memberId`, recording agent_token.revoked for each.
 * Used on removal (so a token leaked before then stays dead if the member comes back)
 * and again on reactivation through an invite, as a second line of defence.
 */
export async function revokeMemberAgentTokens(
  tx: Tx,
  actor: Actor,
  memberId: string,
  reason: "member_removed" | "member_reactivated",
): Promise<void> {
  const revoked = await tx
    .update(agentIdentities)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(agentIdentities.memberId, memberId), isNull(agentIdentities.revokedAt)))
    .returning({ id: agentIdentities.id });
  for (const { id } of revoked) {
    await recordEvent(tx, { actor, type: "agent_token.revoked", subjectKind: "agent", subjectId: id, data: { reason } });
  }
}

/** Marks the member removed and revokes their agent tokens, which never come back. */
export async function removeMember(tx: Tx, actor: Actor, memberId: string): Promise<void> {
  await requirePermission(tx, actor, "workspace.admin");
  const [m] = await tx.select({ status: members.status }).from(members).where(eq(members.id, memberId));
  if (!m) throw new NotFoundError("member not found");
  if (m.status === "removed") return;
  await keepingAnAdmin(tx, async (sp) => {
    await sp.update(members).set({ status: "removed" }).where(eq(members.id, memberId));
    await recordEvent(sp, { actor, type: "member.removed", subjectKind: "member", subjectId: memberId });
    await revokeMemberAgentTokens(sp, actor, memberId, "member_removed");
  });
}

export async function listMembers(tx: Tx): Promise<{
  memberId: string;
  displayName: string;
  status: "active" | "removed";
  roles: { key: string; projectId: string | null }[];
}[]> {
  const rows = await tx
    .select({ memberId: members.id, displayName: members.displayName, status: members.status })
    .from(members)
    .orderBy(asc(members.displayName), asc(members.id));
  const assigned = await tx
    .select({ memberId: memberRoles.memberId, key: roles.key, projectId: memberRoles.projectId })
    .from(memberRoles)
    .innerJoin(roles, eq(roles.id, memberRoles.roleId))
    .where(and(isNull(memberRoles.revokedAt), isNull(roles.archivedAt)))
    .orderBy(asc(roles.key));
  return rows.map((m) => ({
    ...m,
    roles: assigned.filter((a) => a.memberId === m.memberId).map(({ key, projectId }) => ({ key, projectId })),
  }));
}

// ---------------------------------------------------------------------------------------
// Roles

/** Creates the role `key`, or renames it and replaces its permissions. Returns its id. */
export async function upsertRole(
  tx: Tx,
  actor: Actor,
  input: { key: string; name: string; permissions: Permission[] },
): Promise<string> {
  await requirePermission(tx, actor, "workspace.admin");
  if (!ROLE_KEY.test(input.key)) throw new ValidationError("role key must match /^[a-z][a-z0-9_]{1,30}$/");
  const name = label(input.name, "name");
  const unknown = input.permissions.filter((p) => !PERMISSIONS.includes(p));
  if (unknown.length > 0) throw new ValidationError(`unknown permissions: ${unknown.join(", ")}`);
  const permissions = PERMISSIONS.filter((p) => input.permissions.includes(p));
  const [existing] = await tx
    .select({ id: roles.id, archivedAt: roles.archivedAt })
    .from(roles)
    .where(eq(roles.key, input.key));
  if (existing && existing.archivedAt !== null) throw new ValidationError("role is archived; restore it first");
  return keepingAnAdmin(tx, async (sp) => {
    const id = existing?.id ?? newId();
    if (existing) {
      await sp.update(roles).set({ name, permissions }).where(eq(roles.id, id));
    } else {
      await sp.insert(roles).values({ id, workspaceId: actor.workspaceId, key: input.key, name, permissions });
    }
    await recordEvent(sp, {
      actor,
      type: "role.upserted",
      subjectKind: "role",
      subjectId: id,
      data: { key: input.key, name, permissions, created: !existing },
    });
    return id;
  });
}

async function roleById(tx: Tx, roleId: string) {
  const [role] = await tx.select({ id: roles.id, archivedAt: roles.archivedAt }).from(roles).where(eq(roles.id, roleId));
  if (!role) throw new NotFoundError("role not found");
  return role;
}

/** The role stops granting permissions and leaves pickers; its assignments are kept. */
export async function archiveRole(tx: Tx, actor: Actor, roleId: string): Promise<void> {
  await requirePermission(tx, actor, "workspace.admin");
  const role = await roleById(tx, roleId);
  if (role.archivedAt !== null) return;
  await keepingAnAdmin(tx, async (sp) => {
    await sp.update(roles).set({ archivedAt: sql`now()` }).where(eq(roles.id, roleId));
    await recordEvent(sp, { actor, type: "role.archived", subjectKind: "role", subjectId: roleId });
  });
}

export async function restoreRole(tx: Tx, actor: Actor, roleId: string): Promise<void> {
  await requirePermission(tx, actor, "workspace.admin");
  const role = await roleById(tx, roleId);
  if (role.archivedAt === null) return;
  await tx.update(roles).set({ archivedAt: null }).where(eq(roles.id, roleId));
  await recordEvent(tx, { actor, type: "role.restored", subjectKind: "role", subjectId: roleId });
}

export async function listRoles(tx: Tx): Promise<{
  id: string;
  key: string;
  name: string;
  permissions: Permission[];
  archived: boolean;
  memberCount: number;
}[]> {
  const rows = await tx.select().from(roles).orderBy(asc(roles.key));
  const counts = await tx
    .select({ roleId: memberRoles.roleId, n: sql<number>`count(distinct ${members.id})::int` })
    .from(memberRoles)
    .innerJoin(members, eq(members.id, memberRoles.memberId))
    .where(and(isNull(memberRoles.revokedAt), eq(members.status, "active")))
    .groupBy(memberRoles.roleId);
  const byRole = new Map(counts.map((c) => [c.roleId, c.n]));
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    name: r.name,
    permissions: r.permissions,
    archived: r.archivedAt !== null,
    memberCount: byRole.get(r.id) ?? 0,
  }));
}

/** Active members holding the (non-archived) role in `projectId`, workspace-wide or for that project. */
export async function membersWithRole(
  tx: Tx,
  roleId: string,
  projectId: string,
): Promise<{ memberId: string; displayName: string }[]> {
  return tx
    .selectDistinct({ memberId: members.id, displayName: members.displayName })
    .from(members)
    .innerJoin(memberRoles, eq(memberRoles.memberId, members.id))
    .innerJoin(roles, eq(roles.id, memberRoles.roleId))
    .where(and(
      eq(roles.id, roleId),
      isNull(roles.archivedAt),
      isNull(memberRoles.revokedAt),
      eq(members.status, "active"),
      or(isNull(memberRoles.projectId), eq(memberRoles.projectId, projectId)),
    ))
    .orderBy(asc(members.displayName), asc(members.id));
}
