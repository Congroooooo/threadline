// Handoffs: one actor tells a role what was delivered and what the role must now do.
// A handoff stays pending until an active member who currently holds the target role in
// the handoff's project (workspace-wide or project-scoped) responds; agents never can,
// because handoff.ack is HUMAN_ONLY.
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "./db/client.js";
import { blockers, type BlockerRow, handoffs, type HandoffRow } from "./db/schema.js";
import { actorId, recordEvent } from "./events.js";
import { newId } from "./ids.js";
import { label, membersWithRole, requirePermission } from "./tenancy.js";
import { UUID } from "./tokens.js";
import { type Actor, type ExternalRefInput, ForbiddenError, NotFoundError, ValidationError } from "./types.js";
import { attachEvidence, loadTask, lockActiveProject, optionalText, parseEvidence, requireActiveRole } from "./work.js";

export type { BlockerRow, HandoffRow };

export type BlockerStatus = "open" | "resolved";
export type CauseStatus = "none" | "suspected" | "verified";

export type HandoffStatus = "pending" | "accepted" | "needs_changes";

export const MAX_IDEMPOTENCY_KEY = 200;

/** The raw handoff row, or NotFoundError. For use inside core; views come in Task 9. */
export async function getHandoff(tx: Tx, handoffId: string): Promise<HandoffRow> {
  if (typeof handoffId !== "string" || !UUID.test(handoffId)) throw new NotFoundError("handoff not found");
  const [row] = await tx.select().from(handoffs).where(eq(handoffs.id, handoffId));
  if (!row) throw new NotFoundError("handoff not found");
  return row;
}

async function isUnassigned(tx: Tx, roleId: string, projectId: string): Promise<boolean> {
  return (await membersWithRole(tx, roleId, projectId)).length === 0;
}

function parseIdempotencyKey(key: string | undefined): string | null {
  if (key === undefined || key === null) return null;
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY || /[\s\x00-\x1f\x7f]/.test(key)) {
    throw new ValidationError(`idempotencyKey must be 1 to ${MAX_IDEMPOTENCY_KEY} characters without spaces`);
  }
  return key;
}

/**
 * Hands work on a task to a role. Needs handoff.create in the task's project. `toRoleId`
 * must be an active role; `unassigned` says no active member currently holds it for the
 * project (the handoff is still created).
 *
 * Idempotency: with `idempotencyKey`, a repeat returns the handoff first created under that
 * key (`created: false`, its current `unassigned`) and records nothing, even if the rest
 * of the input differs: the first payload wins. A key already used in another project is a
 * ValidationError that reveals nothing about that handoff. The insert uses ON CONFLICT DO
 * NOTHING, so a concurrent duplicate never aborts the caller's transaction.
 */
export async function createHandoff(
  tx: Tx,
  actor: Actor,
  input: {
    taskId: string;
    toRoleId: string;
    delivered: string;
    requiredAction: string;
    knownLimits?: string;
    evidence?: ExternalRefInput[];
    idempotencyKey?: string;
  },
): Promise<{ handoffId: string; unassigned: boolean; created: boolean }> {
  const task = await loadTask(tx, input.taskId);
  await requirePermission(tx, actor, "handoff.create", task.projectId);
  const idempotencyKey = parseIdempotencyKey(input.idempotencyKey);

  // Keys are scoped to the sending actor. A retry is answered before the rest of the input
  // is validated, so it still succeeds after e.g. the target role was archived.
  const existing = async (key: string) => {
    const [row] = await tx
      .select({ id: handoffs.id, projectId: handoffs.projectId, toRoleId: handoffs.toRoleId })
      .from(handoffs)
      .where(and(
        eq(handoffs.fromActorKind, actor.kind),
        eq(handoffs.fromActorId, actorId(actor)),
        eq(handoffs.idempotencyKey, key),
      ));
    if (!row) return null;
    if (row.projectId !== task.projectId) throw new ValidationError("idempotencyKey is already in use");
    return { handoffId: row.id, unassigned: await isUnassigned(tx, row.toRoleId, row.projectId), created: false };
  };
  if (idempotencyKey !== null) {
    const found = await existing(idempotencyKey);
    if (found) return found;
  }

  const delivered = label(input.delivered, "delivered");
  const requiredAction = label(input.requiredAction, "requiredAction");
  const knownLimits = optionalText(input.knownLimits, "knownLimits");
  await requireActiveRole(tx, input.toRoleId, "toRoleId");
  const items = parseEvidence(input.evidence, actor);

  const handoffId = newId();
  const inserted = await tx
    .insert(handoffs)
    .values({
      id: handoffId,
      workspaceId: actor.workspaceId,
      projectId: task.projectId,
      taskId: task.id,
      fromActorKind: actor.kind,
      fromActorId: actorId(actor),
      toRoleId: input.toRoleId,
      delivered,
      requiredAction,
      knownLimits,
      idempotencyKey,
    })
    .onConflictDoNothing()
    .returning({ id: handoffs.id });
  if (inserted.length === 0) {
    // Lost a race with a concurrent create under the same key.
    const found = idempotencyKey !== null ? await existing(idempotencyKey) : null;
    if (!found) throw new Error("handoff insert conflicted unexpectedly");
    return found;
  }
  const evidenceIds = await attachEvidence(tx, actor, task.projectId, "handoff", handoffId, items);
  const unassigned = await isUnassigned(tx, input.toRoleId, task.projectId);
  await recordEvent(tx, {
    actor,
    type: "handoff.created",
    subjectKind: "handoff",
    subjectId: handoffId,
    projectId: task.projectId,
    data: { taskId: task.id, toRoleId: input.toRoleId, unassigned, evidenceIds },
  });
  return { handoffId, unassigned, created: true };
}

/**
 * Accepts a pending handoff or sends it back with `needs_changes` (which needs a note).
 * Needs handoff.ack in the project, and the member must currently hold the target role
 * there. A handoff is answered once.
 */
export async function respondToHandoff(
  tx: Tx,
  actor: Actor,
  input: { handoffId: string; response: "accepted" | "needs_changes"; note?: string },
): Promise<void> {
  if (input.response !== "accepted" && input.response !== "needs_changes") {
    throw new ValidationError("response must be accepted or needs_changes");
  }
  const h = await getHandoff(tx, input.handoffId);
  await requirePermission(tx, actor, "handoff.ack", h.projectId);
  if (actor.kind !== "member") throw new ForbiddenError("only a member may respond to a handoff");
  const holders = await membersWithRole(tx, h.toRoleId, h.projectId);
  if (!holders.some((m) => m.memberId === actor.memberId)) {
    throw new ForbiddenError("only a member holding the handoff's role may respond");
  }
  const note = optionalText(input.note, "note");
  if (input.response === "needs_changes" && note === null) {
    throw new ValidationError("needs_changes requires a note saying what to change");
  }
  const updated = await tx
    .update(handoffs)
    .set({ status: input.response, respondedBy: actor.memberId, responseNote: note, respondedAt: sql`now()` })
    .where(and(eq(handoffs.id, h.id), eq(handoffs.status, "pending")))
    .returning({ id: handoffs.id });
  if (updated.length === 0) throw new ValidationError("handoff has already been answered");
  await recordEvent(tx, {
    actor,
    type: `handoff.${input.response}`,
    subjectKind: "handoff",
    subjectId: h.id,
    projectId: h.projectId,
    data: { taskId: h.taskId, toRoleId: h.toRoleId, status: input.response },
  });
}

// ---------------------------------------------------------------------------------------
// Blockers: what stands in the way of a project or one of its tasks. All writes need
// blocker.write in the project (connections hold it everywhere). Only a member may mark a
// cause verified; agents and connections can only suspect.

/** The raw blocker row, or NotFoundError. For use inside core; views come in Task 9. */
export async function getBlocker(tx: Tx, blockerId: string, lock = false): Promise<BlockerRow> {
  if (typeof blockerId !== "string" || !UUID.test(blockerId)) throw new NotFoundError("blocker not found");
  const q = tx.select().from(blockers).where(eq(blockers.id, blockerId));
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw new NotFoundError("blocker not found");
  return row;
}

/**
 * Raises a blocker on a project, or on one of its tasks when `taskId` is given. `observed`
 * is what was seen; a `suspectedCause` makes the cause status `suspected`, otherwise `none`.
 * `ownerRoleId` must be an active role. Returns the blocker id.
 */
export async function raiseBlocker(
  tx: Tx,
  actor: Actor,
  input: {
    projectId: string;
    taskId?: string;
    observed: string;
    suspectedCause?: string;
    ownerRoleId: string;
    evidence?: ExternalRefInput[];
  },
): Promise<string> {
  if (typeof input.projectId !== "string" || !UUID.test(input.projectId)) throw new NotFoundError("project not found");
  await requirePermission(tx, actor, "blocker.write", input.projectId);
  const observed = label(input.observed, "observed");
  const cause = optionalText(input.suspectedCause, "suspectedCause");
  await requireActiveRole(tx, input.ownerRoleId, "ownerRoleId");
  const items = parseEvidence(input.evidence, actor);
  await lockActiveProject(tx, input.projectId);
  let taskId: string | null = null;
  if (input.taskId !== undefined && input.taskId !== null) {
    const task = await loadTask(tx, input.taskId);
    if (task.projectId !== input.projectId) throw new ValidationError("taskId must belong to projectId");
    taskId = task.id;
  }
  const causeStatus: CauseStatus = cause === null ? "none" : "suspected";
  const id = newId();
  await tx.insert(blockers).values({
    id,
    workspaceId: actor.workspaceId,
    projectId: input.projectId,
    taskId,
    observed,
    cause,
    causeStatus,
    ownerRoleId: input.ownerRoleId,
    raisedByKind: actor.kind,
    raisedById: actorId(actor),
  });
  const evidenceIds = await attachEvidence(tx, actor, input.projectId, "blocker", id, items);
  await recordEvent(tx, {
    actor,
    type: "blocker.raised",
    subjectKind: "blocker",
    subjectId: id,
    projectId: input.projectId,
    data: { taskId, ownerRoleId: input.ownerRoleId, causeStatus, evidenceIds },
  });
  return id;
}

/**
 * Records the cause of an open blocker as suspected or, with `verified: true`, verified.
 * Verifying is for members only.
 */
export async function setBlockerCause(
  tx: Tx,
  actor: Actor,
  input: { blockerId: string; cause: string; verified: boolean },
): Promise<void> {
  const b = await getBlocker(tx, input.blockerId, true);
  await requirePermission(tx, actor, "blocker.write", b.projectId);
  if (typeof input.verified !== "boolean") throw new ValidationError("verified must be true or false");
  if (input.verified && actor.kind !== "member") throw new ForbiddenError("only a member may verify a cause");
  const cause = label(input.cause, "cause");
  if (b.status !== "open") throw new ValidationError("blocker is already resolved");
  if (b.causeStatus === "verified" && actor.kind !== "member") {
    throw new ForbiddenError("only a member may change a verified cause");
  }
  const causeStatus: CauseStatus = input.verified ? "verified" : "suspected";
  await tx
    .update(blockers)
    .set({ cause, causeStatus, causeVerifiedBy: input.verified && actor.kind === "member" ? actor.memberId : null })
    .where(eq(blockers.id, b.id));
  await recordEvent(tx, {
    actor,
    type: "blocker.cause_set",
    subjectKind: "blocker",
    subjectId: b.id,
    projectId: b.projectId,
    data: { taskId: b.taskId, causeStatus },
  });
}

/** Resolves an open blocker with a note on how. A blocker is resolved once. */
export async function resolveBlocker(
  tx: Tx,
  actor: Actor,
  input: { blockerId: string; resolution: string },
): Promise<void> {
  const b = await getBlocker(tx, input.blockerId, true);
  await requirePermission(tx, actor, "blocker.write", b.projectId);
  const resolution = label(input.resolution, "resolution");
  const updated = await tx
    .update(blockers)
    .set({ status: "resolved", resolution, resolvedByKind: actor.kind, resolvedBy: actorId(actor), resolvedAt: sql`now()` })
    .where(and(eq(blockers.id, b.id), eq(blockers.status, "open")))
    .returning({ id: blockers.id });
  if (updated.length === 0) throw new ValidationError("blocker is already resolved");
  await recordEvent(tx, {
    actor,
    type: "blocker.resolved",
    subjectKind: "blocker",
    subjectId: b.id,
    projectId: b.projectId,
    data: { taskId: b.taskId, status: "resolved" },
  });
}
