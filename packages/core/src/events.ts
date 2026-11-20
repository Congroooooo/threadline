import { and, asc, eq, gt, type SQL } from "drizzle-orm";
import type { Tx } from "./db/client.js";
import { events, type EventRow } from "./db/schema.js";
import { newId } from "./ids.js";
import type { Actor } from "./types.js";

export type { EventRow };

export type EventInput = {
  actor: Actor;
  type: string;
  subjectKind: string;
  subjectId: string;
  projectId?: string;
  data?: Record<string, unknown>;
};

/** The id of whoever acts: the member, the agent or the connection. */
export function actorId(actor: Actor): string {
  switch (actor.kind) {
    case "member":
      return actor.memberId;
    case "agent":
      return actor.agentId;
    case "connection":
      return actor.connectionId;
  }
}

/**
 * Appends one event in the caller's transaction and returns its id. The workspace is the
 * actor's; row-level security rejects it if that is not the transaction's workspace.
 */
export async function recordEvent(tx: Tx, e: EventInput): Promise<string> {
  const id = newId();
  await tx.insert(events).values({
    id,
    workspaceId: e.actor.workspaceId,
    projectId: e.projectId ?? null,
    actorKind: e.actor.kind,
    actorId: actorId(e.actor),
    type: e.type,
    subjectKind: e.subjectKind,
    subjectId: e.subjectId,
    data: e.data ?? {},
  });
  return id;
}

export const DEFAULT_EVENT_LIMIT = 50;
export const MAX_EVENT_LIMIT = 200;

/** Events visible to the transaction, oldest first, paging forward with `afterId`. */
export async function listEvents(
  tx: Tx,
  q: { projectId?: string; afterId?: string; limit?: number },
): Promise<EventRow[]> {
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? DEFAULT_EVENT_LIMIT) || 1, 1), MAX_EVENT_LIMIT);
  const where: SQL[] = [];
  if (q.projectId !== undefined) where.push(eq(events.projectId, q.projectId));
  if (q.afterId !== undefined) where.push(gt(events.id, q.afterId));
  return tx
    .select()
    .from(events)
    .where(and(...where))
    .orderBy(asc(events.id))
    .limit(limit);
}
