import { describe, expect, test } from "vitest";
import { withWorkspace } from "./db/client.js";
import { createTestDb, sampleEvent, seedTwoWorkspaces } from "./db/testing.js";
import { listEvents, recordEvent } from "./events.js";
import { newId } from "./ids.js";
import type { Actor } from "./types.js";

describe("event log", () => {
  test("recordEvent stores the actor, subject, project and data", async () => {
    const db = await createTestDb();
    const [a] = await seedTwoWorkspaces(db);
    const projectId = newId();
    const subjectId = newId();
    const agentId = newId();
    const actor: Actor = { kind: "agent", workspaceId: a, memberId: newId(), agentId, projectIds: [projectId] };
    const id = await withWorkspace(db, a, (tx) =>
      recordEvent(tx, { actor, type: "task.created", subjectKind: "task", subjectId, projectId, data: { title: "x" } }),
    );
    const [row] = await withWorkspace(db, a, (tx) => listEvents(tx, {}));
    expect(row).toMatchObject({
      id,
      workspaceId: a,
      projectId,
      actorKind: "agent",
      actorId: agentId,
      type: "task.created",
      subjectKind: "task",
      subjectId,
      data: { title: "x" },
    });
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  test("data defaults to an empty object and project to null", async () => {
    const db = await createTestDb();
    const [a] = await seedTwoWorkspaces(db);
    const actor: Actor = { kind: "connection", workspaceId: a, connectionId: newId() };
    await withWorkspace(db, a, (tx) => recordEvent(tx, { actor, type: "t", subjectKind: "s", subjectId: newId() }));
    const [row] = await withWorkspace(db, a, (tx) => listEvents(tx, {}));
    expect(row).toMatchObject({ data: {}, projectId: null, actorKind: "connection", actorId: actor.connectionId });
  });

  test("listEvents pages forward by id", async () => {
    const db = await createTestDb();
    const [a] = await seedTwoWorkspaces(db);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await withWorkspace(db, a, (tx) => recordEvent(tx, sampleEvent(a))));
    const first = await withWorkspace(db, a, (tx) => listEvents(tx, { limit: 2 }));
    expect(first.map((e) => e.id)).toEqual(ids.slice(0, 2));
    const rest = await withWorkspace(db, a, (tx) => listEvents(tx, { limit: 2, afterId: first[1]!.id }));
    expect(rest.map((e) => e.id)).toEqual(ids.slice(2));
  });

  test("listEvents filters by project", async () => {
    const db = await createTestDb();
    const [a] = await seedTwoWorkspaces(db);
    const p = newId();
    await withWorkspace(db, a, (tx) => recordEvent(tx, sampleEvent(a)));
    const inP = await withWorkspace(db, a, (tx) => recordEvent(tx, { ...sampleEvent(a), projectId: p }));
    const rows = await withWorkspace(db, a, (tx) => listEvents(tx, { projectId: p }));
    expect(rows.map((e) => e.id)).toEqual([inP]);
  });

  test("listEvents defaults to 50 and caps at 200", async () => {
    const db = await createTestDb();
    const [a] = await seedTwoWorkspaces(db);
    await withWorkspace(db, a, async (tx) => {
      for (let i = 0; i < 205; i++) await recordEvent(tx, sampleEvent(a));
    });
    expect(await withWorkspace(db, a, (tx) => listEvents(tx, {}))).toHaveLength(50);
    expect(await withWorkspace(db, a, (tx) => listEvents(tx, { limit: 1000 }))).toHaveLength(200);
    expect(await withWorkspace(db, a, (tx) => listEvents(tx, { limit: 0 }))).toHaveLength(1);
  });
});
