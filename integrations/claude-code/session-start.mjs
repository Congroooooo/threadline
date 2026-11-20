#!/usr/bin/env node
// Claude Code SessionStart hook: prints the developer's open Threadline items so the session
// opens with them. Node built-ins only. It must never fail or slow a session: every error
// path prints nothing and exits 0, and nothing here ever prints the token.
import { execFile } from "node:child_process";

// Generous: a cold Worker plus a few database round trips can take a few seconds. Git calls
// keep their own short timeout.
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 64 * 1024; // a huge response must not flood the session

function git(args) {
  return new Promise((resolve) => {
    execFile("git", args, { timeout: 2000, windowsHide: true }, (err, stdout) => {
      resolve(err ? "" : String(stdout).trim());
    });
  });
}

/**
 * The remote URL without its userinfo: https://user:TOKEN@host/path becomes https://host/path,
 * so credentials stored in a remote never leave the machine. scp-like remotes (git@host:path)
 * carry no secret and are left alone. The server ignores userinfo when matching repositories.
 */
function stripCredentials(remote) {
  return remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, "$1");
}

async function main() {
  const base = process.env.THREADLINE_URL?.trim().replace(/\/+$/, "");
  const token = process.env.THREADLINE_TOKEN?.trim();
  if (!base || !token) return;
  let url;
  try {
    url = new URL(`${base}/api/agent/session-context`);
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  const repo = stripCredentials(await git(["remote", "get-url", "origin"]));
  if (!repo) return;
  const branch = await git(["branch", "--show-current"]);
  url.searchParams.set("repo", repo);
  if (branch) url.searchParams.set("branch", branch);

  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return;
  const bytes = new Uint8Array(await res.arrayBuffer()).subarray(0, MAX_BYTES);
  if (bytes.length > 0) process.stdout.write(bytes);
}

try {
  await main();
} catch {
  // Print nothing: a hook failure must not reach the session.
}
// Not process.exit(): it can cut off pending stdout writes. Let the process end on its own.
process.exitCode = 0;
