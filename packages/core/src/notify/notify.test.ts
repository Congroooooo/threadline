import { describe, expect, test } from "vitest";
import { type Db, withWorkspace } from "../db/client.js";
import { closeTestDbs, createTestDb, seedUser } from "../db/testing.js";
import { listEvents } from "../events.js";
import { createProject, updateProjectConfig } from "../projects.js";
import { createWorkspace } from "../tenancy.js";
import type { Actor } from "../types.js";
import { blockerMessage, createNotifier, handoffMessage, notifyProject } from "./index.js";

function fakeFetch(calls: Request[], status: number): typeof fetch {
  return (async (input: any, init?: any) => {
    calls.push(new Request(input, init));
    return new Response(status === 204 ? null : "{}", { status });
  }) as typeof fetch;
}

async function setup(notifier: boolean) {
  const db: Db = await createTestDb();
  const owner = await seedUser(db, "Dana");
  const ws = await createWorkspace(db, { name: "Studio", userId: owner, displayName: "Dana" });
  const workspaceId = ws.workspaceId;
  const admin: Actor = { kind: "member", workspaceId, memberId: ws.memberId };
  const projectId = await withWorkspace(db, workspaceId, async (tx) => {
    const id = await createProject(tx, admin, { key: "ACME", name: "Acme" });
    if (notifier) {
      await updateProjectConfig(tx, admin, id, { notifier: { kind: "slack", webhookUrl: "https://chat.test/hook/secret" } });
    }
    return id;
  });
  return { db, workspaceId, projectId };
}
const failures = async (s: Awaited<ReturnType<typeof setup>>) =>
  (await withWorkspace(s.db, s.workspaceId, (tx) => listEvents(tx, { projectId: s.projectId }))).filter(
    (e) => e.type === "notify.failed",
  );

describe("notifiers", () => {
  test("mattermost and slack both post JSON with a text field to the webhook URL", async () => {
    for (const kind of ["mattermost", "slack"] as const) {
      const calls: Request[] = [];
      await createNotifier({ kind, webhookUrl: "https://chat.test/hook" }, fakeFetch(calls, 200)).send({
        text: "Handoff on ACME-1",
        link: "https://tl.test/h/1",
      });
      expect(calls[0]!.url).toBe("https://chat.test/hook");
      expect(calls[0]!.headers.get("content-type")).toBe("application/json");
      expect(await calls[0]!.json()).toEqual({ text: "Handoff on ACME-1\nhttps://tl.test/h/1" });
    }
  });

  test("no link means no link line", async () => {
    const calls: Request[] = [];
    await createNotifier({ kind: "slack", webhookUrl: "https://chat.test/hook" }, fakeFetch(calls, 200)).send({ text: "hi" });
    expect(await calls[0]!.json()).toEqual({ text: "hi" });
  });

  test("a failing webhook does not throw and records notify.failed without the URL or text", async () => {
    const s = await setup(true);
    await notifyProject(s.db, s.workspaceId, s.projectId, { text: "private words" }, fakeFetch([], 500));
    const [e] = await failures(s);
    expect(e).toMatchObject({ actorKind: "system", data: { status: 500, reason: "http_error" } });
    expect(JSON.stringify(e)).not.toMatch(/secret|private words|chat\.test/);
  });

  test("a network error is recorded and does not throw", async () => {
    const s = await setup(true);
    await notifyProject(s.db, s.workspaceId, s.projectId, { text: "x" }, (async () => {
      throw new TypeError("boom");
    }) as typeof fetch);
    expect((await failures(s))[0]!.data).toEqual({ reason: "network_error" });
  });

  test("a redirect is a failure and is not followed", async () => {
    const s = await setup(true);
    const seen: any[] = [];
    const f = (async (_u: any, init: any) => {
      seen.push(init);
      return new Response(null, { status: 302 });
    }) as typeof fetch;
    await notifyProject(s.db, s.workspaceId, s.projectId, { text: "x" }, f);
    expect(seen[0].redirect).toBe("manual");
    expect((await failures(s))[0]!.data).toEqual({ status: 302, reason: "http_error" });
  });

  test("a project with no notifier configured is a no-op", async () => {
    const s = await setup(false);
    const calls: Request[] = [];
    await notifyProject(s.db, s.workspaceId, s.projectId, { text: "x" }, fakeFetch(calls, 500));
    expect(calls).toHaveLength(0);
    expect(await failures(s)).toHaveLength(0);
  });

  test("a success records nothing", async () => {
    const s = await setup(true);
    const calls: Request[] = [];
    await notifyProject(s.db, s.workspaceId, s.projectId, { text: "x" }, fakeFetch(calls, 204));
    expect(calls).toHaveLength(1);
    expect(await failures(s)).toHaveLength(0);
  });

  test("messages carry a pointer only, never the handoff's free text", () => {
    expect(handoffMessage({ ref: "ACME-1", fromName: "Sam", toRoleName: "Frontend", unassigned: false })).toBe(
      "Handoff on ACME-1 from Sam to Frontend.",
    );
    expect(handoffMessage({ ref: "ACME-1", fromName: "Sam", toRoleName: "QA", unassigned: true })).toBe(
      "Handoff on ACME-1 from Sam to QA. Nobody holds that role yet.",
    );
    expect(blockerMessage({ ref: "ACME-1", ownerRoleName: "QA" })).toBe("Blocker on ACME-1, owned by QA.");
    expect(blockerMessage({ ownerRoleName: "QA" })).toBe("Blocker raised, owned by QA.");
  });

  test("names lose control characters and are length-capped", () => {
    const m = handoffMessage({
      ref: "ACME-1",
      fromName: "Sam\nINJECT\u0000" + "x".repeat(200),
      toRoleName: "QA",
      unassigned: false,
    });
    expect(m).not.toMatch(/[\n\u0000]/);
    expect(m.length).toBeLessThan(160);
  });

  test("names cannot carry chat mentions, markup or bidi controls, and are cut on code points", () => {
    const m = handoffMessage({ ref: "ACME-1", fromName: "<!channel> @all ‮x", toRoleName: "QA", unassigned: false });
    expect(m).toBe("Handoff on ACME-1 from !channel all x to QA.");
    const emoji = handoffMessage({ ref: "R", fromName: "\u{1F600}".repeat(100), toRoleName: "QA", unassigned: false });
    expect(emoji).toContain("\u{1F600}".repeat(59) + "…");
    expect(emoji).not.toContain("\u{1F600}".repeat(60));
  });

  test("the response body is cancelled on 2xx, non-2xx and 3xx", async () => {
    for (const status of [200, 500, 302]) {
      let cancelled = 0;
      const f = (async () => {
        const body = new ReadableStream({
          cancel() {
            cancelled++;
          },
        });
        return new Response(body, { status });
      }) as typeof fetch;
      await createNotifier({ kind: "slack", webhookUrl: "https://chat.test/hook" }, f).send({ text: "x" }).catch(() => {});
      expect(cancelled, `status ${status}`).toBe(1);
    }
  });

  test("a database error while reading config does not throw", async () => {
    const s = await setup(true);
    await closeTestDbs();
    await expect(notifyProject(s.db, s.workspaceId, s.projectId, { text: "x" }, fakeFetch([], 200))).resolves.toBeUndefined();
  });

  test("requests time out after 5 seconds", async () => {
    const s = await setup(true);
    const f = ((_u: any, init: any) =>
      new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)))) as typeof fetch;
    const realTimeout = AbortSignal.timeout;
    let ms = 0;
    AbortSignal.timeout = (n: number) => {
      ms = n;
      return realTimeout.call(AbortSignal, 20);
    };
    try {
      await notifyProject(s.db, s.workspaceId, s.projectId, { text: "x" }, f);
    } finally {
      AbortSignal.timeout = realTimeout;
    }
    expect(ms).toBe(5000);
    expect((await failures(s))[0]!.data).toEqual({ reason: "timeout" });
  });
});
