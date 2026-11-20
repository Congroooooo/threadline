import { beforeEach, describe, expect, test } from "vitest";
import { getBlocker, raiseBlocker, resolveBlocker, setBlockerCause } from "./coordination.js";
import { listEvents } from "./events.js";
import { newId } from "./ids.js";
import { archiveRole } from "./tenancy.js";
import { type Actor, ForbiddenError, NotFoundError, ValidationError } from "./types.js";
import { seedTeam, type Team } from "./work.fixture.js";
import { blockedBy, createTask, listEvidence } from "./work.js";

let t: Team;
let leadRole: string;
let taskId: string;

beforeEach(async () => {
  t = await seedTeam();
  leadRole = t.roleIds.lead!;
  ({ taskId } = await t.inWs((tx) =>
    createTask(tx, t.backendMember, { projectId: t.acme, title: "Roll out", ownerRoleId: t.roleIds.backend! }),
  ));
});

const raise = (extra: Partial<Parameters<typeof raiseBlocker>[2]> = {}, actor: Actor = t.backendAgent) =>
  t.inWs((tx) =>
    raiseBlocker(tx, actor, { projectId: t.acme, observed: "rollout stuck at 1 of 2 replicas", ownerRoleId: leadRole, ...extra }),
  );

describe("blockers", () => {
  test("a cause given at creation is stored as suspected", async () => {
    const id = await raise({ suspectedCause: "registry image pull after credential reset" });
    expect(await t.inWs((tx) => getBlocker(tx, id))).toMatchObject({
      causeStatus: "suspected",
      cause: "registry image pull after credential reset",
      status: "open",
      taskId: null,
      raisedByKind: "agent",
    });
    const none = await raise();
    expect(await t.inWs((tx) => getBlocker(tx, none))).toMatchObject({ causeStatus: "none", cause: null });
  });

  test("only a person can mark a cause verified", async () => {
    const id = await raise();
    await expect(
      t.inWs((tx) => setBlockerCause(tx, t.backendAgent, { blockerId: id, cause: "bad creds", verified: true })),
    ).rejects.toThrow(ForbiddenError);
    const conn: Actor = { kind: "connection", workspaceId: t.workspaceId, connectionId: newId() };
    await expect(t.inWs((tx) => setBlockerCause(tx, conn, { blockerId: id, cause: "x", verified: true }))).rejects.toThrow(ForbiddenError);
    expect((await t.inWs((tx) => getBlocker(tx, id))).causeStatus).toBe("none");
    await t.inWs((tx) => setBlockerCause(tx, t.backendAgent, { blockerId: id, cause: "maybe creds", verified: false }));
    expect(await t.inWs((tx) => getBlocker(tx, id))).toMatchObject({ causeStatus: "suspected", cause: "maybe creds" });
    await t.inWs((tx) => setBlockerCause(tx, t.backendMember, { blockerId: id, cause: "bad creds", verified: true }));
    expect(await t.inWs((tx) => getBlocker(tx, id))).toMatchObject({
      causeStatus: "verified",
      cause: "bad creds",
      causeVerifiedBy: t.backendMember.memberId,
    });
  });

  test("only a person can change a verified cause", async () => {
    const id = await raise();
    await t.inWs((tx) => setBlockerCause(tx, t.backendMember, { blockerId: id, cause: "bad creds", verified: true }));
    const conn: Actor = { kind: "connection", workspaceId: t.workspaceId, connectionId: newId() };
    for (const actor of [t.backendAgent, conn]) {
      await expect(
        t.inWs((tx) => setBlockerCause(tx, actor, { blockerId: id, cause: "something else", verified: false })),
      ).rejects.toThrow(ForbiddenError);
    }
    expect(await t.inWs((tx) => getBlocker(tx, id))).toMatchObject({
      causeStatus: "verified",
      cause: "bad creds",
      causeVerifiedBy: t.backendMember.memberId,
    });
    await t.inWs((tx) => setBlockerCause(tx, t.backendMember, { blockerId: id, cause: "revised", verified: false }));
    expect(await t.inWs((tx) => getBlocker(tx, id))).toMatchObject({ causeStatus: "suspected", cause: "revised", causeVerifiedBy: null });
  });

  test("an open blocker on a task shows in blockedBy and clears when resolved", async () => {
    const id = await raise({ taskId });
    expect((await t.inWs((tx) => blockedBy(tx, taskId))).blockers).toEqual([id]);
    await t.inWs((tx) => resolveBlocker(tx, t.backendAgent, { blockerId: id, resolution: "re-issued credentials" }));
    expect((await t.inWs((tx) => blockedBy(tx, taskId))).blockers).toEqual([]);
    expect(await t.inWs((tx) => getBlocker(tx, id))).toMatchObject({
      status: "resolved",
      resolution: "re-issued credentials",
      resolvedByKind: "agent",
      resolvedBy: t.backendAgent.agentId,
    });
  });

  test("a project-level blocker with no task is allowed", async () => {
    const id = await raise();
    expect((await t.inWs((tx) => getBlocker(tx, id))).taskId).toBeNull();
    expect((await t.inWs((tx) => blockedBy(tx, taskId))).blockers).toEqual([]);
  });

  test("resolving twice is rejected", async () => {
    const id = await raise();
    await t.inWs((tx) => resolveBlocker(tx, t.backendMember, { blockerId: id, resolution: "done" }));
    await expect(t.inWs((tx) => resolveBlocker(tx, t.backendMember, { blockerId: id, resolution: "again" }))).rejects.toThrow(ValidationError);
    await expect(
      t.inWs((tx) => setBlockerCause(tx, t.backendMember, { blockerId: id, cause: "late", verified: false })),
    ).rejects.toThrow(ValidationError);
    expect((await t.inWs((tx) => getBlocker(tx, id))).resolution).toBe("done");
  });

  test("connections may raise and resolve", async () => {
    const conn: Actor = { kind: "connection", workspaceId: t.workspaceId, connectionId: newId() };
    const id = await raise({ taskId }, conn);
    expect(await t.inWs((tx) => getBlocker(tx, id))).toMatchObject({ raisedByKind: "connection", raisedById: conn.connectionId });
    await t.inWs((tx) => resolveBlocker(tx, conn, { blockerId: id, resolution: "pipeline green" }));
    expect((await t.inWs((tx) => getBlocker(tx, id))).status).toBe("resolved");
  });

  test("needs blocker.write in the project", async () => {
    const outsider = t.agentOf(t.backendMember, [t.other]);
    await expect(raise({}, outsider)).rejects.toThrow(ForbiddenError);
    const id = await raise();
    await expect(t.inWs((tx) => resolveBlocker(tx, outsider, { blockerId: id, resolution: "x" }))).rejects.toThrow(ForbiddenError);
    await expect(t.inWs((tx) => resolveBlocker(tx, t.backendMember, { blockerId: newId(), resolution: "x" }))).rejects.toThrow(NotFoundError);
  });

  test("validates owner role, task and text", async () => {
    await expect(raise({ ownerRoleId: newId() })).rejects.toThrow(ValidationError);
    await t.inWs((tx) => archiveRole(tx, t.owner, t.roleIds.frontend!));
    await expect(raise({ ownerRoleId: t.roleIds.frontend! })).rejects.toThrow(ValidationError);
    const { taskId: otherTask } = await t.inWs((tx) =>
      createTask(tx, t.owner, { projectId: t.other, title: "Elsewhere", ownerRoleId: leadRole }),
    );
    await expect(raise({ taskId: otherTask })).rejects.toThrow(ValidationError);
    await expect(raise({ taskId: newId() })).rejects.toThrow(NotFoundError);
    await expect(raise({ observed: "   " })).rejects.toThrow(ValidationError);
    await expect(raise({ observed: "x".repeat(10_001) })).rejects.toThrow(ValidationError);
  });

  test("redacts secrets, attaches evidence and records events without free text", async () => {
    const id = await raise({
      observed: "pull failed with token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      evidence: [{ kind: "pipeline_run", url: "https://ci.example.com/runs/9" }],
    });
    const row = await t.inWs((tx) => getBlocker(tx, id));
    expect(row.observed).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(await t.inWs((tx) => listEvidence(tx, "blocker", id))).toHaveLength(1);
    await t.inWs((tx) => resolveBlocker(tx, t.backendMember, { blockerId: id, resolution: "fixed" }));
    const evs = (await t.inWs((tx) => listEvents(tx, { projectId: t.acme }))).filter((e) => e.subjectId === id);
    expect(evs.map((e) => e.type)).toEqual(["blocker.raised", "blocker.resolved"]);
    expect(JSON.stringify(evs.map((e) => e.data))).not.toContain("pull failed");
  });
});
