<p align="center"><img src="docs/brand/logo.png" alt="Threadline logo" width="160"></p>

# Threadline

One shared context. Every step connected.

Threadline is a shared, structured record of requirements, tasks, handoffs and blockers that people and their AI coding agents both read and write, for a solo developer or a team. It makes no AI model calls itself: agents connect to it over MCP with their own token, and people use the web app.

## What it does today (Phase 1)

- **Workspaces, members and roles.** Sign in with GitHub or GitLab, create a workspace, invite people with a one-time code, and give them roles (`owner`, `pm`, `lead`, `frontend`, `backend`, `approver`, or your own), workspace-wide or per project.
- **Projects and tasks.** Each project has a key (`ACME`), so tasks get refs like `ACME-12`. Tasks have an owning role, an optional branch, dependencies, a status and progress notes with evidence links.
- **Handoffs.** One role hands work to another: what was delivered, what the next role must do, known limits and evidence. Only people accept a handoff or send it back, in the Inbox.
- **Blockers.** Anyone can raise a blocker on a task or a whole project and name the role that owns it; people record the cause and resolve it.
- **Chat pointers.** A project can post a one-line pointer (never the text itself) to a Mattermost or Slack incoming webhook when a handoff or blocker is created.
- **Agent tokens and MCP.** Each person creates tokens for their agents, limited to chosen projects. Agents use the MCP endpoint at `/mcp` to read their open items, task context, search and evidence lookups, and to report progress, create handoffs and raise blockers. Agents can never accept handoffs or approve anything: that is enforced in the permission check, not in role data.
- **Session start for Claude Code.** A small hook prints your open items when a session opens in one of your projects' repositories.
- **Safety.** Every table has forced row-level security, free text is capped and scrubbed of anything that looks like a secret, text from other people reaches agents marked as untrusted, and records are never deleted.

## Hosting

There are two ways to run Threadline. Both run the same code.

### Option A: Cloudflare Workers and Neon (free plans)

The Worker serves the API and the built web app as static assets; Neon provides Postgres.

1. **Neon.** Create a project with a database named `threadline`. The connection string Neon shows you uses the owner role: that one is your `MIGRATION_DATABASE_URL`.
2. **The `app_user` role.** In the Neon console's SQL Editor, as the owner, run:

   ```sql
   CREATE ROLE app_user LOGIN PASSWORD '<a long random password>' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
   ```

   The running app always connects as `app_user`, which owns no tables, so forced row-level security applies to every query. Do not give the Worker the owner's connection string: the app refuses to start, and `GET /api/health` reports an error, when its role is a superuser, has `BYPASSRLS` or owns tables. Migration `0001` only creates `app_user` (without a password) where it is missing.
3. **Migrate**, from a checkout on your machine:

   ```sh
   pnpm install
   MIGRATION_DATABASE_URL='postgres://<owner>:<password>@<host>/threadline?sslmode=require' pnpm migrate
   ```

   Run it again after pulling new migrations. It records what it applied in `_migrations` and skips those.
4. **Secrets.** From `apps/api`, run `pnpm exec wrangler login`, then `pnpm exec wrangler secret put <KEY>` for each variable in [Configuration](#configuration) that you use. `DATABASE_URL` is the `app_user` connection string. Never put values in `wrangler.jsonc`, which is committed.
5. **Deploy**, from the repository root:

   ```sh
   pnpm run deploy
   ```

   This builds `apps/web`, then runs `wrangler deploy`. `/api/*`, `/auth/*` and `/mcp` go to the Worker; every other path is the web app. (Use `pnpm run deploy`: plain `pnpm deploy` is a built-in pnpm command.) Set `PUBLIC_URL` to the Worker's URL, register the OAuth callbacks (below), and deploy again if you changed anything.
6. **Check** with `curl https://<your-worker>/api/health` (expect `{"ok":true}`) and the [end-to-end check](#end-to-end-check).

### Option B: Docker Compose (self-hosted)

```sh
docker compose up -d --build
```

This starts Postgres 16, applies the migrations as the database owner, and starts Threadline on Node at <http://localhost:8787> with `AUTH_MODE=local` (one local user, no sign-in provider). The Postgres init script creates `app_user` with a password, and the app connects as `app_user`, never as the owner.

To serve a team, put these in a `.env` file next to `docker-compose.yml` (it is ignored by git) before the first start, and put Threadline behind an HTTPS reverse proxy:

```sh
POSTGRES_PASSWORD=<long random password>   # the owner role, used only by the migrate service
APP_USER_PASSWORD=<long random password>   # the app's role
PUBLIC_URL=https://threadline.example.com
AUTH_MODE=oauth
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
WORKSPACE_CREATORS=github:<your-login>
# THREADLINE_PORT=8787                     # host port, if 8787 is taken
```

The two passwords only take effect when the database volume is first created. `docker compose down` stops everything and keeps the data; `docker compose down -v` deletes it.

## Configuration

The API reads these from Worker secrets, from `process.env` on Node (Docker sets them from `.env`), or from `apps/api/.dev.vars` under `wrangler dev` (copy [`apps/api/.dev.vars.example`](apps/api/.dev.vars.example)).

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string for the `app_user` role, never the owner. |
| `PUBLIC_URL` | yes | Where people open Threadline, as an origin with no path, such as `https://threadline.example.com`. Must be https unless it is localhost. OAuth callbacks and the cross-origin check use it. |
| `AUTH_MODE` | no | `oauth` (default) or `local`. `local` signs anyone in as a single local user without a password, so it is refused unless `PUBLIC_URL` is localhost. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | no | A GitHub OAuth app. Leave empty to turn GitHub sign-in off. |
| `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET` | no | A GitLab OAuth application. Leave empty to turn GitLab sign-in off. |
| `GITLAB_BASE_URL` | no | Your self-managed GitLab, such as `https://gitlab.example.com`. Defaults to `https://gitlab.com`. |
| `WORKSPACE_CREATORS` | no | Who may create workspaces, comma-separated: `github:<login>,gitlab:<username>`. Empty means anyone who signs in. Everyone else joins by invite. Logins can be renamed, so review this list when someone renames their account. |

Used only outside the app:

| Variable | Used by | Meaning |
|---|---|---|
| `MIGRATION_DATABASE_URL` | `pnpm migrate` | The owner role's connection string. Never give it to the Worker. |
| `POSTGRES_PASSWORD`, `APP_USER_PASSWORD`, `THREADLINE_PORT` | Docker Compose | See Option B. |
| `PORT` | Node entry | Port to listen on (default 8787). |

## Sign-in providers

Use at least one in `oauth` mode. The callback URL is always `<PUBLIC_URL>/auth/<provider>/callback`.

- **GitHub**: Settings → Developer settings → OAuth Apps → New OAuth App. Homepage URL: your `PUBLIC_URL`. Authorization callback URL: `<PUBLIC_URL>/auth/github/callback`. Copy the client ID, generate a client secret, and set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.
- **GitLab**: User settings (or a group's or the instance's admin settings) → Applications → Add new application. Redirect URI: `<PUBLIC_URL>/auth/gitlab/callback`. Check **Confidential** and the scope `read_user`. Set `GITLAB_CLIENT_ID` (the Application ID), `GITLAB_CLIENT_SECRET`, and `GITLAB_BASE_URL` for a self-managed instance.

## Connecting an agent

In Threadline open **Tokens**, create a token for the projects the agent may work in, and copy it (it is shown once). Then point the agent's MCP client at `<PUBLIC_URL>/mcp` with the header `Authorization: Bearer tl_…`. For Claude Code, including the session-start hook, follow [`integrations/claude-code/README.md`](integrations/claude-code/README.md).

Add each repository's URL to its project's settings, so the hook knows which project a checkout belongs to.

## End-to-end check

`pnpm e2e` runs one handoff through a running deployment: agent A creates a handoff over MCP, agent B's session-start context lists it, and agent B is refused (403) when it tries to accept it. It prints `E2E OK`.

```sh
# Local mode (Docker Compose, or the Node entry with AUTH_MODE=local): the script makes its own setup.
pnpm e2e -- --url http://localhost:8787

# Hosted: two members, each with an agent token made in the web UI; member B holds role-b.
E2E_TOKEN_A=tl_... E2E_TOKEN_B=tl_... pnpm e2e -- --url https://threadline.example.com \
  --workspace <id from the /w/<id> address> --project ACME --task ACME-1 --role-b frontend \
  --repo <a repository URL in the project's settings; default: this checkout's origin>
```

Local mode has one user, so there both tokens belong to one member who holds every role. `--token-a` and `--token-b` also work, but pnpm prints a script's arguments, so the environment variables keep tokens out of your terminal history.

## Local development

You need Node 22 or later and pnpm (the version in `package.json`'s `packageManager`; `corepack enable` picks it up).

```sh
pnpm install
pnpm test        # every package; the database tests use an in-process Postgres (PGlite), no Docker needed
pnpm typecheck
```

To run the app, copy `apps/api/.dev.vars.example` to `apps/api/.dev.vars` and set `PUBLIC_URL=http://localhost:5173` and `AUTH_MODE=local`. Then `pnpm dev` starts the API under `wrangler dev` on port 8787 and the web app under Vite on port 5173, which proxies `/api` and `/auth` to the API, so open <http://localhost:5173>. `wrangler dev` uses the Neon driver, so its `DATABASE_URL` must be a Neon database (a development branch works). With a plain local Postgres, run the Node entry instead of `wrangler dev`:

```sh
# migrate as the owner, then start the API as app_user
MIGRATION_DATABASE_URL=postgres://<owner>@localhost:5432/threadline pnpm migrate
DATABASE_URL=postgres://app_user:<password>@localhost:5432/threadline PUBLIC_URL=http://localhost:5173 AUTH_MODE=local \
  pnpm --filter @threadline/api start
pnpm --filter @threadline/web dev
```

Layout: `packages/core` (domain logic, database, migrations), `apps/api` (Hono API and MCP server; `src/worker.ts` for Workers, `src/node.ts` for Node), `apps/web` (React web app), `integrations/claude-code` (session-start hook), `scripts` (`migrate`, `e2e`).

CI (`.github/workflows/ci.yml`) runs install, typecheck and tests, and a gitleaks secret scan on every push and pull request. The repository is public: never commit secrets, `.dev.vars` or `.env` files.

## License

[Apache-2.0](LICENSE).
