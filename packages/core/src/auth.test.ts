import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import {
  createAgentToken,
  createSession,
  findOrCreateUser,
  listMemberships,
  resolveAgentToken,
  resolveSession,
  revokeAgentToken,
} from "./auth.js";
import { type Db, withSystem, withWorkspace } from "./db/client.js";
import { agentIdentities } from "./db/schema.js";
import { createTestDb, rawQuery, seedUser } from "./db/testing.js";
import { listEvents } from "./events.js";
import { newId } from "./ids.js";
import { createProject } from "./projects.js";
import { hashSecret } from "./tokens.js";
import { addMember, createWorkspace, removeMember, setMemberRoles } from "./tenancy.js";
import { type Actor, ForbiddenError, NotFoundError, ValidationError } from "./types.js";

let db: Db;
let userId: string;
let workspaceId: string;
let memberId: string;
let member: Actor;
let projectId: string;
let otherProject: string;

beforeEach(async () => {
  db = await createTestDb();
  userId = await seedUser(db, "Dana");
  ({ workspaceId, memberId } = await createWorkspace(db, { name: "Studio", userId, displayName: "Dana" }));
  member = { kind: "member", workspaceId, memberId };
  projectId = await inWs((tx) => createProject(tx, member, { key: "APP", name: "App" }));
  otherProject = await inWs((tx) => createProject(tx, member, { key: "WEB", name: "Web" }));
});

const inWs = <T>(fn: Parameters<typeof withWorkspace<T>>[2]) => withWorkspace(db, workspaceId, fn);

async function teammate(name: string, roleKeys: string[], projectScope?: string): Promise<Actor & { kind: "member" }> {
  const uid = await seedUser(db, name);
  const id = await inWs((tx) => addMember(tx, member, { userId: uid, displayName: name, roleKeys: projectScope ? [] : roleKeys }));
  if (projectScope) await inWs((tx) => setMemberRoles(tx, member, { memberId: id, roleKeys, projectId: projectScope }));
  return { kind: "member", workspaceId, memberId: id };
}

describe("users and sessions", () => {
  test("the same provider identity maps to one user", async () => {
    const a = await findOrCreateUser(db, { provider: "gitlab", providerUserId: "42", displayName: "Sam" });
    const b = await findOrCreateUser(db, { provider: "gitlab", providerUserId: "42", displayName: "Sam B" });
    expect(b).toBe(a);
    const c = await findOrCreateUser(db, { provider: "github", providerUserId: "42", displayName: "Sam" });
    expect(c).not.toBe(a);
    expect(await rawQuery(db, "select count(*)::int as n from users")).toEqual([{ n: 3 }]); // Dana + 2
  });

  test("findOrCreateUser stores the display name and email", async () => {
    const id = await findOrCreateUser(db, { provider: "local", providerUserId: "sam", displayName: " Sam ", email: "sam@example.com" });
    expect(await rawQuery(db, `select display_name, email from users where id = '${id}'`))
      .toEqual([{ display_name: "Sam", email: "sam@example.com" }]);
  });

  test("findOrCreateUser rejects an empty provider user id or display name", async () => {
    await expect(findOrCreateUser(db, { provider: "local", providerUserId: "", displayName: "Sam" })).rejects.toThrow(ValidationError);
    await expect(findOrCreateUser(db, { provider: "local", providerUserId: "x", displayName: "  " })).rejects.toThrow(ValidationError);
    await expect(
      findOrCreateUser(db, { provider: "bitbucket" as "local", providerUserId: "x", displayName: "Sam" }),
    ).rejects.toThrow(ValidationError);
  });

  test("a session resolves until it expires", async () => {
    const { token, expiresAt } = await createSession(db, userId);
    const days = (expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    expect(await resolveSession(db, token)).toEqual({ userId });
    await rawQuery(db, "update sessions set expires_at = now() - interval '1 second'");
    expect(await resolveSession(db, token)).toBeNull();
  });

  test("sessions are stored only as hashes and unknown tokens do not resolve", async () => {
    const { token } = await createSession(db, userId);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await rawQuery(db, "select token_hash from sessions");
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].token_hash).not.toContain(token);
    expect(await resolveSession(db, "A".repeat(43))).toBeNull();
    expect(await resolveSession(db, "")).toBeNull();
  });

  test("listMemberships returns the user's active memberships with workspace names", async () => {
    const second = await createWorkspace(db, { name: "Agency", userId, displayName: "Dana" });
    const other = await seedUser(db, "Other");
    await createWorkspace(db, { name: "Elsewhere", userId: other, displayName: "Other" });
    expect(await listMemberships(db, userId)).toEqual([
      { workspaceId: second.workspaceId, memberId: second.memberId, workspaceName: "Agency" },
      { workspaceId, memberId, workspaceName: "Studio" },
    ]);
    // A removed membership is not listed.
    const sam = await teammate("Sam", ["frontend"]);
    const samUser = (await rawQuery(db, `select user_id from members where id = '${sam.memberId}'`))[0].user_id;
    expect(await listMemberships(db, samUser)).toHaveLength(1);
    await inWs((tx) => removeMember(tx, member, sam.memberId));
    expect(await listMemberships(db, samUser)).toEqual([]);
  });
});

describe("agent tokens", () => {
  test("tokens are stored only as hashes", async () => {
    const { token } = await inWs((tx) => createAgentToken(tx, member, { name: "laptop", projectIds: [projectId] }));
    expect(token).toMatch(/^tl_[A-Za-z0-9_-]{43}$/);
    const rows = await rawQuery(db, "select token_hash from agent_identities");
    expect(rows[0].token_hash).not.toContain(token);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("an agent token resolves to an agent actor scoped to its projects", async () => {
    const { agentId, token } = await inWs((tx) => createAgentToken(tx, member, { name: "laptop", projectIds: [projectId] }));
    expect(await resolveAgentToken(db, token)).toEqual(
      { kind: "agent", workspaceId, memberId, agentId, projectIds: [projectId] });
    const [row] = await rawQuery(db, "select last_used_at from agent_identities");
    expect(row.last_used_at).not.toBeNull();
  });

  test("creating and revoking a token records events without the token", async () => {
    const { agentId, token } = await inWs((tx) => createAgentToken(tx, member, { name: "laptop", projectIds: [projectId] }));
    await inWs((tx) => revokeAgentToken(tx, member, agentId));
    const events = await inWs((tx) => listEvents(tx, {}));
    const mine = events.filter((e) => e.subjectId === agentId);
    expect(mine.map((e) => e.type)).toEqual(["agent_token.created", "agent_token.revoked"]);
    expect(mine[0]).toMatchObject({ actorKind: "member", actorId: memberId, subjectKind: "agent" });
    expect(JSON.stringify(events)).not.toContain(token);
  });

  test("a revoked or unknown token resolves to null", async () => {
    const { agentId, token } = await inWs((tx) => createAgentToken(tx, member, { name: "laptop", projectIds: [projectId] }));
    await inWs((tx) => revokeAgentToken(tx, member, agentId));
    expect(await resolveAgentToken(db, token)).toBeNull();
    expect(await resolveAgentToken(db, "tl_bogus")).toBeNull();
    expect(await resolveAgentToken(db, `tl_${"A".repeat(43)}`)).toBeNull();
    // Revoking again is a no-op; revoking an unknown id is NotFound.
    await inWs((tx) => revokeAgentToken(tx, member, agentId));
    await expect(inWs((tx) => revokeAgentToken(tx, member, newId()))).rejects.toThrow(NotFoundError);
  });

  test("a token with no hash never resolves", async () => {
    const { token } = await inWs((tx) => createAgentToken(tx, member, { name: "laptop", projectIds: [projectId] }));
    await rawQuery(db, "update agent_identities set token_hash = null");
    expect(await resolveAgentToken(db, token)).toBeNull();
  });

  test("a member can only create tokens for projects they can read", async () => {
    const scoped = await teammate("Sam", ["frontend"], projectId);
    const created = await inWs((tx) => createAgentToken(tx, scoped, { name: "laptop", projectIds: [projectId] }));
    expect(created.token).toMatch(/^tl_/);
    await expect(
      inWs((tx) => createAgentToken(tx, scoped, { name: "laptop", projectIds: [projectId, otherProject] })),
    ).rejects.toThrow(ForbiddenError);
    const roleless = await teammate("Kim", []);
    await expect(
      inWs((tx) => createAgentToken(tx, roleless, { name: "laptop", projectIds: [projectId] })),
    ).rejects.toThrow(ForbiddenError);
  });

  test("a token can only name existing, active projects of the workspace", async () => {
    await expect(inWs((tx) => createAgentToken(tx, member, { name: "laptop", projectIds: [newId()] }))).rejects.toThrow(NotFoundError);
    await expect(inWs((tx) => createAgentToken(tx, member, { name: "laptop", projectIds: [projectId, newId()] }))).rejects.toThrow(NotFoundError);
    await rawQuery(db, `update projects set archived_at = now() where id = '${otherProject}'`);
    await expect(inWs((tx) => createAgentToken(tx, member, { name: "laptop", projectIds: [otherProject] }))).rejects.toThrow(NotFoundError);
    const owner2 = await seedUser(db, "Eve");
    const ws2 = await createWorkspace(db, { name: "Other", userId: owner2, displayName: "Eve" });
    const admin2: Actor = { kind: "member", workspaceId: ws2.workspaceId, memberId: ws2.memberId };
    const foreign = await withWorkspace(db, ws2.workspaceId, (tx) => createProject(tx, admin2, { key: "APP", name: "Theirs" }));
    await expect(inWs((tx) => createAgentToken(tx, member, { name: "laptop", projectIds: [foreign] }))).rejects.toThrow(NotFoundError);
    expect(await rawQuery(db, "select count(*)::int as n from agent_identities")).toEqual([{ n: 0 }]);
  });

  test("token input is validated", async () => {
    await expect(inWs((tx) => createAgentToken(tx, member, { name: "laptop", projectIds: [] }))).rejects.toThrow(ValidationError);
    await expect(inWs((tx) => createAgentToken(tx, member, { name: " ", projectIds: [projectId] }))).rejects.toThrow(ValidationError);
    await expect(
      inWs((tx) => createAgentToken(tx, member, { name: "laptop", projectIds: ["not-a-uuid"] })),
    ).rejects.toThrow(ValidationError);
  });

  test("agents cannot create or revoke tokens", async () => {
    const { agentId, token } = await inWs((tx) => createAgentToken(tx, member, { name: "laptop", projectIds: [projectId] }));
    const agent = (await resolveAgentToken(db, token))!;
    await expect(inWs((tx) => createAgentToken(tx, agent, { name: "child", projectIds: [projectId] }))).rejects.toThrow(ForbiddenError);
    await expect(inWs((tx) => revokeAgentToken(tx, agent, agentId))).rejects.toThrow(ForbiddenError);
  });

  test("only the token's member or a workspace admin can revoke it", async () => {
    const sam = await teammate("Sam", ["frontend"]);
    const kim = await teammate("Kim", ["frontend"]);
    const { agentId } = await inWs((tx) => createAgentToken(tx, sam, { name: "laptop", projectIds: [projectId] }));
    await expect(inWs((tx) => revokeAgentToken(tx, kim, agentId))).rejects.toThrow(ForbiddenError);
    await inWs((tx) => revokeAgentToken(tx, member, agentId));
    const second = await inWs((tx) => createAgentToken(tx, sam, { name: "desktop", projectIds: [projectId] }));
    await inWs((tx) => revokeAgentToken(tx, sam, second.agentId));
    expect(await rawQuery(db, "select count(*)::int as n from agent_identities where revoked_at is not null")).toEqual([{ n: 2 }]);
  });

  test("a token stops working when its member is removed", async () => {
    const sam = await teammate("Sam", ["frontend"]);
    const { token } = await inWs((tx) => createAgentToken(tx, sam, { name: "laptop", projectIds: [projectId] }));
    expect(await resolveAgentToken(db, token)).not.toBeNull();
    await inWs((tx) => removeMember(tx, member, sam.memberId));
    expect(await resolveAgentToken(db, token)).toBeNull();
  });

  test("removing a member revokes their tokens, which stay dead when the member is re-added", async () => {
    const sam = await teammate("Sam", ["frontend"]);
    const { agentId, token } = await inWs((tx) => createAgentToken(tx, sam, { name: "laptop", projectIds: [projectId] }));
    await inWs((tx) => removeMember(tx, member, sam.memberId));
    const [row] = await rawQuery(db, `select revoked_at from agent_identities where id = '${agentId}'`);
    expect(row.revoked_at).not.toBeNull();
    const events = (await inWs((tx) => listEvents(tx, {}))).filter((e) => e.type === "agent_token.revoked");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorId: memberId, subjectId: agentId, data: { reason: "member_removed" } });
    const samUser = (await rawQuery(db, `select user_id from members where id = '${sam.memberId}'`))[0].user_id;
    const again = await inWs((tx) => addMember(tx, member, { userId: samUser, displayName: "Sam", roleKeys: ["frontend"] }));
    expect(again).toBe(sam.memberId);
    expect(await resolveAgentToken(db, token)).toBeNull();
  });

  test("agent identities are hidden from other workspaces and cannot be inserted under withSystem", async () => {
    await inWs((tx) => createAgentToken(tx, member, { name: "laptop", projectIds: [projectId] }));
    const other = await createWorkspace(db, { name: "Agency", userId, displayName: "Dana" });
    expect(await withWorkspace(db, other.workspaceId, (tx) => tx.select().from(agentIdentities))).toHaveLength(0);
    await expect(
      withSystem(db, (tx) =>
        tx.insert(agentIdentities).values({ id: newId(), workspaceId, memberId, name: "x", tokenHash: "0".repeat(64), projectIds: [projectId] }),
      ),
    ).rejects.toThrow();
    await expect(
      withSystem(db, (tx) => tx.update(agentIdentities).set({ revokedAt: sql`now()` })),
    ).resolves.toBeDefined();
    // The system update matched nothing: system may read tokens, never change them.
    expect(await rawQuery(db, "select count(*)::int as n from agent_identities where revoked_at is null")).toEqual([{ n: 1 }]);
  });

  test("withSystem reads an agent identity only by the hash named in app.lookup_hash", async () => {
    const a = await inWs((tx) => createAgentToken(tx, member, { name: "laptop", projectIds: [projectId] }));
    await inWs((tx) => createAgentToken(tx, member, { name: "desktop", projectIds: [projectId] }));
    expect(await withSystem(db, (tx) => tx.select().from(agentIdentities))).toHaveLength(0);
    const lookup = (value: string) =>
      withSystem(db, async (tx) => {
        await tx.execute(sql`select set_config('app.lookup_hash', ${value}, true)`);
        return tx.select({ id: agentIdentities.id }).from(agentIdentities);
      });
    expect(await lookup("")).toHaveLength(0);
    expect(await lookup(await hashSecret(a.token))).toEqual([{ id: a.agentId }]);
    await rawQuery(db, `update agent_identities set token_hash = null where id = '${a.agentId}'`);
    expect(await lookup(await hashSecret(a.token))).toHaveLength(0);
  });
});
