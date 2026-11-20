// `pnpm e2e`: an end-to-end check against a running Threadline (Docker, Node or Workers).
//
// Hosted (two members, each with an agent token made in the web UI beforehand):
//   pnpm e2e -- --url https://threadline.example.com --workspace <workspace id from the /w/<id> URL> \
//     --token-a tl_… --token-b tl_… --project KEY --task KEY-1 --role-b frontend \
//     [--repo <a repository URL configured on the project; default: this checkout's origin>]
//   Token A's member needs handoff.create on the project; token B's member holds role-b.
//   pnpm echoes a script's arguments, so prefer E2E_TOKEN_A and E2E_TOKEN_B in the
//   environment over --token-a and --token-b.
//
// Local (AUTH_MODE=local on localhost, e.g. `docker compose up`): every flag but --url is
// optional and the script makes its own setup. Local mode has a single user, so both tokens
// belong to one member who holds every role (backend and frontend included); the check is
// the same otherwise.
//
// Checks: /api/health is ok; token A creates a handoff to role-b over MCP; token B's
// session-context lists that handoff; token B gets 403 responding to it (agents can never
// accept a handoff) and MCP offers no tool to do so. Prints `E2E OK`, or `E2E FAIL: …` and
// exits 1.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const LOCAL_REPO = "https://git.example.com/threadline/e2e";

class Failure extends Error {}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Failure(message);
}

const { values: args } = parseArgs({
  // pnpm forwards the `--` separator of `pnpm e2e -- --url …`; drop it.
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    url: { type: "string" },
    workspace: { type: "string" },
    "token-a": { type: "string" },
    "token-b": { type: "string" },
    project: { type: "string" },
    task: { type: "string" },
    "role-b": { type: "string" },
    repo: { type: "string" },
  },
  strict: true,
});
args["token-a"] ??= process.env.E2E_TOKEN_A || undefined;
args["token-b"] ??= process.env.E2E_TOKEN_B || undefined;

type Setup = { workspaceId: string; tokenA: string; tokenB: string; project: string; task: string; roleB: string; repo: string };

let base: URL;
let origin: string;

async function request(
  method: string,
  path: string,
  opts: { cookie?: string; token?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = { origin };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  try {
    return await fetch(new URL(path, base), {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      redirect: "manual",
    });
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    throw new Failure(`cannot reach ${base.origin}: ${cause?.code ?? cause?.message ?? String(err)}`);
  }
}

async function expectJson<T = any>(res: Promise<Response>, status: number, what: string): Promise<T> {
  const r = await res;
  const text = await r.text();
  check(r.status === status, `${what}: expected HTTP ${status}, got ${r.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

/** Local mode: sign in as the local user and build a workspace, project, task and two tokens. */
async function localSetup(): Promise<Setup> {
  const signIn = await request("POST", "/auth/local");
  check(signIn.status === 200, `local sign-in: expected HTTP 200, got ${signIn.status} (is AUTH_MODE=local?)`);
  const session = signIn.headers.getSetCookie().find((c) => c.startsWith("tl_session="));
  check(session, "local sign-in set no tl_session cookie");
  const cookie = session.split(";")[0]!;

  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const { workspaceId } = await expectJson<{ workspaceId: string }>(
    request("POST", "/api/workspaces", { cookie, body: { name: `E2E check ${stamp}` } }), 201, "create workspace");
  const w = `/api/w/${workspaceId}`;
  const { id: projectId } = await expectJson<{ id: string }>(
    request("POST", `${w}/projects`, { cookie, body: { key: "E2E", name: "End-to-end check" } }), 201, "create project");
  await expectJson(request("PATCH", `${w}/projects/${projectId}/config`, { cookie, body: { repoUrls: [LOCAL_REPO] } }), 200, "set repository");
  const roles = await expectJson<{ id: string; key: string }[]>(request("GET", `${w}/roles`, { cookie }), 200, "list roles");
  const backend = roles.find((r) => r.key === "backend");
  check(backend, "the workspace has no backend role");
  const { ref } = await expectJson<{ ref: string }>(
    request("POST", `${w}/projects/${projectId}/tasks`, { cookie, body: { title: "End-to-end check task", ownerRoleId: backend.id } }),
    201, "create task");
  const token = async (name: string) =>
    (await expectJson<{ token: string }>(request("POST", `${w}/tokens`, { cookie, body: { name, projectIds: [projectId] } }), 201, `create token ${name}`)).token;
  return { workspaceId, tokenA: await token("e2e-agent-a"), tokenB: await token("e2e-agent-b"), project: "E2E", task: ref, roleB: "frontend", repo: LOCAL_REPO };
}

function hostedSetup(): Setup {
  const missing = (["workspace", "token-a", "token-b", "project", "task", "role-b"] as const).filter((k) => !args[k]);
  check(missing.length === 0, `hosted mode needs ${missing.map((k) => `--${k}`).join(", ")} (or no tokens at all, for AUTH_MODE=local)`);
  let repo = args.repo;
  if (!repo) {
    try {
      repo = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
    } catch {
      throw new Failure("--repo is required: a repository URL configured on the project (no git origin to default to)");
    }
  }
  return {
    workspaceId: args.workspace!, tokenA: args["token-a"]!, tokenB: args["token-b"]!,
    project: args.project!, task: args.task!, roleB: args["role-b"]!, repo,
  };
}

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: "threadline-e2e", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", base), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}

async function main(): Promise<void> {
  check(args.url, "--url is required, e.g. pnpm e2e -- --url http://localhost:8787");
  base = new URL(args.url);
  origin = base.origin;
  const local = !args["token-a"] && !args["token-b"];
  console.log(`Threadline e2e against ${origin} (${local ? "local mode: own setup" : "hosted mode"})`);

  const health = await expectJson<{ ok: boolean }>(request("GET", "/api/health"), 200, "GET /api/health");
  check(health.ok === true, "/api/health is not ok");
  console.log("ok  /api/health: database role is safe");

  const s = local ? await localSetup() : hostedSetup();
  if (local) console.log(`ok  local setup: workspace ${s.workspaceId}, task ${s.task}, two agent tokens`);

  const a = await mcpClient(s.tokenA);
  const b = await mcpClient(s.tokenB);
  try {
    const { tools } = await b.listTools();
    const names = tools.map((t) => t.name);
    check(!names.some((n) => /respond|accept|ack|approve/.test(n)), `MCP offers a tool agents must not have: ${names.join(", ")}`);
    console.log(`ok  MCP tools: ${names.join(", ")}`);

    const res = (await a.callTool({
      name: "create_handoff",
      arguments: {
        project: s.project,
        task: s.task,
        to_role: s.roleB,
        delivered: "End-to-end check: the API side is done",
        required_action: "Nothing; this handoff was created by the end-to-end check",
        idempotency_key: `e2e-${randomUUID()}`,
      },
    })) as { isError?: boolean; content: { type: string; text: string }[] };
    const text = res.content.map((c) => c.text).join("\n");
    check(!res.isError, `create_handoff with token A failed: ${text}`);
    const created = JSON.parse(text) as { handoffId: string; created: boolean };
    check(created.created && created.handoffId, `create_handoff returned ${text}`);
    console.log(`ok  token A created handoff ${created.handoffId} on ${s.task} to ${s.roleB} over MCP`);

    const ctx = await request("GET", `/api/agent/session-context?repo=${encodeURIComponent(s.repo)}`, { token: s.tokenB });
    const body = await ctx.text();
    check(ctx.status === 200, `session-context with token B: HTTP ${ctx.status} ${body.slice(0, 300)}`);
    check(body.includes(s.task), `token B's session-context does not mention ${s.task}:\n${body}`);
    const handoffs = body.split("\n\n").find((section) => section.startsWith("Handoffs waiting for your roles:")) ?? "";
    check(handoffs.includes(`- ${s.task} from `), `token B's session-context lists no handoff on ${s.task}:\n${body}`);
    console.log(`ok  token B's session-context lists the handoff on ${s.task}`);

    // Token B can use the workspace, so the 403 below is about responding, not a wrong workspace id.
    await expectJson(request("GET", `/api/w/${s.workspaceId}/projects`, { token: s.tokenB }), 200, "list projects with token B");
    const respond = await request("POST", `/api/w/${s.workspaceId}/handoffs/${created.handoffId}/respond`, {
      token: s.tokenB,
      body: { response: "accepted" },
    });
    check(respond.status === 403, `respond with token B: expected HTTP 403, got ${respond.status} ${(await respond.text()).slice(0, 300)}`);
    console.log("ok  token B cannot respond to the handoff (403): only people accept handoffs");
  } finally {
    await Promise.allSettled([a.close(), b.close()]);
  }
  console.log("E2E OK");
}

main().catch((err) => {
  console.error(`E2E FAIL: ${err instanceof Failure ? err.message : (err as Error)?.stack ?? String(err)}`);
  process.exit(1);
});
