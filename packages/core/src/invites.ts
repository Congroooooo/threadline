// How a teammate joins a workspace: an admin creates a single-use code, the teammate signs
// in and accepts it, and becomes a member with the invite's roles.
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { type Db, type Tx, withSystem } from "./db/client.js";
import { invites, memberRoles, members, users } from "./db/schema.js";
import { recordEvent } from "./events.js";
import { newId } from "./ids.js";
import { requireActiveProjects } from "./projects.js";
import { activeRoleIds, assign, label, requirePermission, revokeMemberAgentTokens } from "./tenancy.js";
import { hashSecret, INVITE_CODE_BYTES, INVITE_CODE_PREFIX, randomSecret, secretPattern, UUID } from "./tokens.js";
import { type Actor, ForbiddenError, NotFoundError, ValidationError } from "./types.js";

export const DEFAULT_INVITE_DAYS = 7;
export const MAX_INVITE_DAYS = 30;
const DAY_MS = 86_400_000;

const INVITE_CODE = secretPattern(INVITE_CODE_PREFIX, INVITE_CODE_BYTES);

/** One message for every unusable code, so a caller cannot tell which case it hit. */
const invalid = () => new ValidationError("invite is invalid or expired");

/** Still claimable: not used, not revoked, not expired. */
const open = () => and(isNull(invites.usedAt), isNull(invites.revokedAt), gt(invites.expiresAt, sql`now()`));

/**
 * A single-use invite into the actor's workspace. The roles apply workspace-wide, or in
 * `projectId` only when given. Needs workspace.admin. The code is returned only here.
 */
export async function createInvite(
  tx: Tx,
  actor: Actor,
  input: { roleKeys: string[]; projectId?: string; expiresInDays?: number },
): Promise<{ inviteId: string; code: string }> {
  await requirePermission(tx, actor, "workspace.admin");
  if (actor.kind !== "member") throw new ForbiddenError("only a member can create invites"); // narrows; can() already refuses
  const days = input.expiresInDays ?? DEFAULT_INVITE_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > MAX_INVITE_DAYS) {
    throw new ValidationError(`expiresInDays must be a whole number from 1 to ${MAX_INVITE_DAYS}`);
  }
  if (input.projectId !== undefined && !UUID.test(input.projectId)) throw new ValidationError("projectId must be a UUID");
  if (input.projectId !== undefined) await requireActiveProjects(tx, [input.projectId]);
  const roleKeys = (await activeRoleIds(tx, input.roleKeys)).map((r) => r.key).sort();
  const projectId = input.projectId ?? null;
  const inviteId = newId();
  const code = randomSecret(INVITE_CODE_PREFIX, INVITE_CODE_BYTES);
  const expiresAt = new Date(Date.now() + days * DAY_MS);
  await tx.insert(invites).values({
    id: inviteId,
    workspaceId: actor.workspaceId,
    codeHash: await hashSecret(code),
    roleKeys,
    projectId,
    createdBy: actor.memberId,
    expiresAt,
  });
  await recordEvent(tx, {
    actor,
    type: "invite.created",
    subjectKind: "invite",
    subjectId: inviteId,
    ...(projectId !== null ? { projectId } : {}),
    data: { roleKeys, projectId, expiresAt: expiresAt.toISOString() },
  });
  return { inviteId, code };
}

/**
 * Makes `userId` a member of the invite's workspace with the invite's roles and uses the
 * code up, atomically. A user who is already an active member gets their membership back
 * and the code stays unused. A removed member is reactivated with the invite's roles only.
 */
export async function acceptInvite(
  db: Db,
  input: { userId: string; displayName: string; code: string },
): Promise<{ workspaceId: string; memberId: string }> {
  const displayName = label(input.displayName, "displayName");
  if (typeof input.code !== "string" || !INVITE_CODE.test(input.code)) throw invalid();
  if (!UUID.test(input.userId)) throw new NotFoundError("user not found");
  const codeHash = await hashSecret(input.code);
  return withSystem(db, async (tx) => {
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId));
    if (!user) throw new NotFoundError("user not found");
    // Opens invites_system_lookup for this one hash: system reads no other invite.
    await tx.execute(sql`select set_config('app.lookup_hash', ${codeHash}, true)`);
    const [invite] = await tx
      .select({ id: invites.id, workspaceId: invites.workspaceId, roleKeys: invites.roleKeys, projectId: invites.projectId })
      .from(invites)
      .where(and(eq(invites.codeHash, codeHash), open()));
    if (!invite) throw invalid();
    const { workspaceId } = invite;
    await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);

    const [existing] = await tx
      .select({ id: members.id, status: members.status })
      .from(members)
      .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, input.userId)));
    if (existing?.status === "active") return { workspaceId, memberId: existing.id };
    const memberId = existing?.id ?? newId();

    // Claim first: a concurrent accept of the same code waits on this row, then matches
    // nothing. used_by's foreign key is deferred until the member row below exists.
    const claimed = await tx
      .update(invites)
      .set({ usedAt: sql`now()`, usedBy: memberId })
      .where(and(eq(invites.id, invite.id), open()))
      .returning({ id: invites.id });
    if (claimed.length === 0) throw invalid();

    // Roles archived since the invite was made fail here and roll the claim back. The
    // caller is not a member yet, so they get the uniform message, not the role keys.
    let roleIds: string[];
    try {
      roleIds = (await activeRoleIds(tx, invite.roleKeys)).map((r) => r.id);
    } catch (err) {
      if (err instanceof ValidationError) throw invalid();
      throw err;
    }
    const actor: Actor = { kind: "member", workspaceId, memberId };
    if (existing) {
      await tx.update(members).set({ status: "active", displayName }).where(eq(members.id, memberId));
      await tx
        .update(memberRoles)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(memberRoles.memberId, memberId), isNull(memberRoles.revokedAt)));
      // removeMember already revoked their tokens; this guards rows from other paths
      // (an import, say) so a token from before the removal can never revive.
      await revokeMemberAgentTokens(tx, actor, memberId, "member_reactivated");
    } else {
      await tx.insert(members).values({ id: memberId, workspaceId, userId: input.userId, displayName });
    }
    await assign(tx, workspaceId, memberId, roleIds, invite.projectId);

    const scope = invite.projectId !== null ? { projectId: invite.projectId } : {};
    await recordEvent(tx, {
      actor,
      type: "member.added",
      subjectKind: "member",
      subjectId: memberId,
      ...scope,
      data: {
        userId: input.userId,
        displayName,
        roleKeys: invite.roleKeys,
        projectId: invite.projectId,
        reactivated: !!existing,
        inviteId: invite.id,
      },
    });
    await recordEvent(tx, {
      actor,
      type: "invite.accepted",
      subjectKind: "invite",
      subjectId: invite.id,
      ...scope,
      data: { memberId },
    });
    return { workspaceId, memberId };
  });
}

/** Stops the code working. Needs workspace.admin; revoking twice is a no-op. */
export async function revokeInvite(tx: Tx, actor: Actor, inviteId: string): Promise<void> {
  await requirePermission(tx, actor, "workspace.admin");
  if (!UUID.test(inviteId)) throw new NotFoundError("invite not found");
  const [invite] = await tx
    .select({ usedAt: invites.usedAt, revokedAt: invites.revokedAt, projectId: invites.projectId })
    .from(invites)
    .where(eq(invites.id, inviteId));
  if (!invite) throw new NotFoundError("invite not found");
  if (invite.usedAt !== null) throw new ValidationError("invite has already been used");
  if (invite.revokedAt !== null) return;
  await tx.update(invites).set({ revokedAt: sql`now()` }).where(eq(invites.id, inviteId));
  await recordEvent(tx, {
    actor,
    type: "invite.revoked",
    subjectKind: "invite",
    subjectId: inviteId,
    ...(invite.projectId !== null ? { projectId: invite.projectId } : {}),
  });
}

/**
 * Invites still waiting to be used (not used, revoked or expired), oldest first, with who
 * made them. Needs workspace.admin. Codes are never returned (only their hash is stored).
 */
export async function listInvites(tx: Tx, actor: Actor): Promise<{
  id: string;
  roleKeys: string[];
  projectId: string | null;
  createdBy: string;
  createdByName: string;
  expiresAt: string;
  createdAt: string;
}[]> {
  await requirePermission(tx, actor, "workspace.admin");
  const rows = await tx
    .select({
      id: invites.id,
      roleKeys: invites.roleKeys,
      projectId: invites.projectId,
      createdBy: invites.createdBy,
      createdByName: members.displayName,
      expiresAt: invites.expiresAt,
      createdAt: invites.createdAt,
    })
    .from(invites)
    .innerJoin(members, eq(members.id, invites.createdBy))
    .where(open())
    .orderBy(asc(invites.id));
  return rows.map((r) => ({ ...r, expiresAt: r.expiresAt.toISOString(), createdAt: r.createdAt.toISOString() }));
}
