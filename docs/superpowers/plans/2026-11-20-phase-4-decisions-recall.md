# Decisions and Recall (Phase 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent asked why something was built a certain way calls one MCP tool and gets back the accepted decision record, the decisions it replaced, and the source each one cites. Around that: search across every record kind, an optional external memory service, a measures page comparing baseline numbers with current ones, and whole-workspace export and import.

**Architecture:** `packages/core/src/decisions.ts` holds decision records. They have a proposed, accepted, superseded and rejected lifecycle, with `supersedes_id` chains walked by a recursive CTE, and they are read through `getDecisions`. `search.ts` replaces the Phase 1 search with one `UNION ALL` over generated `tsvector` columns on seven record kinds, and every hit carries an authority level. `memory/` defines a `MemoryProvider` (no-op by default) and one HTTP adapter for a self-hosted Honcho. Approved records are pushed on request, never by a background worker, and recalled items are appended to search as derived, quoted hits. `measures.ts` computes medians in SQL on request from tables and events that already exist, plus one new bookkeeping table fed by a third webhook handler. Export and import live in `portability/` as platform-neutral functions over line streams. They run only from two Node CLI scripts against the database URL, never in a Worker request.

**Tech Stack:** As Phases 0–3 (Node 22, pnpm 9, TypeScript 5 strict, Hono 4, Drizzle, Postgres 16 / PGlite, zod, MCP TypeScript SDK with `@hono/mcp`, React 19, Vite, TanStack Query, Vitest, Wrangler, Web Crypto). Adds `node:zlib` and `node:readline`, in `scripts/` only. No chart library, no Honcho package, no embedding library.

**Spec:** [`docs/design.md`](../../design.md) principles §2, Decision in §3, §7, §8, §10, and §11 "Measures". Scope and exit check: [`docs/roadmap.md`](../../roadmap.md) Phase 4. Builds on [`2026-11-20-core-and-handoffs.md`](2026-11-20-core-and-handoffs.md) (Tasks 1–15, migrations 0001–0007) and [`2026-11-20-phase-2-code-hosts.md`](2026-11-20-phase-2-code-hosts.md) (Tasks 16–31, migrations 0008–0013), and [`2026-11-20-phase-3-spec-ingestion.md`](2026-11-20-phase-3-spec-ingestion.md) (Tasks 32–49, migrations 0014–0018), with each plan's "Changes to earlier code" applied. The Phase 3 names this plan uses are listed in "Phase 3 names used".

## Global Constraints

Copied from Phases 0–3 (still binding):

- No AI model calls anywhere in the platform.
- No provider-specific column in any core table. External things use `ExternalRefInput`.
- Product name `Threadline`, tagline `One shared context. Every step connected.`, package scope `@threadline/*`.
- Every table has `ENABLE` and `FORCE ROW LEVEL SECURITY` with the standard workspace policy. `assertAllTablesHaveForcedRls` covers every new table.
- All database access goes through `withWorkspace` (or `withSystem` for cross-workspace lookups). `apps/*` never imports Drizzle tables directly.
- Every mutation in `core` calls `recordEvent` in the same transaction, except for the bookkeeping tables (Phase 2 and Phase 3 lists, plus the two added below).
- Free text written by any actor is capped at 10,000 characters, passed through `redactSecrets` before storage, and returned to agents as `Quoted`.
- Code runs on Cloudflare Workers and Node. No Node-only APIs in `packages/core` or `apps/api/src` outside `apps/api/src/node.ts`, except in `scripts/`, which is Node-only. No long-lived connections, no background workers. Web Crypto only.
- The repository is public. No secrets, client names or client data in any committed file, including fixtures.
- Records are never deleted. Changes happen through status changes and supersession only.
- IDs are UUID v7 from `newId()`.
- Neutral vocabulary: change request, pipeline run, deployment.
- Secrets (connection credentials, webhook secrets, notifier URLs, tokens) are never returned by any route, MCP tool, view, event, error or export.

Added in Phase 4:

- `decision.propose` and `decision.approve` have been in `Permission`, and `decision.approve` in `HUMAN_ONLY`, since Phase 0 Task 2: `HUMAN_ONLY = ["handoff.ack", "contract.ack", "requirement.approve", "decision.approve", "task.accept", "workspace.admin"]`. The Phase 0 role templates already grant them (Task 4).
- An accepted decision's text never changes. A change is a new decision whose `supersedes_id` points at it. A decision is superseded by at most one accepted decision, enforced by a unique partial index.
- Decision refs are `<project key>-D<number>`, for example `ACME-D3`. They are numbered per project, separately from tasks (`ACME-12`) and requirements (`ACME-R12`).
- Search is Postgres full-text only: generated `tsvector` columns named `tsv`, GIN indexes, `websearch_to_tsquery('simple', $1)`, `ts_headline` snippets. No embeddings and no semantic search.
- Authority levels on every search hit and decision view: `"approved"` (an accepted decision, an approved requirement), `"record"` (tasks, handoffs, blockers, progress notes, contract changes, which are coordination facts stated by an actor, and source sections, which are what the client or PM provided), and `"derived"` (proposed or rejected decisions and requirements, recalled memory). `"derived"` is the lowest level and always comes last when ranks tie.
- Memory service. A workspace sends nothing until an admin enables a provider with `consent: true`. Only accepted or superseded decisions and approved requirements are sent. Handoffs, notes, blockers, contract changes and source text are never sent. Honcho is AGPL-3.0, so it is reached over HTTP only, and no `package.json` in the repository may depend on a package whose name contains `honcho`. Recalled text is never stored in core tables. It reaches people and agents only as a `Quoted` hit with authority `"derived"`.
- Memory API keys are encrypted with `encryptSecret` using the existing `CREDENTIALS_KEY`, with AAD `memory:<workspaceId>`. Memory base URLs pass `validateBaseUrl(url, deps.allowPrivateHosts)`. The flag `ALLOW_PRIVATE_CODE_HOSTS` governs memory hosts too.
- `memory_sync` and `change_request_stats` are bookkeeping tables, exempt from `recordEvent`.
- Measures are computed in SQL on request and never stored as aggregates. Agents cannot read them, and no MCP tool exposes them.
- Export and import run only through `pnpm export` and `pnpm import` on Node. No HTTP route exports or imports a workspace. Export files are named `threadline-export-*` and are git-ignored.
- MCP tool descriptions must not match `/ack|acknowledge|approve/`, because the Phase 1 and Phase 2 tests forbid it. Write "accept" instead.

## Phase 3 names used

Phase 4 uses these names exactly as the Phase 3 plan defines them.

| Phase 3 item | Shape used here | Used in |
|---|---|---|
| `sources`, `snapshots`, `snapshot_sections` | `sources(id, project_id, kind, status, latest_snapshot_id)`; `snapshots(id, source_id, seq, status)`; `snapshot_sections(snapshot_id, key, location, text, tsv)` | `decisions.ts` (snapshot sources), `search.ts` (source hits) |
| `CitationInput`, `CitationView`, `checkCitation` | `CitationInput = { sourceId; snapshot (seq); section (key); excerpt? }`; `checkCitation(tx, { projectId, citation, authoritativeOnly })` (Task 38) | `decisions.ts` |
| `requirements` | `requirements(id, project_id, number, status, approved_revision_id, revision, updated_at)`. There is no `ref` or `text` column: the ref is `formatRequirementRef(projectKey, number)` and the text is `requirement_revisions.text` of the row at `approved_revision_id`. Status `approved` means current. | `search.ts`, `decisions.ts`, `memory/sync.ts` |
| `requirement_revisions` | `text`, `tsv` (GIN, migration 0016) | `search.ts`, `memory/sync.ts` |
| `resolveRequirementRef(tx, projectId, refOrId)` | throws `NotFoundError` | `decisions.ts` |
| `task_requirements` | `(task_id, requirement_id, removed_at)`; only rows with `removed_at is null` count | `decisions.ts` (`about` a task) |
| `blobs`, `blob_chunks` | `blob_chunks(blob_id, index, bytes bytea, sha256)`; `blobs.sealed_at`. Exported as ordinary rows, so no `BlobStore` method is added. | `portability/*` |
| `seedSourceWithSnapshot`, `uploadMarkdownFixture` | `sources/testing.ts` | `db/testing.ts`, e2e |
| `SearchHit` after Phase 3 | `{ kind: "task" \| "handoff" \| "blocker" \| "progress" \| "requirement" \| "source"; id; ref?; snippet; source?: { id; snapshot; section } }` | `search.ts` (extended, not replaced) |
| MCP `propose_change` | `{ project, requirements: RequirementChange[] (1–50), idempotency_key? }`, items in snake_case with `citation: { source, snapshot, section, excerpt? }` | Task 61 extends it |
| MCP tools after Phase 3 | exactly ten: the Phase 2 eight plus `get_source_text` and `propose_change` | Task 61 |

## Review Focus

1. An agent asks "why" and finds a superseded decision first, then acts on it as current. `getDecisions` always returns the chain's current head first and older decisions only under `history`. A search hit on a superseded decision carries `status: "superseded"` and `supersededBy`. Tests in Task 51 and Task 52.
2. Two proposals both supersede the same accepted decision and both get accepted, which forks the chain. The second acceptance is refused with a message naming the decision that replaced it. Test in Task 50.
3. Memory leaks: a workspace that never opted in makes a network call, an agent scoped to project A gets recall for project B, or a handoff note is sent to the memory service. None of these may happen. Tests in Task 55.
4. An export contains a connection token, webhook secret, notifier URL, agent token or memory key, or gets committed to the public repository. Tests in Task 57 and Task 59.
5. An import half-fails and leaves part of a workspace behind, or the people moving from local mode to a hosted deployment sign in with different identities and lose their memberships. Imports run in one transaction, and `--map-identity` remaps identities. Tests in Task 58.
6. A measure with no data yet, or a window with one item. The median is `null` and the page says "No data yet", never `0` or `NaN`. Tests in Task 54 and Task 63.
7. A search query of punctuation, a lone `-`, quotes or SQL-looking text returns `[]` without an error. Test in Task 51.

---

## File Structure

```
packages/core/src/
  decisions.ts              proposeDecision, updateProposedDecision, acceptDecision, rejectDecision,
                            listDecisions, decisionsToReview, getDecisions, views, resolveDecisionRef
  search.ts                 search (moved from context.ts and extended), SearchKind, SearchHit, Authority
  measures.ts               getMeasures, enterManualMeasure, listManualMeasures, measureHandler
  memory/types.ts           MemoryProvider, MemoryRecord, RecallItem, noopMemory
  memory/config.ts          getMemoryConfig, setMemoryConfig, openMemory
  memory/sync.ts            syncMemory, memoryRecordBody
  memory/recall.ts          recallFor, searchWithRecall
  memory/honcho.ts          createHonchoMemory (HTTP only)
  memory/testing.ts         fakeMemory
  portability/format.ts     EXPORT_FORMAT, EXPORT_VERSION, ExportLine, encodeRow, decodeRow
  portability/tables.ts     EXPORT_TABLES, EXCLUDED_TABLES, scrub rules
  portability/export.ts     exportWorkspace
  portability/import.ts     importWorkspace, restoreConnectionCredentials
  db/migrations/0019_decisions.sql 0020_search.sql 0021_measures.sql 0022_memory.sql
  (modified) context.ts connections.ts webhooks.ts notify/index.ts db/client.ts
             db/schema.ts db/testing.ts index.ts
apps/api/src/
  routes/decisions.ts  routes/measures.ts  routes/memory.ts
  decisions.e2e.test.ts
  (modified) app.ts mcp.ts schemas.ts routes/projects.ts routes/connections.ts routes/requirements.ts deps.ts
apps/web/src/
  pages/Decisions.tsx  pages/Decision.tsx  pages/Search.tsx  pages/Measures.tsx  pages/Memory.tsx
  components/charts.tsx
  (modified) main.tsx api.ts pages/Inbox.tsx pages/Task.tsx pages/Project.tsx pages/Connections.tsx components/Header.tsx
scripts/
  export.ts  import.ts  lib/cli.ts  portability.test.ts
```

## Shared types

Defined in Task 50 in `packages/core/src/decisions.ts` and Task 51 in `packages/core/src/search.ts`, and used by every later task.

```ts
// search.ts
export type Authority = "approved" | "record" | "derived";
export type SearchKind = "task" | "handoff" | "blocker" | "progress" | "requirement" | "source" | "decision" | "contract_change";
export type SearchHit = {
  kind: SearchKind | "recall"; id: string; ref?: string;
  snippet: Quoted;                 // source "<kind>:<id>"; "snapshot:<snapshotId>#<key>" for source hits; "recall:<provider>"
  source?: { id: string; snapshot: number; section: string };   // source hits only, as in Phase 3
  authority: Authority;
  status?: string;                 // the record's own status, e.g. "superseded"
  supersededBy?: string;           // decision ref, only on superseded decisions
  createdAt: string; rank: number; // recall hits have rank 0
};

// decisions.ts
export type DecisionStatus = "proposed" | "accepted" | "superseded" | "rejected";
export type DecisionSource =
  | ({ kind: "snapshot" } & CitationInput)       // Phase 3 citation: { sourceId, snapshot (seq), section (key), excerpt? }
  | { kind: "external"; ref: ExternalRefInput }  // chat message, ticket, change request, file
  | { kind: "note"; text: string };              // e.g. "Design review call, 2026-11-18"
export type DecisionSourceView =
  | { kind: "snapshot"; citation: CitationView } // Phase 3 CitationView (source title, location, excerpt, inLatest)
  | { kind: "external"; ref: ExternalRefInput }
  | { kind: "note"; text: Quoted };
export type DecisionInput = {
  projectId: string; title: string; context: string; decision: string; consequences?: string;
  supersedes?: string;             // decision ref or id; must be accepted
  requirements?: string[];         // refs (ACME-R12) or ids; approved requirements only
  tasks?: string[];                // refs (ACME-12) or ids
  source: DecisionSource; evidence?: ExternalRefInput[]; idempotencyKey?: string;
};
export type DecisionView = {
  id: string; ref: string; title: Quoted; context: Quoted; decision: Quoted; consequences: Quoted | null;
  status: DecisionStatus; authority: Authority;     // accepted/superseded → approved; proposed/rejected → derived
  supersedes: string | null; supersededBy: string | null;   // refs
  source: DecisionSourceView; requirements: string[]; tasks: string[]; evidence: ExternalRefInput[];
  proposedBy: string; decidedBy: string | null; decidedAt: string | null; decisionNote: Quoted | null; createdAt: string;
};
export type DecisionChain = { current: DecisionView; history: DecisionView[]; historyTruncated: boolean };
```

`proposedBy` and `decidedBy` are display names, with ` (agent)` appended for agents, as in Phase 1 views. Every `Quoted` in a decision view has source `decision:<id>`.

---

# Phase 4: decisions and recall

### Task 50: Decision records

**Files:**
- Create: `packages/core/src/decisions.ts`, `packages/core/src/db/migrations/0019_decisions.sql`
- Modify: `packages/core/src/notify/index.ts`, `db/schema.ts`, `db/testing.ts`, `index.ts`
- Test: `packages/core/src/decisions.test.ts`

**Interfaces:**
- Consumes: `requirePermission`, `recordEvent`, `cleanText`, `resolveTaskRef`, the `evidence` table (Task 7), `notifyProject`. From Phase 3: `checkCitation`, `CitationInput`, `CitationView`, `resolveRequirementRef`, `seedSourceWithSnapshot`, `proposeRequirements`, `approveProposals` (see "Phase 3 names used"). The permissions `decision.propose` and `decision.approve` and their template grants exist since Phase 0 Tasks 2 and 4.
- Produces:
  - **Why `decision.approve` is separate from `requirement.approve`** (both defined in Phase 0 Task 2): requirements are the client's scope and decisions are often technical. A team commonly wants the lead to accept technical decisions without being able to approve client requirements. The Phase 0 templates give both to `approver`, so default behaviour matches design §5. No migration changes roles.
  - Table `decisions(id, workspace_id, project_id, number int, title, context, decision, consequences null, status text check (status in ('proposed','accepted','superseded','rejected')), supersedes_id uuid null references decisions(id), superseded_by_id uuid null references decisions(id), source jsonb not null, proposed_by_kind, proposed_by_id, decided_by uuid null, decided_at null, decision_note null, idempotency_key null, created_at, updated_at)`. Unique on `(workspace_id, project_id, number)` and `(workspace_id, idempotency_key)`. Unique partial index `decisions_superseded_once` on `(supersedes_id) where status in ('accepted','superseded') and supersedes_id is not null`. `app_user` gets no `DELETE` grant.
  - Table `decision_links(workspace_id, decision_id, target_kind text check (target_kind in ('requirement','task')), target_id uuid, created_at)`, primary key `(decision_id, target_kind, target_id)`. Evidence goes in the existing `evidence` table with `subject_kind = 'decision'`.
  - `proposeDecision(tx, actor, input: DecisionInput): Promise<{ decisionId: string; ref: string; created: boolean }>`: needs `decision.propose`. Status starts `proposed`. Event `decision.proposed`.
  - `updateProposedDecision(tx, actor, input: { decisionId: string; patch: Partial<Omit<DecisionInput, "projectId" | "idempotencyKey">> }): Promise<void>`: needs `decision.approve`, and the status must be `proposed`. Event `decision.edited`.
  - `acceptDecision(tx, actor, input: { decisionId: string; note?: string }): Promise<{ supersededRef: string | null }>`: needs `decision.approve`. Events `decision.accepted`, plus `decision.superseded` on the old decision.
  - `rejectDecision(tx, actor, input: { decisionId: string; note: string }): Promise<void>`: needs `decision.approve`, and the note is required. Event `decision.rejected`.
  - `getDecision(tx, decisionId: string): Promise<DecisionRow>` (raw row, core-internal and tests only), `resolveDecisionRef(tx, projectId: string, refOrId: string): Promise<string>`, which throws `NotFoundError`.
  - `decisionMessage(view: { ref: string; fromName: string; event: "proposed" | "accepted" | "rejected"; supersedesRef: string | null }): string` in `notify/index.ts`
  - Test fixture in `db/testing.ts`: `seedDecisionProject(db): Promise<{ ws: string; projectId: string; otherProjectId: string; approver: Actor; member: Actor; agent: Actor; taskId: string; requirementId: string; requirementRef: string; sourceId: string; snapshotId: string }>`. It calls Phase 3's `seedSourceWithSnapshot(db, ws, projectId, "example-spec-v1.md")`, then `proposeRequirements` and `approveProposals` for one requirement citing `profiles/archive-a-profile` (`requirementRef` is `ACME-R1`).
- Rules (the parts the tests do not fully determine):
  - Numbers come from `coalesce(max(number), 0) + 1` under `select … for update` on the project row, as tasks do.
  - `title` is at most 200 characters after `cleanText`. `context`, `decision`, `consequences` and a `note` source's `text` go through `cleanText`.
  - Source validation. A `snapshot` source must pass `checkCitation(tx, { projectId, citation, authoritativeOnly: false })` (Phase 3 Task 38), so reference sources may be cited too; `decisions.source` stores `{ kind: "snapshot", sourceId, snapshotId, section, excerpt }` with the resolved snapshot id. An `external` ref URL must be `http` or `https`. A `note` text must be 1–500 characters.
  - `requirements` resolve with `resolveRequirementRef` and must have status `approved` (`ValidationError("only approved requirements can be linked")`), as for task links in Phase 3.
  - `supersedes`, when given, must resolve in the same project, and its status must be `accepted` at proposal time.
  - `acceptDecision` locks the new row and, if it has one, the superseded row `for update`. If the old row's status is `superseded`, it throws `ValidationError(\`${old.ref} is already superseded by ${by.ref}; supersede ${by.ref} instead\`)`. The old row becomes `superseded` with `superseded_by_id` set, in the same transaction.
  - Notifications use exact copy, carry pointers only, and are sent after commit through `waitUntil`: `` `Decision ${ref} proposed by ${fromName}. Waiting for a person to accept it.` ``, `` `Decision ${ref} accepted${supersedesRef ? `, replacing ${supersedesRef}` : ""}.` ``, `` `Decision ${ref} rejected.` ``.

- [ ] **Step 1: Write the failing tests**

```ts
test("an agent proposes a decision; only a person holding decision.approve can accept it", async () => {
  const { decisionId, ref, created } = await proposeDecision(tx, agent, { projectId,
    title: "Archived profiles stay visible to admins", context: "Support needs to restore accounts.",
    decision: "Filter archived profiles in the list query, not in the API.", tasks: ["ACME-1"],
    source: { kind: "external", ref: { kind: "message", url: "https://chat.example.com/p/abc" } } });
  expect({ ref, created }).toEqual({ ref: "ACME-D1", created: true });
  expect((await getDecision(tx, decisionId)).status).toBe("proposed");
  await expect(acceptDecision(tx, agent, { decisionId })).rejects.toThrow(ForbiddenError);
  await expect(acceptDecision(tx, member, { decisionId })).rejects.toThrow(ForbiddenError);
  await acceptDecision(tx, approver, { decisionId });
  expect((await getDecision(tx, decisionId)).status).toBe("accepted");
});
test("accepting a superseding decision marks the old one superseded in the same transaction", async () => {
  // D1 accepted; D2 { supersedes: "ACME-D1" } accepted → { supersededRef: "ACME-D1" }; D1.status superseded, superseded_by_id = D2
});
test("a decision is superseded at most once; the second acceptance names the newer decision", async () => {
  // D1 accepted; D2 and D3 both propose supersedes ACME-D1; accept D2; accept D3 →
  await expect(acceptDecision(tx, approver, { decisionId: d3 })).rejects.toThrow(
    "ACME-D1 is already superseded by ACME-D2; supersede ACME-D2 instead");
  expect((await getDecision(tx, d3)).status).toBe("proposed");
});
test("only an accepted decision can be superseded", async () => { /* supersedes a proposed or rejected one → ValidationError at propose */ });
test("an approver can edit a proposal; accepted, superseded and rejected decisions cannot be edited", async () => {});
test("rejecting needs a note and is final", async () => { /* no note → ValidationError; accept after reject → ValidationError */ });
test("a source is required and must belong to this project", async () => {
  // missing source → ValidationError; { kind: "snapshot", sourceId: otherProjectSource, snapshot: 1, section: "overview" } → ValidationError;
  // unknown section → ValidationError listing valid sections; external url "javascript:x" → ValidationError
});
test("a reference (non-authoritative) source section can be cited by a decision", async () => {});
test("linked tasks and requirements resolve by ref and must be in the same project", async () => {
  // tasks ["ACME-1"], requirements [requirementRef] → decision_links rows; "OTH-1" → NotFoundError; a draft requirement → ValidationError
});
test("decision refs never match the task-ref pattern", () => {
  expect(extractTaskRefs(["ACME-D3"], "ACME")).toEqual([]);
});
test("retrying with the same idempotency key returns the same proposal", async () => {
  const a = await proposeDecision(tx, agent, { ...input, idempotencyKey: "k1" });
  expect(await proposeDecision(tx, agent, { ...input, idempotencyKey: "k1" })).toEqual({ ...a, created: false });
});
test("free text is redacted; a title over 200 characters is rejected", async () => {});
test("decisions cannot be deleted", async () => {
  await expect(withWorkspace(db, ws, t => t.delete(decisions))).rejects.toThrow();
});
test("propose, edit, accept and reject each write one event; accepting a superseding decision also writes decision.superseded", async () => {});
test("decisionMessage carries refs only", () => {
  expect(decisionMessage({ ref: "ACME-D2", fromName: "Sam (agent)", event: "proposed", supersedesRef: null }))
    .toBe("Decision ACME-D2 proposed by Sam (agent). Waiting for a person to accept it.");
  expect(decisionMessage({ ref: "ACME-D2", fromName: "Dana", event: "accepted", supersedesRef: "ACME-D1" }))
    .toBe("Decision ACME-D2 accepted, replacing ACME-D1.");
});
```

- [ ] **Step 2: Run `pnpm test decisions`.** Expected: FAIL, module not found.
- [ ] **Step 3: Implement** the schema, migration and functions per the rules above.
- [ ] **Step 4: Run tests, including `assertAllTablesHaveForcedRls`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): decision records with supersession`.

### Task 51: Search across all record kinds

**Files:**
- Create: `packages/core/src/search.ts`, `packages/core/src/db/migrations/0020_search.sql`
- Modify: `packages/core/src/context.ts` (move `search` out and re-export it from `search.ts`), `db/schema.ts`, `index.ts`
- Test: `packages/core/src/search.test.ts` (the Phase 1 and Phase 3 search tests move here unchanged)

**Interfaces:**
- Consumes: Task 50 `decisions`; the Phase 1 `tsv` columns on `tasks`, `handoffs`, `blockers`, `progress_notes`; Phase 2 `contract_changes`; the Phase 3 `tsv` columns on `requirement_revisions` (migration 0016) and `snapshot_sections` (migration 0015), and the Phase 3 search over them (Task 43); `requirePermission`, `quote`
- Produces:
  - `Authority`, `SearchKind`, `SearchHit` (see "Shared types"). This is a superset of the Phase 3 `SearchHit`, so existing fields (including `source` on source hits) keep their meaning.
  - `search(tx, actor, input: { projectId: string; query: string; kinds?: SearchKind[]; limit?: number }): Promise<SearchHit[]>`: needs `project.read`, so an agent outside its projects gets `ForbiddenError`. `query` is trimmed and must be 1–200 characters, otherwise `ValidationError`. Default limit 10, max 25.
  - Migration 0020 adds a generated `tsv tsvector` column and a GIN index to `decisions` (`title || context || decision || coalesce(consequences)`) and to `contract_changes` (`title || array_to_string(files, ' ')`). Requirements and source sections already have `tsv` columns from Phase 3, and keep Phase 3's rules: requirement hits search only the revision at `approved_revision_id` of requirements with status `approved`; source hits search only the latest ready snapshot of active sources.
  - Index `events_subject_idx` on `events (workspace_id, subject_kind, subject_id, type)`. Tasks 52 and 54 read events by subject.
- Algorithm (not determined by the tests):

```
q = websearch_to_tsquery('simple', $query); if numnode(q) = 0: return []
for each kind in kinds (default all): select id, ref, status, created_at, ts_rank_cd(tsv, q) as rank,
    ts_headline('simple', <body text>, q, <Phase 1 options>) as snippet
  where project_id = $projectId and tsv @@ q   (progress joins tasks, requirement joins requirement_revisions,
                                                source joins snapshots and sources, for project_id)
  order by rank desc limit $limit
union all → order by rank desc, authority_order asc (approved, record, derived), id desc → limit $limit
```

  - Authority per kind. A requirement hit is always `approved` (only approved revisions are searched). A decision that is `accepted` or `superseded` is `approved`; one that is `proposed` or `rejected` is `derived`. Every other kind, including `source`, is `record`. `ref`: tasks `ACME-12`, requirements `formatRequirementRef(key, number)` (`ACME-R12`), decisions `ACME-D3`, contract changes `change_request_ref`, sources the section location (as in Phase 3), handoffs, blockers and progress notes the ref of their task when they have one. `supersededBy` is joined from `superseded_by_id`.

- [ ] **Step 1: Write the failing tests**

```ts
test.each(["task", "handoff", "blocker", "progress", "requirement", "decision", "contract_change"] as const)(
  "finds the word 'pagination' in a %s", async kind => {
  const hits = await search(tx, member, { projectId, query: "pagination", kinds: [kind] });
  expect(hits).toHaveLength(1);
  expect(hits[0]).toMatchObject({ kind, snippet: { untrusted: true, source: `${kind}:${hits[0].id}` } });
  expect(hits[0].snippet.text.toLowerCase()).toContain("pagination");
});
test("authority: approved records 'approved', proposals 'derived', coordination records 'record'", async () => {
  const byKind = Object.fromEntries((await search(tx, member, { projectId, query: "pagination" })).map(h => [`${h.kind}:${h.status}`, h.authority]));
  expect(byKind["decision:accepted"]).toBe("approved"); expect(byKind["decision:proposed"]).toBe("derived");
  expect(byKind["requirement:approved"]).toBe("approved"); expect(byKind["handoff:pending"]).toBe("record");
});
test("source hits keep Phase 3's quote source and source field, with authority 'record'", async () => {
  const [h] = await search(tx, member, { projectId, query: "archive", kinds: ["source"] });
  expect(h).toMatchObject({ kind: "source", authority: "record", source: { id: sourceId, snapshot: 1, section: "profiles/archive-a-profile" },
    snippet: { untrusted: true, source: `snapshot:${snapshotId}#profiles/archive-a-profile` } });
});
test("a superseded decision's hit names what replaced it", async () => {
  expect((await search(tx, member, { projectId, query: "archived", kinds: ["decision"] })).find(h => h.ref === "ACME-D1"))
    .toMatchObject({ status: "superseded", supersededBy: "ACME-D2", authority: "approved" });
});
test("never returns another project's or another workspace's rows", async () => {});
test("an agent scoped to project A searching project B gets ForbiddenError", async () => {});
test("odd queries return results or [] but never throw", async () => {
  for (const q of ['"', "-", "!!!", "or", "a & b | c", "'; drop table tasks; --", "ACME-D1"])
    await expect(search(tx, member, { projectId, query: q })).resolves.toBeInstanceOf(Array);
  await expect(search(tx, member, { projectId, query: "   " })).rejects.toThrow(ValidationError);
});
test("limit defaults to 10 and is capped at 25", async () => {});
test("on equal rank, approved hits come before record hits and derived hits come last", async () => {});
```

- [ ] **Step 2: Run `pnpm test search`.** Expected: FAIL.
- [ ] **Step 3: Implement** with one SQL statement built from a fixed per-kind table of `{ kind, table, bodySql, refSql, authoritySql }`. Kinds come from that table, never from input, so `kinds` is validated against it.
- [ ] **Step 4: Run tests, plus `pnpm test context`, so the Phase 1–3 context tests still pass.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): full-text search across all record kinds with authority`.

### Task 52: Decision views, chains and "why" queries

**Files:**
- Modify: `packages/core/src/decisions.ts`, `packages/core/src/context.ts` (`TaskContext`)
- Test: `packages/core/src/decision-views.test.ts`, extend `packages/core/src/context.test.ts`

**Interfaces:**
- Consumes: Task 50, Task 51 `search` (with `kinds: ["decision"]`), Phase 3 `task_requirements` (rows with `removed_at is null`), `resolveRequirementRef`, `CitationView` (built as Phase 3 `getRequirement` builds it), the `evidence` table
- Produces:
  - `DecisionView`, `DecisionChain`, `DecisionSourceView` (see "Shared types")
  - `getDecisions(tx, actor, input: { projectId: string; decision?: string; about?: string; query?: string; includeProposed?: boolean; limit?: number }): Promise<DecisionChain[]>`: needs `project.read`. Exactly one of `decision`, `about` or `query` must be given, otherwise `ValidationError("give exactly one of decision, about, query")`. Default limit 5, max 10 chains. History is cut at 20, with `historyTruncated: true`.
    - `decision`: a ref or id. Walk `superseded_by_id` forward to the head, then return that head's chain. A rejected decision named directly is returned as its own chain with an empty history.
    - `about`: a task ref, which matches `decision_links` for the task plus decisions linked to the task's requirements through active `task_requirements` rows. Or a requirement ref, which matches `decision_links`. Or an `http(s)` URL, which matches `evidence.url` with `subject_kind = 'decision'` or `source->'ref'->>'url'`. Anything else gives `ValidationError`. A matched decision that has been superseded resolves to its head.
    - `query`: `search(tx, actor, { projectId, query, kinds: ["decision"], limit: 25 })`, then each hit is mapped to its head.
    - Chains are de-duplicated by head. A head whose status is `proposed` is included only when `includeProposed`. `rejected` heads are excluded except by direct `decision`. Order: heads with status `accepted` first, then by `decided_at` desc.
  - `listDecisions(tx, actor, input: { projectId: string; status?: DecisionStatus[]; limit?: number }): Promise<DecisionView[]>`: default status `["proposed", "accepted"]`, newest first, limit 50, max 200
  - `decisionsToReview(tx, actor): Promise<(DecisionView & { projectKey: string })[]>`: proposals in every project where the member holds `decision.approve`. Agents get `ForbiddenError`.
  - `TaskContext` gains `decisions: DecisionView[]`: the current accepted decisions linked to the task or to its requirements, newest first, max 10.
- Chains are walked with one recursive CTE over `supersedes_id` from the head, with depth limited to 21.

- [ ] **Step 1: Write the failing tests**

```ts
test("asking about a task returns the current decision first with the one it replaced in history", async () => {
  // D1 linked to ACME-1, accepted; D2 supersedes D1, accepted
  const [chain] = await getDecisions(tx, agent, { projectId, about: "ACME-1" });
  expect(chain.current).toMatchObject({ ref: "ACME-D2", status: "accepted", authority: "approved", supersedes: "ACME-D1" });
  expect(chain.history.map(d => [d.ref, d.status, d.supersededBy])).toEqual([["ACME-D1", "superseded", "ACME-D2"]]);
});
test("asking by a superseded decision's ref leads to the current head", async () => {
  expect((await getDecisions(tx, agent, { projectId, decision: "ACME-D1" }))[0].current.ref).toBe("ACME-D2");
});
test("every decision carries its source", async () => {
  // snapshot source → { kind: "snapshot", citation: { sourceId, snapshotId, snapshot: 1, section: "profiles/archive-a-profile", location: "2.2 Archive a profile", inLatest: "unchanged" } };
  // external → { kind: "external", ref: { url } }
});
test("proposed heads appear only with includeProposed, marked derived", async () => {});
test("a rejected decision appears only when named directly", async () => {});
test("about a requirement ref finds decisions linked to it; about a task also finds decisions on the task's requirements", async () => {});
test("about a URL matches a decision's evidence or source URL", async () => {});
test("exactly one of decision, about and query is required", async () => {
  await expect(getDecisions(tx, agent, { projectId })).rejects.toThrow("give exactly one of decision, about, query");
  await expect(getDecisions(tx, agent, { projectId, decision: "ACME-D1", query: "x" })).rejects.toThrow(ValidationError);
});
test("query finds a decision by words in its context", async () => {});
test("an agent scoped to another project gets ForbiddenError and no data", async () => {});
test("every free-text field is Quoted with source decision:<id>", async () => {
  const [{ current }] = await getDecisions(tx, agent, { projectId, decision: "ACME-D2" });
  for (const f of [current.title, current.context, current.decision])
    expect(f).toEqual({ untrusted: true, source: `decision:${current.id}`, text: expect.any(String) });
});
test("a chain of 25 decisions returns 20 in history with historyTruncated", async () => {});
test("decisionsToReview lists proposals only in projects where the member holds decision.approve", async () => {});

// context.test.ts (extend)
test("getTaskContext includes accepted decisions linked to the task and to its requirements", async () => {
  expect((await getTaskContext(tx, agent, { projectId, task: "ACME-1" })).decisions.map(d => d.ref)).toEqual(["ACME-D2"]);
});
```

- [ ] **Step 2: Run `pnpm test decision-views context`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): decision chains and why queries`.

### Task 53: Change-request activity for measures

**Files:**
- Create: `packages/core/src/db/migrations/0021_measures.sql` (the `change_request_stats` part; Task 54 adds the rest to the same file)
- Create: `packages/core/src/measures.ts` (with `measureHandler`)
- Modify: `packages/core/src/webhooks.ts` (`defaultHandlers.changeRequest`), `db/schema.ts`
- Test: `packages/core/src/measures-capture.test.ts`

**Interfaces:**
- Consumes: Phase 2 `HandlerCtx`, `ChangeRequest` (including `createdAt` and `mergedAt`, defined in Phase 2 Task 17), `defaultHandlers`
- Produces:
  - Table `change_request_stats(workspace_id, project_id, connection_id, change_request_external_id, reference, opened_at timestamptz, merged_at null, state, head_shas text[], first_seen_at, updated_at)`, primary key `(workspace_id, connection_id, change_request_external_id)`. A bookkeeping table.
  - `measureHandler(ctx: HandlerCtx, cr: ChangeRequest): Promise<void>`, added third in `defaultHandlers.changeRequest`. It upserts the row. While `cr.state === "open"`, it appends `cr.headSha` to `head_shas` if absent, capped at 100. It sets `merged_at = cr.mergedAt` and `state` on every call. A SHA observed after the row's `state` is `merged` or `closed` is not appended.

- [ ] **Step 1: Write the failing tests**

```ts
test.each(providers)("%s: each new head SHA on an open change request is counted once; redelivery adds nothing", async p => {
  await deliver(p, "changeRequestOpened"); await deliver(p, "changeRequestOpened");     // same delivery id
  await deliver(p, "changeRequestUpdated", { headSha: "b".repeat(40) });
  expect((await statsRow(p)).head_shas).toHaveLength(2);
});
test.each(providers)("%s: a merge records merged_at and later pushes are not counted", async p => {});
test("a change request in a repository not linked to a project records nothing", async () => {});
```

- [ ] **Step 2: Run `pnpm test measures-capture`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests, including every Phase 2 webhook, evidence and contract test.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): record change-request activity for measures`.

### Task 54: Measures

**Files:**
- Modify: `packages/core/src/measures.ts`, `migrations/0021_measures.sql`, `db/schema.ts`, `db/testing.ts`, `index.ts`
- Test: `packages/core/src/measures.test.ts`

**Interfaces:**
- Consumes: `handoffs`, `blockers`, `contract_changes`, `events`, `change_request_stats`, `requirePermission`
- Produces:
  - `type MetricKey = "handoff_ack" | "contract_ack" | "blocker_open" | "review_rounds" | "cr_cycle" | "dm_messages"`
  - `METRICS: Record<MetricKey, { label: string; unit: "hours" | "count"; computed: boolean; definition: string }>`, with this exact copy:
    - `handoff_ack`: "Handoff to acknowledgement", hours. "Hours from a handoff being created to its first response (accepted or needs changes)."
    - `contract_ack`: "Contract change to acknowledgement", hours. "Hours from a contract change being recorded to every consumer role acknowledging it. Withdrawn changes are left out."
    - `blocker_open`: "Blocker open time", hours. "Hours from a blocker being raised to it being resolved."
    - `review_rounds`: "Review rounds per change request", count. "Distinct commits pushed to a change request while it was open, counted for merged change requests. Each push after review is one more round."
    - `cr_cycle`: "Change-request cycle time", hours. "Hours from a change request being opened to it being merged."
    - `dm_messages`: "Coordination direct messages", count, `computed: false`. "Entered by hand: the platform cannot see direct messages."
  - `type MetricSummary = { metric: MetricKey; unit: "hours" | "count"; count: number; median: number | null; p90: number | null; open: number; series: { weekStart: string; median: number | null; count: number }[] }`
  - `type ManualMeasureView = { id: string; metric: MetricKey; periodLabel: string; periodStart: string; periodEnd: string; value: number; unit: "hours" | "count"; sampleSize: number | null; note: string | null; enteredBy: string; createdAt: string }`
  - `type MeasuresReport = { projectId: string; from: string; to: string; current: MetricSummary[]; manual: ManualMeasureView[] }`. `current` holds the five computed metrics, in `METRICS` order.
  - `getMeasures(tx, actor, input: { projectId: string; from?: string; to?: string }): Promise<MeasuresReport>`: needs `project.read`, and agents get `ForbiddenError`. The default window is the last 30 days ending now. `from >= to` or a window over 366 days gives `ValidationError`. An item belongs to the window by its start time (created or opened). For `review_rounds` and `cr_cycle`, it belongs by `merged_at`. `median` and `p90` are `percentile_cont` rounded to one decimal, and `null` when `count = 0`. `open` counts items started in the window with no end yet; it is always 0 for `review_rounds` and `cr_cycle`. `series` is grouped by `date_trunc('week', …)` in UTC (Mondays) and covers every week in the window, including empty weeks.
  - End times come from events: the first `handoff.accepted` or `handoff.needs_changes`, the first `contract.cleared`, the first `blocker.resolved`, each by `subject_id`.
  - Table `manual_measures(id, workspace_id, project_id, metric, period_label, period_start date, period_end date, value numeric, sample_size int null, note null, entered_by, superseded_by uuid null, created_at)`
  - `enterManualMeasure(tx, actor, input: { projectId: string; metric: MetricKey; periodLabel: string; periodStart: string; periodEnd: string; value: number; sampleSize?: number; note?: string; supersedes?: string }): Promise<string>`: needs `workspace.admin`. `value` must be finite and ≥ 0, `periodLabel` 1–80 characters, `periodStart <= periodEnd`. With `supersedes`, it sets that row's `superseded_by`. Event `measure.entered`.
  - `listManualMeasures(tx, actor, projectId): Promise<ManualMeasureView[]>`: rows not superseded, ordered by `period_start`
  - Test helper in `db/testing.ts`: `backdate(db, table: string, id: string, column: string, iso: string): Promise<void>` (runs as the owner role, so it can edit `events`)

- [ ] **Step 1: Write the failing tests**

```ts
test("handoff time to acknowledgement: median of first-response hours; unanswered counted as open", async () => {
  // four handoffs created at T; responses (event created_at) at T+1h, T+3h, T+10h; one unanswered
  expect(metric(await getMeasures(tx, member, { projectId, from, to }), "handoff_ack"))
    .toMatchObject({ unit: "hours", count: 3, median: 3, open: 1 });
});
test("p90 uses percentile_cont", async () => { /* 10 values 1..10 → p90 9.1 */ });
test("contract change time to acknowledgement leaves out withdrawn changes", async () => {});
test("blocker open time counts resolved blockers; open ones are counted in open", async () => {});
test("review rounds count distinct head SHAs for change requests merged in the window", async () => {
  // stats row head_shas [a,b,c], merged_at in window → median 3; another merged before `from` is excluded
});
test("change-request cycle time is opened_at to merged_at", async () => {});
test("with no data every metric has count 0, median null and p90 null", async () => {
  for (const m of (await getMeasures(tx, member, { projectId })).current) expect(m).toMatchObject({ count: 0, median: null, p90: null });
});
test("the weekly series has one entry per UTC week in the window, including empty weeks", async () => {});
test("a window over 366 days, or from after to, is rejected", async () => {});
test("agents cannot read measures", async () => {
  await expect(getMeasures(tx, agent, { projectId })).rejects.toThrow(ForbiddenError);
});
test("an admin enters a baseline; a correction supersedes it and the old row is kept", async () => {
  const a = await enterManualMeasure(tx, admin, { projectId, metric: "cr_cycle", periodLabel: "Baseline before Phase 1",
    periodStart: "2026-09-01", periodEnd: "2026-11-01", value: 52.5, sampleSize: 20 });
  await enterManualMeasure(tx, admin, { ...sameInput, value: 48, supersedes: a });
  expect((await listManualMeasures(tx, admin, projectId)).map(m => m.value)).toEqual([48]);
  expect(await rawQuery(db, "select count(*)::int as n from manual_measures")).toEqual([{ n: 2 }]);
});
test("only workspace.admin enters measures; negative or non-finite values are rejected", async () => {});
```

- [ ] **Step 2: Run `pnpm test measures`.** Expected: FAIL.
- [ ] **Step 3: Implement** each metric as one SQL query that returns `count`, `median`, `p90`, `open` and the series through `generate_series` of weeks left-joined to the items. JavaScript only maps the rows.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): measures computed from platform data and manual baselines`.

### Task 55: Memory provider interface, configuration, sync and recall

**Files:**
- Create: `packages/core/src/memory/types.ts`, `memory/config.ts`, `memory/sync.ts`, `memory/recall.ts`, `memory/testing.ts`, `migrations/0022_memory.sql`
- Modify: `db/schema.ts`, `index.ts`
- Test: `packages/core/src/memory/memory.test.ts`

**Interfaces:**
- Consumes: `CodeHostDeps` (reused as the memory deps: `fetchImpl`, `credentialsKeys`, `allowPrivateHosts`, `waitUntil`, `publicUrl`), `encryptSecret`, `decryptSecret`, `validateBaseUrl`, Task 51 `search`, Task 52 views, Phase 3 `requirements` and `requirement_revisions` (see "Phase 3 names used")
- Produces:
  - In `types.ts`:

```ts
export type MemoryRecord = {
  id: string; version: string;             // version = `${status}:${updated_at ISO}`
  kind: "decision" | "requirement"; projectId: string; projectKey: string; ref: string;
  status: "accepted" | "superseded" | "approved"; title: string; body: string; url: string;
  // url: `${publicUrl}/w/<ws>/decisions/<id>`, or `${publicUrl}/w/<ws>/p/<projectId>/requirements/<ref>` (Phase 3 route)
};
export type RecallItem = { id: string; text: string; createdAt?: string; threadlineId?: string };
export interface MemoryProvider {
  readonly kind: "none" | "honcho";
  remember(record: MemoryRecord): Promise<void>;
  recall(query: { projectId: string; text: string; limit: number }): Promise<RecallItem[]>;
  test(): Promise<{ ok: true } | { ok: false; error: string }>;
}
export const noopMemory: MemoryProvider;   // remember resolves, recall returns [], test → ok
```

  - Table `workspace_memory(workspace_id primary key, provider text check (provider in ('none','honcho')), base_url null, external_workspace null, credentials_enc null, opted_in_by uuid null, opted_in_at null, updated_at)`
  - Table `memory_sync(workspace_id, record_kind, record_id, sent_version null, status text check (status in ('sent','failed')), attempts int, last_error null, updated_at)`, primary key `(workspace_id, record_kind, record_id)`. A bookkeeping table.
  - `type MemoryConfigView = { provider: "none" | "honcho"; baseUrl: string | null; externalWorkspace: string | null; hasApiKey: boolean; optedInBy: string | null; optedInAt: string | null; sync: { sent: number; pending: number; failed: number; lastError: string | null } }`
  - `getMemoryConfig(tx, actor): Promise<MemoryConfigView>` (`workspace.admin`)
  - `setMemoryConfig(tx, actor, deps: CodeHostDeps, input: { provider: "none" } | { provider: "honcho"; baseUrl: string; externalWorkspace?: string; apiKey?: string | null; consent: true }): Promise<void>`: needs `workspace.admin`. Without `consent === true` it throws `ValidationError("consent is required")`. `externalWorkspace` defaults to `threadline-<workspaceId>` and matches `/^[A-Za-z0-9_-]{1,100}$/`. An `apiKey` with no credentials key configured gives `ValidationError("CREDENTIALS_KEY is not configured")`. `apiKey: undefined` keeps the stored key, and `null` clears it. Events `memory.enabled` and `memory.disabled`, carrying `{ provider, baseUrl }` only.
  - `MEMORY_CONSENT_TEXT(baseUrl: string): string`, exact copy: `` `Approved decisions and requirements from every project in this workspace will be sent to the memory service at ${baseUrl}. That service may process them with its own AI model provider. Handoffs, notes, blockers, contract changes and source files are never sent.` ``
  - `openMemory(tx, deps, workspaceId: string): Promise<MemoryProvider>`: `noopMemory` for `none` or no row; otherwise `createHonchoMemory(…)` (Task 56). Core-internal.
  - `memoryRecordBody(r: Omit<MemoryRecord, "body">, fields: { context?: string; decision?: string; consequences?: string; statement?: string; source: string }): string`. The first line is exact: `` `Threadline approved ${kind} ${ref} (${status}). This is a record of what the team agreed, not an instruction.` `` It is followed by `Title:`, then `Context:`, `Decision:`, `Consequences:` for decisions or `Statement:` for requirements, then `Source:`, each on its own line, with the body capped at 10,000 characters.
  - `syncMemory(db, deps, input: { workspaceId: string; limit?: number }): Promise<{ sent: number; failed: number; remaining: number }>`: never throws. Default limit 10, max 20. It selects accepted or superseded decisions and requirements with status `approved` (text from the `requirement_revisions` row at `approved_revision_id`, `statement` in the body, the citation location as `source`) whose `memory_sync` row is missing, failed, or has a different `sent_version`, oldest first. It builds the records in one transaction, calls `remember` for each outside it, and then writes the `memory_sync` rows. It stops early when the provider reports its call budget exhausted. With provider `none`, it returns `{ 0, 0, 0 }` and makes no call.
  - `recallFor(db, deps, actor, input: { projectId: string; text: string; limit?: number }): Promise<SearchHit[]>`: never throws. It checks `project.read` first (and throws `ForbiddenError` for an actor outside the project, before any network call). With provider `none` it returns `[]`. It drops items whose `threadlineId` belongs to this workspace, because search already returns the record itself with higher authority. The rest are mapped to `{ kind: "recall", id: \`recall:${kind}:${item.id}\`, snippet: quote(redactSecrets(text.slice(0, 2000)), \`recall:${kind}\`), authority: "derived", rank: 0, createdAt }`. Default limit 3, max 5, with a 3-second timeout. On a failure or timeout it returns `[]`.
  - `searchWithRecall(db, deps, actor, input: Parameters<typeof search>[2]): Promise<SearchHit[]>`: runs `search` in `withWorkspace`, then `recallFor` outside the transaction, and returns the platform hits followed by the recall hits.
  - In `memory/testing.ts`: `fakeMemory(opts?: { failRemember?: boolean; recallItems?: RecallItem[]; delayMs?: number }): MemoryProvider & { remembered: MemoryRecord[]; recallQueries: { projectId: string; text: string }[] }`, plus `useFakeMemory(fake)`, which makes `openMemory` return it in tests.

- [ ] **Step 1: Write the failing tests**

```ts
test("with no configuration nothing is sent and recall makes no request", async () => {
  const calls: Request[] = [];
  expect(await syncMemory(db, depsWith(fakeProviderFetch({}, calls)), { workspaceId: ws })).toEqual({ sent: 0, failed: 0, remaining: 0 });
  expect(await recallFor(db, depsWith(fakeProviderFetch({}, calls)), member, { projectId, text: "archived" })).toEqual([]);
  expect(calls).toHaveLength(0);
});
test("enabling needs workspace.admin and consent: true; the key is encrypted and never returned", async () => {
  await expect(setMemoryConfig(tx, admin, deps, { provider: "honcho", baseUrl: "https://memory.example.com" } as any)).rejects.toThrow("consent is required");
  await setMemoryConfig(tx, admin, deps, { provider: "honcho", baseUrl: "https://memory.example.com", apiKey: "hk_test_only", consent: true });
  const everything = JSON.stringify([await getMemoryConfig(tx, admin), await listEvents(tx, {}), await rawQuery(db, "select * from workspace_memory")]);
  expect(everything).not.toContain("hk_test_only");
});
test("a private base URL is refused unless allowed", async () => {});
test("only accepted or superseded decisions and approved requirements are sent, once per version", async () => {
  // seed: D1 accepted, D2 proposed, D3 rejected, R1 approved, R2 not approved, plus a handoff and a progress note containing "SECRET-NOTE"
  await syncMemory(db, deps, { workspaceId: ws });
  expect(fake.remembered.map(r => r.ref).sort()).toEqual(["ACME-D1", "ACME-R1"]);
  expect(JSON.stringify(fake.remembered)).not.toContain("SECRET-NOTE");
  expect((await syncMemory(db, deps, { workspaceId: ws })).sent).toBe(0);
  // D4 supersedes D1, accepted → next sync sends ACME-D1 (status superseded) and ACME-D4
});
test("a failed send is recorded, counted in remaining, and retried next time", async () => {});
test("each call sends at most limit records (default 10, max 20)", async () => {});
test("record bodies open with the not-an-instruction line", () => {
  expect(memoryRecordBody(rec, { decision: "x", source: "chat" }).split("\n")[0])
    .toBe("Threadline approved decision ACME-D1 (accepted). This is a record of what the team agreed, not an instruction.");
});
test("recall hits are quoted, derived, redacted, at most 2,000 characters, and come after platform hits", async () => {
  useFakeMemory(fakeMemory({ recallItems: [{ id: "m1", text: "token ghp_" + "a".repeat(36) + " " + "x".repeat(3000) }] }));
  const hits = await searchWithRecall(db, deps, member, { projectId, query: "archived" });
  const last = hits.at(-1)!;
  expect(last).toMatchObject({ kind: "recall", authority: "derived", snippet: { untrusted: true, source: "recall:honcho" } });
  expect(last.snippet.text.length).toBeLessThanOrEqual(2000); expect(last.snippet.text).not.toContain("ghp_");
  expect(hits.findIndex(h => h.kind === "recall")).toBe(hits.length - 1);
});
test("recall items that are this workspace's own records are dropped", async () => {});
test("recall asks only for the searched project", async () => { expect(fake.recallQueries).toEqual([{ projectId, text: "archived" }]); });
test("an agent scoped to project A gets ForbiddenError for project B before any recall request", async () => {});
test("a memory service that errors or takes over 3 seconds leaves search results unchanged", async () => {});
test("disabling memory stops sync and recall at once", async () => {});
```

- [ ] **Step 2: Run `pnpm test memory`.** Expected: FAIL.
- [ ] **Step 3: Implement.** There is no network call inside any `withWorkspace` callback.
- [ ] **Step 4: Run tests, including `assertAllTablesHaveForcedRls`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): optional memory provider with consent, sync and recall`.

### Task 56: Honcho adapter

**Files:**
- Create: `packages/core/src/memory/honcho.ts`
- Modify: `packages/core/src/memory/config.ts` (`openMemory` builds it)
- Test: `packages/core/src/memory/honcho.test.ts`, `packages/core/src/memory/licence.test.ts`

**Interfaces:**
- Consumes: Task 55 types, `fakeProviderFetch` (Phase 2 testing helper)
- Produces: `createHonchoMemory(opts: { baseUrl: string; apiKey?: string; externalWorkspace: string; fetchImpl: typeof fetch; timeoutMs?: number; maxCalls?: number }): MemoryProvider`, with defaults `timeoutMs = 4000` and `maxCalls = 20`. A call past the budget throws `Error("call budget exhausted")` without fetching. `syncMemory` treats that as "stop", not as a failure.
  - Mapping. One Honcho workspace (`externalWorkspace`). One peer `threadline`. One session per project, `project-<projectId>`. Each record becomes one message from peer `threadline` with `content = record.body` and `metadata = { threadline_id, threadline_workspace, kind, ref, version, status, url, authority: "approved" }`. Workspace, peer and session are get-or-create, at most once per instance for each.
  - Intended endpoints (Honcho v2 API): `POST /v2/workspaces` `{ id }`; `POST /v2/workspaces/:ws/peers` `{ id }`; `POST /v2/workspaces/:ws/sessions` `{ id }`; `POST /v2/workspaces/:ws/sessions/:session/messages` `{ messages: [{ peer_id, content, metadata }] }`; `POST /v2/workspaces/:ws/sessions/:session/search` `{ query, limit }`. **Before writing, check the API reference of the Honcho version named in the README and adjust the paths.** The fake routes in the test are the contract. Recall uses search, not Honcho's chat endpoint, so recall itself triggers no model call.
  - `recall` maps each returned message to `{ id, text: content, createdAt: created_at, threadlineId: metadata?.threadline_id }`. A 404 (no session yet) returns `[]`. `test()` calls the workspace get-or-create.
  - Auth: `Authorization: Bearer <apiKey>` only when `apiKey` is set. Error messages read `` `honcho ${method} ${path} returned ${status}` `` and never contain the key.

- [ ] **Step 1: Write the failing tests**

```ts
test("remember sets up workspace, peer and session once, then posts one message per record", async () => {
  const calls: Request[] = [];
  const m = createHonchoMemory({ baseUrl: "https://memory.example.com", externalWorkspace: "threadline-test", fetchImpl: fakeProviderFetch(HONCHO_ROUTES, calls) });
  await m.remember(recD1); await m.remember(recD2);
  expect(calls.map(c => new URL(c.url).pathname)).toEqual([
    "/v2/workspaces", "/v2/workspaces/threadline-test/peers", `/v2/workspaces/threadline-test/sessions`,
    `/v2/workspaces/threadline-test/sessions/project-${projectId}/messages`, `/v2/workspaces/threadline-test/sessions/project-${projectId}/messages`]);
  expect((await calls[3].json()).messages[0]).toMatchObject({ peer_id: "threadline", content: recD1.body,
    metadata: { threadline_id: recD1.id, ref: "ACME-D1", authority: "approved" } });
});
test("recall searches only the project's session and maps metadata", async () => {});
test("recall for a project with no session yet returns []", async () => {});
test("the API key is sent as a bearer token and never appears in errors", async () => {});
test("a slow call times out and the 21st call fails without fetching", async () => {});

// licence.test.ts
test("no package.json in the repository depends on a Honcho package", () => {
  for (const file of allPackageJsonFiles()) {
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies });
    expect(deps.filter(d => /honcho/i.test(d))).toEqual([]);
  }
});
```

- [ ] **Step 2: Run `pnpm test honcho licence`.** Expected: FAIL.
- [ ] **Step 3: Implement** with `fetch` and `AbortSignal.timeout` only.
- [ ] **Step 4: Run tests, plus `pnpm test memory`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): Honcho memory adapter over HTTP`.

### Task 57: Workspace export

**Files:**
- Create: `packages/core/src/portability/format.ts`, `portability/tables.ts`, `portability/export.ts`
- Modify: `packages/core/src/db/client.ts` (`withWorkspace` options), `index.ts`
- Test: `packages/core/src/portability/export.test.ts`

**Interfaces:**
- Consumes: every table so far; `can`; `recordEvent`
- Produces:
  - `withWorkspace(db, workspaceId, fn, opts?: { isolation?: "repeatable read"; readOnly?: boolean })`: passes the options to Drizzle's `transaction`, so `BEGIN` carries them before `set_config` runs
  - `EXPORT_FORMAT = "threadline-workspace-export"`, `EXPORT_VERSION = 1`
  - `type ExportLine = { t: "manifest"; format: string; version: 1; exportedAt: string; sourceUrl: string; migration: string; workspace: { id: string; name: string } } | { t: "row"; table: string; row: Record<string, unknown> } | { t: "end"; counts: Record<string, number>; sha256: string }`. Lines are JSON, one per line. The `end.sha256` is the SHA-256 hex of every preceding line joined with `\n`, computed incrementally.
  - `encodeRow(row)` / `decodeRow(table, json)`: dates become ISO strings, `bytea` becomes `{ "$bytes": "<base64>" }`, arrays and `jsonb` stay as they are. `decodeRow` throws `ValidationError(\`unknown column ${table}.${col}\`)` for a column not in the Drizzle table.
  - `EXPORT_TABLES: { table: string; scrub?: Record<string, (v: unknown, ctx: { exportedAt: string }) => unknown> }[]`, in insert order: `workspaces`, `roles`, `users` (only those referenced by members), `user_identities` (same), `members`, `member_roles`, `agent_identities` (`token_hash → null`, `revoked_at → coalesce(revoked_at, exportedAt)`), `invites` (`code_hash → null`, `expires_at → least(expires_at, exportedAt)`), `projects`, `project_config` (`notifier → null`), `connections` (`credentials_enc → null`, `webhook_secret_hash → null`), `project_repos`, `blobs`, `blob_chunks` (`bytes` as `{ "$bytes": … }`), `sources`, `snapshots`, `snapshot_sections`, `source_changes`, `requirements`, `requirement_revisions`, `approvals`, `tasks`, `task_dependencies`, `task_requirements`, `task_reviews`, `external_refs`, `runs`, `progress_notes`, `handoffs`, `blockers`, `contract_changes`, `acknowledgements`, `evidence`, `pipeline_states`, `decisions`, `decision_links`, `manual_measures`, `change_request_stats`, `events`. Generated `tsv` columns are not exported. Rows in each table are ordered by `id`, or by primary key when there is no `id`.
  - `EXCLUDED_TABLES = ["sessions", "webhook_deliveries", "tracker_sync", "workspace_memory", "memory_sync"]`. Each has a one-line reason in a comment: deployment-bound, log, bookkeeping (the next status change pushes again), holds a secret and an opt-in that must be repeated, bookkeeping for the old memory service.
  - `exportWorkspace(db: Db, input: { workspaceId: string; actor: Actor; sourceUrl: string }, write: (line: string) => Promise<void>): Promise<{ counts: Record<string, number>; sha256: string }>`. The actor must be a member holding `workspace.admin`, otherwise `ForbiddenError`. Reads happen in one `withWorkspace(…, { isolation: "repeatable read", readOnly: true })` transaction, in pages of 500 rows by key. After that transaction, a separate one records event `workspace.exported` with data `{ counts }`. The event is written after the read snapshot, so it is not in the file. `migration` is the newest applied migration name.

- [ ] **Step 1: Write the failing tests**

```ts
test("every table with a workspace_id is either exported or excluded", async () => {
  const rows = await rawQuery(db, "select distinct table_name from information_schema.columns where table_schema = 'public' and column_name = 'workspace_id'");
  const known = new Set([...EXPORT_TABLES.map(t => t.table), ...EXCLUDED_TABLES]);
  expect(rows.map(r => r.table_name).filter(t => !known.has(t))).toEqual([]);
});
test("every exported column whose name suggests a secret has a scrub rule", async () => {
  // columns matching /secret|token|credential|password|code_hash|webhook_url|api_key/ in EXPORT_TABLES → scrub[col] defined
});
test("an export contains none of the workspace's secrets", async () => {
  // seed: connection token GL_TEST_TOKEN + webhookSecret, notifier "https://chat.test/hook", agent token, invite code, memory key
  const text = (await exportLines(db, ws, admin)).join("\n");
  for (const s of [GL_TEST_TOKEN, webhookSecret, "https://chat.test/hook", agentToken, inviteCode, "hk_test_only"]) expect(text).not.toContain(s);
  expect(text).not.toMatch(/"(credentials_enc|token_hash|code_hash|webhook_secret_hash)":"/);
});
test("an export holds only this workspace's rows", async () => {});
test("the first line is the manifest and the last is end, with counts and a matching checksum", async () => {});
test("events are exported verbatim in id order", async () => {});
test("blob chunks are exported as blob_chunks rows with bytes as $bytes base64 and their sha256", async () => {});
test("a readOnly withWorkspace transaction rejects a write", async () => {
  await expect(withWorkspace(db, ws, tx => recordEvent(tx, sampleEvent(ws)), { readOnly: true })).rejects.toThrow();
});
test("only a member holding workspace.admin can export, agents never; the export records workspace.exported", async () => {});
```

- [ ] **Step 2: Run `pnpm test portability`.** Expected: FAIL.
- [ ] **Step 3: Implement.** `exportWorkspace` uses only `write` and Web Crypto, so it runs on any runtime. The CLI in Task 59 is still the only caller.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): workspace export without secrets`.

### Task 58: Workspace import

**Files:**
- Create: `packages/core/src/portability/import.ts`
- Modify: `packages/core/src/connections.ts` (`needsCredentials`, `restoreConnectionCredentials`), `db/client.ts` (`withImport`), `index.ts`
- Test: `packages/core/src/portability/import.test.ts`

**Interfaces:**
- Consumes: Task 57, `findOrCreateUser`, `encryptSecret`, `randomToken`, `sha256Hex`
- Produces:
  - No migration. `connections.credentials_enc`, `connections.webhook_secret_hash` (Phase 2 Task 20), `agent_identities.token_hash` and `invites.code_hash` (Phase 0 Task 5) are nullable from the start, and `openConnection` already returns null when `credentials_enc` is null. `resolveAgentToken` never matches a null hash.
  - `ConnectionView` gains `needsCredentials: boolean` (`credentials_enc is null`)
  - `restoreConnectionCredentials(tx, actor, deps: CodeHostDeps, connectionId: string, token: string): Promise<{ webhookSecret: string }>`: needs `workspace.admin`. It sets new credentials and a new webhook secret. Event `connection.credentials_restored`.
  - `withImport<T>(db, workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T>`, core-internal: one transaction that sets both `app.system = 'on'` and `app.workspace_id`
  - `type ImportSummary = { workspaceId: string; counts: Record<string, number>; needsAttention: { connections: number; notifierProjects: string[]; agentTokensRevoked: number; invitesRevoked: number } }`
  - `importWorkspace(db: Db, input: { lines: AsyncIterable<string>; asIdentity: string; mapIdentities?: Record<string, string>; targetMigration: string }): Promise<ImportSummary>`. Identities are written as `<provider>:<provider_user_id>`, for example `github:1234` or `local:1`.
- Rules, in order. Any failure rolls back the whole transaction and writes nothing.
  1. The first line must be a manifest with `format === EXPORT_FORMAT` and `version === 1`. Otherwise `ValidationError("not a Threadline export")`.
  2. If `manifest.migration > targetMigration`: `ValidationError(\`this export needs migration ${manifest.migration}; run pnpm migrate on this deployment first\`)`.
  3. If the workspace id exists (checked with `withSystem`): `ValidationError(\`workspace ${id} already exists here\`)`.
  4. Inside `withImport`, rows are inserted in batches of 200, in file order. Users: identities from the file are rewritten through `mapIdentities`. A user whose (mapped) identity already exists on the target is reused, and `members.user_id` is remapped. Otherwise the user is inserted with the exported id, or a fresh `newId()` if that id is taken. Every other id is kept as it is.
  5. After `member_roles`, `asIdentity` (after mapping) must belong to a member whose roles in the file grant `workspace.admin`. Otherwise `ForbiddenError("the importing identity is not an admin of this workspace")`.
  6. Rows go in `EXPORT_TABLES` order. A column that points at a row later in that order (`sources.latest_snapshot_id`, `requirements.approved_revision_id`, `requirements.superseded_by`, `decisions.superseded_by_id`) is inserted null and set in a final pass. `blobs` rows are inserted with `sealed_at` null and sealed after their `blob_chunks`, whose `bytes` must match `sha256`; `snapshot_sections` are accepted because their ready snapshots are created in the same transaction. Both follow the Phase 3 immutability triggers, which are not bypassed.
  7. An `end` line must arrive, and its `sha256` must equal the running hash. Otherwise `ValidationError("export file is incomplete or changed (checksum mismatch)")`.
  8. The importer records event `workspace.imported`, with actor the importing member and data `{ sourceUrl, exportedAt, counts }`.

- [ ] **Step 1: Write the failing tests**

```ts
test("export then import into a fresh database reproduces every row, id and event", async () => {
  const lines = await exportLines(dbA, ws, admin);
  const summary = await importWorkspace(dbB, { lines: iter(lines), asIdentity: "github:1001", targetMigration: LATEST });
  for (const { table, scrub } of EXPORT_TABLES)
    expect(normalize(await rowsOf(dbB, table, ws), scrub)).toEqual(normalize(await rowsOf(dbA, table, ws), scrub));
  const evB = await rowsOf(dbB, "events", ws);
  expect(evB.slice(0, -1)).toEqual(await rowsBefore(dbA, "events", ws, "workspace.exported"));
  expect(evB.at(-1).type).toBe("workspace.imported");
});
test("after import, getDecisions and search give the same answers as before", async () => {});
test("imported connections need credentials; agent tokens and invites are revoked; notifiers are unset", async () => {
  expect(summary.needsAttention).toEqual({ connections: 1, notifierProjects: ["ACME"], agentTokensRevoked: 2, invitesRevoked: 1 });
  expect(await resolveAgentToken(dbB, agentToken)).toBeNull();
  expect((await listConnections(txB, adminB, depsB))[0].needsCredentials).toBe(true);
});
test("restoreConnectionCredentials makes an imported connection work again with a new webhook secret", async () => {});
test("importing a workspace that already exists is refused and writes nothing", async () => {});
test("a truncated file or a changed line is refused and writes nothing", async () => {
  await expect(importWorkspace(dbB, { ...input, lines: iter(lines.slice(0, -1)) })).rejects.toThrow("checksum mismatch");
  await expect(importWorkspace(dbB, { ...input, lines: iter(tamper(lines, 5)) })).rejects.toThrow("checksum mismatch");
  expect(await rawQuery(dbB, "select count(*)::int as n from tasks")).toEqual([{ n: 0 }]);
});
test("a file from a newer schema is refused naming the migration", async () => {});
test("an identity that is not an admin in the file is refused", async () => {});
test("mapIdentities moves a local-mode member to a GitHub identity", async () => {
  // export from a local-mode workspace (identity local:1), import with { "local:1": "github:1001" } → member's user has identity github:1001
});
test("a user who already exists on the target is reused and members point to them", async () => {});
test("an unknown table or column in the file is refused", async () => {});
```

- [ ] **Step 2: Run `pnpm test portability`.** Expected: FAIL.
- [ ] **Step 3: Implement.** Use `insert … values` batches through Drizzle tables looked up by name in a fixed registry built from `EXPORT_TABLES`. Never interpolate a table name from the file.
- [ ] **Step 4: Run tests, including the Phase 2 connection tests (an imported connection's `openConnection` is null).** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): workspace import preserving ids and events`.

### Task 59: Export and import CLI

**Files:**
- Create: `scripts/export.ts`, `scripts/import.ts`, `scripts/lib/cli.ts`, `scripts/portability.test.ts`
- Modify: root `package.json` (scripts `export`, `import`). `.gitignore` already has `threadline-export-*` (Phase 0 Task 1).

**Interfaces:**
- Consumes: Tasks 57–58, `createDb`
- Produces:
  - **Why a CLI and not HTTP:** a Worker request gets 10 ms of CPU. Serializing and base64-encoding a workspace with 10 MB blobs cannot fit. A paged HTTP import would need many requests and a client anyway, and could not run in one transaction, so a failure would leave half a workspace. A Node script has no CPU limit, holds one transaction, and streams with constant memory. The cost is that it needs the database URL, which only the operator has. A workspace admin on a shared deployment asks the operator, and the script still checks that the named identity is a workspace admin.
  - `pnpm export -- --workspace <uuid> --as <provider>:<id> [--out <file>]` uses `DATABASE_URL` (role `app_user`, so row-level security applies). The default output is `threadline-export-<first 8 hex of workspace id>-<YYYYMMDD>.jsonl.gz` in the current directory. The workspace name is never in the file name.
  - `pnpm import -- --file <file> --as <provider>:<id> [--map-identity <from>=<to>]...` uses `DATABASE_URL` and prints the summary. Afterwards it prints exactly these lines, each only when its count is non-zero: `Re-enter the token for N connection(s) under Connections, then update each webhook with the new secret.`, `Set the chat webhook again for: ACME, OTH.`, `N agent token(s) were revoked; members create new ones under Tokens.`, `N invite(s) were revoked.`, `Memory service is off; an admin can enable it again under Memory.`
  - Both resolve `--as` through `withSystem` to the user's member in the workspace, build an `Actor`, and pass it in. `runExport(argv: string[], io: { db?: Db; stdout; stderr }): Promise<number>` and `runImport(…)` return an exit code, so tests do not spawn processes. Usage errors exit 2, `ForbiddenError` and `ValidationError` exit 1 with the message on stderr, success exits 0.
  - Streaming: export writes `createGzip()` into `createWriteStream`. Import reads `createReadStream` through `createGunzip()` into `readline`, as the `AsyncIterable<string>` that `importWorkspace` takes.

- [ ] **Step 1: Write the failing tests**

```ts
test("export writes a gzip JSON Lines file with a neutral name, and import reads it back", async () => {
  expect(await runExport(["--workspace", ws, "--as", "github:1001"], { db: dbA, ...io })).toBe(0);
  const [file] = readdirSync(tmp).filter(f => /^threadline-export-[0-9a-f]{8}-\d{8}\.jsonl\.gz$/.test(f));
  expect(await runImport(["--file", join(tmp, file), "--as", "github:1001"], { db: dbB, ...io })).toBe(0);
  expect(io.out()).toContain("agent token(s) were revoked");
});
test("missing --workspace or --as prints usage and exits 2", async () => {});
test("a non-admin identity exits 1 with the ForbiddenError message", async () => {});
test("export files are ignored by git", () => {
  expect(execFileSync("git", ["check-ignore", "threadline-export-0190abcd-20261120.jsonl.gz"]).toString().trim())
    .toBe("threadline-export-0190abcd-20261120.jsonl.gz");
});
```

- [ ] **Step 2: Run `pnpm vitest run scripts/portability.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: pnpm export and pnpm import for whole workspaces`.

### Task 60: HTTP API for decisions, search, measures and memory

**Files:**
- Create: `apps/api/src/routes/decisions.ts`, `routes/measures.ts`, `routes/memory.ts`
- Modify: `apps/api/src/app.ts`, `routes/projects.ts` (search), `routes/connections.ts` (credentials restore), `routes/requirements.ts` (Phase 3 Task 44: memory sync after approval), `schemas.ts`
- Test: `apps/api/src/decisions.test.ts`, `apps/api/src/measures.test.ts`, `apps/api/src/memory.test.ts`, extend `apps/api/src/requirements.test.ts`

**Interfaces:**
- Consumes: Tasks 50–58, `codeHostDeps`, `notifyProject`
- Produces, under `/api/w/:workspaceId`:
  - `GET projects/:projectId/decisions?status=proposed,accepted` → `listDecisions`; `POST projects/:projectId/decisions` (`decisionInputBody`) → 201 `{ decisionId, ref, created }`, then `waitUntil(notifyProject(decisionMessage proposed))`
  - `GET projects/:projectId/decisions/why?decision=|about=|q=&includeProposed=` → `getDecisions`; `GET decisions/:decisionId` → the single chain for that decision
  - `PATCH decisions/:decisionId` → `updateProposedDecision`; `POST decisions/:decisionId/accept` `{ note? }` → `{ supersededRef }`, then `waitUntil` for the notification and `syncMemory({ limit: 5 })`; `POST decisions/:decisionId/reject` `{ note }`
  - `GET decisions/to-review` → `decisionsToReview`
  - `GET projects/:projectId/search?q=&kinds=decision,requirement&limit=` → `searchWithRecall`. An unknown kind gives 400.
  - `GET projects/:projectId/measures?from=&to=` → `getMeasures` plus `metrics: METRICS`; `GET projects/:projectId/manual-measures`, `POST projects/:projectId/manual-measures`
  - `GET memory`, `PUT memory`, `POST memory/test` → `{ ok, error? }`, `POST memory/sync` → `{ sent, failed, remaining }`. `GET memory` also returns `consentText: MEMORY_CONSENT_TEXT(baseUrl)` for the UI. The memory routes need `workspace.admin`, so agents get 403.
  - `POST connections/:id/credentials` `{ token }` → 200 `{ webhookSecret }` (returned once)
  - Phase 3's `POST proposals/approve` also calls `waitUntil(syncMemory(db, deps, { workspaceId, limit: 5 }))` after commit when any requirement was approved
  - zod schemas `decisionInputBody` (`DecisionSource` as a discriminated union on `kind`; the `snapshot` variant reuses Phase 3's citation fields `sourceId`, `snapshot`, `section`, `excerpt?`), `decisionPatchBody`, `acceptDecisionBody`, `rejectDecisionBody`, `searchQuery`, `measuresQuery`, `manualMeasureBody`, `memoryConfigBody` (with `consent: z.literal(true)` for `honcho`), `restoreCredentialsBody`, exported from `schemas.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test("a member proposes, an approver accepts, and why?about=ACME-1 returns the chain", async () => {
  const { decisionId } = await (await post(`/api/w/${ws}/projects/${projectId}/decisions`, memberCookie, decisionBody)).json();
  expect((await post(`/api/w/${ws}/decisions/${decisionId}/accept`, approverCookie, {})).status).toBe(200);
  const [chain] = await (await get(`/api/w/${ws}/projects/${projectId}/decisions/why?about=ACME-1`, agentBearer)).json();
  expect(chain.current).toMatchObject({ ref: "ACME-D1", status: "accepted" });
});
test("agent tokens get 403 on accept, reject, edit, to-review, measures, manual-measures and every memory route", async () => {});
test("a 201-character title or a missing source returns 400", async () => {});
test("search accepts kinds and rejects an unknown kind with 400", async () => {});
test("measures returns 400 for a window over 366 days", async () => {});
test("PUT memory without consent returns 400; GET memory never includes the API key", async () => {});
test("memory/sync returns remaining and can be called repeatedly", async () => {});
test("restoring credentials on an imported connection returns a new webhook secret once", async () => {});

// requirements.test.ts (extend)
test("approving a requirement with memory enabled sends it on the next sync without Sync now", async () => {});
```

- [ ] **Step 2: Run `pnpm --filter api test`.** Expected: FAIL.
- [ ] **Step 3: Implement.** Error mapping is unchanged from Task 11.
- [ ] **Step 4: Run tests.** Expected: PASS, including every Phase 1–3 API test.
- [ ] **Step 5: Commit** `feat(api): decisions, search, measures and memory routes`.

### Task 61: MCP: decisions through `propose_change` and `get_decisions`

**Files:**
- Modify: `apps/api/src/mcp.ts`, `apps/api/src/mcp.test.ts`

**Interfaces:**
- Consumes: Task 50 `proposeDecision`, Task 52 `getDecisions` and `TaskContext.decisions`, Task 55 `searchWithRecall`. From Phase 3: the `propose_change` tool and its requirement-proposal handler, and `get_source_text`.
- Produces:
  - **`propose_change` extended, not a new `propose_decision` tool:** design §7 already defines `propose_change` as "Propose a requirement change or a decision". Every agent write that touches approved records is then in one proposal-only tool, and the list grows by one read tool only. Phase 3's input is `{ project, requirements: RequirementChange[] (1–50), idempotency_key? }`. It gains `kind?: "requirement" | "decision"`, defaulting to `"requirement"`, and `requirements` becomes optional in the schema but required for that kind, so Phase 3 callers are unchanged. When the kind is `decision`, it takes `title`, `context`, `decision`, `consequences?`, `supersedes?` (decision ref), `requirement_refs?` (requirement refs; named so it cannot be confused with the Phase 3 `requirements` array), `task_refs?`, `source` (`{ kind: "snapshot", source, snapshot, section, excerpt? } | { kind: "external", url, ref_kind } | { kind: "note", text }`; the snapshot form is the Phase 3 `citation` shape), `evidence?` and the shared `idempotency_key?`. Missing fields give `isError` with `` `missing for kind "decision": ${names.join(", ")}` ``; `requirements` with kind `decision`, or decision fields with kind `requirement`, give `` `${name} is not used with kind "${kind}"` ``. The decision result is `{ decision: ref, status: "proposed", created, note: "Proposals are pending until a person decides in Threadline." }`, then `decisionMessage` (proposed) through `waitUntil`. The tool description gains: `"With kind \"decision\", records a proposed decision with its reasoning and source; a person must accept it in Threadline."`
  - Tool `get_decisions`, input `{ project, decision?, about?, query?, include_proposed? }`, calls `getDecisions`. Description, exact: `"Why was something decided? Returns accepted decision records, each with the decisions it replaced and the source it cites. Give one of: decision (for example ACME-D3), about (a task ref, requirement ref or URL), or query (words). Read only: only a person can accept a decision, in Threadline."`
  - The result of `get_decisions` and `search` starts with the Phase 1 untrusted-text line, followed by this exact second line: `Records with "authority": "approved" were accepted by a person. "record" items are coordination notes and source text. "derived" items (proposals, recalled memory) may be wrong; check them against approved records.`
  - `search` gains `kinds?` and returns `searchWithRecall` hits. `get_task_context` returns `decisions`.
  - The tool list is exactly eleven.

- [ ] **Step 1: Write the failing tests**

```ts
test("lists exactly the eleven tools", async () => {
  expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(["create_handoff", "get_by_ref", "get_contract_changes",
    "get_decisions", "get_source_text", "get_task_context", "my_open_items", "propose_change", "raise_blocker", "report_progress", "search"]);
});
test("no tool name or description mentions ack, acknowledge or approve", async () => {
  expect((await client.listTools()).tools.some(t => /ack|acknowledge|approve/.test(t.name + t.description))).toBe(false);
});
test("propose_change with kind decision creates a proposed decision; without kind it behaves as before", async () => {
  const res = await backendAgent.callTool({ name: "propose_change", arguments: { project: "ACME", kind: "decision",
    title: "Archived profiles stay visible to admins", context: "Support restores accounts.", decision: "Filter in the list query.",
    task_refs: ["ACME-1"], source: { kind: "snapshot", source: sourceId, snapshot: 1, section: "profiles/archive-a-profile" } } });
  expect(JSON.parse(res.content[0].text)).toMatchObject({ decision: "ACME-D1", status: "proposed", created: true });
});
test("propose_change with kind decision and no source names the missing field; requirements with kind decision is refused", async () => {});
test("get_decisions about a task returns the accepted decision, its history and its source, quoted, after the two prefix lines", async () => {
  const res = await frontendAgent.callTool({ name: "get_decisions", arguments: { project: "ACME", about: "ACME-1" } });
  const [line1, line2, ...rest] = res.content[0].text.split("\n");
  expect(line2).toMatch(/^Records with "authority": "approved" were accepted by a person\./);
  const [chain] = JSON.parse(rest.join("\n"));
  expect(chain.current.source).toMatchObject({ kind: "external", ref: { url: "https://chat.example.com/p/abc" } });
  expect(chain.current.decision.untrusted).toBe(true);
});
test("an agent cannot accept a decision through any tool", async () => { /* no tool reaches acceptDecision */ });
test("search returns decisions with authority, and recall hits last when memory is configured", async () => {});
test("get_task_context includes decisions", async () => {});
test("a token scoped to project A gets an error and no data for get_decisions in project B", async () => {});
```

- [ ] **Step 2: Run `pnpm --filter api test mcp`.** Expected: FAIL (ten tools).
- [ ] **Step 3: Implement.** The `propose_change` input shape stays a flat zod object (the SDK takes a raw shape). The decision fields are optional in the schema and checked in the handler when `kind === "decision"`.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): decisions over MCP`.

### Task 62: Web UI for decisions and search

**Files:**
- Create: `apps/web/src/pages/Decisions.tsx`, `pages/Decision.tsx`, `pages/Search.tsx`
- Modify: `apps/web/src/main.tsx` (routes `/w/:ws/p/:projectId/decisions`, `/w/:ws/decisions/:id`, `/w/:ws/p/:projectId/search`), `api.ts`, `pages/Inbox.tsx`, `pages/Task.tsx`, `pages/Project.tsx` (search box, Decisions link), `components/Header.tsx` (Inbox count includes decisions to review)
- Test: `apps/web/src/pages/Decisions.test.tsx`, `Decision.test.tsx`, `Search.test.tsx`, extend `Inbox.test.tsx` and `Task.test.tsx`

**Interfaces:**
- Consumes: the Task 60 routes and schemas
- Produces:
  - **Decisions:** tabs "Accepted", "Proposed", "History" (superseded and rejected). Each row shows the ref, title, status badge and date. "New decision" opens a form with title, context, decision, consequences, links (task and requirement pickers), and a source picker: "Section of a source" (source → snapshot → section, the same picker as Phase 3's hand-entered requirement citation), "Link" (URL), or "Note".
  - **Decision:** the current decision at the top, then a timeline of older decisions, each marked `Replaced by ACME-D2`. Each one shows its source: a snapshot source shows its citation (source title, snapshot, location, excerpt, and the "Section changed in latest snapshot" marker when `inLatest` is not `unchanged`) and links to that source on the Sources screen; an external link renders only for `http`/`https`. For holders of `decision.approve` on a proposal: Edit, Accept (optional note) and Reject (note required). On an accepted decision: "Supersede", which opens the form prefilled with `supersedes`.
  - **Search:** a query box with kind filter chips. Each result shows the kind, ref, snippet, and an authority badge: "Approved", "Record", or "Unverified" for `derived`. Recall hits appear under the heading "From memory (unverified)".
  - **Inbox:** a "Decisions to review" section for holders of `decision.approve`.
  - **Task:** a "Decisions" list from `TaskContext.decisions`.
  - Snippets render the `«…»`-style highlight markers from `ts_headline` by splitting the text, never as HTML.

- [ ] **Step 1: Write the failing tests** with Testing Library and a mocked `api.ts`

```ts
test("Decisions: Accept and Reject are shown only with decision.approve", async () => {});
test("Decision: the current decision comes first and older ones are marked 'Replaced by ACME-D2'", async () => {});
test("Decision: Reject cannot be submitted without a note", async () => {});
test("Decision: Supersede opens the form prefilled with supersedes", async () => {});
test("Decision: an external source renders as a link only for http and https", async () => {});
test("Search: results show an authority badge and recall hits sit under 'From memory (unverified)'", async () => {});
test("decision text and snippets render as text, never HTML", async () => {
  render(<Decision />);   // decision.text = '<img src=x onerror=alert(1)>'
  expect(document.querySelector("img")).toBeNull();
});
test("Inbox: 'Decisions to review' lists proposals for approvers", async () => {});
```

- [ ] **Step 2: Run `pnpm --filter web test`.** Expected: FAIL.
- [ ] **Step 3: Implement**, following the Task 13 rules (no `dangerouslySetInnerHTML`, brand tokens, no component library).
- [ ] **Step 4: Run tests and `pnpm --filter web build`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): decisions and search`.

### Task 63: Web UI for measures and memory settings

**Files:**
- Create: `apps/web/src/pages/Measures.tsx`, `pages/Memory.tsx`, `components/charts.tsx`
- Modify: `apps/web/src/main.tsx` (routes `/w/:ws/p/:projectId/measures`, `/w/:ws/memory`), `api.ts`, `pages/Project.tsx` (Measures link), `pages/Connections.tsx` (a "Needs credentials" badge and a restore form)
- Test: `apps/web/src/pages/Measures.test.tsx`, `Memory.test.tsx`, `components/charts.test.tsx`, extend `Connections.test.tsx`

**Interfaces:**
- Consumes: the Task 60 routes
- Produces:
  - `charts.tsx`: `CompareBars(props: { label: string; unit: "hours" | "count"; baseline: number | null; current: number | null }): JSX.Element` and `WeeklyLine(props: { series: { weekStart: string; median: number | null; count: number }[]; unit: "hours" | "count" }): JSX.Element`. Both are inline SVG with `role="img"`, a `<title>`, and a visually hidden `<table>` of the same numbers. Colours come from the brand tokens. No chart library.
  - **Measures:** a date-range picker (default last 30 days). For each metric in `METRICS` order: label, definition text, `CompareBars` (baseline = the newest manual entry for that metric, current = computed median), the open count, and `WeeklyLine`. A metric with `median: null` shows "No data yet". `dm_messages` shows manual entries only. Admins get "Add a manual figure" (metric, period label, start, end, value, sample size, note) and "Correct" on each entry, which sends `supersedes`.
  - **Memory** (admin only): provider select ("Off", "Honcho, self-hosted"), base URL, external workspace name, API key (a password input, never prefilled, with "Clear key"), and a consent checkbox labelled with `consentText` exactly. Save is disabled until the box is ticked. "Test" shows ok or the error. "Sync now" calls `memory/sync` repeatedly until `remaining` is 0, showing "Sent N, M left". A note states that Honcho is a separate service the team runs itself.
  - **Connections:** a connection with `needsCredentials` shows "Needs credentials (imported)" and a token form that calls `connections/:id/credentials` and shows the new secret once.

- [ ] **Step 1: Write the failing tests**

```ts
test("Measures: each metric shows baseline and current median with its unit; no data shows 'No data yet'", async () => {});
test("Measures: only admins see 'Add a manual figure'; Correct sends supersedes", async () => {});
test("charts: CompareBars renders an svg with a title and a table with the same numbers", () => {
  render(<CompareBars label="Change-request cycle time" unit="hours" baseline={52.5} current={30} />);
  expect(screen.getByRole("img", { name: /Change-request cycle time/ })).toBeTruthy();
  expect(screen.getByText("52.5")).toBeTruthy(); expect(screen.getByText("30")).toBeTruthy();
});
test("charts: a null value draws no bar and the table says 'No data yet'", () => {});
test("Memory: Save stays disabled until the consent box, labelled with the exact consent text, is ticked", async () => {});
test("Memory: the API key is a password input and is never prefilled", async () => {});
test("Memory: Sync now repeats until remaining is 0", async () => { /* mocked: remaining 25 → 5 → 0; three calls */ });
test("Connections: an imported connection shows 'Needs credentials (imported)' and shows the new secret once", async () => {});
```

- [ ] **Step 2: Run `pnpm --filter web test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests and `pnpm --filter web build`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): measures page and memory settings`.

### Task 64: End-to-end check, deployment and guide

**Files:**
- Create: `apps/api/src/decisions.e2e.test.ts`
- Modify: `README.md` (sections "Decisions", "Search", "Memory service (optional)", "Measures", "Export and import"), `.github/workflows/ci.yml` (add `pnpm vitest run scripts`)

**Interfaces:**
- Consumes: everything above
- Produces:
  - `decisions.e2e.test.ts`, in process (`createApp(env, { db, fetchImpl })`, with Honcho faked by `fakeProviderFetch`):
    1. The backend agent calls `propose_change` with `kind: "decision"` for `ACME-1`, citing `{ kind: "snapshot", source, snapshot: 1, section: "profiles/archive-a-profile" }` from `example-spec-v1.md` (uploaded with Phase 3's `uploadMarkdownFixture`) as its source.
    2. The approver accepts it over HTTP. The chat webhook receives `Decision ACME-D1 accepted.`
    3. A second proposal with `supersedes: "ACME-D1"` is accepted.
    4. The frontend agent calls `get_decisions` with `{ about: "ACME-1" }` and gets current `ACME-D2` with its source, and history `ACME-D1` with `supersededBy: "ACME-D2"`.
    5. `search` for a word from the decision returns `ACME-D2` with authority `approved` ahead of any `record` hit with the same rank.
    6. With memory enabled (consent given), `memory/sync` sends `ACME-D1` (superseded) and `ACME-D2`. A recalled item appears last in `search`, as `derived`.
    7. `exportWorkspace` into a fresh database, then `importWorkspace`. Step 4 returns the same chain there.
  - README:
    - Decisions: who proposes, who accepts (`decision.approve`), and supersession.
    - Search: keyword only, the three authority labels.
    - Memory service: how to self-host Honcho (the version tested), that it is AGPL-3.0 and kept as a separate service, what is sent and what never is, the consent text, `ALLOW_PRIVATE_CODE_HOSTS` for a private Honcho, and that Honcho may call its own model provider.
    - Measures: the definitions, and how to enter the roadmap baseline.
    - Export and import: the commands, that secrets are never exported, the after-import checklist, and that export files must never be committed.

- [ ] **Step 1: Write `decisions.e2e.test.ts` and run `pnpm --filter api test decisions.e2e`.** Expected: PASS. A failure names the numbered step: 1 or 3 points to Task 61, 2 to Task 60, 4 to Task 52, 5 to Task 51, 6 to Tasks 55–56, 7 to Tasks 57–58.
- [ ] **Step 2: Run `pnpm typecheck && pnpm test && pnpm test:ci-snippets && pnpm vitest run scripts`.** Expected: PASS.
- [ ] **Step 3: Deploy.** Run `pnpm migrate` (0019–0022), then `pnpm deploy`. Check that `GET /api/w/<ws>/memory` with an agent token returns 403.
- [ ] **Step 4: Rehearse a move.** `pnpm export` from the hosted deployment, `docker compose up`, `pnpm migrate` against it, `pnpm import` with `--map-identity` if needed, then sign in. Decisions, the event timeline and tasks match, and the printed checklist is correct.
- [ ] **Step 5: Write the README sections.**
- [ ] **Step 6: Commit** `chore: decisions end-to-end test, deployment and guide`.

**Phase 4 exit check (with the real team on the pilot project):**
1. A developer's agent proposes a decision through `propose_change` during real work, citing the spec section or chat thread it came from. The approver accepts it in Threadline.
2. Another member, in a fresh agent session, asks their agent why the affected feature was built that way. The agent calls `get_decisions` and answers with the decision record (ref, decision, reasoning) and its source. If the decision was superseded, it uses the current one and mentions the earlier one.
3. A workspace admin (manual figures need `workspace.admin`, which the `pm` template does not hold) enters the pre-Phase-1 baseline from the PM on the Measures page, and it shows next to the current numbers.
4. An export of the pilot workspace imports cleanly into a local Docker deployment.

Record what was learned below.

## Changes to earlier code

Folded into the earlier plans (built right the first time):

- `decision.propose`, `decision.approve` in `Permission`, and `decision.approve` in `HUMAN_ONLY`: Task 2 of the Phase 0–1 plan.
- Role template grants of both: Task 4 of the Phase 0–1 plan.
- Nullable `agent_identities.token_hash` and `invites.code_hash`: Task 5 of the Phase 0–1 plan.
- `.gitignore` entry `threadline-export-*`: Task 1 of the Phase 0–1 plan.
- `tsv` as the name of every generated search column: Task 9 of the Phase 0–1 plan.
- `ChangeRequest.createdAt` and `mergedAt`, with fixtures and suite: Tasks 17–19 of the Phase 2 plan.
- Nullable `connections.credentials_enc` and `webhook_secret_hash`, and `openConnection` returning null without credentials: Task 20 of the Phase 2 plan.
- `checkCitation` with `authoritativeOnly`: Task 38 of the Phase 3 plan.

Made by this plan's tasks:

| Earlier code | Change | Task |
|---|---|---|
| `db/client.ts` (Phase 0 Task 3) | `withWorkspace` options `{ isolation, readOnly }` | 57 |
| `db/client.ts` | core-internal `withImport` | 58 |
| `context.ts` (Phase 1 Task 9, Phase 3 Task 43) | `search` moves to `search.ts`; `SearchHit` gains `authority`, `status`, `supersededBy`, `createdAt`, `rank`; `kind` gains `decision`, `contract_change`, `recall` | 51 |
| `context.ts` | `TaskContext` gains `decisions` | 52 |
| `mcp.ts` (Phase 1 Task 12, Phase 3 Task 45) | eleven tools with `get_decisions`; `propose_change` gains `kind: "decision"`; `search` gains `kinds?` | 61 |
| `webhooks.ts` (Phase 2 Task 22) | `measureHandler` third in `defaultHandlers.changeRequest` | 53 |
| `connections.ts` (Phase 2 Task 20) | `ConnectionView.needsCredentials`, `restoreConnectionCredentials` | 58 |
| `routes/connections.ts` (Phase 2 Task 27) | `POST connections/:id/credentials` | 60 |
| `routes/requirements.ts` (Phase 3 Task 44) | `syncMemory` after an approval | 60 |
| `Connections.tsx` (Phase 2 Task 29) | "Needs credentials (imported)" and restore form | 63 |
| Global Constraints | bookkeeping exemption gains `memory_sync`, `change_request_stats` (stated in this plan) | none |

## Notes after the phase

(To be filled in after the exit check.)
