import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, test } from "vitest";
import { type Db, type Tx, withWorkspace } from "./db/client.js";
import { assertAllTablesHaveForcedRls, createTestDb, rawQuery, seedUser } from "./db/testing.js";
import { listEvents } from "./events.js";
import { newId } from "./ids.js";
import { createProject } from "./projects.js";
import {
  addMember,
  archiveRole,
  can,
  createWorkspace,
  listMembers,
  listRoles,
  membersWithRole,
  removeMember,
  requirePermission,
  restoreRole,
  ROLE_TEMPLATES,
  setMemberRoles,
  upsertRole,
} from "./tenancy.js";
import { type Actor, ForbiddenError, HUMAN_ONLY, NotFoundError, type Permission, ValidationError } from "./types.js";

let db: Db;
let userId: string;
let workspaceId: string;
let memberId: string;
let admin: Actor;
let projectId: string;
let projectA: string;
let projectB: string;

beforeEach(async () => {
  db = await createTestDb();
  userId = await seedUser(db, "Dana");
  ({ workspaceId, memberId } = await createWorkspace(db, { name: "Studio", userId, displayName: "Dana" }));
  admin = { kind: "member", workspaceId, memberId };
  const mk = (key: string) => withWorkspace(db, workspaceId, (tx) => createProject(tx, admin, { key, name: key }));
  projectId = await mk("PRJ");
  projectA = await mk("AAA");
  projectB = await mk("BBB");
});

const check = (actor: Actor, p: Permission, project?: string) =>
  withWorkspace(db, workspaceId, (tx) => can(tx, actor, p, project));

/** Adds a member with the given workspace-wide roles and returns them as an actor. */
async function member(name: string, roleKeys: string[]): Promise<Actor> {
  const uid = await seedUser(db, name);
  const id = await withWorkspace(db, workspaceId, (tx) => addMember(tx, admin, { userId: uid, displayName: name, roleKeys }));
  return { kind: "member", workspaceId, memberId: id };
}

function memberIdOf(actor: Actor): string {
  if (actor.kind !== "member") throw new Error("not a member");
  return actor.memberId;
}

describe("workspaces, members, roles and permissions", () => {
  test("the creator of a workspace holds every role", async () => {
    const { workspaceId, memberId } = await createWorkspace(db, { name: "Solo", userId, displayName: "Dana" });
    const actor: Actor = { kind: "member", workspaceId, memberId };
    for (const p of ["requirement.approve", "handoff.ack", "workspace.admin", "task.write"] as const)
      expect(await withWorkspace(db, workspaceId, (tx) => can(tx, actor, p))).toBe(true);
    const members = await withWorkspace(db, workspaceId, (tx) => listMembers(tx));
    expect(members).toHaveLength(1);
    expect(members[0]!.roles.map((r) => r.key).sort()).toEqual(Object.keys(ROLE_TEMPLATES).sort());
    expect(members[0]!.roles.every((r) => r.projectId === null)).toBe(true);
  });

  test("creating a workspace records workspace.created in that workspace", async () => {
    const events = await withWorkspace(db, workspaceId, (tx) => listEvents(tx, {}));
    expect(events.map((e) => e.type)[0]).toBe("workspace.created");
    expect(events.filter((e) => e.type !== "project.created")).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorKind: "member", actorId: memberId, subjectId: workspaceId });
  });

  test("an agent never gets a human-only permission, even when its member has it", async () => {
    const agent: Actor = { kind: "agent", workspaceId, memberId, agentId: newId(), projectIds: [projectId] };
    for (const p of HUMAN_ONLY)
      expect(await withWorkspace(db, workspaceId, (tx) => can(tx, agent, p, projectId))).toBe(false);
    expect(await withWorkspace(db, workspaceId, (tx) => can(tx, agent, "handoff.create", projectId))).toBe(true);
  });

  test("an agent is refused outside its projects", async () => {
    const agent: Actor = { kind: "agent", workspaceId, memberId, agentId: newId(), projectIds: [projectA] };
    expect(await withWorkspace(db, workspaceId, (tx) => can(tx, agent, "project.read", projectB))).toBe(false);
    expect(await withWorkspace(db, workspaceId, (tx) => can(tx, agent, "project.read", projectA))).toBe(true);
  });

  test("a connection may only write blockers", async () => {
    const conn: Actor = { kind: "connection", workspaceId, connectionId: newId() };
    expect(await check(conn, "blocker.write", projectA)).toBe(true);
    expect(await check(conn, "task.write", projectA)).toBe(false);
    expect(await check(conn, "project.read", projectA)).toBe(false);
  });

  test("role templates grant exactly the documented permissions", async () => {
    expect([...ROLE_TEMPLATES.approver].sort()).toEqual(["decision.approve", "decision.propose", "project.read",
      "requirement.approve", "requirement.propose", "task.accept"]);
    expect([...ROLE_TEMPLATES.frontend].sort()).toEqual(["blocker.write", "contract.ack", "decision.propose", "handoff.ack",
      "handoff.create", "project.read", "requirement.propose", "task.write"]);
    for (const k of ["pm", "lead", "backend"] as const)
      expect([...ROLE_TEMPLATES[k]].sort()).toEqual([...ROLE_TEMPLATES.frontend].sort());
    expect(ROLE_TEMPLATES.owner).toHaveLength(12);
  });

  test("roles can only be scoped to existing, active projects", async () => {
    const dev = await member("Sam", []);
    const set = (roleKeys: string[], project: string) =>
      withWorkspace(db, workspaceId, (tx) => setMemberRoles(tx, admin, { memberId: memberIdOf(dev), roleKeys, projectId: project }));
    await expect(set(["frontend"], newId())).rejects.toThrow(NotFoundError);
    await expect(set(["frontend"], "nope")).rejects.toThrow(NotFoundError);
    await set(["frontend"], projectA);
    await rawQuery(db, `update projects set archived_at = now() where id = '${projectA}'`);
    await expect(set(["backend"], projectA)).rejects.toThrow(NotFoundError);
    await set([], projectA); // clearing stays possible
  });

  test("a project-scoped role does not apply to other projects", async () => {
    const dev = await member("Ari", []);
    await withWorkspace(db, workspaceId, (tx) =>
      setMemberRoles(tx, admin, { memberId: memberIdOf(dev), roleKeys: ["frontend"], projectId: projectA }));
    expect(await check(dev, "task.write", projectA)).toBe(true);
    expect(await check(dev, "task.write", projectB)).toBe(false);
    expect(await check(dev, "task.write")).toBe(false);
    const holders = await withWorkspace(db, workspaceId, async (tx) => {
      const fe = (await listRoles(tx)).find((r) => r.key === "frontend")!;
      return [await membersWithRole(tx, fe.id, projectA), await membersWithRole(tx, fe.id, projectB)];
    });
    expect(holders[0]!.map((m) => m.displayName).sort()).toEqual(["Ari", "Dana"]);
    expect(holders[1]!.map((m) => m.displayName)).toEqual(["Dana"]);
  });

  test("only workspace.admin can add members or edit roles", async () => {
    const dev = await member("Ben", ["backend"]);
    const uid = await seedUser(db, "Cy");
    await expect(withWorkspace(db, workspaceId, (tx) =>
      addMember(tx, dev, { userId: uid, displayName: "Cy", roleKeys: [] }))).rejects.toThrow(ForbiddenError);
    await expect(withWorkspace(db, workspaceId, (tx) =>
      upsertRole(tx, dev, { key: "qa", name: "QA", permissions: ["blocker.write"] }))).rejects.toThrow(ForbiddenError);
    await expect(withWorkspace(db, workspaceId, (tx) =>
      setMemberRoles(tx, dev, { memberId: memberIdOf(dev), roleKeys: ["owner"] }))).rejects.toThrow(ForbiddenError);
    await expect(withWorkspace(db, workspaceId, (tx) =>
      removeMember(tx, dev, memberId))).rejects.toThrow(ForbiddenError);
    await expect(withWorkspace(db, workspaceId, (tx) =>
      requirePermission(tx, dev, "workspace.admin"))).rejects.toThrow(ForbiddenError);
  });

  test("an agent of an admin cannot administer the workspace", async () => {
    const agent: Actor = { kind: "agent", workspaceId, memberId, agentId: newId(), projectIds: [] };
    await expect(withWorkspace(db, workspaceId, (tx) =>
      upsertRole(tx, agent, { key: "qa", name: "QA", permissions: ["blocker.write"] }))).rejects.toThrow(ForbiddenError);
  });

  test("a custom role works like a template", async () => {
    const roleId = await withWorkspace(db, workspaceId, (tx) =>
      upsertRole(tx, admin, { key: "qa", name: "Quality", permissions: ["blocker.write"] }));
    const qa = await member("Quinn", ["qa"]);
    expect(await check(qa, "blocker.write", projectA)).toBe(true);
    expect(await check(qa, "task.write", projectA)).toBe(false);
    const roles = await withWorkspace(db, workspaceId, (tx) => listRoles(tx));
    expect(roles.find((r) => r.key === "qa")).toEqual({
      id: roleId, key: "qa", name: "Quality", permissions: ["blocker.write"], archived: false, memberCount: 1,
    });
    const types = (await withWorkspace(db, workspaceId, (tx) => listEvents(tx, { limit: 200 }))).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["role.upserted", "member.added"]));
  });

  test("role keys and permissions are validated", async () => {
    for (const key of ["QA", "q", "1qa", "qa-team", "a".repeat(32)])
      await expect(withWorkspace(db, workspaceId, (tx) =>
        upsertRole(tx, admin, { key, name: "x", permissions: [] }))).rejects.toThrow(ValidationError);
    await expect(withWorkspace(db, workspaceId, (tx) =>
      upsertRole(tx, admin, { key: "qa", name: "x", permissions: ["root" as Permission] }))).rejects.toThrow(ValidationError);
    await expect(withWorkspace(db, workspaceId, (tx) =>
      setMemberRoles(tx, admin, { memberId, roleKeys: ["owner", "nope"] }))).rejects.toThrow(ValidationError);
  });

  test("a member can hold several roles and gets the union of their permissions", async () => {
    const m = await member("Mo", []);
    await withWorkspace(db, workspaceId, (tx) =>
      setMemberRoles(tx, admin, { memberId: memberIdOf(m), roleKeys: ["frontend", "approver"] }));
    expect(await check(m, "task.write")).toBe(true);
    expect(await check(m, "requirement.approve")).toBe(true);
    expect(await check(m, "workspace.admin")).toBe(false);
    // Setting again replaces the set for that scope.
    await withWorkspace(db, workspaceId, (tx) =>
      setMemberRoles(tx, admin, { memberId: memberIdOf(m), roleKeys: ["approver"] }));
    expect(await check(m, "task.write")).toBe(false);
    expect(await check(m, "requirement.approve")).toBe(true);
  });

  test("editing a role's permissions takes effect on the next check", async () => {
    const dev = await member("Eve", ["frontend"]);
    expect(await check(dev, "task.accept")).toBe(false);
    await withWorkspace(db, workspaceId, (tx) =>
      upsertRole(tx, admin, { key: "frontend", name: "Front end", permissions: ["project.read", "task.accept"] }));
    expect(await check(dev, "task.accept")).toBe(true);
    expect(await check(dev, "task.write")).toBe(false);
  });

  test("an archived role grants nothing and can be restored", async () => {
    const dev = await member("Fay", ["frontend"]);
    const fe = (await withWorkspace(db, workspaceId, (tx) => listRoles(tx))).find((r) => r.key === "frontend")!;
    await withWorkspace(db, workspaceId, (tx) => archiveRole(tx, admin, fe.id));
    expect(await check(dev, "task.write")).toBe(false);
    const after = await withWorkspace(db, workspaceId, async (tx) => ({
      role: (await listRoles(tx)).find((r) => r.id === fe.id),
      holders: await membersWithRole(tx, fe.id, projectA),
    }));
    expect(after.role?.archived).toBe(true);
    expect(after.holders).toEqual([]);
    await expect(withWorkspace(db, workspaceId, (tx) =>
      setMemberRoles(tx, admin, { memberId: memberIdOf(dev), roleKeys: ["frontend"] }))).rejects.toThrow(ValidationError);
    await withWorkspace(db, workspaceId, (tx) => restoreRole(tx, admin, fe.id));
    expect(await check(dev, "task.write")).toBe(true);
    const types = (await withWorkspace(db, workspaceId, (tx) => listEvents(tx, { limit: 200 }))).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["role.archived", "role.restored"]));
  });

  test("the last member holding workspace.admin cannot be removed or lose that permission", async () => {
    const run = <T>(fn: Parameters<typeof withWorkspace<T>>[2]) => withWorkspace(db, workspaceId, fn);
    await expect(run((tx) => removeMember(tx, admin, memberId))).rejects.toThrow(ValidationError);
    await expect(run((tx) => setMemberRoles(tx, admin, { memberId, roleKeys: ["frontend"] }))).rejects.toThrow(ValidationError);
    await expect(run((tx) => upsertRole(tx, admin, { key: "owner", name: "Owner", permissions: ["project.read"] })))
      .rejects.toThrow(ValidationError);
    const ownerId = (await run((tx) => listRoles(tx))).find((r) => r.key === "owner")!.id;
    await expect(run((tx) => archiveRole(tx, admin, ownerId))).rejects.toThrow(ValidationError);
    // A refused change leaves nothing behind, even when the caller carries on in the same transaction.
    await run(async (tx) => {
      await expect(removeMember(tx, admin, memberId)).rejects.toThrow(ValidationError);
      expect(await can(tx, admin, "workspace.admin")).toBe(true);
    });
    expect(await check(admin, "workspace.admin")).toBe(true);
    // A project-scoped owner role does not count as a workspace admin.
    const other = await member("Gus", []);
    await run((tx) => setMemberRoles(tx, admin, { memberId: memberIdOf(other), roleKeys: ["owner"], projectId: projectA }));
    await expect(run((tx) => removeMember(tx, admin, memberId))).rejects.toThrow(ValidationError);
    // Once someone else is an admin, the first one can go.
    await run((tx) => setMemberRoles(tx, admin, { memberId: memberIdOf(other), roleKeys: ["owner"] }));
    await run((tx) => removeMember(tx, admin, memberId));
    expect(await check(other, "workspace.admin")).toBe(true);
  });

  test("a removed member has no permissions", async () => {
    const dev = await member("Hal", ["frontend"]);
    expect(await check(dev, "project.read")).toBe(true);
    await withWorkspace(db, workspaceId, (tx) => removeMember(tx, admin, memberIdOf(dev)));
    expect(await check(dev, "project.read")).toBe(false);
    const agent: Actor = { kind: "agent", workspaceId, memberId: memberIdOf(dev), agentId: newId(), projectIds: [projectA] };
    expect(await check(agent, "project.read", projectA)).toBe(false);
    const listed = (await withWorkspace(db, workspaceId, (tx) => listMembers(tx))).find((m) => m.displayName === "Hal");
    expect(listed?.status).toBe("removed");
    const types = (await withWorkspace(db, workspaceId, (tx) => listEvents(tx, { limit: 200 }))).map((e) => e.type);
    expect(types).toContain("member.removed");
  });

  test("a member of one workspace has no permissions in another", async () => {
    const other = await createWorkspace(db, { name: "Other", userId, displayName: "Dana" });
    const foreign: Actor = { kind: "member", workspaceId, memberId: other.memberId };
    expect(await check(foreign, "project.read")).toBe(false);
  });

  test("tenancy tables are scoped by forced row-level security", async () => {
    await assertAllTablesHaveForcedRls(db);
    const other = await createWorkspace(db, { name: "Other", userId, displayName: "Dana" });
    const seen = await withWorkspace(db, other.workspaceId, (tx) => listMembers(tx));
    expect(seen.map((m) => m.memberId)).toEqual([other.memberId]);
    // Users are account data: invisible inside a workspace transaction.
    const rows = await withWorkspace(db, workspaceId, (tx) => tx.execute("select count(*)::int as n from users"));
    expect((rows as unknown as { rows: { n: number }[] }).rows[0]!.n).toBe(0);
    expect((await rawQuery(db, "select count(*)::int as n from users"))[0].n).toBe(1);
  });

  test("guarded changes lock the workspace row so concurrent admin changes serialise", async () => {
    // PGlite has one connection, so blocking cannot be shown; check the lock is taken, and runs.
    const dev = await member("Ida", ["frontend"]);
    const dialect = new PgDialect();
    const statements: string[] = [];
    const bound = <T extends object>(target: T, wrap: (key: PropertyKey, value: any) => any) =>
      new Proxy(target, {
        get(t, key) {
          const value = Reflect.get(t, key, t);
          return typeof value === "function" ? wrap(key, value.bind(t)) : value;
        },
      });
    await withWorkspace(db, workspaceId, async (tx) => {
      const spy = bound(tx, (key, fn) => key !== "transaction" ? fn
        : (cb: (sp: Tx) => unknown) => fn((sp: Tx) => cb(bound(sp, (k, f) => k !== "execute" ? f
          : (q: SQL) => { statements.push(dialect.sqlToQuery(q).sql); return f(q); }))));
      await setMemberRoles(spy, admin, { memberId: memberIdOf(dev), roleKeys: ["backend"] });
      await removeMember(spy, admin, memberIdOf(dev));
    });
    expect(statements.filter((q) => /from workspaces .*for update/i.test(q))).toHaveLength(2);
    expect(await check(dev, "task.write")).toBe(false);
  });

  test("adding an unknown user fails with NotFoundError and leaves the transaction usable", async () => {
    await withWorkspace(db, workspaceId, async (tx) => {
      await expect(addMember(tx, admin, { userId: newId(), displayName: "Nobody", roleKeys: [] }))
        .rejects.toThrow(NotFoundError);
      await upsertRole(tx, admin, { key: "qa", name: "QA", permissions: ["blocker.write"] });
      expect((await listMembers(tx)).map((m) => m.displayName)).toEqual(["Dana"]);
    });
    expect((await withWorkspace(db, workspaceId, (tx) => listRoles(tx))).some((r) => r.key === "qa")).toBe(true);
  });

  test("upserting an archived role is refused until it is restored", async () => {
    const fe = (await withWorkspace(db, workspaceId, (tx) => listRoles(tx))).find((r) => r.key === "frontend")!;
    await withWorkspace(db, workspaceId, (tx) => archiveRole(tx, admin, fe.id));
    await expect(withWorkspace(db, workspaceId, (tx) =>
      upsertRole(tx, admin, { key: "frontend", name: "FE", permissions: ["project.read"] })))
      .rejects.toThrow(/archived; restore it first/);
    await withWorkspace(db, workspaceId, (tx) => restoreRole(tx, admin, fe.id));
    await expect(withWorkspace(db, workspaceId, (tx) =>
      upsertRole(tx, admin, { key: "frontend", name: "FE", permissions: ["project.read"] }))).resolves.toBe(fe.id);
  });
});
