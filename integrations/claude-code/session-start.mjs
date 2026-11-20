#!/usr/bin/env node
// Claude Code SessionStart hook: prints the developer's open Threadline items so the session
// opens with them. Node built-ins only. It must never fail or slow a session: every error
// path prints nothing and exits 0, and nothing here ever prints the token.
import { execFile } from "node:child_process";

const TIMEOUT_MS = 3000;

function git(args) {
  return new Promise((resolve) => {
    execFile("git", args, { timeout: 2000, windowsHide: true }, (err, stdout) => {
      resolve(err ? "" : String(stdout).trim());
    });
  });
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

  const repo = await git(["remote", "get-url", "origin"]);
  if (!repo) return;
  const branch = await git(["branch", "--show-current"]);
  url.searchParams.set("repo", repo);
  if (branch) url.searchParams.set("branch", branch);

  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return;
  const body = await res.text();
  if (body) process.stdout.write(body);
}

try {
  await main();
} catch {
  // Print nothing: a hook failure must not reach the session.
}
process.exit(0);
