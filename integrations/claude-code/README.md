# Claude Code integration

Two pieces connect a coding agent to Threadline:

- **MCP server**: gives the agent Threadline's tools.
- **Session-start hook** (Claude Code only): prints your open Threadline items when a session opens, so the agent starts with them.

The hook is one file, `session-start.mjs`. It uses only Node built-ins (Node 22 or later), so there is nothing to install. It works on Windows, macOS and Linux.

## 1. Create a token

In Threadline open **Agent tokens**, create a token for the projects the agent may work in, and copy it (it is shown once). Set these in the environment the agent runs in:

```sh
export THREADLINE_URL=https://your-threadline.example   # origin only, no trailing path
export THREADLINE_TOKEN=tl_...
```

On Windows PowerShell: `$env:THREADLINE_URL = "https://..."` and `$env:THREADLINE_TOKEN = "tl_..."`.

## 2. Connect the MCP server

Add to `.mcp.json` in your project (Claude Code expands `${VAR}` from the environment):

```json
{ "mcpServers": { "threadline": { "type": "http", "url": "${THREADLINE_URL}/mcp",
    "headers": { "Authorization": "Bearer ${THREADLINE_TOKEN}" } } } }
```

## 3. Add the session-start hook (Claude Code)

Copy `integrations/claude-code/session-start.mjs` to your project's `.claude/hooks/threadline-session-start.mjs`, then add to `.claude/settings.json`:

```json
{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command",
    "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/threadline-session-start.mjs\"" } ] } ] } }
```

`$CLAUDE_PROJECT_DIR` is expanded by Claude Code to the project root.

(Unverified: this `$CLAUDE_PROJECT_DIR` form was written without checking the current Claude Code hooks documentation. Check it there if the hook does not run.)

Inside a checkout of Threadline itself the script can instead be referenced by its repo-relative path: `"command": "node integrations/claude-code/session-start.mjs"`.

### What the hook does

It runs `git remote get-url origin` and `git branch --show-current`, then requests `GET /api/agent/session-context` with your token, and prints the response exactly as received. Claude Code adds a SessionStart hook's output to the session.

It stays quiet and never fails the session. It prints nothing, and exits 0, when `THREADLINE_URL` or `THREADLINE_TOKEN` is unset, the URL is not http(s), the folder is not a git repository with an `origin`, the server is unreachable, answers with an error, or takes longer than 3 seconds, or when the repository does not belong to one of the token's projects. It never prints the token.

## Other MCP-capable agents

These get the Threadline tools but no session-start hook. The settings below come from memory of each client's format and were not checked against current docs: check your client's docs. Each reads the token from `THREADLINE_TOKEN`.

**Codex CLI** (`~/.codex/config.toml`; check your client's docs):

```toml
[mcp_servers.threadline]
url = "https://your-threadline.example/mcp"
bearer_token_env_var = "THREADLINE_TOKEN"
```

**Cursor** (`.cursor/mcp.json`; check your client's docs):

```json
{ "mcpServers": { "threadline": { "url": "https://your-threadline.example/mcp",
    "headers": { "Authorization": "Bearer ${env:THREADLINE_TOKEN}" } } } }
```

**OpenCode** (`opencode.json`; check your client's docs):

```json
{ "mcp": { "threadline": { "type": "remote", "url": "https://your-threadline.example/mcp",
    "headers": { "Authorization": "Bearer {env:THREADLINE_TOKEN}" } } } }
```

## Tests

`pnpm test` at the repository root runs them, or `node --test integrations/claude-code/session-start.test.mjs`. They use a local HTTP server; no network.
