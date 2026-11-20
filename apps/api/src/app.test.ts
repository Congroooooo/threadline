import { type Db, newId, SESSION_CONTEXT_EMPTY, SESSION_CONTEXT_FIRST_LINE } from "@threadline/core";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { baseEnv, type Harness, harness, json, ORIGIN } from "./test/helpers.js";

const REPO = "https://git.example.com/acme/app";
const HOOK = "https://hooks.example.com/services/T000/B000/abc";

let h: Harness;
let dana: string; // owner session cookie
let ws: string;
let acme: string;
let roleIds: Record<string, string>;

/** An invite into `ws` with `roleKeys`, accepted by a new person; returns their cookie and member id. */
async function join(name: string, roleKeys: string[]): Promise<{ cookie: string; memberId: string }> {
  const { code } = await json(h.call("POST", `/api/w/${ws}/invites`, dana, { roleKeys }), 201);
  const cookie = await h.signIn(name);
  const { memberId } = await json(h.call("POST", "/api/invites/accept", cookie, { code }), 200);
  return { cookie, memberId };
}

async function agentToken(cookie: string, name: string): Promise<string> {
  const { token } = await json(h.call("POST", `/api/w/${ws}/tokens`, cookie, { name, projectIds: [acme] }), 201);
  return token;
}

beforeEach(async () => {
  h = await harness();
  dana = await h.signIn("Dana");
  ({ workspaceId: ws } = await json(h.call("POST", "/api/workspaces", dana, { name: "Studio" }), 201));
  ({ id: acme } = await json(h.call("POST", `/api/w/${ws}/projects`, dana, { key: "ACME", name: "Acme" }), 201));
  await json(h.call("PATCH", `/api/w/${ws}/projects/${acme}/config`, dana, {
    repoUrls: [REPO],
    notifier: { kind: "slack", webhookUrl: HOOK },
  }), 200);
  const roles: { id: string; key: string }[] = await json(h.call("GET", `/api/w/${ws}/roles`, dana), 200);
  roleIds = Object.fromEntries(roles.map((r) => [r.key, r.id]));
});

describe("configuration", () => {
  test("local mode refuses to start unless PUBLIC_URL is localhost", () => {
    expect(() => createApp({ ...baseEnv, AUTH_MODE: "local", PUBLIC_URL: "https://threadline.example.com" })).toThrow();
    expect(() => createApp({ ...baseEnv, AUTH_MODE: "local", PUBLIC_URL: "http://localhost.evil.test:8787" })).toThrow();
    expect(() => createApp({ ...baseEnv, AUTH_MODE: "local", PUBLIC_URL: "http://localhost:8787" })).not.toThrow();
    expect(() => createApp({ ...baseEnv, AUTH_MODE: "local", PUBLIC_URL: "http://127.0.0.1:8787" })).not.toThrow();
    expect(() => createApp({ ...baseEnv, AUTH_MODE: "other" as "local" })).toThrow();
    expect(() => createApp({ ...baseEnv, PUBLIC_URL: "not a url" })).toThrow();
    expect(() => createApp({ ...baseEnv, PUBLIC_URL: "https://example.com/threadline" })).toThrow(/path/);
    expect(() => createApp({ ...baseEnv, PUBLIC_URL: "https://example.com/" })).not.toThrow();
  });

  test("local mode only answers requests addressed to localhost", async () => {
    const local = await harness({ AUTH_MODE: "local", PUBLIC_URL: "http://localhost:8787" });
    const health = (host: string) => local.app.request("/api/health", { headers: { host } });
    for (const host of ["localhost:8787", "localhost", "127.0.0.1:8787", "[::1]:8787", "LOCALHOST:8787"]) {
      expect((await health(host)).status, host).toBe(200);
    }
    for (const host of ["192.168.1.20:8787", "threadline.example.com", "localhost.evil.test:8787", "evil.test"]) {
      expect((await health(host)).status, host).toBe(403);
    }
    // Without a Host header, the request URL's host decides.
    expect((await local.app.request("http://attacker.test/api/health")).status).toBe(403);
    // OAuth mode is unaffected.
    expect((await h.call("GET", "/api/health", undefined, undefined, { host: "threadline.example.com" })).status).toBe(200);
  });

  test("API responses carry the security headers, errors included", async () => {
    for (const res of [await h.call("GET", "/api/health"), await h.call("GET", "/api/me"), await h.call("GET", "/nowhere")]) {
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    }
  });

  test("the health check passes for app_user, which is no superuser, cannot bypass RLS and owns no tables", async () => {
    expect(await json(h.call("GET", "/api/health"), 200)).toEqual({ ok: true });
  });

  test("an unsafe database role fails the health check with a generic reason", async () => {
    const owner = { execute: async () => ({ rows: [{ role: "neondb_owner", superuser: null, bypassrls: "neondb_owner", owned: 12 }] }) } as unknown as Db;
    const res = await createApp(baseEnv, { db: owner }).request("/api/health");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, reason: "database role is not safe" });
  });

  test("unexpected errors are a bare 500 that leaks no message", async () => {
    const broken = new Proxy({} as Db, {
      get: () => () => Promise.reject(new Error("connection string postgres://secret@db")),
    });
    const app = createApp(baseEnv, { db: broken });
    const res = await app.request("/api/me", { headers: { cookie: `tl_session=${"a".repeat(43)}` } });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal error" });
  });
});

describe("authentication", () => {
  test("unauthenticated requests get 401; a member of another workspace gets 403", async () => {
    expect(await json(h.call("GET", `/api/w/${ws}/projects`), 401)).toEqual({ error: expect.any(String) });
    expect((await h.call("GET", "/api/me")).status).toBe(401);
    expect((await h.call("GET", "/api/me", "tl_session=not-a-session")).status).toBe(401);

    const sam = await h.signIn("Sam");
    const { workspaceId: other } = await json(h.call("POST", "/api/workspaces", sam, { name: "Elsewhere" }), 201);
    expect((await h.call("GET", `/api/w/${ws}/projects`, sam)).status).toBe(403);
    expect((await h.call("GET", `/api/w/${other}/projects`, sam)).status).toBe(200);
    // A workspace that does not exist looks the same as one you are not in.
    expect((await h.call("GET", `/api/w/${newId()}/projects`, sam)).status).toBe(403);
    expect((await h.call("GET", "/api/w/not-a-uuid/projects", sam)).status).toBe(400);

    // An agent token is bound to its own workspace.
    const token = await agentToken(dana, "dana-agent");
    expect((await h.call("GET", `/api/w/${ws}/projects`, token)).status).toBe(200);
    expect((await h.call("GET", `/api/w/${other}/projects`, token)).status).toBe(403);
    expect((await h.call("GET", `/api/w/${ws}/projects`, `tl_${"x".repeat(43)}`)).status).toBe(401);
  });

  test("a bearer token wins over a cookie sent with it", async () => {
    const token = await agentToken(dana, "dana-agent");
    const res = await h.call("GET", "/api/me", dana, undefined, { authorization: `Bearer ${token}` });
    // /api/me is for people; the agent identity was used, not Dana's session.
    expect(res.status).toBe(403);
  });

  test("state-changing requests with a session cookie need a matching Origin header", async () => {
    const body = JSON.stringify({ key: "WEB", name: "Web" });
    const post = (headers: Record<string, string>) =>
      h.app.request(`/api/w/${ws}/projects`, { method: "POST", headers: { cookie: dana, "content-type": "application/json", ...headers }, body });
    expect((await post({ origin: "https://evil.test" })).status).toBe(403);
    expect((await post({})).status).toBe(403);
    expect((await post({ origin: "null" })).status).toBe(403);
    expect((await post({ origin: ORIGIN })).status).toBe(201);
    // Reads need no Origin; bearer requests are exempt.
    expect((await h.app.request(`/api/w/${ws}/projects`, { headers: { cookie: dana } })).status).toBe(200);
    const token = await agentToken(dana, "dana-agent");
    const task = await h.app.request(`/api/w/${ws}/projects/${acme}/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: "https://evil.test" },
      body: JSON.stringify({ title: "From an agent", ownerRoleId: roleIds.backend }),
    });
    expect(task.status).toBe(201);
  });

  test("sign-out ends the session", async () => {
    const res = await h.call("POST", "/auth/sign-out", dana);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/tl_session=;/);
    expect((await h.call("GET", "/api/me", dana)).status).toBe(401);
  });
});

describe("workspaces and people", () => {
  test("GET /api/me returns the user and their memberships", async () => {
    const me = await json(h.call("GET", "/api/me", dana), 200);
    expect(me.user).toMatchObject({ displayName: "Dana", identities: [{ provider: "github", login: "dana" }] });
    expect(me.memberships).toEqual([{ workspaceId: ws, memberId: expect.any(String), workspaceName: "Studio" }]);
  });

  test("a user not listed in WORKSPACE_CREATORS gets 403 creating a workspace but can accept an invite", async () => {
    h = await harness({ WORKSPACE_CREATORS: " github:Dana , gitlab:someone " });
    dana = await h.signIn("Dana", "dana");
    ({ workspaceId: ws } = await json(h.call("POST", "/api/workspaces", dana, { name: "Studio" }), 201));
    const sam = await h.signIn("Sam", "sam");
    expect(await json(h.call("POST", "/api/workspaces", sam, { name: "Mine" }), 403)).toEqual({ error: expect.any(String) });
    const { code } = await json(h.call("POST", `/api/w/${ws}/invites`, dana, { roleKeys: ["frontend"] }), 201);
    expect(await json(h.call("POST", "/api/invites/accept", sam, { code }), 200)).toMatchObject({ workspaceId: ws });
    const me = await json(h.call("GET", "/api/me", sam), 200);
    expect(me.memberships.map((m: { workspaceId: string }) => m.workspaceId)).toEqual([ws]);
    // A bad code is a 400 with the uniform message.
    expect(await json(h.call("POST", "/api/invites/accept", sam, { code: "tli_nope" }), 400)).toEqual({
      error: "invite is invalid or expired",
    });
  });

  test("an admin creates a custom role, assigns it with another role to a member, and that member's permissions change", async () => {
    const sam = await join("Sam", ["approver"]);
    const blocker = { observed: "Staging is down", ownerRoleId: roleIds.backend };
    expect((await h.call("POST", `/api/w/${ws}/projects/${acme}/blockers`, sam.cookie, blocker)).status).toBe(403);

    const { id: qa } = await json(h.call("POST", `/api/w/${ws}/roles`, dana, {
      key: "qa",
      name: "QA",
      permissions: ["project.read", "blocker.write"],
    }), 201);
    await json(h.call("PUT", `/api/w/${ws}/members/${sam.memberId}/roles`, dana, { roleKeys: ["qa", "approver"] }), 200);
    const members: { memberId: string; roles: { key: string }[] }[] = await json(h.call("GET", `/api/w/${ws}/members`, dana), 200);
    expect(members.find((m) => m.memberId === sam.memberId)!.roles.map((r) => r.key)).toEqual(["approver", "qa"]);
    await json(h.call("POST", `/api/w/${ws}/projects/${acme}/blockers`, sam.cookie, blocker), 201);

    // Renaming through roles/:roleId, then archiving takes the permission away again.
    await json(h.call("PUT", `/api/w/${ws}/roles/${qa}`, dana, { name: "Quality", permissions: ["project.read", "blocker.write"] }), 200);
    await json(h.call("POST", `/api/w/${ws}/roles/${qa}/archive`, dana), 200);
    expect((await h.call("POST", `/api/w/${ws}/projects/${acme}/blockers`, sam.cookie, blocker)).status).toBe(403);
    await json(h.call("POST", `/api/w/${ws}/roles/${qa}/restore`, dana), 200);
    const roles: { key: string; name: string }[] = await json(h.call("GET", `/api/w/${ws}/roles`, dana), 200);
    expect(roles.find((r) => r.key === "qa")!.name).toBe("Quality");

    // Members cannot manage roles; removing a member locks them out.
    expect((await h.call("POST", `/api/w/${ws}/roles`, sam.cookie, { key: "x1", name: "X", permissions: [] })).status).toBe(403);
    await json(h.call("POST", `/api/w/${ws}/members/${sam.memberId}/remove`, dana), 200);
    expect((await h.call("GET", `/api/w/${ws}/projects`, sam.cookie)).status).toBe(403);
  });

  test("admins list pending invites; people list their own tokens, admins everyone's", async () => {
    const { inviteId, code } = await json(h.call("POST", `/api/w/${ws}/invites`, dana, { roleKeys: ["backend"] }), 201);
    const invites = await json(h.call("GET", `/api/w/${ws}/invites`, dana), 200);
    expect(invites).toEqual([expect.objectContaining({ id: inviteId, roleKeys: ["backend"], createdByName: "Dana" })]);
    expect(JSON.stringify(invites)).not.toContain(code);

    const bo = await join("Bo", ["backend"]);
    expect((await h.call("GET", `/api/w/${ws}/invites`, bo.cookie)).status).toBe(403);
    const boToken = await agentToken(bo.cookie, "bo-agent");
    await agentToken(dana, "dana-agent");
    const own = await json(h.call("GET", `/api/w/${ws}/tokens`, bo.cookie), 200);
    expect(own).toEqual([expect.objectContaining({ name: "bo-agent", ownerName: "Bo", projectIds: [acme], revokedAt: null })]);
    expect(JSON.stringify(own)).not.toContain(boToken);
    expect((await json(h.call("GET", `/api/w/${ws}/tokens`, dana), 200)).map((t: { name: string }) => t.name))
      .toEqual(["bo-agent", "dana-agent"]);
    expect((await h.call("GET", `/api/w/${ws}/tokens`, boToken)).status).toBe(403);
  });

  test("member and role lists are refused to agents but open to members", async () => {
    const bo = await join("Bo", ["backend"]);
    const boToken = await agentToken(bo.cookie, "bo-agent");
    expect((await h.call("GET", `/api/w/${ws}/members`, boToken)).status).toBe(403);
    expect((await h.call("GET", `/api/w/${ws}/roles`, boToken)).status).toBe(403);
    await json(h.call("GET", `/api/w/${ws}/members`, bo.cookie), 200);
    await json(h.call("GET", `/api/w/${ws}/roles`, bo.cookie), 200);
  });

  test("invites can be revoked and agent tokens revoked", async () => {
    const { inviteId, code } = await json(h.call("POST", `/api/w/${ws}/invites`, dana, { roleKeys: ["backend"] }), 201);
    await json(h.call("POST", `/api/w/${ws}/invites/${inviteId}/revoke`, dana), 200);
    const sam = await h.signIn("Sam");
    expect((await h.call("POST", "/api/invites/accept", sam, { code })).status).toBe(400);

    const { agentId, token } = await json(h.call("POST", `/api/w/${ws}/tokens`, dana, { name: "a", projectIds: [acme] }), 201);
    expect((await h.call("GET", `/api/w/${ws}/projects`, token)).status).toBe(200);
    await json(h.call("POST", `/api/w/${ws}/tokens/${agentId}/revoke`, dana), 200);
    expect((await h.call("GET", `/api/w/${ws}/projects`, token)).status).toBe(401);
  });
});

describe("work over HTTP", () => {
  test("the full handoff path over HTTP", async () => {
    const bo = await join("Bo", ["backend"]);
    const fia = await join("Fia", ["frontend"]);
    const backendAgent = await agentToken(bo.cookie, "bo-agent");
    const frontendAgent = await agentToken(fia.cookie, "fia-agent");
    const { taskId, ref } = await json(h.call("POST", `/api/w/${ws}/projects/${acme}/tasks`, bo.cookie, {
      title: "Archived profiles",
      ownerRoleId: roleIds.backend,
    }), 201);
    expect(ref).toBe("ACME-1");
    h.fetch.calls.length = 0;

    // backend agent: POST handoffs → 201; chat webhook received one call
    const created = await json(h.call("POST", `/api/w/${ws}/projects/${acme}/handoffs`, backendAgent, {
      task: ref,
      toRoleId: roleIds.frontend,
      delivered: "API returns archived flag",
      requiredAction: "Hide archived profiles in the list",
      evidence: [{ kind: "change_request", url: "https://git.example.com/acme/app/-/merge_requests/7" }],
    }), 201);
    expect(created).toMatchObject({ handoffId: expect.any(String), unassigned: false, created: true });
    expect(h.fetch.calls).toHaveLength(1);
    expect(h.fetch.calls[0]!.url).toBe(HOOK);
    expect(JSON.parse(h.fetch.calls[0]!.body).text).toContain("Handoff on ACME-1 from Bo (agent) to Frontend.");
    // the link opens the task page of the web app (route /w/:ws/t/:taskId)
    expect(JSON.parse(h.fetch.calls[0]!.body).text).toBe(
      `Handoff on ACME-1 from Bo (agent) to Frontend.\n${ORIGIN}/w/${ws}/t/${taskId}`);

    // frontend agent: GET open-items → the handoff; POST respond → 403
    const items = await json(h.call("GET", `/api/w/${ws}/projects/${acme}/open-items`, frontendAgent), 200);
    expect(items.handoffs).toHaveLength(1);
    expect(items.handoffs[0]).toMatchObject({
      id: created.handoffId,
      taskRef: "ACME-1",
      delivered: { untrusted: true, text: "API returns archived flag" },
    });
    const respond = (auth: string) =>
      h.call("POST", `/api/w/${ws}/handoffs/${created.handoffId}/respond`, auth, { response: "accepted" });
    expect((await respond(frontendAgent)).status).toBe(403);

    // frontend session: POST respond {response:"accepted"} → 200; GET open-items → none
    await json(respond(fia.cookie), 200);
    expect((await json(h.call("GET", `/api/w/${ws}/projects/${acme}/open-items`, fia.cookie), 200)).handoffs).toEqual([]);

    // The task view, progress, status, events and search all answer.
    const ctx = await json(h.call("GET", `/api/w/${ws}/tasks/${taskId}`, frontendAgent), 200);
    expect(ctx.task).toMatchObject({ ref: "ACME-1", title: { text: "Archived profiles" } });
    expect(ctx.handoffs[0].status).toBe("accepted");
    await json(h.call("POST", `/api/w/${ws}/tasks/${taskId}/progress`, backendAgent, { note: "Started on the filter" }), 201);
    await json(h.call("POST", `/api/w/${ws}/tasks/${taskId}/status`, bo.cookie, { status: "in_progress" }), 200);
    expect((await h.call("POST", `/api/w/${ws}/tasks/${taskId}/status`, bo.cookie, { status: "shipped" })).status).toBe(400);
    const events: { id: string; type: string }[] = await json(h.call("GET", `/api/w/${ws}/projects/${acme}/events`, bo.cookie), 200);
    expect(events.map((e) => e.type)).toContain("handoff.accepted");
    const after = await json(h.call("GET", `/api/w/${ws}/projects/${acme}/events?after=${events.at(-2)!.id}`, bo.cookie), 200);
    expect(after).toEqual([events.at(-1)]);
    const hits = await json(h.call("GET", `/api/w/${ws}/projects/${acme}/search?q=filter`, bo.cookie), 200);
    expect(hits.map((x: { kind: string }) => x.kind)).toContain("progress");
  });

  test("blockers are raised, explained and resolved; raising one notifies the chat", async () => {
    const bo = await join("Bo", ["backend"]);
    const agent = await agentToken(bo.cookie, "bo-agent");
    h.fetch.calls.length = 0;
    const { id } = await json(h.call("POST", `/api/w/${ws}/projects/${acme}/blockers`, agent, {
      observed: "Login fails on staging",
      ownerRoleId: roleIds.backend,
    }), 201);
    expect(h.fetch.calls).toHaveLength(1);
    expect(JSON.parse(h.fetch.calls[0]!.body).text).toContain("Blocker raised, owned by Backend.");
    // without a task, the link opens the project page of the web app (route /w/:ws/p/:projectId)
    expect(JSON.parse(h.fetch.calls[0]!.body).text).toBe(`Blocker raised, owned by Backend.\n${ORIGIN}/w/${ws}/p/${acme}`);
    // Agents may only suspect a cause.
    expect((await h.call("POST", `/api/w/${ws}/blockers/${id}/cause`, agent, { cause: "Expired cert", verified: true })).status).toBe(403);
    await json(h.call("POST", `/api/w/${ws}/blockers/${id}/cause`, agent, { cause: "Expired cert", verified: false }), 200);
    await json(h.call("POST", `/api/w/${ws}/blockers/${id}/resolve`, bo.cookie, { resolution: "Renewed the cert" }), 200);
    expect((await json(h.call("GET", `/api/w/${ws}/projects/${acme}/open-items`, bo.cookie), 200)).blockers).toEqual([]);
  });

  test("tasks and blockers of a project are listed, optionally by status", async () => {
    const bo = await join("Bo", ["backend"]);
    const mk = (title: string) =>
      json(h.call("POST", `/api/w/${ws}/projects/${acme}/tasks`, bo.cookie, { title, ownerRoleId: roleIds.backend }), 201);
    const first = await mk("First <b>task</b>");
    await mk("Second");
    await json(h.call("POST", `/api/w/${ws}/tasks/${first.taskId}/status`, bo.cookie, { status: "in_review" }), 200);
    const { id: blockerId } = await json(h.call("POST", `/api/w/${ws}/projects/${acme}/blockers`, bo.cookie, {
      task: "ACME-2",
      observed: "CI is red",
      ownerRoleId: roleIds.frontend,
    }), 201);

    const tasks = await json(h.call("GET", `/api/w/${ws}/projects/${acme}/tasks`, bo.cookie), 200);
    expect(tasks.map((t: { ref: string; status: string; blocked: boolean }) => [t.ref, t.status, t.blocked]))
      .toEqual([["ACME-1", "in_review", false], ["ACME-2", "todo", true]]);
    expect(tasks[0].title).toEqual({ untrusted: true, source: `task:${first.taskId}`, text: "First <b>task</b>" });
    const inReview = await json(h.call("GET", `/api/w/${ws}/projects/${acme}/tasks?status=in_review`, bo.cookie), 200);
    expect(inReview.map((t: { ref: string }) => t.ref)).toEqual(["ACME-1"]);
    expect((await h.call("GET", `/api/w/${ws}/projects/${acme}/tasks?status=shipped`, bo.cookie)).status).toBe(400);

    // Bo does not own the blocker (frontend does), but the project list shows it.
    const blockers = await json(h.call("GET", `/api/w/${ws}/projects/${acme}/blockers?status=open`, bo.cookie), 200);
    expect(blockers).toEqual([expect.objectContaining({ id: blockerId, taskRef: "ACME-2", ownerRole: "frontend" })]);
    expect(await json(h.call("GET", `/api/w/${ws}/projects/${acme}/blockers?status=resolved`, bo.cookie), 200)).toEqual([]);
    expect((await h.call("GET", `/api/w/${ws}/projects/${acme}/blockers?status=closed`, bo.cookie)).status).toBe(400);
  });

  test("a 12,000 character note returns 400", async () => {
    const { taskId } = await json(h.call("POST", `/api/w/${ws}/projects/${acme}/tasks`, dana, {
      title: "Long notes",
      ownerRoleId: roleIds.backend,
    }), 201);
    const res = await h.call("POST", `/api/w/${ws}/tasks/${taskId}/progress`, dana, { note: "x".repeat(12_000) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.stringContaining("note") });
  });

  test("bodies, path ids and queries are validated before core sees them", async () => {
    expect((await h.call("POST", `/api/w/${ws}/projects`, dana, { key: "ACME" })).status).toBe(400);
    expect((await h.call("POST", `/api/w/${ws}/tasks/not-a-uuid/status`, dana, { status: "todo" })).status).toBe(400);
    expect((await h.call("GET", `/api/w/${ws}/projects/${acme}/search`, dana)).status).toBe(400);
    expect((await h.call("GET", `/api/w/${ws}/projects/${acme}/events?after=nope`, dana)).status).toBe(400);
    const bad = await h.app.request(`/api/w/${ws}/projects`, {
      method: "POST",
      headers: { cookie: dana, origin: ORIGIN, "content-type": "application/json" },
      body: "{not json",
    });
    expect(bad.status).toBe(400);
    expect((await h.call("GET", `/api/w/${ws}/tasks/${newId()}`, dana)).status).toBe(404);
    expect((await h.call("GET", `/api/w/${ws}/projects/${acme}`, dana)).status).toBe(200);
  });

  test("session-context returns text for a known repo and an empty body for an unknown one", async () => {
    const bo = await join("Bo", ["backend"]);
    const agent = await agentToken(bo.cookie, "bo-agent");
    await json(h.call("POST", `/api/w/${ws}/projects/${acme}/tasks`, bo.cookie, {
      title: "Archived profiles",
      ownerRoleId: roleIds.backend,
      branch: "feat/archived",
    }), 201);
    const get = (query: string, auth = agent) => h.call("GET", `/api/agent/session-context?${query}`, auth);

    const known = await get(`repo=${encodeURIComponent("git@git.example.com:acme/app.git")}&branch=feat/archived`);
    expect(known.status).toBe(200);
    expect(known.headers.get("content-type")).toMatch(/^text\/plain/);
    const text = await known.text();
    expect(text.split("\n")[0]).toBe(SESSION_CONTEXT_FIRST_LINE);
    expect(text).toContain("ACME-1");

    const noBranch = await get(`repo=${encodeURIComponent(REPO)}`);
    expect(await noBranch.text()).toContain("ACME-1");

    const unknown = await get(`repo=${encodeURIComponent("https://git.example.com/acme/other")}`);
    expect(unknown.status).toBe(200);
    expect(await unknown.text()).toBe("");

    expect((await get("branch=main")).status).toBe(400);
    expect((await get(`repo=${encodeURIComponent(REPO)}`, bo.cookie)).status).toBe(403);
    expect((await h.call("GET", `/api/agent/session-context?repo=${encodeURIComponent(REPO)}`)).status).toBe(401);

    // A repository whose project is outside the agent's scope is as quiet as an unknown one.
    const { id: web } = await json(h.call("POST", `/api/w/${ws}/projects`, dana, { key: "WEB", name: "Web" }), 201);
    await json(h.call("PATCH", `/api/w/${ws}/projects/${web}/config`, dana, { repoUrls: ["https://git.example.com/acme/web"] }), 200);
    const outside = await get(`repo=${encodeURIComponent("https://git.example.com/acme/web")}`);
    expect(outside.status).toBe(200);
    expect(await outside.text()).toBe("");

    // Nothing open for someone without tasks there.
    const fia = await join("Fia", ["frontend"]);
    const empty = await get(`repo=${encodeURIComponent(REPO)}`, await agentToken(fia.cookie, "fia-agent"));
    expect(await empty.text()).toBe(SESSION_CONTEXT_EMPTY);
  });
});
