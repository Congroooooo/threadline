import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import { createAgentToken, resolveAgentToken } from "./auth.js";
import { type Db, withSystem, withWorkspace } from "./db/client.js";
import { invites } from "./db/schema.js";
import { createTestDb, rawQuery, seedUser } from "./db/testing.js";
import { listEvents } from "./events.js";
import { newId } from "./ids.js";
import { acceptInvite, createInvite, revokeInvite } from "./invites.js";
import { hashSecret } from "./tokens.js";
import { addMember, archiveRole, createWorkspace, listMembers, listRoles, removeMember } from "./tenancy.js";
import { type Actor, ForbiddenError, NotFoundError, ValidationError } from "./types.js";

let db: Db;
let workspaceId: string;
let admin: Actor;
let newUser: string;
let otherUser: string;
const projectId = newId();

beforeEach(async () => {
  db = await createTestDb();
  const owner = await seedUser(db, "Dana");
  const ws = await createWorkspace(db, { name: "Studio", userId: owner, displayName: "Dana" });
  workspaceId = ws.workspaceId;
  admin = { kind: "member", workspaceId, memberId: ws.memberId };
  newUser = await seedUser(db, "Sam");
  otherUser = await seedUser(db, "Other");
});

const inWs = <T>(fn: Parameters<typeof withWorkspace<T>>[2]) => withWorkspace(db, workspaceId, fn);
const INVALID = "invite is invalid or expired";

describe("invites", () => {
  test("an invite adds the user with the invite's roles, once", async () => {
    const { code } = await inWs((tx) => createInvite(tx, admin, { roleKeys: ["frontend"] }));
    expect(code).toMatch(/^tli_[A-Za-z0-9_-]{32}$/);
    const { memberId, workspaceId: joined } = await acceptInvite(db, { userId: newUser, displayName: "Sam", code });
    expect(joined).toBe(workspaceId);
    expect((await inWs((tx) => listMembers(tx))).find((m) => m.memberId === memberId)?.roles)
      .toEqual([{ key: "frontend", projectId: null }]);
    await expect(acceptInvite(db, { userId: otherUser, displayName: "X", code })).rejects.toThrow(ValidationError);
    const [row] = await rawQuery(db, "select used_by, used_at from invites");
    expect(row.used_by).toBe(memberId);
    expect(row.used_at).not.toBeNull();
  });

  test("a project invite assigns its roles in that project only", async () => {
    const { code } = await inWs((tx) => createInvite(tx, admin, { roleKeys: ["backend"], projectId }));
    const { memberId } = await acceptInvite(db, { userId: newUser, displayName: "Sam", code });
    expect((await inWs((tx) => listMembers(tx))).find((m) => m.memberId === memberId)?.roles)
      .toEqual([{ key: "backend", projectId }]);
  });

  test("codes are stored only as hashes", async () => {
    const { code } = await inWs((tx) => createInvite(tx, admin, { roleKeys: ["frontend"] }));
    const [row] = await rawQuery(db, "select code_hash from invites");
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.code_hash).not.toContain(code);
    expect(JSON.stringify(await inWs((tx) => listEvents(tx, {})))).not.toContain(code);
  });

  test("expired, revoked and unknown codes are rejected with the same message", async () => {
    const expired = await inWs((tx) => createInvite(tx, admin, { roleKeys: ["frontend"] }));
    await rawQuery(db, `update invites set expires_at = now() - interval '1 second' where id = '${expired.inviteId}'`);
    const revoked = await inWs((tx) => createInvite(tx, admin, { roleKeys: ["frontend"] }));
    await inWs((tx) => revokeInvite(tx, admin, revoked.inviteId));
    const used = await inWs((tx) => createInvite(tx, admin, { roleKeys: ["frontend"] }));
    await acceptInvite(db, { userId: otherUser, displayName: "Other", code: used.code });
    const hashless = await inWs((tx) => createInvite(tx, admin, { roleKeys: ["frontend"] }));
    await rawQuery(db, `update invites set code_hash = null where id = '${hashless.inviteId}'`);

    const codes = [expired.code, revoked.code, used.code, hashless.code, `tli_${"A".repeat(32)}`, "tli_bogus", ""];
    for (const code of codes) {
      const attempt = acceptInvite(db, { userId: newUser, displayName: "Sam", code });
      await expect(attempt).rejects.toThrow(ValidationError);
      await expect(acceptInvite(db, { userId: newUser, displayName: "Sam", code })).rejects.toThrow(INVALID);
    }
    expect((await inWs((tx) => listMembers(tx))).map((m) => m.displayName).sort()).toEqual(["Dana", "Other"]);
  });

  test("accepting when already a member returns the existing membership and does not consume the code", async () => {
    const sam = await inWs((tx) => addMember(tx, admin, { userId: newUser, displayName: "Sam", roleKeys: ["pm"] }));
    const { code } = await inWs((tx) => createInvite(tx, admin, { roleKeys: ["frontend"] }));
    expect(await acceptInvite(db, { userId: newUser, displayName: "Sam", code })).toEqual({ workspaceId, memberId: sam });
    expect(await rawQuery(db, "select used_at from invites")).toEqual([{ used_at: null }]);
    // Roles unchanged, and the code still works for someone else.
    expect((await inWs((tx) => listMembers(tx))).find((m) => m.memberId === sam)?.roles).toEqual([{ key: "pm", projectId: null }]);
    await acceptInvite(db, { userId: otherUser, displayName: "Other", code });
  });

  test("a removed member who accepts an invite is reactivated with the invite's roles only", async () => {
    const sam = await inWs((tx) => addMember(tx, admin, { userId: newUser, displayName: "Sam", roleKeys: ["pm"] }));
    const { token } = await inWs((tx) => createAgentToken(tx, { kind: "member", workspaceId, memberId: sam }, { name: "laptop", projectIds: [projectId] }));
    await inWs((tx) => removeMember(tx, admin, sam));
    const { code } = await inWs((tx) => createInvite(tx, admin, { roleKeys: ["frontend"] }));
    expect(await acceptInvite(db, { userId: newUser, displayName: "Sam", code })).toEqual({ workspaceId, memberId: sam });
    const m = (await inWs((tx) => listMembers(tx))).find((x) => x.memberId === sam)!;
    expect(m).toMatchObject({ status: "active", roles: [{ key: "frontend", projectId: null }] });
    // A token from before the removal stays dead, and its revocation is recorded.
    expect(await resolveAgentToken(db, token)).toBeNull();
    expect(await rawQuery(db, "select count(*)::int as n from agent_identities where revoked_at is null")).toEqual([{ n: 0 }]);
    const revokedEvents = (await inWs((tx) => listEvents(tx, {}))).filter((e) => e.type === "agent_token.revoked");
    expect(revokedEvents).toHaveLength(1);
    expect(revokedEvents[0]).toMatchObject({ actorId: sam, subjectKind: "agent", data: { reason: "member_reactivated" } });
    // New tokens work as usual.
    const fresh = await inWs((tx) => createAgentToken(tx, { kind: "member", workspaceId, memberId: sam }, { name: "laptop", projectIds: [projectId] }));
    expect(await resolveAgentToken(db, fresh.token)).not.toBeNull();
  });

  test("accepting records invite.accepted and member.added by the new member", async () => {
    const { code, inviteId } = await inWs((tx) => createInvite(tx, admin, { roleKeys: ["frontend"] }));
    const { memberId } = await acceptInvite(db, { userId: newUser, displayName: "Sam", code });
    const events = await inWs((tx) => listEvents(tx, {}));
    expect(events.filter((e) => e.subjectId === inviteId).map((e) => e.type)).toEqual(["invite.created", "invite.accepted"]);
    expect(events.find((e) => e.type === "invite.accepted")).toMatchObject({ actorKind: "member", actorId: memberId });
    expect(events.find((e) => e.type === "member.added" && e.subjectId === memberId)).toBeDefined();
  });

  test("two concurrent accepts of one code do not both succeed", async () => {
    const { code } = await inWs((tx) => createInvite(tx, admin, { roleKeys: ["frontend"] }));
    const results = await Promise.allSettled([
      acceptInvite(db, { userId: newUser, displayName: "Sam", code }),
      acceptInvite(db, { userId: otherUser, displayName: "Other", code }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await inWs((tx) => listMembers(tx))).toHaveLength(2);
  });

  test("an invite whose role was archived since cannot be accepted, and the code is not consumed", async () => {
    const { code } = await inWs((tx) => createInvite(tx, admin, { roleKeys: ["frontend"] }));
    const role = (await inWs((tx) => listRoles(tx))).find((r) => r.key === "frontend")!;
    await inWs((tx) => archiveRole(tx, admin, role.id));
    const attempt = acceptInvite(db, { userId: newUser, displayName: "Sam", code });
    await expect(attempt).rejects.toThrow(ValidationError);
    await expect(attempt).rejects.toThrow(new RegExp(`^${INVALID}$`));
    expect(await rawQuery(db, "select used_at from invites")).toEqual([{ used_at: null }]);
    expect(await inWs((tx) => listMembers(tx))).toHaveLength(1);
  });

  test("only workspace.admin can create invites", async () => {
    const sam = await inWs((tx) => addMember(tx, admin, { userId: newUser, displayName: "Sam", roleKeys: ["frontend"] }));
    const samActor: Actor = { kind: "member", workspaceId, memberId: sam };
    await expect(inWs((tx) => createInvite(tx, samActor, { roleKeys: ["frontend"] }))).rejects.toThrow(ForbiddenError);
    const agent: Actor = { kind: "agent", workspaceId, memberId: admin.kind === "member" ? admin.memberId : "", agentId: newId(), projectIds: [projectId] };
    await expect(inWs((tx) => createInvite(tx, agent, { roleKeys: ["frontend"] }))).rejects.toThrow(ForbiddenError);
    const { inviteId } = await inWs((tx) => createInvite(tx, admin, { roleKeys: ["frontend"] }));
    await expect(inWs((tx) => revokeInvite(tx, samActor, inviteId))).rejects.toThrow(ForbiddenError);
  });

  test("invite input is validated", async () => {
    const make = (input: Parameters<typeof createInvite>[2]) => inWs((tx) => createInvite(tx, admin, input));
    await expect(make({ roleKeys: ["nope"] })).rejects.toThrow(ValidationError);
    await expect(make({ roleKeys: ["frontend"], expiresInDays: 31 })).rejects.toThrow(ValidationError);
    await expect(make({ roleKeys: ["frontend"], expiresInDays: 0 })).rejects.toThrow(ValidationError);
    await expect(make({ roleKeys: ["frontend"], expiresInDays: 1.5 })).rejects.toThrow(ValidationError);
    await expect(make({ roleKeys: ["frontend"], projectId: "nope" })).rejects.toThrow(ValidationError);
    await make({ roleKeys: ["frontend"], expiresInDays: 30 });
    const rows = await rawQuery(db, "select round(extract(epoch from expires_at - now()) / 86400)::int as days from invites");
    expect(rows).toEqual([{ days: 30 }]);
    await make({ roleKeys: ["frontend"] });
    expect((await rawQuery(db, "select round(extract(epoch from expires_at - now()) / 86400)::int as days from invites order by days"))[0])
      .toEqual({ days: 7 });
  });

  test("revoking: unknown is NotFound, repeat is a no-op, a used invite cannot be revoked", async () => {
    await expect(inWs((tx) => revokeInvite(tx, admin, newId()))).rejects.toThrow(NotFoundError);
    const a = await inWs((tx) => createInvite(tx, admin, { roleKeys: ["frontend"] }));
    await inWs((tx) => revokeInvite(tx, admin, a.inviteId));
    await inWs((tx) => revokeInvite(tx, admin, a.inviteId));
    const events = await inWs((tx) => listEvents(tx, {}));
    expect(events.filter((e) => e.type === "invite.revoked")).toHaveLength(1);
    const b = await inWs((tx) => createInvite(tx, admin, { roleKeys: ["frontend"] }));
    await acceptInvite(db, { userId: newUser, displayName: "Sam", code: b.code });
    await expect(inWs((tx) => revokeInvite(tx, admin, b.inviteId))).rejects.toThrow(ValidationError);
  });

  test("accepting for an unknown user is NotFound", async () => {
    const { code } = await inWs((tx) => createInvite(tx, admin, { roleKeys: ["frontend"] }));
    await expect(acceptInvite(db, { userId: newId(), displayName: "Ghost", code })).rejects.toThrow(NotFoundError);
  });

  test("invites are hidden from other workspaces and cannot be written under withSystem", async () => {
    await inWs((tx) => createInvite(tx, admin, { roleKeys: ["frontend"] }));
    const owner = await seedUser(db, "Ola");
    const other = await createWorkspace(db, { name: "Agency", userId: owner, displayName: "Ola" });
    expect(await withWorkspace(db, other.workspaceId, (tx) => tx.select().from(invites))).toHaveLength(0);
    await withSystem(db, (tx) => tx.update(invites).set({ roleKeys: ["owner"] }));
    expect(await rawQuery(db, "select role_keys from invites")).toEqual([{ role_keys: ["frontend"] }]);
  });

  test("withSystem reads an invite only by the hash named in app.lookup_hash", async () => {
    const a = await inWs((tx) => createInvite(tx, admin, { roleKeys: ["frontend"] }));
    await inWs((tx) => createInvite(tx, admin, { roleKeys: ["backend"] }));
    expect(await withSystem(db, (tx) => tx.select().from(invites))).toHaveLength(0);
    const lookup = (value: string) =>
      withSystem(db, async (tx) => {
        await tx.execute(sql`select set_config('app.lookup_hash', ${value}, true)`);
        return tx.select({ id: invites.id }).from(invites);
      });
    expect(await lookup("")).toHaveLength(0);
    expect(await lookup(await hashSecret(a.code))).toEqual([{ id: a.inviteId }]);
    // A NULL stored hash never matches, whatever the setting.
    await rawQuery(db, `update invites set code_hash = null where id = '${a.inviteId}'`);
    expect(await lookup(await hashSecret(a.code))).toHaveLength(0);
  });
});
