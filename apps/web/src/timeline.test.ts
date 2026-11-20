import { expect, test } from "vitest";
import type { EventRow } from "./api";
import { describeEvent, mergeEvents, OVERLAP_MS, overlapCursor, uuidFloor } from "./timeline";

const at = (iso: string) => new Date(iso).getTime();
/** A UUID v7-shaped id for a time, with distinguishing low bits. */
const idAt = (iso: string, n: number) => {
  const hex = at(iso).toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-${n.toString(16).padStart(12, "0")}`;
};
const ev = (iso: string, n: number, over: Partial<EventRow> = {}): EventRow => ({
  id: idAt(iso, n), workspaceId: "w1", projectId: "p1", actorKind: "member", actorId: "m1",
  type: "task.created", subjectKind: "task", subjectId: "t1", data: {}, createdAt: iso, ...over,
});

test("uuidFloor sorts before every UUID v7 of the same millisecond and after earlier ones", () => {
  const floor = uuidFloor(at("2026-11-20T10:00:00.000Z"));
  expect(floor).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7000-8000-000000000000$/);
  expect(idAt("2026-11-20T10:00:00.000Z", 1) > floor).toBe(true);
  expect(idAt("2026-11-20T09:59:59.999Z", 999) < floor).toBe(true);
});

test("mergeEvents de-duplicates by id and keeps id order", () => {
  const a = ev("2026-11-20T10:00:00.000Z", 1);
  const b = ev("2026-11-20T10:00:10.000Z", 2);
  const c = ev("2026-11-20T10:00:20.000Z", 3);
  const merged = mergeEvents([a, b], [b, c, a]);
  expect(merged.map((e) => e.id)).toEqual([a.id, b.id, c.id]);
});

test("mergeEvents keeps only the newest `max` events", () => {
  const list = [1, 2, 3, 4].map((n) => ev(`2026-11-20T10:00:0${n}.000Z`, n));
  expect(mergeEvents([], list, 2).map((e) => e.id)).toEqual([list[2]!.id, list[3]!.id]);
});

test("overlapCursor re-requests from an event at least 30 seconds older than the newest seen", () => {
  expect(OVERLAP_MS).toBe(30_000);
  const old = ev("2026-11-20T10:00:00.000Z", 1);
  const older = ev("2026-11-20T09:59:00.000Z", 2);
  const recent = ev("2026-11-20T10:00:20.000Z", 3);
  const newest = ev("2026-11-20T10:00:45.000Z", 4);
  // 10:00:45 minus 30 s is 10:00:15: the newest event at or before that is `old`.
  expect(overlapCursor([older, old, recent, newest])).toBe(old.id);
});

test("overlapCursor falls back to a time floor when every seen event is recent", () => {
  const a = ev("2026-11-20T10:00:40.000Z", 1);
  const b = ev("2026-11-20T10:00:45.000Z", 2);
  expect(overlapCursor([a, b])).toBe(uuidFloor(at("2026-11-20T10:00:15.000Z")));
  expect(overlapCursor([])).toBeUndefined();
});

test("a late-committing event inside the overlap window is picked up on the next poll", () => {
  const seen = [ev("2026-11-20T10:00:00.000Z", 1), ev("2026-11-20T10:00:40.000Z", 3)];
  // Committed after the last poll, but its id (time) is older than the newest seen.
  const late = ev("2026-11-20T10:00:30.000Z", 2);
  const cursor = overlapCursor(seen)!;
  expect(late.id > cursor).toBe(true); // the server's `id > after` returns it
  expect(mergeEvents(seen, [late, seen[1]!]).map((e) => e.id)).toEqual([seen[0]!.id, late.id, seen[1]!.id]);
});

test("describeEvent handles the system actor and unknown types", () => {
  expect(describeEvent(ev("2026-11-20T10:00:00.000Z", 1, { actorKind: "system", type: "notify.failed" }))).toEqual({
    who: "Threadline",
    what: "could not post to the chat channel",
  });
  expect(describeEvent(ev("2026-11-20T10:00:00.000Z", 1, { actorKind: "agent", type: "something.new" })).who).toBe("An agent");
  expect(describeEvent(ev("2026-11-20T10:00:00.000Z", 1, { type: "something.new" })).what).toBe("something new");
});
