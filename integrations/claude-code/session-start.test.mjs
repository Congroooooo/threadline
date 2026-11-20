import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "session-start.mjs");
const TOKEN = "tl_secret_token_value_123";
const dirs = [];
const servers = [];

function gitRepo(remote, branch) {
  const dir = mkdtempSync(join(tmpdir(), "tl-hook-"));
  dirs.push(dir);
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", branch);
  if (remote) git("remote", "add", "origin", remote);
  return dir;
}

function notRepo() {
  const dir = mkdtempSync(join(tmpdir(), "tl-hook-plain-"));
  dirs.push(dir);
  return dir;
}

async function serve(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization });
    handler(req, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

function run(cwd, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [script], {
      cwd,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: process.env.HOME, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
  });
}

after(() => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("prints the server's text when the request succeeds", async () => {
  const body = "Open items\n- TL-1 something & <b>\n";
  const srv = await serve((_req, res) => res.writeHead(200, { "content-type": "text/plain" }).end(body));
  const repo = gitRepo("https://git.example/acme/app.git", "feature/x&y#z");
  const r = await run(repo, { THREADLINE_URL: `${srv.url}/`, THREADLINE_TOKEN: TOKEN });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, body);
  assert.equal(srv.requests.length, 1);
  const u = new URL(srv.requests[0].url, "http://x");
  assert.equal(u.pathname, "/api/agent/session-context");
  assert.equal(u.searchParams.get("repo"), "https://git.example/acme/app.git");
  assert.equal(u.searchParams.get("branch"), "feature/x&y#z");
  assert.equal(srv.requests[0].auth, `Bearer ${TOKEN}`);
});

test("prints nothing when the body is empty", async () => {
  const srv = await serve((_req, res) => res.writeHead(200).end(""));
  const repo = gitRepo("https://git.example/a/b.git", "main");
  const r = await run(repo, { THREADLINE_URL: srv.url, THREADLINE_TOKEN: TOKEN });
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""]);
});

test("prints nothing and exits 0 when the env vars are missing, the folder is not a git repo, or the server is unreachable", async () => {
  const srv = await serve((_req, res) => res.end("should not be printed"));
  const repo = gitRepo("https://git.example/a/b.git", "main");
  const cases = [
    [repo, {}],
    [repo, { THREADLINE_URL: srv.url }],
    [repo, { THREADLINE_TOKEN: TOKEN }],
    [notRepo(), { THREADLINE_URL: srv.url, THREADLINE_TOKEN: TOKEN }],
    [gitRepo(null, "main"), { THREADLINE_URL: srv.url, THREADLINE_TOKEN: TOKEN }],
    [repo, { THREADLINE_URL: "http://127.0.0.1:1", THREADLINE_TOKEN: TOKEN }],
    [repo, { THREADLINE_URL: "file:///etc/passwd", THREADLINE_TOKEN: TOKEN }],
    [repo, { THREADLINE_URL: "not a url", THREADLINE_TOKEN: TOKEN }],
  ];
  for (const [cwd, env] of cases) {
    const r = await run(cwd, env);
    assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""], JSON.stringify(env));
  }
  // Only the "no git repo" / "no origin" / env cases must never reach the server.
  assert.equal(srv.requests.length, 0);
});

test("prints nothing on a non-200 response", async () => {
  const srv = await serve((_req, res) => res.writeHead(401).end("Unauthorized token"));
  const repo = gitRepo("https://git.example/a/b.git", "main");
  const r = await run(repo, { THREADLINE_URL: srv.url, THREADLINE_TOKEN: TOKEN });
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""]);
});

test("prints a large body in full up to 64 KB and drops the rest", async () => {
  const big = "x".repeat(300 * 1024);
  const srv = await serve((_req, res) => res.writeHead(200).end(big));
  const repo = gitRepo("https://git.example/a/b.git", "main");
  const r = await run(repo, { THREADLINE_URL: srv.url, THREADLINE_TOKEN: TOKEN });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.length, 64 * 1024);
  const small = "y".repeat(60 * 1024);
  const srv2 = await serve((_req, res) => res.writeHead(200).end(small));
  const r2 = await run(repo, { THREADLINE_URL: srv2.url, THREADLINE_TOKEN: TOKEN });
  assert.equal(r2.stdout, small);
});

test("omits branch when HEAD is detached", async () => {
  const srv = await serve((_req, res) => res.end("ok"));
  const repo = gitRepo("https://git.example/a/b.git", "main");
  execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "--allow-empty", "-m", "x", "-q"], { cwd: repo });
  execFileSync("git", ["checkout", "-q", "--detach"], { cwd: repo });
  const r = await run(repo, { THREADLINE_URL: srv.url, THREADLINE_TOKEN: TOKEN });
  assert.equal(r.stdout, "ok");
  assert.equal(new URL(srv.requests[0].url, "http://x").searchParams.has("branch"), false);
});

test("gives up after 3 seconds", async () => {
  const srv = await serve(() => {});
  const repo = gitRepo("https://git.example/a/b.git", "main");
  const r = await run(repo, { THREADLINE_URL: srv.url, THREADLINE_TOKEN: TOKEN });
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""]);
  assert.ok(r.ms >= 2900, `returned too early: ${r.ms}ms`);
  assert.ok(r.ms < 6000, `took too long: ${r.ms}ms`);
});

test("never prints the token", async () => {
  const echoing = await serve((req, res) => res.writeHead(500).end(req.headers.authorization));
  const repo = gitRepo("https://git.example/a/b.git", "main");
  const outputs = [
    await run(repo, { THREADLINE_URL: echoing.url, THREADLINE_TOKEN: TOKEN }),
    await run(repo, { THREADLINE_URL: "http://127.0.0.1:1", THREADLINE_TOKEN: TOKEN }),
    await run(notRepo(), { THREADLINE_URL: echoing.url, THREADLINE_TOKEN: TOKEN }),
  ];
  for (const r of outputs) {
    assert.ok(!(r.stdout + r.stderr).includes(TOKEN));
    assert.equal(r.code, 0);
  }
});
