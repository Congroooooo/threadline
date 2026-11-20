import { beforeEach, describe, expect, test } from "vitest";
import { createHandoff, getHandoff, respondToHandoff } from "./coordination.js";
import { listEvents } from "./events.js";
import { newId } from "./ids.js";
import { archiveRole, setMemberRoles, upsertRole } from "./tenancy.js";
import { ForbiddenError, NotFoundError, ValidationError } from "./types.js";
import { seedTeam, type Team } from "./work.fixture.js";
import { createTask, listEvidence } from "./work.js";

let t: Team;
let taskId: string;
let frontendRole: string;
let input: Parameters<typeof createHandoff>[2];

beforeEach(async () => {
  t = await seedTeam();
  frontendRole = t.roleIds.frontend!;
  ({ taskId } = await t.inWs((tx) =>
    createTask(tx, t.backendMember, { projectId: t.acme, title: "Archived profiles", ownerRoleId: t.roleIds.backend! }),
  ));
  input = {
    taskId,
    toRoleId: frontendRole,
    delivered: "added `archived` to Profile; helper isVisible in shared",
    requiredAction: "read archived in profile-list.ts",
  };
});

describe("handoffs", () => {
  test("a handoff is pending until a member holding the target role responds", async () => {
    const { handoffId, unassigned, created } = await t.inWs((tx) => createHandoff(tx, t.backendAgent, input));
    expect({ unassigned, created }).toEqual({ unassigned: false, created: true });
    expect(await t.inWs((tx) => getHandoff(tx, handoffId))).toMatchObject({
      status: "pending",
      projectId: t.acme,
      taskId,
      fromActorKind: "agent",
      fromActorId: t.backendAgent.agentId,
      toRoleId: frontendRole,
      delivered: input.delivered,
      requiredAction: input.requiredAction,
      knownLimits: null,
      respondedBy: null,
    });
    await expect(t.inWs((tx) => respondToHandoff(tx, t.backendMember, { handoffId, response: "accepted" }))).rejects.toThrow(ForbiddenError);
    // handoff.ack alone is not enough without the target role (approver has neither)
    await expect(t.inWs((tx) => respondToHandoff(tx, t.approver, { handoffId, response: "accepted" }))).rejects.toThrow(ForbiddenError);
    expect((await t.inWs((tx) => getHandoff(tx, handoffId))).status).toBe("pending");
    await t.inWs((tx) => respondToHandoff(tx, t.frontendMember, { handoffId, response: "accepted" }));
    expect(await t.inWs((tx) => getHandoff(tx, handoffId))).toMatchObject({
      status: "accepted",
      respondedBy: t.frontendMember.memberId,
      responseNote: null,
    });
  });

  test("a project-scoped holder of the target role may respond, in that project only", async () => {
    const scoped = await t.member("Pia", ["frontend"], t.acme);
    const { handoffId } = await t.inWs((tx) => createHandoff(tx, t.backendAgent, input));
    await t.inWs((tx) => respondToHandoff(tx, scoped, { handoffId, response: "accepted" }));

    const othTask = (await t.inWs((tx) => createTask(tx, t.owner, { projectId: t.other, title: "x", ownerRoleId: t.roleIds.backend! }))).taskId;
    const oth = await t.inWs((tx) => createHandoff(tx, t.backendMember, { ...input, taskId: othTask }));
    await expect(t.inWs((tx) => respondToHandoff(tx, scoped, { handoffId: oth.handoffId, response: "accepted" }))).rejects.toThrow(ForbiddenError);
  });

  test("an agent cannot respond to a handoff, even its owner's", async () => {
    const { handoffId } = await t.inWs((tx) => createHandoff(tx, t.backendAgent, input));
    await expect(t.inWs((tx) => respondToHandoff(tx, t.frontendAgent, { handoffId, response: "accepted" }))).rejects.toThrow(ForbiddenError);
    const ownerAgent = t.agentOf(t.owner, [t.acme]);
    await expect(t.inWs((tx) => respondToHandoff(tx, ownerAgent, { handoffId, response: "needs_changes", note: "x" }))).rejects.toThrow(ForbiddenError);
    expect((await t.inWs((tx) => getHandoff(tx, handoffId))).status).toBe("pending");
  });

  test("retrying with the same idempotency key returns the same handoff", async () => {
    const a = await t.inWs((tx) => createHandoff(tx, t.backendAgent, { ...input, idempotencyKey: "k1" }));
    const b = await t.inWs((tx) => createHandoff(tx, t.backendAgent, { ...input, idempotencyKey: "k1" }));
    expect(a.created).toBe(true);
    expect(b).toEqual({ handoffId: a.handoffId, unassigned: false, created: false });
    // A different payload under the same key still returns the original, unchanged.
    const c = await t.inWs((tx) => createHandoff(tx, t.backendAgent, { ...input, delivered: "else", idempotencyKey: "k1" }));
    expect(c.handoffId).toBe(a.handoffId);
    expect((await t.inWs((tx) => getHandoff(tx, a.handoffId))).delivered).toBe(input.delivered);
    // A retry inside a longer transaction leaves it usable.
    await t.inWs(async (tx) => {
      expect((await createHandoff(tx, t.backendAgent, { ...input, idempotencyKey: "k1" })).created).toBe(false);
      await createHandoff(tx, t.backendAgent, { ...input, idempotencyKey: "k2" });
    });
    const created = (await t.inWs((tx) => listEvents(tx, { projectId: t.acme }))).filter((e) => e.type === "handoff.created");
    expect(created).toHaveLength(2);
    // the reported unassigned flag is the current one
    await t.inWs((tx) => setMemberRoles(tx, t.owner, { memberId: t.frontendMember.memberId, roleKeys: [] }));
    await t.inWs((tx) => setMemberRoles(tx, t.owner, { memberId: t.owner.memberId, roleKeys: ["owner"] }));
    expect(await t.inWs((tx) => createHandoff(tx, t.backendAgent, { ...input, idempotencyKey: "k1" }))).toEqual({
      handoffId: a.handoffId,
      unassigned: true,
      created: false,
    });
  });

  test("an idempotency key used in another project is not reused or revealed", async () => {
    const othTask = (await t.inWs((tx) => createTask(tx, t.owner, { projectId: t.other, title: "x", ownerRoleId: t.roleIds.backend! }))).taskId;
    const oth = await t.inWs((tx) => createHandoff(tx, t.owner, { ...input, taskId: othTask, idempotencyKey: "shared" }));
    const err = await t.inWs((tx) => createHandoff(tx, t.backendAgent, { ...input, idempotencyKey: "shared" })).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(String(err.message)).not.toContain(oth.handoffId);
    await expect(t.inWs((tx) => createHandoff(tx, t.backendAgent, { ...input, idempotencyKey: "x".repeat(201) }))).rejects.toThrow(ValidationError);
    await expect(t.inWs((tx) => createHandoff(tx, t.backendAgent, { ...input, idempotencyKey: "" }))).rejects.toThrow(ValidationError);
  });

  test("a handoff to a role nobody holds is created and flagged unassigned", async () => {
    const emptyRole = await t.inWs((tx) => upsertRole(tx, t.owner, { key: "qa", name: "QA", permissions: ["project.read", "handoff.ack"] }));
    const r = await t.inWs((tx) => createHandoff(tx, t.backendAgent, { ...input, toRoleId: emptyRole }));
    expect(r).toMatchObject({ unassigned: true, created: true });
    const [event] = (await t.inWs((tx) => listEvents(tx, { projectId: t.acme }))).filter((e) => e.type === "handoff.created");
    expect(event!.data).toEqual({ taskId, toRoleId: emptyRole, unassigned: true, evidenceIds: [] });
    // a role held only in another project counts as unassigned here
    const other = await t.member("Oz", ["qa"], t.other);
    expect(other.memberId).toBeTruthy();
    expect((await t.inWs((tx) => createHandoff(tx, t.backendAgent, { ...input, toRoleId: emptyRole }))).unassigned).toBe(true);
  });

  test("the target role must be an active role of the workspace", async () => {
    await expect(t.inWs((tx) => createHandoff(tx, t.backendAgent, { ...input, toRoleId: newId() }))).rejects.toThrow(ValidationError);
    await expect(t.inWs((tx) => createHandoff(tx, t.backendAgent, { ...input, toRoleId: "frontend" }))).rejects.toThrow(ValidationError);
    const qa = await t.inWs((tx) => upsertRole(tx, t.owner, { key: "qa", name: "QA", permissions: [] }));
    await t.inWs((tx) => archiveRole(tx, t.owner, qa));
    await expect(t.inWs((tx) => createHandoff(tx, t.backendAgent, { ...input, toRoleId: qa }))).rejects.toThrow(ValidationError);
  });

  test("creating a handoff needs handoff.create in the task's project", async () => {
    await expect(t.inWs((tx) => createHandoff(tx, t.approver, input))).rejects.toThrow(ForbiddenError);
    const othAgent = t.agentOf(t.backendMember, [t.other]);
    const err = await t.inWs((tx) => createHandoff(tx, othAgent, input)).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(String(err.message)).not.toContain("ACME");
    await expect(t.inWs((tx) => createHandoff(tx, t.backendAgent, { ...input, taskId: newId() }))).rejects.toThrow(NotFoundError);
  });

  test("free text is cleaned and evidence is attached to the handoff", async () => {
    const { handoffId } = await t.inWs((tx) =>
      createHandoff(tx, t.backendAgent, {
        ...input,
        delivered: "done; token=abc123def",
        requiredAction: "use glpat-abcdefghijklmnopqrstuvwx",
        knownLimits: "x",
        evidence: [{ kind: "change_request", url: "https://git.example.com/acme/app/-/merge_requests/7", externalId: "7" }],
      }),
    );
    expect(await t.inWs((tx) => getHandoff(tx, handoffId))).toMatchObject({
      delivered: "done; token=[REDACTED]",
      requiredAction: "use [REDACTED]",
      knownLimits: "x",
    });
    const evidence = await t.inWs((tx) => listEvidence(tx, "handoff", handoffId));
    expect(evidence.map((e) => [e.kind, e.externalId])).toEqual([["change_request", "7"]]);
    for (const bad of [{ delivered: " " }, { requiredAction: "" }, { knownLimits: "x".repeat(10_001) }]) {
      await expect(t.inWs((tx) => createHandoff(tx, t.backendAgent, { ...input, ...bad }))).rejects.toThrow(ValidationError);
    }
  });

  test("a solo member can hand off to a role they hold and acknowledge it", async () => {
    const { handoffId, unassigned } = await t.inWs((tx) => createHandoff(tx, t.owner, { ...input, toRoleId: t.roleIds.lead! }));
    expect(unassigned).toBe(false);
    await t.inWs((tx) => respondToHandoff(tx, t.owner, { handoffId, response: "accepted", note: "thanks" }));
    expect(await t.inWs((tx) => getHandoff(tx, handoffId))).toMatchObject({
      status: "accepted",
      respondedBy: t.owner.memberId,
      responseNote: "thanks",
    });
  });

  test("needs_changes requires a note and a responded handoff cannot be answered twice", async () => {
    const { handoffId } = await t.inWs((tx) => createHandoff(tx, t.backendAgent, input));
    await expect(t.inWs((tx) => respondToHandoff(tx, t.frontendMember, { handoffId, response: "needs_changes" }))).rejects.toThrow(ValidationError);
    await expect(t.inWs((tx) => respondToHandoff(tx, t.frontendMember, { handoffId, response: "needs_changes", note: "  " }))).rejects.toThrow(ValidationError);
    await expect(t.inWs((tx) => respondToHandoff(tx, t.frontendMember, { handoffId, response: "maybe" as any }))).rejects.toThrow(ValidationError);
    await t.inWs((tx) =>
      respondToHandoff(tx, t.frontendMember, { handoffId, response: "needs_changes", note: "missing field; password=hunter2" }),
    );
    expect(await t.inWs((tx) => getHandoff(tx, handoffId))).toMatchObject({
      status: "needs_changes",
      responseNote: "missing field; password=[REDACTED]",
    });
    await expect(t.inWs((tx) => respondToHandoff(tx, t.frontendMember, { handoffId, response: "accepted" }))).rejects.toThrow(ValidationError);
    await expect(t.inWs((tx) => respondToHandoff(tx, t.owner, { handoffId, response: "needs_changes", note: "x" }))).rejects.toThrow(ValidationError);
    await expect(t.inWs((tx) => respondToHandoff(tx, t.owner, { handoffId: newId(), response: "accepted" }))).rejects.toThrow(NotFoundError);
    await expect(t.inWs((tx) => getHandoff(tx, "nope"))).rejects.toThrow(NotFoundError);
  });

  test("each of create, respond writes one event", async () => {
    const { handoffId } = await t.inWs((tx) => createHandoff(tx, t.backendAgent, input));
    await t.inWs((tx) => respondToHandoff(tx, t.frontendMember, { handoffId, response: "accepted", note: "secret note" }));
    const second = await t.inWs((tx) => createHandoff(tx, t.backendAgent, input));
    await t.inWs((tx) => respondToHandoff(tx, t.frontendMember, { handoffId: second.handoffId, response: "needs_changes", note: "n" }));
    const events = (await t.inWs((tx) => listEvents(tx, { projectId: t.acme }))).filter((e) => e.subjectKind === "handoff");
    expect(events.map((e) => [e.type, e.subjectId, e.actorKind])).toEqual([
      ["handoff.created", handoffId, "agent"],
      ["handoff.accepted", handoffId, "member"],
      ["handoff.created", second.handoffId, "agent"],
      ["handoff.needs_changes", second.handoffId, "member"],
    ]);
    expect(events[1]!.data).toEqual({ taskId, toRoleId: frontendRole, status: "accepted" });
    const all = JSON.stringify(events.map((e) => e.data));
    expect(all).not.toMatch(/archived|secret note|profile-list/);
  });
});
