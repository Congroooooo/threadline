import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import { assertAllTablesHaveForcedRls, rawQuery, seedUser } from "./db/testing.js";
import { withWorkspace } from "./db/client.js";
import { listEvents } from "./events.js";
import { newId } from "./ids.js";
import { createWorkspace } from "./tenancy.js";
import { type Actor, ForbiddenError, NotFoundError, ValidationError } from "./types.js";
import { seedTeam, type Team } from "./work.fixture.js";
import {
  addDependency,
  blockedBy,
  createTask,
  finishRun,
  getTask,
  listEvidence,
  listProgress,
  removeDependency,
  reportProgress,
  resolveTaskRef,
  setTaskStatus,
  startRun,
} from "./work.js";

let t: Team;
let taskId: string;

beforeEach(async () => {
  t = await seedTeam();
  ({ taskId } = await t.inWs((tx) =>
    createTask(tx, t.backendMember, { projectId: t.acme, title: "Add archived flag", ownerRoleId: t.roleIds.backend! }),
  ));
});

const task = (actor: Actor, projectId: string, title: string, dependsOn?: string[]) =>
  t.inWs((tx) => createTask(tx, actor, { projectId, title, ownerRoleId: t.roleIds.backend!, ...(dependsOn ? { dependsOn } : {}) }));

describe("tasks", () => {
  test("task refs count up per project", async () => {
    expect((await t.inWs((tx) => getTask(tx, taskId))).number).toBe(1);
    expect((await task(t.backendMember, t.acme, "second")).ref).toBe("ACME-2");
    expect((await task(t.backendAgent, t.acme, "third")).ref).toBe("ACME-3");
    expect((await task(t.owner, t.other, "elsewhere")).ref).toBe("OTH-1");
    const fourth = await task(t.owner, t.acme, "fourth");
    expect(fourth.ref).toBe("ACME-4");
    expect(await t.inWs((tx) => resolveTaskRef(tx, t.acme, "ACME-4"))).toBe(fourth.taskId);
    expect(await t.inWs((tx) => resolveTaskRef(tx, t.acme, "acme-4"))).toBe(fourth.taskId);
    expect(await t.inWs((tx) => resolveTaskRef(tx, t.acme, fourth.taskId))).toBe(fourth.taskId);
    for (const bad of ["ACME-99", "OTH-1", "ACME-x", "4", "", newId()]) {
      await expect(t.inWs((tx) => resolveTaskRef(tx, t.acme, bad)), bad).rejects.toThrow(NotFoundError);
    }
  });

  test("a new task is todo with cleaned text, and its creation is one event without free text", async () => {
    const { taskId: id, ref } = await t.inWs((tx) =>
      createTask(tx, t.backendAgent, {
        projectId: t.acme,
        title: "  Rotate glpat-abcdefghijklmnopqrstuvwx  ",
        description: "password=hunter2",
        ownerRoleId: t.roleIds.frontend!,
        branch: "feat/archived-flag",
      }),
    );
    const row = await t.inWs((tx) => getTask(tx, id));
    expect(row).toMatchObject({
      status: "todo",
      title: "Rotate [REDACTED]",
      description: "password=[REDACTED]",
      ownerRoleId: t.roleIds.frontend,
      branch: "feat/archived-flag",
      createdBy: t.backendMember.memberId,
    });
    const events = (await t.inWs((tx) => listEvents(tx, { projectId: t.acme }))).filter((e) => e.subjectId === id);
    expect(events.map((e) => e.type)).toEqual(["task.created"]);
    expect(events[0]!.actorKind).toBe("agent");
    expect(events[0]!.data).toEqual({ ref, ownerRoleId: t.roleIds.frontend, dependsOn: [] });
  });

  test("task input is validated", async () => {
    const base = { projectId: t.acme, title: "x", ownerRoleId: t.roleIds.backend! };
    const bad = [
      { ...base, title: "   " },
      { ...base, title: "x".repeat(10_001) },
      { ...base, description: "x".repeat(10_001) },
      { ...base, ownerRoleId: newId() },
      { ...base, ownerRoleId: "nope" },
      { ...base, branch: "has space" },
      { ...base, branch: "" },
      { ...base, dependsOn: [newId()] },
    ];
    for (const input of bad) {
      await expect(t.inWs((tx) => createTask(tx, t.owner, input)), JSON.stringify(input).slice(0, 80)).rejects.toThrow(ValidationError);
    }
    await expect(t.inWs((tx) => createTask(tx, t.owner, { ...base, projectId: newId() }))).rejects.toThrow(NotFoundError);
    await expect(t.inWs((tx) => createTask(tx, t.owner, { ...base, projectId: "nope" }))).rejects.toThrow(NotFoundError);
    await rawQuery(t.db, `update roles set archived_at = now() where id = '${t.roleIds.frontend}'`);
    await expect(t.inWs((tx) => createTask(tx, t.owner, { ...base, ownerRoleId: t.roleIds.frontend! }))).rejects.toThrow(ValidationError);
    await rawQuery(t.db, `update projects set archived_at = now() where id = '${t.other}'`);
    await expect(t.inWs((tx) => createTask(tx, t.owner, { ...base, projectId: t.other }))).rejects.toThrow(NotFoundError);
  });

  test("writing tasks needs task.write in the project", async () => {
    await expect(task(t.approver, t.acme, "no")).rejects.toThrow(ForbiddenError);
    await expect(t.inWs((tx) => setTaskStatus(tx, t.approver, taskId, "in_review"))).rejects.toThrow(ForbiddenError);
    await expect(t.inWs((tx) => startRun(tx, t.approver, taskId))).rejects.toThrow(ForbiddenError);
    await expect(t.inWs((tx) => reportProgress(tx, t.approver, { taskId, note: "hi" }))).rejects.toThrow(ForbiddenError);
    const conn: Actor = { kind: "connection", workspaceId: t.workspaceId, connectionId: newId() };
    await expect(task(conn, t.acme, "no")).rejects.toThrow(ForbiddenError);
    // a project-scoped role only reaches its own project
    const scoped = await t.member("Sol", ["backend"], t.other);
    await expect(task(scoped, t.acme, "no")).rejects.toThrow(ForbiddenError);
    await expect(task(scoped, t.other, "yes")).resolves.toMatchObject({ ref: "OTH-1" });
  });

  test("an agent is limited to its projects and learns nothing about others", async () => {
    const othTask = (await task(t.owner, t.other, "secret plans glpat-abcdefghijklmnopqrstuvwx")).taskId;
    const agent = t.backendAgent;
    const errors = await Promise.all([
      task(agent, t.other, "no").catch((e) => e),
      t.inWs((tx) => setTaskStatus(tx, agent, othTask, "in_progress")).catch((e) => e),
      t.inWs((tx) => startRun(tx, agent, othTask)).catch((e) => e),
      t.inWs((tx) => reportProgress(tx, agent, { taskId: othTask, note: "x" })).catch((e) => e),
      t.inWs((tx) => addDependency(tx, agent, othTask, taskId)).catch((e) => e),
    ]);
    for (const err of errors) {
      expect(err).toBeInstanceOf(ForbiddenError);
      expect(String(err.message)).not.toMatch(/OTH|secret|plans/);
      expect(String(err.message)).not.toContain(othTask);
    }
  });

  test("tasks of another workspace are not found", async () => {
    const u = await seedUser(t.db, "Eve");
    const ws2 = await createWorkspace(t.db, { name: "Elsewhere", userId: u, displayName: "Eve" });
    const eve: Actor = { kind: "member", workspaceId: ws2.workspaceId, memberId: ws2.memberId };
    await expect(withWorkspace(t.db, ws2.workspaceId, (tx) => getTask(tx, taskId))).rejects.toThrow(NotFoundError);
    await expect(withWorkspace(t.db, ws2.workspaceId, (tx) => setTaskStatus(tx, eve, taskId, "in_progress"))).rejects.toThrow(NotFoundError);
    await expect(withWorkspace(t.db, ws2.workspaceId, (tx) => startRun(tx, eve, taskId))).rejects.toThrow(NotFoundError);
    await expect(t.inWs((tx) => getTask(tx, "not-a-uuid"))).rejects.toThrow(NotFoundError);
  });
});

describe("status and runs", () => {
  test("starting a run moves a todo task to in_progress", async () => {
    await t.inWs((tx) => startRun(tx, t.backendAgent, taskId));
    expect((await t.inWs((tx) => getTask(tx, taskId))).status).toBe("in_progress");
  });

  test("a failed run does not change the task's status", async () => {
    const runId = await t.inWs((tx) => startRun(tx, t.backendAgent, taskId));
    await t.inWs((tx) => finishRun(tx, t.backendAgent, runId, "failed"));
    expect((await t.inWs((tx) => getTask(tx, taskId))).status).toBe("in_progress");
    const [run] = await rawQuery(t.db, `select status, finished_at, actor_kind, actor_id from runs where id = '${runId}'`);
    expect(run).toMatchObject({ status: "failed", actor_kind: "agent", actor_id: t.backendAgent.agentId });
    expect(run.finished_at).not.toBeNull();
  });

  test("a run finishes once, and only its own agent or a member with task.write finishes it", async () => {
    const runId = await t.inWs((tx) => startRun(tx, t.backendAgent, taskId));
    const otherAgent = t.agentOf(t.backendMember, [t.acme]);
    await expect(t.inWs((tx) => finishRun(tx, otherAgent, runId, "succeeded"))).rejects.toThrow(ForbiddenError);
    await expect(t.inWs((tx) => finishRun(tx, t.approver, runId, "succeeded"))).rejects.toThrow(ForbiddenError);
    await expect(t.inWs((tx) => finishRun(tx, t.backendAgent, runId, "running" as any))).rejects.toThrow(ValidationError);
    await t.inWs((tx) => finishRun(tx, t.frontendMember, runId, "cancelled"));
    await expect(t.inWs((tx) => finishRun(tx, t.backendAgent, runId, "succeeded"))).rejects.toThrow(ValidationError);
    await expect(t.inWs((tx) => finishRun(tx, t.backendAgent, newId(), "succeeded"))).rejects.toThrow(NotFoundError);
    const types = (await t.inWs((tx) => listEvents(tx, { projectId: t.acme }))).map((e) => e.type);
    expect(types.filter((x) => x.startsWith("run."))).toEqual(["run.started", "run.finished"]);
  });

  test("only a person with task.accept can mark a task done", async () => {
    await expect(t.inWs((tx) => setTaskStatus(tx, t.backendAgent, taskId, "done"))).rejects.toThrow(ForbiddenError);
    const ownerAgent = t.agentOf(t.owner, [t.acme]);
    await expect(t.inWs((tx) => setTaskStatus(tx, ownerAgent, taskId, "done"))).rejects.toThrow(ForbiddenError);
    await expect(t.inWs((tx) => setTaskStatus(tx, t.backendMember, taskId, "done"))).rejects.toThrow(ForbiddenError);
    await t.inWs((tx) => setTaskStatus(tx, t.backendAgent, taskId, "in_review"));
    await t.inWs((tx) => setTaskStatus(tx, t.approver, taskId, "done"));
    expect((await t.inWs((tx) => getTask(tx, taskId))).status).toBe("done");
    // reopening an accepted task also needs task.accept
    await expect(t.inWs((tx) => setTaskStatus(tx, t.backendMember, taskId, "in_progress"))).rejects.toThrow(ForbiddenError);
    await expect(t.inWs((tx) => startRun(tx, t.backendAgent, taskId))).rejects.toThrow(ValidationError);
    const events = (await t.inWs((tx) => listEvents(tx, { projectId: t.acme }))).filter((e) => e.type === "task.status_changed");
    expect(events.map((e) => e.data)).toEqual([
      { from: "todo", to: "in_review" },
      { from: "in_review", to: "done" },
    ]);
    await expect(t.inWs((tx) => setTaskStatus(tx, t.owner, taskId, "blocked" as any))).rejects.toThrow(ValidationError);
  });
});

describe("dependencies", () => {
  test("a task is blocked while a dependency is not done", async () => {
    const beTask = taskId;
    const feTask = (await task(t.frontendMember, t.acme, "list archived", [beTask])).taskId;
    expect(await t.inWs((tx) => blockedBy(tx, feTask))).toEqual({ dependencies: [beTask], blockers: [] });
    await t.inWs((tx) => setTaskStatus(tx, t.approver, beTask, "done"));
    expect((await t.inWs((tx) => blockedBy(tx, feTask))).dependencies).toEqual([]);
    expect((await t.inWs((tx) => getTask(tx, feTask))).status).toBe("todo");
  });

  test("a dependency cycle is rejected", async () => {
    const a = taskId;
    const b = (await task(t.owner, t.acme, "B")).taskId;
    const c = (await task(t.owner, t.acme, "C", [b])).taskId; // C → B
    await t.inWs((tx) => addDependency(tx, t.owner, a, b)); // A → B
    await expect(t.inWs((tx) => addDependency(tx, t.owner, b, a))).rejects.toThrow(ValidationError); // B → A
    await expect(t.inWs((tx) => addDependency(tx, t.owner, a, a))).rejects.toThrow(ValidationError);
    await t.inWs((tx) => addDependency(tx, t.owner, a, c)); // A → C → B: a diamond, not a cycle
    const x = (await task(t.owner, t.acme, "X", [a])).taskId; // X → A → C → B
    await expect(t.inWs((tx) => addDependency(tx, t.owner, b, x))).rejects.toThrow(ValidationError); // B → X closes it
    expect((await t.inWs((tx) => blockedBy(tx, x))).dependencies).toEqual([a]);
    expect((await t.inWs((tx) => blockedBy(tx, a))).dependencies).toEqual([b, c]);
  });

  test("dependencies stay inside one project and can be removed", async () => {
    const oth = (await task(t.owner, t.other, "other")).taskId;
    await expect(task(t.owner, t.acme, "cross", [oth])).rejects.toThrow(ValidationError);
    await expect(t.inWs((tx) => addDependency(tx, t.owner, taskId, oth))).rejects.toThrow(ValidationError);
    const b = (await task(t.owner, t.acme, "B")).taskId;
    await t.inWs((tx) => addDependency(tx, t.owner, taskId, b));
    await t.inWs((tx) => addDependency(tx, t.owner, taskId, b)); // already there: no-op
    expect((await t.inWs((tx) => blockedBy(tx, taskId))).dependencies).toEqual([b]);
    await t.inWs((tx) => removeDependency(tx, t.owner, taskId, b));
    expect((await t.inWs((tx) => blockedBy(tx, taskId))).dependencies).toEqual([]);
    await t.inWs((tx) => addDependency(tx, t.owner, taskId, b)); // and re-added
    expect((await t.inWs((tx) => blockedBy(tx, taskId))).dependencies).toEqual([b]);
    const types = (await t.inWs((tx) => listEvents(tx, { projectId: t.acme }))).map((e) => e.type);
    expect(types.filter((x) => x.startsWith("task.dependency"))).toEqual([
      "task.dependency_added", "task.dependency_removed", "task.dependency_added",
    ]);
    await expect(t.inWs((tx) => addDependency(tx, t.approver, b, taskId))).rejects.toThrow(ForbiddenError);
  });
});

describe("progress", () => {
  test("progress notes are redacted and evidence is attached", async () => {
    const runId = await t.inWs((tx) => startRun(tx, t.backendAgent, taskId));
    const noteId = await t.inWs((tx) =>
      reportProgress(tx, t.backendAgent, {
        taskId,
        runId,
        note: "pushed with glpat-abcdefghijklmnopqrstuvwx by mistake",
        evidence: [
          { kind: "commit", url: "https://git.example.com/acme/app/-/commit/abc123", externalId: "abc123" },
          { kind: "pipeline_run", url: "https://ci.example.com/runs/9?token=sekrit", version: "9" },
        ],
      }),
    );
    const [note] = await t.inWs((tx) => listProgress(tx, taskId));
    expect(note).toMatchObject({ id: noteId, runId, note: "pushed with [REDACTED] by mistake", actorKind: "agent", actorId: t.backendAgent.agentId });
    const evidence = await t.inWs((tx) => listEvidence(tx, "progress", noteId));
    expect(evidence.map((e) => [e.kind, e.url, e.externalId, e.version, e.projectId])).toEqual([
      ["commit", "https://git.example.com/acme/app/-/commit/abc123", "abc123", null, t.acme],
      ["pipeline_run", "https://ci.example.com/runs/9?token=[REDACTED]", null, "9", t.acme],
    ]);
    const [event] = (await t.inWs((tx) => listEvents(tx, { projectId: t.acme }))).filter((e) => e.type === "task.progress_reported");
    expect(event!.data).toEqual({ progressId: noteId, runId, evidenceIds: evidence.map((e) => e.id) });
    expect(JSON.stringify(event!.data)).not.toMatch(/pushed|https/);
  });

  test("progress input is validated", async () => {
    const otherTask = (await task(t.owner, t.acme, "other")).taskId;
    const otherRun = await t.inWs((tx) => startRun(tx, t.owner, otherTask));
    const bad: Parameters<typeof reportProgress>[2][] = [
      { taskId, note: "  " },
      { taskId, note: "x".repeat(10_001) },
      { taskId, note: "x", runId: otherRun },
      { taskId, note: "x", evidence: [{ kind: "commit", url: "ftp://example.com/x" }] },
      { taskId, note: "x", evidence: [{ kind: "commit", url: "javascript:alert(1)" }] },
      { taskId, note: "x", evidence: [{ kind: "commit", url: "https://user:pw@example.com/x" }] },
      { taskId, note: "x", evidence: [{ kind: "commit", url: "https://example.com\\@evil.com/" }] },
      { taskId, note: "x", evidence: [{ kind: "commit", url: "https://example.com/" + "a".repeat(2100) }] },
      { taskId, note: "x", evidence: [{ kind: "nope" as any, url: "https://example.com/" }] },
      { taskId, note: "x", evidence: [{ kind: "commit", url: "https://example.com/", externalId: "x".repeat(300) }] },
      { taskId, note: "x", evidence: [{ kind: "commit", url: "https://example.com/", connectionId: "nope" }] },
      { taskId, note: "x", evidence: Array.from({ length: 21 }, () => ({ kind: "file" as const, url: "https://example.com/" })) },
    ];
    for (const input of bad) {
      await expect(t.inWs((tx) => reportProgress(tx, t.owner, input)), JSON.stringify(input).slice(0, 100)).rejects.toThrow(ValidationError);
    }
    await expect(t.inWs((tx) => reportProgress(tx, t.owner, { taskId: newId(), note: "x" }))).rejects.toThrow(NotFoundError);
  });

  test("evidence and progress notes are append-only for the app", async () => {
    const noteId = await t.inWs((tx) =>
      reportProgress(tx, t.owner, { taskId, note: "x", evidence: [{ kind: "file", url: "https://example.com/f" }] }),
    );
    await expect(t.inWs((tx) => tx.execute(sql.raw(`update evidence set url = 'https://evil.example.com/'`)))).rejects.toThrow();
    await expect(t.inWs((tx) => tx.execute(sql.raw(`delete from evidence`)))).rejects.toThrow();
    await expect(t.inWs((tx) => tx.execute(sql.raw(`update progress_notes set note = 'x'`)))).rejects.toThrow();
    expect(await t.inWs((tx) => listEvidence(tx, "progress", noteId))).toHaveLength(1);
    await expect(assertAllTablesHaveForcedRls(t.db)).resolves.toBeUndefined();
  });
});
