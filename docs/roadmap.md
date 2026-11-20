# Threadline: roadmap

2026-11-20 · Design: [`design.md`](design.md)

This is the start-to-finish plan. Each phase ends with working software that the team can use. All four detailed implementation plans are written and form one build sequence (Tasks 1–64, migrations 0001–0022). Before a phase starts, its plan is checked against the code that actually exists by then.

| Phase | Detailed plan |
|---|---|
| 0 and 1 | [`superpowers/plans/2026-11-20-core-and-handoffs.md`](superpowers/plans/2026-11-20-core-and-handoffs.md) (Tasks 1–15, migrations 0001–0007) |
| 2 | [`superpowers/plans/2026-11-20-phase-2-code-hosts.md`](superpowers/plans/2026-11-20-phase-2-code-hosts.md) (Tasks 16–31, migrations 0008–0013) |
| 3 | [`superpowers/plans/2026-11-20-phase-3-spec-ingestion.md`](superpowers/plans/2026-11-20-phase-3-spec-ingestion.md) (Tasks 32–49, migrations 0014–0018) |
| 4 | [`superpowers/plans/2026-11-20-phase-4-decisions-recall.md`](superpowers/plans/2026-11-20-phase-4-decisions-recall.md) (Tasks 50–64, migrations 0019–0022) |

## Before any code

Everything here must be done before Phase 0 starts, so the build does not stop to wait for an account or a decision.

### Decisions to confirm with the team

- [x] Name "Threadline", tagline "One shared context. Every step connected.", logo in `docs/brand/logo.png`.
- [ ] The default role templates: `owner`, `pm`, `lead`, `frontend`, `backend`, `approver`.
- [ ] The pilot project, and which two members (one frontend, one backend) try it first.
- [x] Code lives in the public repository `github.com/Congroooooo/threadline`.
- [x] Licence: Apache-2.0.
- [ ] Who is listed in `WORKSPACE_CREATORS` on the shared deployment.

### Checks on terms

- [ ] Cloudflare's free plan terms allow use for client work. Vercel's Hobby plan does not allow commercial use, which is why it is not the default.
- [ ] Your client agreements allow specification text to be stored on Neon and Cloudflare. If any do not, use the Docker Compose path on your own machine for that client.

### Accounts and credentials (all free)

- [x] Cloudflare account, for the API and the web UI.
- [x] Neon account.
- [ ] A Neon project with database `threadline` and a role `app_user` (done in Task 15 if not before).
- [ ] `wrangler login` and `gh auth login` on the build machine.
- [ ] A GitHub OAuth app, giving a client ID and secret. Its callback URL is known only after the first deploy, so create it during Task 15.
- [ ] A GitLab OAuth application on your GitLab instance, giving an application ID and secret.
- [ ] A Mattermost incoming webhook pointing at a test channel.

### Local tools

- [ ] Node 22 or later, pnpm 9 or later, and git. Docker is not needed; tests use an in-process Postgres.
- [ ] Secrets go in `apps/api/.dev.vars`, which is ignored by git.

### Baseline, taken once before Phase 1 ships

- [ ] For the last 20 merged change requests on the pilot project: cycle time, number of review rounds, and how many coordination direct messages were sent. These are the numbers the platform has to beat.

## Free hosting limits to watch

| Service | Free allowance | What happens at the limit |
|---|---|---|
| Cloudflare Workers | 100,000 requests a day, 10 ms of CPU per request | Requests fail until midnight UTC. A team of ten polling every 15 seconds for eight hours uses about 19,000. |
| Neon Postgres | About 1 GB of storage and 100 compute-hours a month per project | The database stops until the next month. It sleeps when idle, so the first request after a pause takes about a second. |

These figures came from vendor pages and third-party summaries in November 2026 and change often. Confirm them on the vendors' pricing pages when creating the accounts.

## Phases

### Phase 0: skeleton

Delivers the repository, database with forced row-level security, the event log, workspaces, members, roles, sign-in, agent tokens and projects.

Exit check: a solo user in local mode and a two-member team signed in through OAuth can each create a project, and a member of one workspace cannot read anything in another.

### Phase 1: handoffs and agent context

Delivers tasks, runs, handoffs, acknowledgements, blockers, the context queries, the Mattermost and Slack notifiers, the HTTP API, the MCP server with seven tools, the web UI, the session-start hook, and deployment.

Exit check: the backend developer's agent creates a handoff to the frontend role; a pointer appears in the team's chat channel; the frontend developer's next agent session opens with that handoff in context; they acknowledge it in the UI. No direct message is sent.

Then the team uses it on the pilot project for two weeks before Phase 2 starts. What they stop using or work around decides what Phase 2 changes.

### Phase 2: code hosts

- `CodeHost` interface with GitLab (including self-hosted) and GitHub (including Enterprise Server) adapters, passing one shared adapter test suite.
- `connections` table with tokens and webhook secrets encrypted at rest (`CREDENTIALS_KEY`); repositories linked to projects through `project_repos`, with shared paths, consumer roles and a CI owner role per project.
- Webhook receiver at `/hooks/:workspaceId/:connectionId`: signature check, de-duplication by delivery ID, re-read of state from the provider, secret redaction before storage, and a recent-deliveries log.
- Evidence linked automatically: a change request that names a task ref is attached to that task.
- Pipeline and deployment failures open blockers; a later success of the same check closes them.
- Contract changes: declared shared paths, consumer roles, acknowledgement by a person, and a `threadline/contract` commit status that blocks the merge where the repository requires it. On GitLab the status is attached when the webhook is processed, so a change request merged in the seconds between a push and that delivery is not blocked.
- Contract changes in the inbox, in `my_open_items` and the session context, and in the new MCP tool `get_contract_changes` (eight tools).
- Ready-made CI snippets for GitHub Actions and GitLab CI that a project adds to its own repository: a public-API report check and an unused-export check.

Exit check: on both a GitLab and a GitHub test repository, a change request touching a declared shared path creates an open item for the consumer role and cannot merge until a person acknowledges it.

Needs before it starts: a test repository on each host, and permission to add webhooks to the pilot project's repository.

### Phase 3: spec ingestion

- `SpecSource` interface with upload (PDF, DOCX, Markdown), ticket-link and repo-path adapters; `Tracker` interface with GitLab and GitHub issue adapters, using the existing code-host connections.
- Original files stored through `BlobStore` in 1 MiB chunks, with text extracted in the browser; immutable, content-hashed snapshots split into sections.
- MCP tools `get_source_text` and `propose_change` (ten tools); a review screen where an approver edits and approves proposed requirements under the project's approval rule.
- Requirement IDs `<KEY>-R<n>`, revisions, and links from tasks to requirements.
- A new snapshot of an authoritative source produces a section diff and proposals; approving them flags exactly the linked tasks for review.
- Tickets as sources, refreshed by webhook; optional mirroring of task status to the tracker, or the tracker as the authority for "done".

Exit check: the PM uploads a specification; an agent proposes requirements with citations; an approver approves them; a second upload with one changed section flags exactly the tasks linked to that section.

Needs before it starts: two or three real past specifications from the PM, with client details removed, to test against. They stay in the git-ignored `research_notes/`.

### Phase 4: decisions and recall

- Decision records (`<KEY>-D<n>`) with supersession, proposed by agents through `propose_change` with `kind: "decision"` and accepted by people holding `decision.approve`; MCP tool `get_decisions` (eleven tools).
- Keyword search across every record kind, with each hit labelled `approved`, `record` or `derived`.
- An optional memory service (self-hosted Honcho over HTTP), off until an admin consents. Only approved decisions and requirements are sent.
- A measures page showing the baseline numbers against current ones. Review rounds are approximated as distinct commits pushed while a change request is open; direct-message counts are entered by hand.
- Export of a whole workspace to a file and import into another deployment, through `pnpm export` and `pnpm import`, for backups and for moving between free hosting and self-hosting. Secrets are never exported.

Exit check: an agent asked why something was built a certain way returns the decision record and its source.

## How each phase is run

1. Check the phase's detailed plan against the code as it stands, and update it where they differ.
2. Build task by task. Each task has its tests written first and is committed on its own.
3. Run the exit check with the real team on the pilot project.
4. Record what was learned at the bottom of that phase's plan, then revise the next plan.
