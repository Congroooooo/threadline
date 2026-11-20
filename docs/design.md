# Threadline: design

**One shared context. Every step connected.**

Status: draft for review · 2026-11-20

## 1. Purpose

Developers who build with AI coding agents coordinate today by pasting AI-written reports into direct messages. The information in those messages (which change pairs with which, what contract changed, what is blocked, who acts next) has no permanent home, and each person's agent starts without it.

Threadline gives a project one shared, structured record that people and their agents both read and write. An agent starting a session receives the approved requirements, the open handoffs addressed to its owner, and the current blockers, without anyone forwarding a message.

### Goals

- One trustworthy record per project of requirements, tasks, handoffs, decisions, blockers and evidence.
- Works for a solo developer or a team of any size, with the same code path.
- Not tied to any provider. Code host, spec source, ticket tracker and chat tool are each chosen per project.
- Works with any coding agent that speaks MCP.
- Every record says where it came from, and nothing AI-derived overrides an approved record.

### Non-goals (first version)

- Replacing the code host, CI, or chat tool.
- A spec editor. Specs are ingested, not authored here.
- A chat product. Discussion stays in the tools people already use; the platform stores pointers.
- Running or orchestrating agents. Agents run where they run today and call the platform.
- A plugin marketplace. Adapters are modules in this repository.

## 2. Principles

1. **Three levels of knowledge.** *Source* (what the client or PM actually provided), *approved record* (what the team agreed), *derived* (AI summaries and extractions). Derived content never silently changes an approved record; it creates a proposal. Search labels every hit `approved`, `record` (coordination facts stated by an actor, and source text) or `derived`.
2. **One authority per record kind per project.** A project configures where each kind of record is authoritative. Everything else is a mirror.
3. **Provider-neutral core.** The core stores no provider-specific fields. External things are referenced through one generic shape.
4. **Agents propose, people approve.** Agent write tools that touch approved records are proposal-only.
5. **Ingested content is untrusted.** Text from uploads, tickets, change-request descriptions and chat is data for agents, never instructions.
6. **Solo is a team of one.** No separate mode. Roles and approval rules are configuration.

## 3. Concepts

| Concept | Meaning |
|---|---|
| Workspace | Tenant boundary. One per team, agency client, or solo user. Nothing crosses it. |
| Member | A person in a workspace. |
| Role | A named set of permissions, defined per workspace. A member can hold several. |
| Agent identity | An agent acting under one member, limited to that member's permissions and to named projects. |
| Project | The boundary for all records about one piece of work. |
| Connection | A configured adapter instance, for example "GitHub repo `acme/web`" or "Mattermost channel". |
| Source | Something requirements came from: an uploaded file, a ticket link, or a path in a repo. |
| Snapshot | An unchangeable copy of a source at one moment, identified by content hash. |
| Requirement | One approved statement of what must be delivered, with a stable ID `<KEY>-R<n>` such as `ACME-R12` and a citation into a snapshot. |
| Task | A piece of work that implements one or more requirements, with a ref such as `ACME-12`. Has an owner role and optional dependencies. |
| Run | One attempt at a task by a person or agent. Its status is separate from the task's. |
| Handoff | A formal transfer between two parties: what was delivered, the evidence, what the recipient must do, and whether they acknowledged it. |
| Contract change | A recorded change to a shared interface that named consumers must acknowledge. |
| Blocker | Something stopping a task, with a stated cause (marked verified or suspected) and an owner for the next action. |
| Decision | An accepted technical or product decision with its reasoning and source, with a ref such as `ACME-D3`. Later decisions supersede earlier ones; none are deleted. |
| Evidence | Proof attached to a task or handoff: a change request, commit, test run, pipeline run or deployment. |
| Event | An append-only entry recording who or what changed which record, and when. |

### External references

Every link to something outside the platform uses one shape:

```ts
type ExternalRef = {
  connectionId: string;   // which configured adapter instance
  kind: "change_request" | "commit" | "pipeline_run" | "deployment" | "ticket" | "file" | "message";
  externalId: string;     // provider's own identifier
  url: string;
  version?: string;       // commit SHA, ticket updated-at, file hash
};
```

Neutral vocabulary: a *change request* is a GitLab merge request or a GitHub pull request; a *pipeline run* is a GitLab pipeline or a GitHub Actions run.

## 4. Adapters

The core depends on four interfaces, plus an optional fifth. Each adapter declares which optional capabilities it supports, and features that need a missing capability switch off for that project.

| Interface | Responsibility | First adapters | Later |
|---|---|---|---|
| `CodeHost` | Read change requests, changed files, pipeline runs, deployments and repository files; post comments and commit statuses; verify and normalize webhooks | GitLab (including self-hosted), GitHub (including Enterprise Server) | Bitbucket, Gitea |
| `SpecSource` | Fetch a source and return a snapshot plus extracted text with locations | File upload (PDF, DOCX, Markdown), ticket link, repo path | Google Docs, Notion |
| `Tracker` | Read tickets, detect changes, optionally mirror task status | GitLab issues, GitHub issues, through the same connections as the code host | Jira, Linear (with their own connection kind) |
| `Notifier` | Send a short pointer to a channel or person | Mattermost, Slack | email |
| `MemoryProvider` (optional) | Store approved records and recall them | none (default), Honcho over HTTP | others |

Sketch of the two most important interfaces:

```ts
interface CodeHost {
  capabilities: { commitStatus: boolean; comments: boolean; deployments: boolean };
  getChangeRequest(repo: RepoIdent, number: number): Promise<ChangeRequest>;
  listChangedFiles(repo: RepoIdent, number: number): Promise<{ files: ChangedFile[]; truncated: boolean }>;
  getPipelineRun(repo: RepoIdent, externalId: string): Promise<PipelineRun>;
  getFileText(repo: RepoIdent, path: string, ref: string): Promise<{ text: string; blobSha: string; size: number }>;
  setCommitStatus(repo: RepoIdent, sha: string, status: CommitStatus): Promise<void>;
  postComment(repo: RepoIdent, number: number, body: string): Promise<void>;
  verifyWebhook(headers: Headers, rawBody: Uint8Array, secret: WebhookSecret): Promise<boolean>;  // async: Web Crypto
  normalizeWebhook(headers: Headers, body: unknown): NormalizedEvent[];   // identifiers only; state is re-read
}

interface SpecSource<L> {                       // L: the locator for this kind (upload, ticket URL, repo path)
  fetch(locator: L): Promise<FetchedSource>;    // inline content, or an upload already staged in chunks
  hasChanged(locator: L, last: { contentHash: string; version: string | null }): Promise<boolean>;
}
```

The full `CodeHost` interface is in the Phase 2 plan. `verifyWebhook` takes a `WebhookSecret` because GitHub's HMAC needs the plaintext secret while GitLab compares a hash. The merge block is a required commit status (`threadline/contract`) on both hosts, so the capability is `commitStatus`.

Rules for adapters:

- Two adapters per interface ship in the first release that uses it (GitLab and GitHub; upload and ticket link). One adapter does not prove an interface is neutral.
- Webhook receivers verify the signature, deduplicate on the provider's delivery ID, tolerate out-of-order delivery, and re-read important state from the provider's API instead of trusting the payload.
- Adapters never write to core tables directly. They return normalized values; the core decides what to record.

### Per-project configuration

Repositories are linked to a project through connections. The rest is stored in `project_config`:

```yaml
project: ACME
authority:
  requirements: upload            # upload | ticket | repo_path
  tasks: platform                 # platform | tracker
code_host:
  sharedPaths: ["packages/shared/**"]
  consumerRoleKeys: [frontend]    # every consumer role must acknowledge
  ciOwnerRoleKey: lead            # owns blockers from failed runs with no task
tracker: { connectionId: <id>, mirrorStatus: true }    # or null
notifier: { kind: mattermost }    # webhook URL kept secret
approval:
  requirements: { roleKey: approver, count: 1 }
```

## 5. Members, roles and approval

- A workspace has a member list. There is no "team size" setting; the list is the configuration. People join through single-use invite links that carry the roles they will hold.
- Who may create a workspace on a shared deployment is limited by an allow-list; everyone else joins by invite.
- Roles are rows, not code. A workspace starts from templates (`owner`, `pm`, `lead`, `frontend`, `backend`, `approver`) and can create any number of new roles, choose each role's permissions, rename them, and archive them. Any member can be given any combination of roles, each either workspace-wide or limited to one project.
- Work is addressed to a role within a project ("the frontend owner"), and the platform resolves the role to members. No feature names a specific person.
- Approval rules are per workspace and per record kind: which role, and how many approvals.
- Solo: one member holds every role. The same approval rule applies and that member satisfies it. A handoff is then a transfer between that person's own sessions or agents.

Default permissions (a workspace can change them):

| Action | approver | other members | agent |
|---|---|---|---|
| Read project records | yes | yes | within its projects |
| Add a source, propose requirements | yes | yes | propose only |
| Approve requirements and decisions | yes | no | never |
| Create tasks, handoffs, blockers | yes | yes | yes |
| Acknowledge a handoff or contract change | recipient only | recipient only | never |
| Mark a task accepted | yes | no | never |

Permissions no agent can hold, whatever its member's roles: `handoff.ack`, `contract.ack`, `requirement.approve`, `decision.approve`, `task.accept`, `workspace.admin`.

## 6. Main flows

### 6.1 Source to approved requirements

1. A member uploads a file or pastes a ticket link.
2. The `SpecSource` adapter fetches it and stores a snapshot (original bytes, hash, extracted text with page or section locations). Text is extracted from uploaded PDF and DOCX files in the browser at upload time, so the server does no heavy processing.
3. The member's own agent reads the snapshot text through MCP and proposes candidate requirements, each citing its location in the snapshot. The platform runs no AI model of its own; it only stores data. A member can also enter requirements by hand.
4. A member with the approver role reviews, edits and approves. Approved requirements get stable IDs.
5. Tasks are created against requirements, each with an owner role and dependencies.

### 6.2 Source changes

1. A new upload or an edited ticket produces a new snapshot.
2. The platform diffs it against the previous one and proposes added, changed and removed requirements.
3. On approval, every task linked to a changed requirement is flagged for review and its owner is notified. Nothing is rewritten silently.

### 6.3 Handoff

1. A member or their agent calls `create_handoff` with the task, what was delivered, evidence references, known limits and the action required of the recipient role.
2. The notifier posts a one-line pointer to the project channel.
3. The recipient's next agent session starts with the open handoff in its context.
4. The recipient acknowledges, or returns it with "needs changes". Only a person can acknowledge.

### 6.4 Contract change

1. A project declares its shared interface paths (for example `packages/shared/**` or an OpenAPI file) and which roles consume them.
2. When a change request touches those paths, the code-host webhook produces a `contract.changed` record listing the changed files and the consumer roles.
3. Consumers must acknowledge it. The platform posts a commit status `threadline/contract`; where the repository requires that check (a GitHub ruleset, or GitLab "Pipelines must succeed"), the merge is blocked until they do. Otherwise it stays as an open item and a comment on the change request. On GitLab the status is attached when the webhook is processed, so a change request merged in the seconds between a push and that delivery is not blocked.
4. Recommended alongside, in the project's own CI: a committed public-API report for each shared package and an unused-export check. These run on any CI system and make additive changes visible in the diff.

### 6.5 Blocker from CI or deploy

1. A failed pipeline run or deployment arrives by webhook and is linked to its change requests and, through them, to tasks.
2. The platform opens a blocker with the observed facts. A cause entered by a person or agent is stored as *suspected* until someone marks it verified.
3. The blocker has an owner role for the next action and closes when a later run succeeds.

## 7. Agent interface (MCP)

One remote MCP server per deployment, authenticated per agent identity. The tool list stays small so it costs little context: eleven tools once every phase is built.

| Tool | Kind | Purpose | Added in |
|---|---|---|---|
| `get_task_context` | read | Requirements, decisions, dependencies, open handoffs, blockers and evidence for one task | Phase 1 (requirements from 3, decisions from 4) |
| `my_open_items` | read | Handoffs, contract changes, task reviews and blockers waiting on the caller's owner | Phase 1 |
| `search` | read | Keyword search across the project's records, each hit labelled `approved`, `record` or `derived` | Phase 1 (more kinds in 3 and 4) |
| `get_by_ref` | read | Everything linked to a change request, commit or ticket | Phase 1 |
| `report_progress` | write | Attach a progress note and evidence to a task | Phase 1 |
| `create_handoff` | write | Open a handoff to a role | Phase 1 |
| `raise_blocker` | write | Open a blocker with observed facts and suspected cause | Phase 1 |
| `get_contract_changes` | read | Contract changes in a project; a person acknowledges them in the UI | Phase 2 |
| `get_source_text` | read | List sources, or read one snapshot section by section with the locations to cite | Phase 3 |
| `propose_change` | proposal | Propose requirement changes (Phase 3) or, with `kind: "decision"`, a decision (Phase 4); a person approves | Phase 3 |
| `get_decisions` | read | Why something was decided: the current accepted decision, the ones it replaced, and its source | Phase 4 |

Tool counts: 7 after Phase 1, 8 after Phase 2, 10 after Phase 3, 11 after Phase 4.

Rules:

- The MCP server calls the same domain API the web UI uses. It has no direct database access.
- Every result marks ingested text as untrusted content and gives its source.
- No tool acknowledges, approves or accepts anything, and no tool name or description contains `ack`, `acknowledge` or `approve`.
- A session-start hook for supported agents fetches the open items and the task context for the current branch, so context arrives without the user asking.

## 8. Storage

Postgres is the only required datastore.

- **Tenancy:** every table has `workspace_id`. Row-level security is enabled and forced on every table, so the owner role cannot bypass it.
- **History:** current-state tables are updated in the same transaction as an append-only `events` row. Records are superseded, never deleted. A few bookkeeping tables (marked * below) are logs and are exempt.
- **Files:** uploaded sources are stored in Postgres behind a `BlobStore` interface, in 1 MiB chunks, capped at 10 MB each. Text is extracted in the browser; the server never parses PDF or DOCX. An S3-compatible store can replace Postgres later without touching callers.
- **Content hash:** a snapshot's hash is the SHA-256 of the concatenated SHA-256 digests of its 1 MiB chunks, so the server never hashes more than one chunk per request. It is not the plain SHA-256 of the file.
- **Live updates:** the web UI polls the events endpoint. The server holds no long-lived connections, so it runs on serverless hosting.
- **Search:** Postgres full-text (keyword) search only, with no embeddings; the calling agent does the interpretation. Every hit carries an authority label: `approved` (accepted decisions, approved requirements), `record` (tasks, handoffs, blockers, progress notes, contract changes, source text) or `derived` (proposed or rejected decisions, recalled memory).
- **Background work:** none required. Webhooks and notifications are handled within the request. Every handler is idempotent.

Tables, by the phase that adds them (* bookkeeping):

| Phase | Tables |
|---|---|
| 0 | `workspaces`, `users`, `user_identities`, `sessions`, `members`, `roles`, `member_roles`, `agent_identities`, `invites`, `projects`, `project_config`, `events` |
| 1 | `tasks`, `task_dependencies`, `runs`, `progress_notes`, `evidence`, `handoffs`, `blockers` |
| 2 | `connections`, `project_repos`, `webhook_deliveries`*, `pipeline_states`*, `contract_changes`, `acknowledgements` |
| 3 | `blobs`, `blob_chunks`*, `sources`, `snapshots`, `snapshot_sections`, `requirements`, `requirement_revisions`, `approvals`, `source_changes`, `task_requirements`, `task_reviews`, `external_refs` (with a `relation` column), `tracker_sync`* |
| 4 | `decisions`, `decision_links`, `change_request_stats`*, `manual_measures`, `workspace_memory`, `memory_sync`* |

## 9. Technology

| Layer | Choice | Reason |
|---|---|---|
| Language | TypeScript throughout | One language for core, adapters, MCP server and UI |
| API | Hono; schemas in zod shared with the UI | Runs unchanged on Cloudflare Workers and on Node |
| Database | Postgres 16+, accessed through Drizzle | Authority, history and search in one place; any Postgres host works |
| Web UI | React single-page app built with Vite | Static files, free to host anywhere |
| Agent interface | Official MCP TypeScript SDK, stateless streamable HTTP | Works with any MCP-capable agent |
| Sign-in | GitHub and GitLab OAuth (self-hosted GitLab supported) | No passwords to store; members already have these accounts |
| Hosting, free default | Cloudflare Workers (API and static UI) with Neon Postgres | Both have free plans that fit a small team |
| Hosting, self-hosted | One Docker Compose file running the same code on Node | For teams whose client agreements require their own infrastructure |

The platform makes no AI model calls, so it has no model costs. Each member's agent uses whatever model and provider that member already has.

Licensing: no AGPL code is embedded, so the platform can later be offered to others. Honcho (AGPL-3.0) can be connected as an optional memory service that the team runs itself; it is reached over HTTP only and no package depends on it.

### Why sign-in is required

The server is reachable over the internet and holds client specifications. Sign-in is what lets it (a) keep everyone outside the workspace out, (b) address a handoff to the right person and record who approved or acknowledged what, and (c) issue each agent a token limited to its owner's permissions. Without it, anyone with the URL could read the specs and write text that every agent on the team then reads.

A local mode (`AUTH_MODE=local`) skips sign-in and creates one local user. It only starts when the server's public URL is `localhost`.

## 10. Security

- **Isolation:** one workspace per team or client; forced row-level security; per-workspace storage prefixes.
- **Agent tokens:** scoped to one member and named projects, revocable, and unable to approve or acknowledge.
- **Prompt injection:** ingested text is stored and returned as quoted data with its source. Agent-facing tool results never present it as instructions. Proposal-only writes limit what an injected agent can change.
- **Secrets:** a redaction pass runs on everything written by agents and on webhook payloads before storage. Code-host tokens and webhook secrets are encrypted at rest with AES-GCM (`CREDENTIALS_KEY`) and never returned or exported.
- **Data minimization:** agents publish summaries and evidence, not full session transcripts.
- **Audit:** every write records the actor (member, agent identity or connection) in `events`.
- **Model provider:** the platform sends data to no model provider. Whatever a member's agent reads through MCP goes to that member's own provider, under that member's own terms. The one opt-in exception: when a workspace admin enables the optional memory service and gives consent, approved decisions and requirements are sent to it, and Honcho may process them with its own model provider. Handoffs, notes, blockers, contract changes and source files are never sent.

## 11. Build plan

| Phase | Delivers | Done when |
|---|---|---|
| 0. Skeleton | Workspace, members, roles, projects, events, auth, Docker Compose | A solo user and a two-member team can both sign in and create a project |
| 1. Handoffs and agent context | Tasks, handoffs, blockers, acknowledgements; MCP server with seven tools; session-start hook; Mattermost and Slack notifiers | A backend handoff appears in the frontend owner's next agent session with no message sent |
| 2. Code hosts | GitLab and GitHub adapters; webhooks; evidence linking; pipeline blockers; contract-change records and the merge check; `get_contract_changes` (eight tools) | A change to a declared shared path cannot merge unnoticed on either host |
| 3. Spec ingestion | Upload, ticket-link and repo-path sources; snapshots; browser extraction; approval; change diffs; trackers; `get_source_text` and `propose_change` (ten tools) | An uploaded spec becomes approved requirements with citations, and a re-upload flags affected tasks |
| 4. Decisions and recall | Decision records with supersession; keyword search across all record kinds with authority labels; optional memory service; measures page; workspace export and import; `get_decisions` (eleven tools) | An agent can answer "why was this decided" with a cited record |

Phase 1 comes before spec ingestion because handoffs are the pain felt today and they need nothing from the later phases.

### Measures

Taken before Phase 1 and again after each phase, from code-host data: time from a handoff to its acknowledgement, review rounds per change request, change-request cycle time, and the number of coordination messages sent by direct message. Review rounds are approximated as distinct commits pushed to a change request while it is open, because neither host's webhooks report review rounds directly. Direct-message counts are entered by hand.

## 12. Decisions (2026-11-20)

1. The platform owns tasks from Phase 1. Mirroring to an external tracker waits for the `Tracker` adapter in Phase 3.
2. Sign-in is through GitHub and GitLab OAuth, with a local mode for one person on their own machine.
3. Hosting must cost nothing: Cloudflare Workers and Neon free plans by default, Docker Compose as the self-hosted alternative. No billing or seat management is built.
4. The platform runs no AI model. Extraction and interpretation are done by each member's own agent through MCP.

Build order and prerequisites: [`roadmap.md`](roadmap.md).
