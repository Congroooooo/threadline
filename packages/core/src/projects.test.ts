import { beforeEach, describe, expect, test } from "vitest";
import { type Db, withWorkspace } from "./db/client.js";
import { assertAllTablesHaveForcedRls, createTestDb, rawQuery, seedUser } from "./db/testing.js";
import { listEvents } from "./events.js";
import { newId } from "./ids.js";
import { createProject, findProjectByRepoUrl, getProject, normalizeRepoUrl, updateProjectConfig } from "./projects.js";
import { addMember, createWorkspace, setMemberRoles } from "./tenancy.js";
import { type Actor, ForbiddenError, NotFoundError, ValidationError } from "./types.js";

let db: Db;
let workspaceId: string;
let admin: Actor & { kind: "member" };

beforeEach(async () => {
  db = await createTestDb();
  const owner = await seedUser(db, "Dana");
  const ws = await createWorkspace(db, { name: "Studio", userId: owner, displayName: "Dana" });
  workspaceId = ws.workspaceId;
  admin = { kind: "member", workspaceId, memberId: ws.memberId };
});

const inWs = <T>(fn: Parameters<typeof withWorkspace<T>>[2]) => withWorkspace(db, workspaceId, fn);
const hook = "https://chat.example.com/hooks/abc123secret";

async function member(roleKeys: string[], projectId?: string): Promise<Actor & { kind: "member" }> {
  const uid = await seedUser(db, "Sam");
  const id = await inWs((tx) => addMember(tx, admin, { userId: uid, displayName: "Sam", roleKeys: projectId ? [] : roleKeys }));
  if (projectId) await inWs((tx) => setMemberRoles(tx, admin, { memberId: id, roleKeys, projectId }));
  return { kind: "member", workspaceId, memberId: id };
}

describe("normalizeRepoUrl", () => {
  test("ssh and https forms of a repository URL match", () => {
    const want = "gitlab.example.com/acme/app";
    expect(normalizeRepoUrl("git@gitlab.example.com:acme/app.git")).toBe(want);
    expect(normalizeRepoUrl("https://gitlab.example.com/acme/app")).toBe(want);
    expect(normalizeRepoUrl("https://oauth2:tok@GitLab.example.com/acme/app.git/")).toBe(want);
    expect(normalizeRepoUrl("ssh://git@gitlab.example.com:2222/acme/app.git")).toBe(want);
    expect(normalizeRepoUrl("  https://gitlab.example.com/acme/app?tab=1#x ")).toBe(want);
    expect(normalizeRepoUrl("https://gitlab.example.com:8443/acme/app")).toBe("gitlab.example.com:8443/acme/app");
    expect(normalizeRepoUrl("https://gitlab.example.com/group/sub/app.git")).toBe("gitlab.example.com/group/sub/app");
  });

  test("things that are not repositories are rejected", () => {
    for (const bad of ["", "   ", "app", "https://gitlab.example.com", "https://gitlab.example.com/", "a b/c", "x".repeat(600)]) {
      expect(() => normalizeRepoUrl(bad), bad).toThrow(ValidationError);
    }
  });
});

describe("projects", () => {
  test("a project is found by any of its repository URLs", async () => {
    const id = await inWs((tx) => createProject(tx, admin, { key: "APP", name: "App" }));
    const other = await inWs((tx) => createProject(tx, admin, { key: "WEB", name: "Web" }));
    await inWs((tx) =>
      updateProjectConfig(tx, admin, id, { repoUrls: ["https://github.com/acme/app.git", "git@gitlab.example.com:acme/app.git"] }),
    );
    expect(await inWs((tx) => findProjectByRepoUrl(tx, "git@github.com:acme/app"))).toBe(id);
    expect(await inWs((tx) => findProjectByRepoUrl(tx, "https://GitLab.example.com/acme/app/"))).toBe(id);
    expect(await inWs((tx) => findProjectByRepoUrl(tx, "https://github.com/acme/web"))).toBeNull();
    expect((await inWs((tx) => getProject(tx, admin, id))).repoUrls).toEqual(["github.com/acme/app", "gitlab.example.com/acme/app"]);
    expect(await inWs((tx) => getProject(tx, admin, other))).toMatchObject({ key: "WEB", repoUrls: [] });
  });

  test("a repository belongs to one project; archived projects release it and are not found", async () => {
    const a = await inWs((tx) => createProject(tx, admin, { key: "APP", name: "App" }));
    const b = await inWs((tx) => createProject(tx, admin, { key: "WEB", name: "Web" }));
    await inWs((tx) => updateProjectConfig(tx, admin, a, { repoUrls: ["https://github.com/acme/app"] }));
    await expect(inWs((tx) => updateProjectConfig(tx, admin, b, { repoUrls: ["git@github.com:acme/app.git"] }))).rejects.toThrow(ValidationError);
    await inWs((tx) => updateProjectConfig(tx, admin, a, { repoUrls: ["https://github.com/acme/app"] })); // its own is fine
    await rawQuery(db, `update projects set archived_at = now() where id = '${a}'`);
    expect(await inWs((tx) => findProjectByRepoUrl(tx, "https://github.com/acme/app"))).toBeNull();
    await inWs((tx) => updateProjectConfig(tx, admin, b, { repoUrls: ["https://github.com/acme/app"] }));
    expect(await inWs((tx) => findProjectByRepoUrl(tx, "https://github.com/acme/app"))).toBe(b);
    await expect(inWs((tx) => updateProjectConfig(tx, admin, a, { repoUrls: [] }))).rejects.toThrow(NotFoundError);
  });

  test("project keys are unique within a workspace but not across", async () => {
    await inWs((tx) => createProject(tx, admin, { key: "APP", name: "App" }));
    await expect(inWs((tx) => createProject(tx, admin, { key: "APP", name: "Again" }))).rejects.toThrow(ValidationError);
    const owner2 = await seedUser(db, "Eve");
    const ws2 = await createWorkspace(db, { name: "Other", userId: owner2, displayName: "Eve" });
    const admin2: Actor = { kind: "member", workspaceId: ws2.workspaceId, memberId: ws2.memberId };
    await expect(withWorkspace(db, ws2.workspaceId, (tx) => createProject(tx, admin2, { key: "APP", name: "App" }))).resolves.toMatch(/^[0-9a-f-]{36}$/);
    // a duplicate leaves the transaction usable
    await inWs(async (tx) => {
      await expect(createProject(tx, admin, { key: "APP", name: "Again" })).rejects.toThrow(ValidationError);
      await createProject(tx, admin, { key: "WEB", name: "Web" });
    });
  });

  test("keys and names are validated", async () => {
    for (const key of ["a1", "A", "1AB", "ABCDEFGHIJK", "AB-C", ""]) {
      await expect(inWs((tx) => createProject(tx, admin, { key, name: "X" })), key).rejects.toThrow(ValidationError);
    }
    await expect(inWs((tx) => createProject(tx, admin, { key: "OK", name: "  " }))).rejects.toThrow(ValidationError);
    await expect(inWs((tx) => createProject(tx, admin, { key: "OK", name: "x".repeat(10_001) }))).rejects.toThrow(ValidationError);
    await inWs((tx) => createProject(tx, admin, { key: "A1234567890".slice(0, 10), name: "Ten" }));
  });

  test("creating a project and changing its config need workspace.admin", async () => {
    const id = await inWs((tx) => createProject(tx, admin, { key: "APP", name: "App" }));
    const lead = await member(["lead"]);
    await expect(inWs((tx) => createProject(tx, lead, { key: "NEW", name: "New" }))).rejects.toThrow(ForbiddenError);
    await expect(inWs((tx) => updateProjectConfig(tx, lead, id, { repoUrls: [] }))).rejects.toThrow(ForbiddenError);
    const agent: Actor = { kind: "agent", workspaceId, memberId: admin.memberId, agentId: newId(), projectIds: [id] };
    await expect(inWs((tx) => createProject(tx, agent, { key: "NEW", name: "New" }))).rejects.toThrow(ForbiddenError);
    await expect(inWs((tx) => updateProjectConfig(tx, agent, id, { repoUrls: [] }))).rejects.toThrow(ForbiddenError);
    const conn: Actor = { kind: "connection", workspaceId, connectionId: newId() };
    await expect(inWs((tx) => createProject(tx, conn, { key: "NEW", name: "New" }))).rejects.toThrow(ForbiddenError);
  });

  test("the webhook URL is never returned or written to events", async () => {
    const id = await inWs((tx) => createProject(tx, admin, { key: "APP", name: "App" }));
    expect((await inWs((tx) => getProject(tx, admin, id))).notifier).toBeNull();
    await inWs((tx) => updateProjectConfig(tx, admin, id, { notifier: { kind: "slack", webhookUrl: hook } }));
    const agent: Actor = { kind: "agent", workspaceId, memberId: admin.memberId, agentId: newId(), projectIds: [id] };
    for (const actor of [admin, agent]) {
      const p = await inWs((tx) => getProject(tx, actor, id));
      expect(p.notifier).toEqual({ kind: "slack", configured: true });
      expect(JSON.stringify(p)).not.toContain("abc123secret");
    }
    expect(JSON.stringify(await inWs((tx) => listEvents(tx, {})))).not.toContain("abc123secret");
    // stored, for notifyProject to read later
    expect((await rawQuery(db, "select notifier from project_config"))[0].notifier).toEqual({ kind: "slack", webhookUrl: hook });
    await inWs((tx) => updateProjectConfig(tx, admin, id, { notifier: null }));
    expect((await inWs((tx) => getProject(tx, admin, id))).notifier).toBeNull();
    // a repo-only patch leaves the notifier alone
    await inWs((tx) => updateProjectConfig(tx, admin, id, { notifier: { kind: "mattermost", webhookUrl: hook } }));
    await inWs((tx) => updateProjectConfig(tx, admin, id, { repoUrls: ["https://github.com/acme/app"] }));
    expect((await inWs((tx) => getProject(tx, admin, id)).then((p) => p.notifier))).toEqual({ kind: "mattermost", configured: true });
  });

  test("the notifier URL must be absolute https (http only for localhost)", async () => {
    const id = await inWs((tx) => createProject(tx, admin, { key: "APP", name: "App" }));
    const set = (webhookUrl: string, kind: any = "slack") => inWs((tx) => updateProjectConfig(tx, admin, id, { notifier: { kind, webhookUrl } }));
    for (const bad of ["", "not a url", "/hooks/x", "http://chat.example.com/h", "ftp://chat.example.com/h", "javascript:alert(1)"]) {
      await expect(set(bad), bad).rejects.toThrow(ValidationError);
    }
    await expect(set(hook, "teams")).rejects.toThrow(ValidationError);
    await set("http://localhost:8065/hooks/x");
    await set("http://127.0.0.1/hooks/x");
    await set(hook);
  });

  test("getProject needs project.read on that project", async () => {
    const a = await inWs((tx) => createProject(tx, admin, { key: "APP", name: "App" }));
    const b = await inWs((tx) => createProject(tx, admin, { key: "WEB", name: "Web" }));
    const scoped = await member(["frontend"], a);
    expect((await inWs((tx) => getProject(tx, scoped, a))).key).toBe("APP");
    await expect(inWs((tx) => getProject(tx, scoped, b))).rejects.toThrow(ForbiddenError);
    const agent: Actor = { kind: "agent", workspaceId, memberId: admin.memberId, agentId: newId(), projectIds: [a] };
    await expect(inWs((tx) => getProject(tx, agent, b))).rejects.toThrow(ForbiddenError);
    await expect(inWs((tx) => getProject(tx, admin, newId()))).rejects.toThrow(NotFoundError);
    await expect(inWs((tx) => getProject(tx, admin, "nope"))).rejects.toThrow(NotFoundError);
  });

  test("config input is validated", async () => {
    const id = await inWs((tx) => createProject(tx, admin, { key: "APP", name: "App" }));
    await expect(inWs((tx) => updateProjectConfig(tx, admin, id, {}))).rejects.toThrow(ValidationError);
    await expect(inWs((tx) => updateProjectConfig(tx, admin, id, { repoUrls: ["nope"] }))).rejects.toThrow(ValidationError);
    await expect(inWs((tx) => updateProjectConfig(tx, admin, newId(), { repoUrls: [] }))).rejects.toThrow(NotFoundError);
    const many = Array.from({ length: 21 }, (_, i) => `https://github.com/acme/r${i}`);
    await expect(inWs((tx) => updateProjectConfig(tx, admin, id, { repoUrls: many }))).rejects.toThrow(ValidationError);
    await inWs((tx) => updateProjectConfig(tx, admin, id, { repoUrls: ["https://github.com/acme/a", "git@github.com:acme/a.git"] }));
    expect((await inWs((tx) => getProject(tx, admin, id))).repoUrls).toEqual(["github.com/acme/a"]);
  });

  test("another workspace cannot see or find a project", async () => {
    const id = await inWs((tx) => createProject(tx, admin, { key: "APP", name: "App" }));
    await inWs((tx) => updateProjectConfig(tx, admin, id, { repoUrls: ["https://github.com/acme/app"] }));
    const owner2 = await seedUser(db, "Eve");
    const ws2 = await createWorkspace(db, { name: "Other", userId: owner2, displayName: "Eve" });
    const admin2: Actor = { kind: "member", workspaceId: ws2.workspaceId, memberId: ws2.memberId };
    const run = <T>(fn: Parameters<typeof withWorkspace<T>>[2]) => withWorkspace(db, ws2.workspaceId, fn);
    expect(await run((tx) => findProjectByRepoUrl(tx, "https://github.com/acme/app"))).toBeNull();
    await expect(run((tx) => getProject(tx, admin2, id))).rejects.toThrow();
    await run((tx) => createProject(tx, admin2, { key: "APP", name: "Theirs" }));
  });

  test("every mutation records an event; default config is stored; tables have forced RLS", async () => {
    const id = await inWs((tx) => createProject(tx, admin, { key: "APP", name: "App" }));
    await inWs((tx) => updateProjectConfig(tx, admin, id, { repoUrls: ["https://github.com/acme/app"], notifier: { kind: "slack", webhookUrl: hook } }));
    const events = await inWs((tx) => listEvents(tx, { projectId: id }));
    expect(events.map((e) => e.type)).toEqual(["project.created", "project.config_updated"]);
    expect(events[1]!.data).toEqual({ repoUrls: ["github.com/acme/app"], notifier: { kind: "slack", configured: true } });
    const [cfg] = await rawQuery(db, "select approval, tracker from project_config");
    expect(cfg).toEqual({ approval: { requirements: { roleKey: "approver", count: 1 } }, tracker: null });
    await expect(assertAllTablesHaveForcedRls(db)).resolves.toBeUndefined();
  });
});
