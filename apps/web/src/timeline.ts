// The project activity timeline: polling `events?after=` with an overlap window.
//
// Event ids are UUID v7, so id order is (roughly) creation order and `after=<id>` returns
// strictly newer ids. A transaction can commit after a later-started one, so an event can
// appear with an id older than the newest one already seen. Each poll therefore re-requests
// from an event at least OVERLAP_MS older than the newest seen and merges by id.
import { useEffect, useRef, useState } from "react";
import { api, type EventRow } from "./api";

export const OVERLAP_MS = 30_000;
export const POLL_MS = 15_000;
/** How far back the timeline starts when the page opens. */
export const HISTORY_MS = 7 * 24 * 60 * 60 * 1000;
/** Most events kept on screen (the newest). */
export const MAX_EVENTS = 200;
const PAGE = 200;
const MAX_PAGES = 10;

/** The smallest UUID v7 for a millisecond: every id created at or after `ms` sorts above it. */
export function uuidFloor(ms: number): string {
  const hex = Math.max(0, Math.floor(ms)).toString(16).padStart(12, "0").slice(-12);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;
}

/** `existing` plus `incoming`, one per id, in id order, at most `max` (the newest). */
export function mergeEvents(existing: EventRow[], incoming: EventRow[], max = MAX_EVENTS): EventRow[] {
  const byId = new Map<string, EventRow>();
  for (const e of existing) byId.set(e.id, e);
  for (const e of incoming) byId.set(e.id, e);
  const all = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return all.length > max ? all.slice(all.length - max) : all;
}

const timeOf = (e: EventRow) => new Date(e.createdAt).getTime();

/**
 * Where the next poll starts (`after`): the newest seen event at least OVERLAP_MS older
 * than the newest one, or, when every seen event is that recent, the time floor
 * OVERLAP_MS before the newest. Undefined when nothing has been seen.
 */
export function overlapCursor(seen: EventRow[]): string | undefined {
  const newest = seen[seen.length - 1];
  if (!newest) return undefined;
  const cutoff = timeOf(newest) - OVERLAP_MS;
  for (let i = seen.length - 1; i >= 0; i--) {
    const e = seen[i]!;
    if (timeOf(e) <= cutoff) return e.id;
  }
  return uuidFloor(cutoff);
}

/** One entry per event type core emits (packages/core: recordEvent calls, plus notify.failed). */
export const VERBS: Record<string, string> = {
  "workspace.created": "created the workspace",
  "project.created": "created the project",
  "project.config_updated": "changed project settings",
  "task.created": "created a task",
  "task.status_changed": "changed a task's status",
  "task.progress_reported": "reported progress",
  "task.dependency_added": "added a task dependency",
  "task.dependency_removed": "removed a task dependency",
  "run.started": "started a run",
  "run.finished": "finished a run",
  "handoff.created": "handed work over",
  "handoff.accepted": "accepted a handoff",
  "handoff.needs_changes": "sent a handoff back for changes",
  "blocker.raised": "raised a blocker",
  "blocker.cause_set": "named a blocker's cause",
  "blocker.resolved": "resolved a blocker",
  "member.roles_set": "changed someone's roles",
  "member.added": "joined",
  "member.removed": "removed a member",
  "invite.created": "created an invite",
  "invite.accepted": "accepted an invite",
  "invite.revoked": "revoked an invite",
  "agent_token.created": "created an agent token",
  "agent_token.revoked": "revoked an agent token",
  "role.upserted": "changed a role",
  "role.archived": "archived a role",
  "role.restored": "restored a role",
  "notify.failed": "could not post to the chat channel",
};

const WHO: Record<EventRow["actorKind"], string> = {
  member: "Someone",
  agent: "An agent",
  connection: "A connection",
  system: "Threadline",
};

/** Plain words for an event. Events carry ids, not names, so the actor is described by kind. */
export function describeEvent(e: EventRow): { who: string; what: string } {
  const what = VERBS[e.type] ?? e.type.replace(/[._]/g, " ");
  return { who: WHO[e.actorKind] ?? "Someone", what };
}

async function fetchFrom(ws: string, projectId: string, after: string | undefined): Promise<EventRow[]> {
  let out: EventRow[] = [];
  let cursor = after;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await api.events(ws, projectId, { ...(cursor ? { after: cursor } : {}), limit: PAGE });
    out = out.concat(batch);
    if (batch.length < PAGE) break;
    cursor = batch[batch.length - 1]!.id;
  }
  return out;
}

/**
 * The project's recent events, newest last. Polls every POLL_MS while the tab is visible,
 * and once more as soon as it becomes visible again.
 */
export function useTimeline(ws: string, projectId: string): { events: EventRow[]; error: string | null } {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const seen = useRef<EventRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    seen.current = [];
    setEvents([]);

    const poll = async () => {
      if (running || cancelled) return;
      running = true;
      try {
        const after = overlapCursor(seen.current) ?? uuidFloor(Date.now() - HISTORY_MS);
        const batch = await fetchFrom(ws, projectId, after);
        if (cancelled) return;
        seen.current = mergeEvents(seen.current, batch);
        setEvents(seen.current);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "could not load activity");
      } finally {
        running = false;
        schedule();
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      if (cancelled || document.visibilityState === "hidden") return;
      timer = setTimeout(() => void poll(), POLL_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void poll();
      else clearTimeout(timer);
    };

    void poll();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ws, projectId]);

  return { events, error };
}
