# Code Hosts (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On both a GitLab (including self-hosted) and a GitHub repository, a change request touching a declared shared path creates an open item for the consumer role and cannot merge until a person acknowledges it; change requests naming a task become its evidence; failed pipeline runs and deployments open blockers that a later success closes.

**Architecture:** A `CodeHost` interface in `packages/core/src/codehost/` with one GitLab and one GitHub adapter; everything outside that folder uses neutral words (change request, pipeline run, deployment). A `connections` table holds each configured code host with its token and webhook secret encrypted by AES-GCM. A webhook endpoint `POST /hooks/:workspaceId/:connectionId` verifies, de-duplicates and normalizes deliveries into identifier-only events, re-reads the real state from the provider API, and hands it to three idempotent core handlers (evidence linking, pipeline blockers, contract changes), all inside the request. The contract handler posts a `threadline/contract` commit status that is pending until every consumer role has acknowledged.

**Tech Stack:** As Phases 0–1 (Node 22, pnpm 9, TypeScript 5 strict, Hono 4, Drizzle, Postgres 16 / PGlite, zod, MCP TypeScript SDK with `@hono/mcp`, React 19, Vite, TanStack Query, Vitest, Wrangler), plus Web Crypto (`crypto.subtle`) for HMAC and AES-GCM, and `yaml` (dev only) to test the CI snippets.

**Spec:** [`docs/design.md`](../../design.md) sections 4, 6.4, 6.5, 10. Scope and exit check: [`docs/roadmap.md`](../../roadmap.md) Phase 2. Builds on [`2026-11-20-core-and-handoffs.md`](2026-11-20-core-and-handoffs.md) (Tasks 1–15, migrations 0001–0007).

## Global Constraints

Copied from Phases 0–1 (still binding):

- No AI model calls anywhere in the platform.
- No provider-specific column in any core table. External things use `ExternalRefInput`.
- Product name `Threadline`, tagline `One shared context. Every step connected.`, package scope `@threadline/*`, logo at `docs/brand/logo.png`.
- Every table has `ENABLE` and `FORCE ROW LEVEL SECURITY`. Workspace tables have `workspace_id uuid not null` and a policy `workspace_id = current_setting('app.workspace_id')::uuid`. The three account tables that belong to no workspace (`users`, `user_identities`, `sessions`) have a policy allowing access only when `current_setting('app.system', true) = 'on'`, set by `withSystem`.
- All database access goes through `withWorkspace`. `apps/*` never imports Drizzle tables directly.
- Every mutation in `core` calls `recordEvent` in the same transaction.
- Agents can never hold `handoff.ack`, `contract.ack`, `requirement.approve`, `decision.approve`, `task.accept` or `workspace.admin` (`HUMAN_ONLY`, complete since Phase 0 Task 2). This is enforced in `can`, not in role data.
- MCP tool names and descriptions never contain the substrings `ack`, `acknowledge` or `approve`.
- Free text written by any actor is capped at 10,000 characters, passed through `redactSecrets` before storage, and returned to agents as `Quoted`.
- The code runs on both Cloudflare Workers and Node. No Node-only APIs in `packages/core` or `apps/api/src` outside `apps/api/src/node.ts`. No long-lived connections and no background workers.
- No password storage. Session, invite and agent tokens are random (32 bytes for sessions and agents, 24 for invites) and stored only as SHA-256 hex.
- The repository is public. No secrets, client names or client data in any committed file, including tests and docs. `research_notes/` and `reports/` stay out of git.
- Records are never deleted; status changes and supersession only.
- IDs are UUID v7 generated in the application (`newId()`).

Added in Phase 2:

- Neutral vocabulary everywhere outside `packages/core/src/codehost/{gitlab,github}.ts` and their fixtures: *change request* (MR/PR), *pipeline run* (pipeline / Actions run), *deployment*. No table, column, exported type, route, MCP field or UI label says "merge request", "pull request" or "workflow".
- `contract.ack` is the permission to acknowledge a contract change. It has been in `Permission` and `HUMAN_ONLY` since Phase 0 Task 2, and the `pm`, `lead`, `frontend` and `backend` templates hold it since Task 4.
- A connection actor can hold only `blocker.write`, and only in a project it is linked to through an active `project_repos` row. Evidence links and contract-change records are written by core webhook handlers acting as the connection; no HTTP route or MCP tool lets anyone write them directly.
- Code-host tokens and webhook secrets are encrypted at rest with AES-GCM (256-bit key, env `CREDENTIALS_KEY`, base64 of 32 bytes; optional `CREDENTIALS_KEY_PREVIOUS` for rotation), with the connection ID as additional authenticated data. They are never returned by any route, MCP tool, view, event or error message. Only the webhook secret is shown, once, when created or rotated.
- Web Crypto only (`crypto.subtle`, `crypto.getRandomValues`). No `node:crypto`.
- Webhooks are processed inside the request. Signatures are verified first: GitHub `X-Hub-Signature-256` (HMAC-SHA256 of the raw body, verified with `crypto.subtle.verify`), GitLab `X-Gitlab-Token` (SHA-256 of the header compared to the stored hash with `constantTimeEqual`). Deliveries are de-duplicated on GitHub `X-GitHub-Delivery`, GitLab `Idempotency-Key`, falling back to `X-Gitlab-Event-UUID`. Every handler is idempotent and tolerates out-of-order delivery. Normalized events carry identifiers only. All state is re-read from the provider API.
- Workers free-plan budget per webhook request: at most 20 provider API calls (the 50-subrequest limit also covers the database and the notifier), a 4-second timeout per call, request bodies over 1 MB rejected with 413. The only work after the response is `waitUntil` notifications.
- After its signature is verified, a webhook gets a 2xx response even when processing fails. Failures are recorded on the delivery and shown in the UI, so GitLab does not auto-disable the hook. A redelivery of a failed delivery is processed again.
- Provider base URLs must be `https`, with no credentials, query or fragment. Loopback, private, link-local and unique-local hosts are refused unless `ALLOW_PRIVATE_CODE_HOSTS=true` (for a self-hosted GitLab on a private network with the Node deployment).
- The merge check is a commit status named exactly `threadline/contract`, constant `CONTRACT_CHECK_NAME`.
- Bookkeeping tables `webhook_deliveries` and `pipeline_states`, and the merge-check sync columns on `contract_changes` (`merge_check`, `merge_check_sha`, `comment_revision`), are exempt from `recordEvent`. Any change they cause to a record does record an event. Delivery rows older than 30 days may be pruned. They are logs, not records.
- Tests make no network calls. Provider APIs are faked with `fakeProviderFetch`; webhooks come from fixture files signed at test time. Fixtures are synthetic and use only `example-org/example-app`, users `dev-one` and `dev-two`, emails `@example.com`, and invented IDs, with no tokens.

## Review Focus

1. A repository that requires the `threadline/contract` check gets a change request that touches no shared path, or a project with no shared paths declared: the check must still be posted as `success` on every head SHA, or every merge in that repository is blocked forever. Test in Task 25.
2. Two pipelines on the same branch (two GitHub workflows, or a pipeline and a deployment): one fails and the other succeeds. The blocker stays open; only a later success of the same stream closes it. Test in Task 24.
3. Webhooks arrive out of order: an older run's success arrives after a newer run's failure, or an older failure arrives after the success that closed the blocker. Neither closes nor opens a blocker. Test in Task 24.
4. After acknowledgement, the author pushes more commits. If they change shared files, the contract change returns to pending (new revision, consumers acknowledge again). If not, it stays acknowledged and `success` is posted on the new head SHA. Test in Task 25.
5. The provider is down or the token lacks permission when the check is posted after an acknowledgement. The acknowledgement is saved; `mergeCheck` becomes `failed` (retry works) or `unsupported` (one comment posted on the change request). Test in Task 25 and Task 27.
6. GitLab creates a pipeline just for Threadline's own external status (source `external`). Its result must not open or close blockers. Test in Task 18.
7. A workspace admin enters a code-host base URL such as `https://169.254.169.254` or `https://localhost:8080`. Refused unless `ALLOW_PRIVATE_CODE_HOSTS=true`. Test in Task 20.

---

## File Structure

```
packages/core/src/
  crypto.ts                  sha256Hex, constantTimeEqual, hmacSha256Verify, randomToken, AES-GCM credentials
  codehost/types.ts          CodeHost, ChangeRequest, ChangedFile, PipelineRun, NormalizedEvent, RepoIdent,
                             CodeHostCapabilities, CommitStatus, WebhookSecret, ProviderError, CONTRACT_CHECK_NAME
  codehost/http.ts           createProviderHttp (budget, timeout, error mapping), paginate
  codehost/gitlab.ts         GitLab adapter (gitlab.com and self-hosted)
  codehost/github.ts         GitHub adapter (github.com and Enterprise Server)
  codehost/index.ts          createCodeHost, DEFAULT_BASE_URL, defaultCapabilities
  codehost/testing.ts        fakeProviderFetch, loadFixture, signGitHub
  codehost/suite.ts          runCodeHostSuite: the shared behaviour both adapters must pass
  codehost/fixtures/{gitlab,github}/   webhook-*.json and api-*.json (synthetic)
  connections.ts             connections: create, list, test, rotate secret, replace token, archive, openConnection
  repos.ts                   project_repos: linkRepo, listProjectRepos, unlinkRepo, findRepoLink
  glob.ts                    validateGlob, compileGlobs
  refs.ts                    extractTaskRefs
  webhooks.ts                handleWebhook, defaultHandlers, listDeliveries
  evidence.ts                linkChangeRequestToTasks, tasksForChangeRequests
  pipelines.ts               applyPipelineRun
  contracts.ts               contract changes, acknowledgements, syncContractStatus, views
  db/migrations/0008_connections.sql … 0013_contract_changes.sql
  (modified) types.ts tenancy.ts projects.ts context.ts notify/index.ts schema.ts index.ts db/testing.ts
apps/api/src/
  routes/connections.ts  routes/contracts.ts  routes/hooks.ts   (modified) routes/projects.ts app.ts schemas.ts mcp.ts
  deps.ts                    codeHostDeps(env, c): CodeHostDeps
  codehost.e2e.test.ts       both providers, end to end, in process
apps/web/src/
  pages/Connections.tsx      (modified) pages/Project.tsx Inbox.tsx Task.tsx components/Header.tsx api.ts main.tsx
integrations/ci/
  README.md
  github/api-report.yml  github/unused-exports.yml
  gitlab/api-report.gitlab-ci.yml  gitlab/unused-exports.gitlab-ci.yml
  templates/api-extractor.json  templates/knip.json
  ci.test.mjs
```

## Shared types

Defined in Task 17 in `packages/core/src/codehost/types.ts` and used by every later task.

```ts
export type Provider = "gitlab" | "github";
export const CONTRACT_CHECK_NAME = "threadline/contract";

export type CodeHostCapabilities = { commitStatus: boolean; comments: boolean; deployments: boolean };
export type RepoIdent = { externalRepoId: string; path: string };          // path: "example-org/example-app"

export type ChangeRequest = {
  externalId: string;      // provider's global id (GitLab MR `id`, GitHub PR `id`), not the per-repo number
  number: number; reference: string;   // reference: "example-org/example-app!7" or "…#7"
  url: string; title: string; description: string;
  sourceBranch: string; targetBranch: string; headSha: string;
  state: "open" | "merged" | "closed"; createdAt: string; mergedAt: string | null; updatedAt: string;
};
export type ChangedFile = { path: string; previousPath?: string; status: "added" | "modified" | "removed" | "renamed" };
export type PipelineRun = {
  kind: "pipeline_run" | "deployment"; externalId: string; url: string;
  name: string;            // display: workflow name, "pipeline", or environment name
  stream: string;          // stable identity of "the same check": "workflow:<id>", "pipeline", "env:<name>"
  ref: string;             // always a branch or tag name, never refs/merge-requests/…
  sha: string; status: "pending" | "running" | "succeeded" | "failed" | "cancelled"; startedAt: string;
};
export type CommitStatus = { state: "pending" | "success"; description: string; targetUrl?: string };
export type NormalizedEvent =
  | { type: "change_request"; repo: RepoIdent; number: number }
  | { type: "pipeline_run"; repo: RepoIdent; externalId: string }
  | { type: "deployment"; repo: RepoIdent; externalId: string }
  | { type: "ping" }
  | { type: "ignored"; reason: string };
export type WebhookSecret = { hashHex: string; reveal(): Promise<string> };

export interface CodeHost {
  readonly provider: Provider;
  readonly capabilities: CodeHostCapabilities;
  testConnection(): Promise<{ account: string }>;
  getRepo(path: string): Promise<{ repo: RepoIdent; url: string; defaultBranch: string }>;
  getChangeRequest(repo: RepoIdent, number: number): Promise<ChangeRequest>;
  listChangedFiles(repo: RepoIdent, number: number): Promise<{ files: ChangedFile[]; truncated: boolean }>;
  compareFiles(repo: RepoIdent, fromSha: string, toSha: string): Promise<{ paths: string[]; truncated: boolean }>;
  getPipelineRun(repo: RepoIdent, externalId: string): Promise<PipelineRun>;
  getDeployment(repo: RepoIdent, externalId: string): Promise<PipelineRun>;
  listChangeRequestsForCommit(repo: RepoIdent, sha: string): Promise<{ externalId: string; reference: string }[]>;
  setCommitStatus(repo: RepoIdent, sha: string, status: CommitStatus): Promise<void>;
  postComment(repo: RepoIdent, number: number, body: string): Promise<void>;
  deliveryId(headers: Headers): string | null;
  verifyWebhook(headers: Headers, rawBody: Uint8Array, secret: WebhookSecret): Promise<boolean>;
  normalizeWebhook(headers: Headers, body: unknown): NormalizedEvent[];
}

export class ProviderError extends Error {
  constructor(public provider: Provider, public status: number /* 0 = network, timeout or budget */,
              message: string, public rateLimited = false) { super(message); }
}
```

Design §4 sketches this interface. Three choices behind it: `verifyWebhook` is async, because Web Crypto is. It takes a `WebhookSecret`, because GitHub's HMAC needs the plaintext secret while GitLab compares a hash. Capabilities name `commitStatus` rather than `requiredReviewers`, because the merge block is a required status check on both hosts.

Defined in Task 20 in `packages/core/src/connections.ts`:

```ts
export type ConnectionActor = Extract<Actor, { kind: "connection" }>;
export type CodeHostDeps = {
  fetchImpl: typeof fetch;
  credentialsKeys: CredentialsKey[];      // [current, previous?]; empty when CREDENTIALS_KEY is unset
  publicUrl: string;
  allowPrivateHosts: boolean;
  waitUntil(p: Promise<unknown>): void;
};
```

---

# Phase 2: code hosts

### Task 16: Crypto helpers and credential encryption

**Files:**
- Create: `packages/core/src/crypto.ts`
- Test: `packages/core/src/crypto.test.ts`

**Interfaces:**
- Produces:
  - `sha256Hex(text: string | Uint8Array): Promise<string>`
  - `constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean`: false for different lengths; otherwise XOR-accumulates every byte without returning early
  - `hmacSha256Verify(secret: string, data: Uint8Array, signatureHex: string): Promise<boolean>`: false (not throw) for malformed hex; uses `crypto.subtle.verify`
  - `randomToken(prefix: string, bytes: number): string`: prefix + base64url without padding
  - `type CredentialsKey = { kid: string; key: CryptoKey }`, where `kid` is the first 8 hex characters of the SHA-256 of the raw key
  - `importCredentialsKey(base64: string): Promise<CredentialsKey>`: throws `ValidationError` unless it decodes to exactly 32 bytes
  - `encryptSecret(key: CredentialsKey, plaintext: string, aad: string): Promise<string>`: format `v1.<kid>.<iv b64url>.<ciphertext b64url>`, with a fresh 12-byte IV
  - `decryptSecret(keys: CredentialsKey[], blob: string, aad: string): Promise<string>`: picks the key by `kid`; throws `ValidationError("credentials cannot be decrypted")` on unknown kid, wrong AAD or tampering

- [ ] **Step 1: Write the failing tests**

```ts
test("sha256Hex", async () => {
  expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
test("hmacSha256Verify accepts the RFC 4231 vector and rejects a changed byte or bad hex", async () => {
  const data = new TextEncoder().encode("what do ya want for nothing?");
  const sig = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";
  expect(await hmacSha256Verify("Jefe", data, sig)).toBe(true);
  expect(await hmacSha256Verify("Jefe", data, sig.replace(/^5/, "6"))).toBe(false);
  expect(await hmacSha256Verify("Jefe", data, "zz")).toBe(false);
});
test("constantTimeEqual", () => {
  expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
  expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
  expect(constantTimeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
});
test("randomToken", () => { expect(randomToken("whs_", 32)).toMatch(/^whs_[A-Za-z0-9_-]{43}$/); });
test("encrypt then decrypt round-trips; ciphertext hides the plaintext and differs each time", async () => {
  const k = await importCredentialsKey(TEST_KEY_B64);   // 32 zero bytes, base64, defined in the test
  const a = await encryptSecret(k, "glpat-test-only", "connection:1");
  const b = await encryptSecret(k, "glpat-test-only", "connection:1");
  expect(a).toMatch(/^v1\.[0-9a-f]{8}\./); expect(a).not.toContain("glpat"); expect(a).not.toBe(b);
  expect(await decryptSecret([k], a, "connection:1")).toBe("glpat-test-only");
});
test("decrypt fails with the wrong AAD, a tampered blob, or an unknown key", async () => {});
test("a blob made with the previous key still decrypts when it is listed second", async () => {});
test("importCredentialsKey rejects a 16-byte key", async () => {
  await expect(importCredentialsKey(btoa("x".repeat(16)))).rejects.toThrow(ValidationError);
});
```

- [ ] **Step 2: Run `pnpm test crypto`.** Expected: FAIL, module not found.
- [ ] **Step 3: Implement** with `crypto.subtle` (`importKey` raw AES-GCM 256, non-extractable; HMAC SHA-256) only.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): crypto helpers and credential encryption`.

### Task 17: CodeHost interface, provider HTTP and the shared adapter suite

**Files:**
- Create: `packages/core/src/codehost/types.ts`, `http.ts`, `testing.ts`, `suite.ts`, `fixtures/README.md` (states the fixture rules from Global Constraints)
- Test: `packages/core/src/codehost/http.test.ts`, `packages/core/src/codehost/fixtures.test.ts`

**Interfaces:**
- Produces: everything in "Shared types" from `types.ts`, plus
  - `createProviderHttp(opts: { provider: Provider; apiBase: string; authHeaders: Record<string, string>; fetchImpl: typeof fetch; maxCalls?: number; timeoutMs?: number }): ProviderHttp` with defaults `maxCalls = 20`, `timeoutMs = 4000`
  - `type ProviderHttp = { request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<{ data: T; headers: Headers }>; calls(): number }`. A non-2xx response throws `ProviderError(provider, status, "<provider> <METHOD> <path without query> returned <status>")`. 403 or 429 with a rate-limit header sets `rateLimited`. A timeout or network failure throws status 0. Call number `maxCalls + 1` throws status 0 `"call budget exhausted"` without fetching. Messages never contain header values or the token.
  - `paginate<T>(http: ProviderHttp, path: string, hasNext: (headers: Headers, page: T[]) => boolean, maxPages = 3): Promise<{ items: T[]; truncated: boolean }>`: requests `per_page=100&page=n`; `truncated` is true when page `maxPages` still has a next page
  - In `testing.ts`: `fakeProviderFetch(routes: Record<string, unknown | { status: number; body?: unknown; headers?: Record<string, string> }>, calls?: Request[]): typeof fetch`, with keys like `"GET https://api.github.com/repos/example-org/example-app/pulls/7"` (query string ignored unless the key has one). An unmatched request throws `Error("unexpected request GET <url>")`. `loadFixture(provider: Provider, name: string): unknown`. `signGitHub(body: Uint8Array, secret: string): Promise<string>` returns `sha256=<hex>`.
  - In `suite.ts`: `runCodeHostSuite(spec: CodeHostSuiteSpec): void` registers Vitest tests every adapter must pass. `CodeHostSuiteSpec = { provider: Provider; makeHost(fetchImpl: typeof fetch): CodeHost; apiRoutes: Record<string, unknown>; repo: RepoIdent; signedDelivery(name: SuiteWebhook, secret: string): Promise<{ headers: Headers; body: Uint8Array }>; secretFor(secret: string): Promise<WebhookSecret>; expected: { changeRequest: ChangeRequest; failedRun: PipelineRun; events: Record<SuiteWebhook, NormalizedEvent[]> } }` and `SuiteWebhook = "changeRequestOpened" | "changeRequestUpdated" | "pipelineFailed" | "pipelineSucceeded" | "pipelineNotFinished" | "deploymentFailed" | "ping"`.
  - Suite tests: a good signature verifies; a changed body byte, a wrong secret and a missing header each fail; `deliveryId` reads the provider header; each `SuiteWebhook` normalizes to `expected.events[name]`; a malformed body (`{}` or `"x"`) normalizes to `[{ type: "ignored", … }]` without throwing; `getChangeRequest` equals `expected.changeRequest`; `listChangedFiles` follows two pages and reports a rename with `previousPath`; four full pages give `truncated: true` after three; `setCommitStatus` sends one POST naming `threadline/contract` with the given state; a 500 response throws `ProviderError` whose message and `String(err)` contain no part of the token.

- [ ] **Step 1: Write the failing tests**

```ts
// http.test.ts
test("the 21st call fails without fetching", async () => {
  const calls: Request[] = [];
  const http = createProviderHttp({ provider: "github", apiBase: "https://api.test", authHeaders: { authorization: "Bearer t0k" },
    fetchImpl: fakeProviderFetch({ "GET https://api.test/x": {} }, calls) });
  for (let i = 0; i < 20; i++) await http.request("GET", "/x");
  await expect(http.request("GET", "/x")).rejects.toMatchObject({ status: 0 });
  expect(calls).toHaveLength(20);
});
test("errors name the method, path and status but never the token or query string", async () => {
  const err = await http.request("GET", "/repos/a/b?private_token=t0k").catch(e => e);
  expect(err).toBeInstanceOf(ProviderError);
  expect(err.message).toBe("github GET /repos/a/b returned 404");
  expect(JSON.stringify({ m: err.message, s: String(err) })).not.toContain("t0k");
});
test("a slow response times out with status 0", async () => { /* fetch that never resolves, timeoutMs 50 */ });
test("429 sets rateLimited", async () => {});
test("paginate stops at maxPages and reports truncation", async () => {});

// fixtures.test.ts
test("fixtures contain no secrets, real-looking emails or names outside the allow-list", () => {
  for (const file of allFixtureFiles()) {
    const text = readFileSync(file, "utf8");
    expect(redactSecrets(text)).toBe(text);
    for (const email of text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? []) expect(email).toMatch(/@example\.com$/);
    for (const repo of text.match(/"(full_name|path_with_namespace)":\s*"([^"]+)"/g) ?? [])
      expect(repo).toMatch(/example-org\/example-app/);
  }
});
```

- [ ] **Step 2: Run `pnpm test codehost`.** Expected: FAIL.
- [ ] **Step 3: Implement** `types.ts`, `http.ts`, `testing.ts`, and `suite.ts` (the suite registers tests and makes no assertions of its own when imported).
- [ ] **Step 4: Run tests.** Expected: PASS (`fixtures.test.ts` passes on an empty fixture folder; Tasks 18–19 add files).
- [ ] **Step 5: Commit** `feat(core): code host interface and provider HTTP`.

### Task 18: GitLab adapter

**Files:**
- Create: `packages/core/src/codehost/gitlab.ts`, `packages/core/src/codehost/fixtures/gitlab/*.json`
- Test: `packages/core/src/codehost/gitlab.test.ts`

**Interfaces:**
- Consumes: Task 17
- Produces: `createGitLabHost(opts: { baseUrl: string; token: string; fetchImpl: typeof fetch }): CodeHost`
  - API base `${baseUrl}/api/v4`. Auth header `PRIVATE-TOKEN` (works for personal, project and group access tokens). Repos are addressed by `externalRepoId` (the numeric project id) once known; `getRepo` uses the URL-encoded path.
  - Endpoints: `GET /user`; `GET /projects/:path`; `GET /projects/:id/merge_requests/:iid`; `GET …/merge_requests/:iid/diffs` (paginated, next page from the `x-next-page` header); `GET /projects/:id/repository/compare?from=&to=&straight=true`; `GET /projects/:id/pipelines/:pid`; `GET /projects/:id/deployments/:did`; `GET /projects/:id/repository/commits/:sha/merge_requests`; `POST /projects/:id/statuses/:sha` with `{ name: "threadline/contract", state, description, target_url, ref }`; `POST …/merge_requests/:iid/notes` with `{ body }`.
  - Mapping. MR state `opened`/`locked` → `open`, `merged` → `merged`, `closed` → `closed`. `reference` is `references.full`. `createdAt` is `created_at`, `mergedAt` is `merged_at`. Pipeline `success` → `succeeded`, `failed` → `failed`, `canceled`/`skipped` → `cancelled`, `created`/`waiting_for_resource`/`preparing`/`pending`/`scheduled`/`manual` → `pending`, `running` → `running`. Pipeline `stream` is `"pipeline"`, `name` is the pipeline `name` or `"pipeline"`, `startedAt` is `started_at ?? created_at`. A ref of the form `refs/merge-requests/:iid/(head|merge|train)` is replaced by that MR's `source_branch` (one extra call). Deployment `success` → `succeeded`, `failed` → `failed`, `canceled` → `cancelled`, everything else → `running`; `stream` is `env:<environment name>`.
  - Webhooks: event header `X-Gitlab-Event`. `Merge Request Hook` gives `change_request` (from `object_attributes.iid` and `project.id` / `project.path_with_namespace`) for actions `open`, `update`, `reopen`, `close`, `merge`; other actions are `ignored`. `Pipeline Hook` gives `pipeline_run` only when `object_attributes.status` is terminal (`success`, `failed`, `canceled`, `skipped`), and gives `ignored` with reason `"external status pipeline"` when `object_attributes.source === "external"`. `Deployment Hook` gives `deployment` from `deployment_id` when the status is terminal. Anything else is `ignored`.
  - `deliveryId`: `Idempotency-Key`, else `X-Gitlab-Event-UUID`, else null.
  - `verifyWebhook`: `constantTimeEqual(hexToBytes(await sha256Hex(header)), hexToBytes(secret.hashHex))`; a missing header is false. Never calls `reveal()`.
- Fixtures (synthetic, trimmed to the fields read): `webhook-merge_request-open.json`, `webhook-merge_request-update.json`, `webhook-pipeline-failed.json`, `webhook-pipeline-success.json`, `webhook-pipeline-running.json`, `webhook-pipeline-external.json`, `webhook-deployment-failed.json`, `api-user.json`, `api-project.json`, `api-mr.json`, `api-mr-diffs-p1.json`, `api-mr-diffs-p2.json`, `api-compare.json`, `api-pipeline-failed.json`, `api-pipeline-success.json`, `api-pipeline-mr-ref.json`, `api-deployment-failed.json`, `api-commit-mrs.json`.

- [ ] **Step 1: Write the failing tests**

```ts
runCodeHostSuite({ provider: "gitlab", makeHost: f => createGitLabHost({ baseUrl: "https://gitlab.example.com", token: "glpat-test-only-000000000000", fetchImpl: f }), … });

test("works under a self-hosted base URL with a path prefix", async () => {
  const calls: Request[] = [];
  const host = createGitLabHost({ baseUrl: "https://example.com/gitlab", token: T,
    fetchImpl: fakeProviderFetch({ "GET https://example.com/gitlab/api/v4/user": { username: "dev-one" } }, calls) });
  expect(await host.testConnection()).toEqual({ account: "dev-one" });
});
test("a pipeline created only for Threadline's external status is ignored", () => {
  expect(host.normalizeWebhook(headers("Pipeline Hook"), loadFixture("gitlab", "webhook-pipeline-external"))[0])
    .toEqual({ type: "ignored", reason: "external status pipeline" });
});
test("a merge-request pipeline ref becomes the source branch", async () => {
  expect((await host.getPipelineRun(repo, "9001")).ref).toBe("feature/ACME-1-profile");
});
test("Idempotency-Key is preferred to X-Gitlab-Event-UUID", () => {});
test("the token header is compared by hash and reveal() is never called", async () => {});
```

- [ ] **Step 2: Run `pnpm test gitlab`.** Expected: FAIL.
- [ ] **Step 3: Implement**, parsing webhook bodies and API responses with zod schemas local to `gitlab.ts`; a schema failure in a webhook gives `ignored: "unrecognized payload"`, in an API response a `ProviderError(…, 502, …)`.
- [ ] **Step 4: Run tests.** Expected: PASS, including the shared suite and `fixtures.test.ts`.
- [ ] **Step 5: Commit** `feat(core): GitLab code host adapter`.

### Task 19: GitHub adapter

**Files:**
- Create: `packages/core/src/codehost/github.ts`, `packages/core/src/codehost/index.ts`, `packages/core/src/codehost/fixtures/github/*.json`
- Test: `packages/core/src/codehost/github.test.ts`

**Interfaces:**
- Consumes: Task 17
- Produces:
  - `createGitHubHost(opts: { baseUrl: string; token: string; fetchImpl: typeof fetch }): CodeHost`. API base is `https://api.github.com` when `baseUrl` is `https://github.com`, otherwise `${baseUrl}/api/v3` (Enterprise Server). Headers: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `User-Agent: threadline`.
  - Endpoints: `GET /user`; `GET /repos/:path`; `GET /repos/:path/pulls/:n`; `GET …/pulls/:n/files` (paginated, next from the `Link` header `rel="next"`); `GET …/compare/:from...:to`; `GET …/actions/runs/:id`; `GET …/deployments/:id` plus `GET …/deployments/:id/statuses?per_page=1`; `GET …/commits/:sha/pulls`; `POST …/statuses/:sha` with `{ context: "threadline/contract", state, description, target_url }`, description cut to 140 characters; `POST …/issues/:n/comments`. GitHub repos are addressed by `path` (`externalRepoId` is the numeric `repository.id`, used for matching).
  - Mapping. PR `open` → `open`; `closed` with `merged_at` → `merged`, otherwise `closed`. `reference` is `<full_name>#<n>`. `createdAt` is `created_at`, `mergedAt` is `merged_at`. File status `added`/`removed`/`renamed` map to themselves, everything else → `modified`. Run `status !== "completed"` → `running` (`queued` → `pending`). Conclusion `success` → `succeeded`; `failure`/`timed_out`/`startup_failure` → `failed`; anything else → `cancelled`. `stream` is `workflow:<workflow_id>`, `name` the workflow name, `startedAt` is `run_started_at`, `ref` is `head_branch`. Deployment state `success` → `succeeded`, `failure`/`error` → `failed`, `inactive` → `cancelled`, others → `running`; `stream` is `env:<environment>`.
  - Webhooks: header `X-GitHub-Event`. `pull_request` with actions `opened`, `edited`, `synchronize`, `reopened`, `closed` → `change_request`. `workflow_run` with action `completed` → `pipeline_run`. `deployment_status` → `deployment` from `deployment.id` when the state is terminal. `ping` → `ping`. Everything else `ignored`.
  - `deliveryId`: `X-GitHub-Delivery`. `verifyWebhook`: header must be `sha256=<64 hex>`; `hmacSha256Verify(await secret.reveal(), rawBody, hex)`.
  - In `index.ts`: `DEFAULT_BASE_URL: Record<Provider, string> = { gitlab: "https://gitlab.com", github: "https://github.com" }`, `defaultCapabilities(provider: Provider): CodeHostCapabilities` (all true for both), and `createCodeHost(input: { provider: Provider; baseUrl: string; token: string; fetchImpl: typeof fetch }): CodeHost`.
- Fixtures mirror Task 18: `webhook-pull_request-opened.json`, `webhook-pull_request-synchronize.json`, `webhook-workflow_run-failure.json`, `webhook-workflow_run-success.json`, `webhook-workflow_run-requested.json`, `webhook-deployment_status-failure.json`, `webhook-ping.json`, and the matching `api-*.json`.

- [ ] **Step 1: Write the failing tests**

```ts
runCodeHostSuite({ provider: "github", makeHost: f => createGitHubHost({ baseUrl: "https://github.com", token: "ghp_test0only0000000000000000000000000000", fetchImpl: f }), … });

test("verifies GitHub's documented example signature", async () => {
  const body = new TextEncoder().encode("Hello, World!");
  const h = new Headers({ "x-hub-signature-256": "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17" });
  expect(await host.verifyWebhook(h, body, secretOf("It's a Secret to Everybody"))).toBe(true);
});
test("Enterprise Server base URL uses /api/v3", async () => {});
test("two workflows on one commit have different streams", async () => {
  const a = await host.getPipelineRun(repo, "501"); const b = await host.getPipelineRun(repo, "502");
  expect(a.stream).not.toBe(b.stream); expect(a.ref).toBe(b.ref);
});
test("a closed pull request without merged_at is closed, with merged_at is merged", async () => {});
test("createCodeHost dispatches on provider", () => {});
```

- [ ] **Step 2: Run `pnpm test github`.** Expected: FAIL.
- [ ] **Step 3: Implement**, with the same zod and error rules as Task 18.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): GitHub code host adapter`.

### Task 20: Connections

**Files:**
- Create: `packages/core/src/connections.ts`, `migrations/0008_connections.sql`; modify `schema.ts`, `index.ts`, `db/testing.ts`
- Test: `packages/core/src/connections.test.ts`

**Interfaces:**
- Consumes: Tasks 16, 19 (`createCodeHost`, `defaultCapabilities`), `requirePermission`, `recordEvent`, `cleanText`
- Produces:
  - Table `connections(id, workspace_id, kind text check (kind = 'code_host'), provider text, base_url, display_name, credentials_enc text null, webhook_secret_hash text null, capabilities jsonb, archived_at, created_by, created_at)`. Both credential columns are always set by `createConnection`; they are nullable only for connections imported from another deployment (Phase 4), which have no credentials until an admin re-enters the token. `credentials_enc` is `encryptSecret(current, JSON.stringify({ token, webhookSecret }), "connection:" + id)`. `webhook_secret_hash` is the SHA-256 hex of the webhook secret. Both are stored because GitLab verification compares the hash and GitHub's HMAC needs the plaintext.
  - `ConnectionActor`, `CodeHostDeps` (see "Shared types")
  - `type ConnectionView = { id: string; kind: "code_host"; provider: Provider; baseUrl: string; displayName: string; capabilities: CodeHostCapabilities; webhookUrl: string; archived: boolean; lastDelivery: { at: string; status: "processed" | "ignored" | "failed" } | null; createdAt: string }`. `webhookUrl` is `${publicUrl}/hooks/${workspaceId}/${id}`. `lastDelivery` is null until Task 22.
  - `validateBaseUrl(url: string, allowPrivate: boolean): string`: returns the URL without a trailing slash; throws `ValidationError`
  - `createConnection(tx, actor, deps: CodeHostDeps, input: { provider: Provider; baseUrl?: string; displayName: string; token: string }): Promise<{ connection: ConnectionView; webhookSecret: string }>`: needs `workspace.admin`. The secret is `randomToken("whs_", 32)`. Throws `ValidationError("CREDENTIALS_KEY is not configured")` when `deps.credentialsKeys` is empty. Event `connection.created` (data: provider, baseUrl, displayName only).
  - `listConnections(tx, actor, deps): Promise<ConnectionView[]>`: members only; agents get `ForbiddenError`
  - `testConnection(db, actor, deps, connectionId: string): Promise<{ ok: true; account: string } | { ok: false; error: string }>`: needs `workspace.admin`; `error` is the `ProviderError` message passed through `cleanText`
  - `rotateWebhookSecret(tx, actor, deps, connectionId): Promise<{ webhookSecret: string }>`; `replaceConnectionToken(tx, actor, deps, connectionId, token: string): Promise<void>`; `archiveConnection(tx, actor, connectionId): Promise<void>`. All need `workspace.admin`, with events `connection.secret_rotated`, `connection.token_replaced`, `connection.archived`.
  - `openConnection(tx, deps, connectionId: string): Promise<OpenConnection | null>` (core-internal, not exported from `index.ts`), where `OpenConnection = { id: string; workspaceId: string; provider: Provider; capabilities: CodeHostCapabilities; host: CodeHost; secret: WebhookSecret; actor: ConnectionActor }`. Null when missing, archived, or without stored credentials (`credentials_enc` null). `secret.reveal()` decrypts lazily.
  - Test fixture in `db/testing.ts`: `seedConnection(db, workspaceId, provider: Provider, fetchImpl): Promise<{ connectionId: string; webhookSecret: string; deps: CodeHostDeps }>`

- [ ] **Step 1: Write the failing tests**

```ts
test("the token is stored encrypted and never appears in views, events or listings", async () => {
  const { connection, webhookSecret } = await createConnection(tx, admin, deps,
    { provider: "gitlab", baseUrl: "https://gitlab.example.com", displayName: "Example GitLab", token: "glpat-test-only-000000000000" });
  const row = (await rawQuery(db, "select credentials_enc, webhook_secret_hash from connections"))[0];
  expect(row.credentials_enc).not.toContain("glpat"); expect(row.credentials_enc).not.toContain(webhookSecret);
  expect(row.webhook_secret_hash).toBe(await sha256Hex(webhookSecret));
  const everything = JSON.stringify([connection, await listConnections(tx, admin, deps), await listEvents(tx, {})]);
  expect(everything).not.toContain("glpat"); expect(everything).not.toContain(webhookSecret);
  expect(connection.webhookUrl).toBe(`https://tl.test/hooks/${workspaceId}/${connection.id}`);
});
test("only workspace.admin can create, rotate, replace or archive; agents cannot list", async () => {});
test("private and non-https base URLs are refused unless allowed", () => {
  for (const u of ["http://gitlab.example.com", "https://localhost:8080", "https://127.0.0.1", "https://10.0.0.5",
                   "https://192.168.1.2", "https://169.254.169.254", "https://[::1]", "https://user:pw@gitlab.example.com"])
    expect(() => validateBaseUrl(u, false)).toThrow(ValidationError);
  expect(validateBaseUrl("https://10.0.0.5/gitlab/", true)).toBe("https://10.0.0.5/gitlab");
  expect(validateBaseUrl("https://gitlab.example.com/", false)).toBe("https://gitlab.example.com");
});
test("rotating the secret changes the hash and the old secret stops verifying", async () => {});
test("testConnection reports the account, or a cleaned error without the token", async () => {});
test("openConnection returns null for an archived connection, another workspace's id, and a connection with null credentials", async () => {});
test("createConnection fails clearly when CREDENTIALS_KEY is not configured", async () => {});
```

- [ ] **Step 2: Run `pnpm test connections`.** Expected: FAIL.
- [ ] **Step 3: Implement.** The migration enables and forces RLS on `connections` with the standard workspace policy. Private-host detection covers IPv4 literals in 0/8, 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, IPv6 `::1`, `fc00::/7`, `fe80::/10`, and the names `localhost` and `*.localhost`. Hostnames are not resolved, because Workers cannot do that; the README says so.
- [ ] **Step 4: Run tests, including `assertAllTablesHaveForcedRls`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): code host connections with encrypted credentials`.

### Task 21: Project repositories and code-host configuration

**Files:**
- Create: `packages/core/src/repos.ts`, `packages/core/src/glob.ts`, `migrations/0009_project_repos.sql`; modify `projects.ts`, `tenancy.ts`, `schema.ts`, `index.ts`
- Test: `packages/core/src/repos.test.ts`, `packages/core/src/glob.test.ts`

**Interfaces:**
- Consumes: Task 20 (`openConnection`), `normalizeRepoUrl`, `updateProjectConfig`, `getProject`, `can`
- Produces:
  - Table `project_repos(id, workspace_id, project_id, connection_id, external_repo_id, repo_path, repo_url, default_branch, archived_at, created_at)`, with a unique index on `(workspace_id, connection_id, external_repo_id) where archived_at is null`. `repo_url` is stored as `normalizeRepoUrl(url)`.
  - `project_config` gains `code_host jsonb not null default '{"sharedPaths":[],"consumerRoleKeys":[],"ciOwnerRoleKey":null}'`
  - `type CodeHostConfig = { sharedPaths: string[]; consumerRoleKeys: string[]; ciOwnerRoleKey: string | null }`
  - `updateProjectConfig(tx, actor, projectId, patch: { repoUrls?; notifier?; codeHost?: CodeHostConfig })`: validates at most 50 globs with `validateGlob`, and that every role key exists and is active. `getProject` adds `codeHost: CodeHostConfig`.
  - `type RepoLinkView = { id: string; projectId: string; connectionId: string; provider: Provider; repoPath: string; url: string; defaultBranch: string }`
  - `linkRepo(db, actor, deps: CodeHostDeps, input: { projectId: string; connectionId: string; repoPath: string }): Promise<RepoLinkView>`: needs `workspace.admin`. It calls `host.getRepo(repoPath)` outside the transaction. A repo already linked to another project gives `ValidationError("already linked to project <KEY>")`. Event `repo.linked`.
  - `listProjectRepos(tx, actor, projectId): Promise<RepoLinkView[]>` (`project.read`); `unlinkRepo(tx, actor, repoLinkId): Promise<void>` (`workspace.admin`, sets `archived_at`, event `repo.unlinked`)
  - `type RepoLink = { id: string; projectId: string; projectKey: string; repo: RepoIdent; config: CodeHostConfig }`
  - `findRepoLink(tx, connectionId: string, externalRepoId: string): Promise<RepoLink | null>` (core-internal)
  - `findProjectByRepoUrl` also matches active `project_repos.repo_url`
  - `can` for a connection actor: `permission === "blocker.write"`, and `projectId` is given, and an active `project_repos` row links `actor.connectionId` to it
  - `glob.ts`: `validateGlob(pattern: string): void` and `compileGlobs(patterns: string[]): (path: string) => boolean`. Patterns are anchored at the repository root and case-sensitive: `**` matches zero or more whole segments, `*` any characters except `/`, `?` one character except `/`, everything else literal. Rejected: empty, over 200 characters, a leading `/` or `!`, a `..` segment, or `**` not alone in its segment.

- [ ] **Step 1: Write the failing tests**

```ts
// glob.test.ts
test.each([
  ["packages/shared/**", "packages/shared/a/b.ts", true],
  ["packages/shared/**", "packages/shared", true],
  ["packages/shared/**", "packages/shared-ui/x.ts", false],
  ["api/*.yaml", "api/openapi.yaml", true],
  ["api/*.yaml", "api/v2/openapi.yaml", false],
  ["openapi.yaml", "docs/openapi.yaml", false],
  ["**/schema.graphql", "schema.graphql", true],
  ["src/?.ts", "src/a.ts", true],
])("%s matches %s → %s", (p, path, want) => expect(compileGlobs([p])(path)).toBe(want));
test("invalid patterns are rejected", () => {
  for (const p of ["", "/abs/**", "!neg", "a/../b", "a/**b", "x".repeat(201)]) expect(() => validateGlob(p)).toThrow(ValidationError);
});

// repos.test.ts
test("linking a repo stores the provider's repo id and the project is then found by its URL", async () => {
  const link = await linkRepo(db, admin, deps, { projectId, connectionId, repoPath: "example-org/example-app" });
  expect(await withWorkspace(db, ws, tx => findProjectByRepoUrl(tx, "git@gitlab.example.com:example-org/example-app.git"))).toBe(projectId);
  expect(link.repoPath).toBe("example-org/example-app");
  expect(await withWorkspace(db, ws, tx => findRepoLink(tx, connectionId, FIXTURE_REPO_ID))).toMatchObject({ projectId, projectKey: "ACME" });
});
test("a connection may write blockers only in projects it is linked to", async () => {
  const conn: Actor = { kind: "connection", workspaceId: ws, connectionId };
  expect(await withWorkspace(db, ws, tx => can(tx, conn, "blocker.write", projectId))).toBe(true);
  expect(await withWorkspace(db, ws, tx => can(tx, conn, "blocker.write", otherProjectId))).toBe(false);
  expect(await withWorkspace(db, ws, tx => can(tx, conn, "task.write", projectId))).toBe(false);
});
test("a repo cannot be linked to two projects; after unlinking it can be linked again", async () => {});
test("code-host config rejects unknown or archived role keys and more than 50 globs", async () => {});
test("an agent can read the config but not change it", async () => {});
```

- [ ] **Step 2: Run `pnpm test repos glob`.** Expected: FAIL.
- [ ] **Step 3: Implement.** Compile globs to anchored `RegExp`s once per call to `compileGlobs`.
- [ ] **Step 4: Run tests, including the Phase 1 tenancy and projects tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): project repositories and code-host config`.

### Task 22: Webhook receiver

**Files:**
- Create: `packages/core/src/webhooks.ts`, `migrations/0010_webhook_deliveries.sql`; modify `connections.ts` (`lastDelivery`), `schema.ts`, `index.ts`
- Test: `packages/core/src/webhooks.test.ts`

**Interfaces:**
- Consumes: Tasks 18–21
- Produces:
  - Table `webhook_deliveries(workspace_id, connection_id, delivery_id, event_kind, status text check (status in ('processed','ignored','failed')), detail text, received_at)`, with primary key `(workspace_id, connection_id, delivery_id)`. `app_user` may delete rows older than 30 days. A bookkeeping table (see Global Constraints).
  - `type HandlerCtx = { db: Db; deps: CodeHostDeps; workspaceId: string; actor: ConnectionActor; host: CodeHost; capabilities: CodeHostCapabilities; link: RepoLink }`
  - `type WebhookHandlers = { changeRequest: ((ctx: HandlerCtx, cr: ChangeRequest) => Promise<void>)[]; pipelineRun: ((ctx: HandlerCtx, run: PipelineRun) => Promise<void>)[] }`
  - `defaultHandlers: WebhookHandlers` (empty here; Tasks 23–25 add theirs)
  - `type WebhookInput = { workspaceId: string; connectionId: string; headers: Headers; rawBody: Uint8Array }`
  - `type WebhookResult = { status: 200 | 202 | 400 | 401 | 413 | 415; body: { ok: boolean; duplicate?: true; ignored?: string; error?: string } }`
  - `handleWebhook(db: Db, deps: CodeHostDeps, input: WebhookInput, handlers?: WebhookHandlers): Promise<WebhookResult>`
  - `listDeliveries(tx, actor, connectionId: string, limit?: number): Promise<{ deliveryId: string; eventKind: string; status: string; detail: string | null; receivedAt: string }[]>` (`workspace.admin`, default 20)
  - Order of checks in `handleWebhook`:
    1. Body over 1,048,576 bytes → 413.
    2. `workspaceId` or `connectionId` not a UUID, or `openConnection` returns null → 401 `{ ok: false }`.
    3. `verifyWebhook` false → 401 `{ ok: false }`. The same body as step 2, so connection IDs cannot be probed.
    4. `deliveryId` null → 400.
    5. An existing delivery with status `processed` or `ignored` → 200 `{ ok: true, duplicate: true }`.
    6. `content-type` not JSON → 415. Unparseable JSON → 400.
    7. `normalizeWebhook`. For each event: `ping` → ok. `ignored` → ignored. Otherwise `findRepoLink` (none → ignored `"repository not linked to a project"`), re-read state with `getChangeRequest`, `getPipelineRun` or `getDeployment` (skip deployments when `capabilities.deployments` is false), then run that kind's handlers in order.
    8. Upsert the delivery row as `processed` / `ignored`, with `detail` the ignore reason → 200.
    9. Any thrown error: upsert the row as `failed`, with `detail` the error message through `cleanText` and cut to 500 characters; record event `webhook.failed` (connection actor, data `{ deliveryId, eventKind }`) → 202 `{ ok: false, error: "processing failed; see Connections in Threadline" }`.
    10. Prune this connection's rows older than 30 days (at most 100).

- [ ] **Step 1: Write the failing tests** (both providers via `test.each(["gitlab", "github"])`, using a recording handler)

```ts
test.each(providers)("%s: a signed delivery reaches the handler with state re-read from the API", async p => {
  const seen: ChangeRequest[] = [];
  const res = await handleWebhook(db, deps, await signedInput(p, "changeRequestOpened"), { changeRequest: [async (_c, cr) => { seen.push(cr); }], pipelineRun: [] });
  expect(res.status).toBe(200);
  expect(seen[0].title).toBe(API_TITLE[p]);   // the api-*.json title, deliberately different from the webhook payload's
});
test.each(providers)("%s: a bad signature, unknown connection and archived connection all return the same 401", async p => {});
test.each(providers)("%s: the same delivery ID twice runs the handler once", async p => {});
test.each(providers)("%s: a delivery that failed is processed again when redelivered", async p => {
  // first attempt: handler throws → 202, row failed, event webhook.failed; second attempt same ID → handler runs → 200 processed
});
test("a body over 1 MB returns 413 before any database or provider call", async () => {});
test("a repo not linked to any project is recorded as ignored and makes no further provider calls", async () => {});
test("a failure detail containing a token is redacted", async () => { /* handler throws Error("glpat-…") → detail has [REDACTED] */ });
test("a pipeline event that is not finished makes no provider call", async () => {});
test("lastDelivery on the connection view reflects the newest delivery", async () => {});
```

- [ ] **Step 2: Run `pnpm test webhooks`.** Expected: FAIL.
- [ ] **Step 3: Implement.** Use one `CodeHost` instance per call, so the 20-call budget is per request. A delivery with several normalized events processes them in order and records one row.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): webhook receiver with verification and de-duplication`.

### Task 23: Evidence linking

**Files:**
- Create: `packages/core/src/refs.ts`, `packages/core/src/evidence.ts`, `migrations/0011_evidence_links.sql`; modify `webhooks.ts` (`defaultHandlers.changeRequest`)
- Test: `packages/core/src/refs.test.ts`, `packages/core/src/evidence.test.ts`

**Interfaces:**
- Consumes: Task 22 `HandlerCtx`; the `evidence` table from Task 7; `resolveTaskRef`
- Produces:
  - Migration: unique index `evidence_link_once` on `evidence(workspace_id, subject_kind, subject_id, kind, connection_id, external_id) where connection_id is not null`
  - `extractTaskRefs(texts: string[], projectKey: string, max = 20): string[]`: case-insensitive, returned upper-case, de-duplicated in first-seen order. A ref is `<key>-<digits>`, preceded by start or a non-alphanumeric character and followed by end or a non-alphanumeric character.
  - `linkChangeRequestToTasks(tx, actor: ConnectionActor, input: { projectId: string; projectKey: string; cr: ChangeRequest }): Promise<{ linked: string[] }>`. Scans `cr.title`, `cr.sourceBranch` and `cr.description`. For each ref that resolves to a task in that project, inserts evidence `{ subject_kind: "task", kind: "change_request", url: cr.url, external_id: cr.externalId, version: cr.headSha, connection_id }` with `on conflict do nothing`, and records `evidence.linked` only for new rows. Unknown refs are skipped. Never throws `NotFoundError`.
  - `tasksForChangeRequests(tx, input: { projectId: string; connectionId: string; externalIds: string[] }): Promise<{ taskId: string; ref: string; ownerRoleId: string }[]>`
  - `linkEvidenceHandler(ctx: HandlerCtx, cr: ChangeRequest): Promise<void>`, added first in `defaultHandlers.changeRequest`, runs `linkChangeRequestToTasks` in `withWorkspace`

- [ ] **Step 1: Write the failing tests**

```ts
// refs.test.ts
test("finds refs in titles, branches and descriptions", () => {
  expect(extractTaskRefs(["Fix profile (ACME-12)", "feature/acme-7-archive", "Also closes ACME-12 and acme-30."], "ACME"))
    .toEqual(["ACME-12", "ACME-7", "ACME-30"]);
});
test("does not match inside longer words or numbers", () => {
  expect(extractTaskRefs(["XACME-1 ACME-12a ACME-", "MACME-3"], "ACME")).toEqual([]);
  expect(extractTaskRefs(["ACME-123"], "ACME")).toEqual(["ACME-123"]);
});
test("caps the number of refs", () => { expect(extractTaskRefs([Array.from({ length: 30 }, (_, i) => `ACME-${i + 1}`).join(" ")], "ACME")).toHaveLength(20); });

// evidence.test.ts
test.each(providers)("%s: a change request naming ACME-1 becomes evidence on that task, once", async p => {
  await handleWebhook(db, deps, await signedInput(p, "changeRequestOpened"));
  await handleWebhook(db, deps, await signedInput(p, "changeRequestUpdated"));   // new delivery ID, same change request
  const ctx = await withWorkspace(db, ws, tx => getTaskContext(tx, member, { projectId, task: "ACME-1" }));
  expect(ctx.evidence.filter(e => e.kind === "change_request")).toEqual([
    expect.objectContaining({ kind: "change_request", url: CR_URL[p], connectionId })]);
  expect((await events(db, ws)).filter(e => e.type === "evidence.linked")).toHaveLength(1);
});
test("refs to tasks in another project or unknown numbers are ignored without error", async () => {});
test("the evidence event's actor is the connection", async () => { /* actor_kind === "connection" */ });
test("getByRef with the change request URL finds the linked task", async () => {});
```

- [ ] **Step 2: Run `pnpm test refs evidence`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): link change requests to tasks as evidence`.

### Task 24: Blockers from pipeline runs and deployments

**Files:**
- Create: `packages/core/src/pipelines.ts`, `migrations/0012_pipeline_states.sql`; modify `webhooks.ts` (`defaultHandlers.pipelineRun`), `notify/index.ts`
- Test: `packages/core/src/pipelines.test.ts`

**Interfaces:**
- Consumes: Task 22 `HandlerCtx`; Task 23 `tasksForChangeRequests`; Task 8 `raiseBlocker`, `resolveBlocker`, `getBlocker`; `notifyProject`, `blockerMessage`
- Produces:
  - Table `pipeline_states(workspace_id, repo_link_id, ref, stream, last_run_id, last_started_at timestamptz, last_status, blocker_id uuid null, updated_at)`, primary key `(workspace_id, repo_link_id, ref, stream)`. A bookkeeping table.
  - `applyPipelineRun(ctx: HandlerCtx, run: PipelineRun): Promise<{ action: "opened" | "observed_again" | "resolved" | "none" }>`, added to `defaultHandlers.pipelineRun`
  - Algorithm (the part the tests do not fully determine):

```
if run.status not in {failed, succeeded}: return none
if run.status == failed: crs = host.listChangeRequestsForCommit(repo, run.sha)        // before the transaction; refs = crs.map(c => c.reference)
withWorkspace:
  state = select … for update (insert an empty row first if missing)
  if state.last_run_id and run.externalId != state.last_run_id and run.startedAt < state.last_started_at: return none   // stale
  update state: last_run_id = run.externalId, last_started_at = max(state, run.startedAt), last_status = run.status
  open = state.blocker_id and getBlocker(state.blocker_id).status == "open"
  if failed and open:     add evidence(run) to the blocker; event blocker.observed_again;   return observed_again
  if failed and not open:
      tasks = tasksForChangeRequests(crs.map(c => c.externalId)); task = tasks.length == 1 ? tasks[0] : none
      owner = task.ownerRoleId ?? role(config.ciOwnerRoleKey) ?? first active role holding workspace.admin
      id = raiseBlocker(tx, ctx.actor, { projectId, taskId: task?.taskId, observed, ownerRoleId: owner,
                                         evidence: [{ connectionId, kind: run.kind, url: run.url, externalId: run.externalId, version: run.sha }] })
      state.blocker_id = id;  after the transaction: waitUntil(notifyProject(blockerMessage …));   return opened
  if succeeded and open:  resolveBlocker(tx, ctx.actor, { blockerId, resolution }); state.blocker_id = null;   return resolved
  return none
```

  - Exact text, through `cleanText`. `observed`: `` `${label} "${run.name}" failed on ${run.ref} at ${run.sha.slice(0, 8)}: ${run.url}` ``, plus `` `\nChange requests: ${refs.join(", ")}` `` when there are any, and `` `\nTasks: ${taskRefs.join(", ")}` `` when there are several. `resolution`: `` `${label} "${run.name}" succeeded on ${run.ref} at ${run.sha.slice(0, 8)}: ${run.url}` ``. `label` is `"Pipeline run"`, or `` `Deployment to ${environment}` ``. No suspected cause is ever set.
  - A blocker a person resolved by hand is not reopened by later successes. The next failure opens a new one.

- [ ] **Step 1: Write the failing tests** (both providers; `run(p, overrides)` builds fake API responses for a run)

```ts
test.each(providers)("%s: a failed run on a change request linked to ACME-1 opens a blocker on ACME-1 with facts only", async p => {
  await deliver(p, "pipelineFailed");
  const [b] = (await openItemsFor(leadMember)).blockers;
  expect(b.taskRef).toBe("ACME-1"); expect(b.causeStatus).toBe("none"); expect(b.cause).toBeNull();
  expect(b.observed.text).toMatch(/^Pipeline run ".+" failed on feature\/ACME-1-profile at [0-9a-f]{8}: https:/);
});
test.each(providers)("%s: a later success on the same ref and stream resolves it, recorded as the connection", async p => {
  await deliver(p, "pipelineFailed"); await deliver(p, "pipelineSucceeded");
  expect((await getBlockerById()).status).toBe("resolved");
  const ev = (await events(db, ws)).find(e => e.type === "blocker.resolved");
  expect(ev).toMatchObject({ actorKind: "connection", actorId: connectionId });
});
test("a success in a different stream on the same ref does not resolve it", async () => {
  // workflow:501 failed, workflow:502 succeeded → still open; then workflow:501 succeeded → resolved
});
test("an older success arriving after a newer failure does not resolve it", async () => { /* startedAt older, different run id → none */ });
test("an older failure arriving after the success that resolved it opens nothing", async () => {});
test("a re-run of the same failed run that now succeeds resolves it", async () => { /* same externalId, status succeeded */ });
test("a second failure while open adds evidence instead of a second blocker", async () => {});
test("a failure with no change request opens a project-level blocker owned by ciOwnerRoleKey", async () => {});
test("a failed deployment opens a blocker labelled with its environment", async () => {});
test("the redelivered failure opens one blocker, not two", async () => {});
test("opening a blocker posts one chat pointer", async () => {});
```

- [ ] **Step 2: Run `pnpm test pipelines`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): blockers from failed pipeline runs and deployments`.

### Task 25: Contract changes and the merge check

**Files:**
- Create: `packages/core/src/contracts.ts`, `migrations/0013_contract_changes.sql`; modify `webhooks.ts` (`defaultHandlers.changeRequest`), `notify/index.ts`, `schema.ts`, `index.ts`
- Test: `packages/core/src/contracts.test.ts`

**Interfaces:**
- Consumes: Tasks 20–23, `membersWithRole`, `requirePermission`, `quote`, `notifyProject`
- Produces:
  - Uses `contract.ack` as defined in Phase 0 Tasks 2 and 4. No migration changes roles.
  - Table `contract_changes(id, workspace_id, project_id, repo_link_id, connection_id, change_request_external_id, change_request_number, change_request_ref, change_request_url, title, head_sha, acked_sha null, files text[], files_truncated bool, consumer_role_ids uuid[], status, merged bool, revision int, merge_check, merge_check_sha null, comment_revision int default 0, created_at, updated_at)`, with a unique index on `(workspace_id, connection_id, change_request_external_id)`. `title` and `files` go through `cleanText`.
  - Table `acknowledgements(id, workspace_id, subject_kind, subject_id, revision, role_id, member_id, note, created_at)`, with a unique index on `(workspace_id, subject_kind, subject_id, revision, role_id)`
  - `type ContractStatus = "pending" | "acknowledged" | "withdrawn"`; `type MergeCheck = "pending" | "ok" | "failed" | "unsupported"`
  - `type ContractChangeView = { id: string; reference: string; url: string; title: Quoted; repo: string; files: Quoted; filesTruncated: boolean; consumerRoles: { key: string; acknowledged: boolean; unassigned: boolean }[]; status: ContractStatus; merged: boolean; mergeCheck: MergeCheck; revision: number; linkedTasks: string[]; createdAt: string; updatedAt: string }`. `files` is one `Quoted` with one path per line and source `contract_change:<id>`.
  - `contractHandler(ctx: HandlerCtx, cr: ChangeRequest): Promise<void>`, added second in `defaultHandlers.changeRequest`
  - `acknowledgeContractChange(tx, actor, input: { contractChangeId: string; note?: string }): Promise<{ status: ContractStatus; remainingRoles: string[] }>`
  - `listContractChanges(tx, actor, input: { projectId: string; status?: ContractStatus }): Promise<ContractChangeView[]>` (`project.read`, newest first, limit 50)
  - `pendingContractChangesFor(tx, actor, projectId: string): Promise<ContractChangeView[]>`: pending ones where the actor's member holds a consumer role not yet acknowledged at the current revision (used by Task 26)
  - `syncContractStatus(db, deps, input: { workspaceId: string; contractChangeId: string }): Promise<MergeCheck>`: never throws
  - In `notify/index.ts`: `contractChangeMessage(view: { reference: string; consumerRoleNames: string[]; unassignedRoleNames: string[]; updated: boolean }): string`
  - Exact copy:
    - Message: `` `${updated ? "Contract change updated" : "Contract change"} in ${reference} needs acknowledgement from ${names.join(", ")}.` ``, plus `` ` Nobody holds ${unassigned.join(", ")} yet.` `` when any role is unassigned
    - Status descriptions: pending `` `Waiting for ${roleKeys.join(", ")} to acknowledge shared-path changes` ``; success `"Shared-path changes acknowledged"`, `"No shared paths changed"`, or `"Shared-path changes withdrawn"`. `targetUrl` is `` `${publicUrl}/inbox?contract=${id}` ``.
    - Fallback comment (posted only when `mergeCheck` becomes `unsupported`, once per revision): ``Threadline: this change touches shared paths that other roles consume.\nFiles: `a`, `b` (and N more)\nWaiting for acknowledgement from: Frontend.\nThis repository does not report Threadline's merge check, so merging is not blocked. Acknowledge at <targetUrl>``. At most 10 files are listed.
  - `contractHandler` algorithm:

```
cfg = ctx.link.config; existing = row for (connection, cr.externalId)
if cr.state != open:
    if existing and cr.state == closed and existing.status == pending: status = withdrawn, event contract.withdrawn
    if existing and cr.state == merged and not existing.merged:        merged = true, event contract.merged
    return                                                              // never post on closed or merged
if cfg.sharedPaths is empty: setCommitStatus(success, "No shared paths changed"); return
{files, truncated} = host.listChangedFiles(cr); match = compileGlobs(cfg.sharedPaths)
matched = files where match(path) or match(previousPath); touches = matched.length > 0 or truncated
if not existing:
    if not touches: setCommitStatus(success, "No shared paths changed"); return
    insert revision 1, status pending, consumer_role_ids = cfg roles; event contract.changed; notify
elif existing.status == acknowledged and cr.headSha != existing.acked_sha:
    since = host.compareFiles(existing.acked_sha, cr.headSha)  (a ProviderError 404 counts as "changed")
    if since.truncated or any since.paths match: revision += 1, status pending, files = matched; event contract.updated; notify(updated)
    else: head_sha = cr.headSha; event contract.head_moved
elif existing.status == pending and not touches: status withdrawn; event contract.withdrawn
elif existing.status == withdrawn and touches:   revision += 1, status pending; event contract.updated; notify(updated)
elif existing.status == pending:  update files and head_sha if they changed; event contract.updated (no notify)
syncContractStatus(...)        // errors are recorded on the row, not thrown
```

  - `acknowledgeContractChange`: requires `contract.ack` (so agents get `ForbiddenError`). Status must be `pending`, otherwise `ValidationError`. The member must hold at least one consumer role in that project (`ForbiddenError` otherwise). One acknowledgement row is written per consumer role the member holds that is not yet acknowledged at this revision (`ValidationError` if there are none). When every consumer role is acknowledged: status `acknowledged`, `acked_sha = head_sha`, event `contract.cleared`. Event `contract.acknowledged` per call. A merged-but-pending change can still be acknowledged.
  - `syncContractStatus`: returns early (with the current value) when the change request is no longer open, or when `merge_check = 'ok'` and `merge_check_sha = head_sha` and the desired state is unchanged. Otherwise it posts `pending` (status `pending`) or `success` (`acknowledged` / `withdrawn`) on `head_sha`. Outcomes: success → `ok`. `capabilities.commitStatus` false, or `ProviderError` 403/404 → `unsupported`, plus the fallback comment if `comment_revision < revision`. Any other error → `failed` and event `contract.check_failed`.

- [ ] **Step 1: Write the failing tests** (both providers; config `{ sharedPaths: ["packages/shared/**"], consumerRoleKeys: ["frontend"] }`; `statusCalls(p)` filters the recorded requests to status POSTs)

```ts
test.each(providers)("%s: touching a shared path creates a pending contract change and posts a pending check", async p => {
  await deliver(p, "changeRequestOpened");            // api diffs include packages/shared/profile.ts and src/app.ts
  const [c] = await list(member, projectId);
  expect(c).toMatchObject({ status: "pending", revision: 1, mergeCheck: "ok",
    consumerRoles: [{ key: "frontend", acknowledged: false, unassigned: false }] });
  expect(c.files.text).toBe("packages/shared/profile.ts");
  expect(statusCalls(p).at(-1)).toMatchObject({ sha: HEAD[p], name: "threadline/contract", state: "pending" });
});
test.each(providers)("%s: a change request that touches no shared path gets a success check and no record", async p => {
  expect(statusCalls(p).at(-1)).toMatchObject({ state: "success", description: "No shared paths changed" });
  expect(await list(member, projectId)).toEqual([]);
});
test("a project with no shared paths declared still posts success on every change request", async () => {});
test("only a person holding a consumer role can acknowledge; agents never", async () => {
  await expect(ack(frontendAgent)).rejects.toThrow(ForbiddenError);
  await expect(ack(backendMember)).rejects.toThrow(ForbiddenError);
  expect(await ack(frontendMember)).toEqual({ status: "acknowledged", remainingRoles: [] });
  expect(statusCalls("github").at(-1)).toMatchObject({ state: "success", description: "Shared-path changes acknowledged" });
});
test("with two consumer roles, it stays pending until both are acknowledged; a solo member holding both clears it in one call", async () => {});
test("a consumer role nobody holds is flagged unassigned and the chat message says so", async () => {
  expect(contractChangeMessage({ reference: "example-org/example-app#7", consumerRoleNames: ["Mobile"], unassignedRoleNames: ["Mobile"], updated: false }))
    .toBe("Contract change in example-org/example-app#7 needs acknowledgement from Mobile. Nobody holds Mobile yet.");
});
test("a push after acknowledgement that changes shared files reopens it at revision 2", async () => {
  // compare acked_sha...new head → packages/shared/profile.ts → status pending, revision 2, check pending, earlier ack no longer counts
});
test("a push after acknowledgement that changes only other files keeps it acknowledged and posts success on the new head", async () => {});
test("reverting the shared-file changes withdraws it and posts success", async () => {});
test("a truncated file list is treated as touching shared paths", async () => {});
test("closing without merge withdraws; merging while pending keeps it pending and still acknowledgeable", async () => {});
test("a renamed file whose old path was shared counts as touching", async () => {});
test("when the provider refuses the status (403) the check is unsupported and exactly one comment is posted per revision", async () => {});
test("when the provider is down during acknowledgement, the acknowledgement is saved and mergeCheck is failed; a later sync posts success", async () => {});
test("the same webhook delivered twice, or two deliveries for one push, creates one record and one notification", async () => {});
test("file paths and titles reach views only inside Quoted", async () => {});
test("a change request title containing a token is stored redacted", async () => {
  // api title "Rotate ghp_test0only0000000000000000000000000000" → row.title and view title.text contain [REDACTED], not ghp_
});
```

- [ ] **Step 2: Run `pnpm test contracts`.** Expected: FAIL.
- [ ] **Step 3: Implement.** Provider calls happen outside `withWorkspace`; each transaction re-reads the row `for update`, so concurrent deliveries for one push converge on a single row.
- [ ] **Step 4: Run tests, plus the Phase 1 tenancy tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): contract changes, acknowledgement and merge check`.

### Task 26: Contract changes in agent context

**Files:**
- Modify: `packages/core/src/context.ts`
- Test: `packages/core/src/context.test.ts` (extend)

**Interfaces:**
- Consumes: Task 25 `pendingContractChangesFor`, `ContractChangeView`
- Produces:
  - `OpenItems = { handoffs: HandoffView[]; contractChanges: ContractChangeView[]; blockers: BlockerView[]; tasks: TaskView[] }`
  - `getByRef` result gains `contractChanges: ContractChangeView[]` (matches `change_request_url` exactly)
  - `renderSessionContext` sections in order: Handoffs, Contract changes, Blockers, Tasks. Each contract line: `` `- ${reference} changes shared files ${files} (revision ${n}). A person holding ${roles} must acknowledge it in the Threadline inbox before it merges.` ``, where `files` is the first 5 paths from the quoted text, in double quotes, comma-separated, plus `(+N more)`. The first-line text, the 6,000-character limit and the empty-case line are unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
test("my open items include a pending contract change for my consumer role and drop it once acknowledged", async () => {
  expect((await myOpenItems(tx, frontendAgent, { projectId })).contractChanges.map(c => c.id)).toEqual([contractId]);
  expect((await myOpenItems(tx, backendAgent, { projectId })).contractChanges).toEqual([]);
  await acknowledgeContractChange(tx, frontendMember, { contractChangeId: contractId });
  expect((await myOpenItems(tx, frontendAgent, { projectId })).contractChanges).toEqual([]);
});
test("the session context lists contract changes between handoffs and blockers", () => {
  const text = renderSessionContext(items);
  expect(text.indexOf("Handoffs")).toBeLessThan(text.indexOf("Contract changes"));
  expect(text.indexOf("Contract changes")).toBeLessThan(text.indexOf("Blockers"));
  expect(text).toContain("must acknowledge it in the Threadline inbox");
});
test("getByRef with a change request URL returns its contract change", async () => {});
test("a contract change alone is enough to make the context non-empty", () => {});
```

- [ ] **Step 2: Run `pnpm test context`.** Expected: FAIL.
- [ ] **Step 3: Implement.** Truncation drops the oldest items first, across all sections, as before.
- [ ] **Step 4: Run tests.** Expected: PASS, including every Phase 1 context test.
- [ ] **Step 5: Commit** `feat(core): contract changes in open items and session context`.

### Task 27: HTTP API for connections, repositories, contract changes and webhooks

**Files:**
- Create: `apps/api/src/deps.ts`, `apps/api/src/routes/connections.ts`, `routes/contracts.ts`, `routes/hooks.ts`
- Modify: `apps/api/src/app.ts`, `routes/projects.ts`, `schemas.ts`, `.dev.vars.example`, `wrangler.jsonc`
- Test: `apps/api/src/connections.test.ts`, `apps/api/src/hooks.test.ts`

**Interfaces:**
- Consumes: Tasks 20–26
- Produces:
  - `Env` gains `CREDENTIALS_KEY?: string; CREDENTIALS_KEY_PREVIOUS?: string; ALLOW_PRIVATE_CODE_HOSTS?: string`. `createApp` throws at start-up when `CREDENTIALS_KEY` is set but not 32 bytes of base64.
  - `codeHostDeps(env: Env, c: Context, fetchImpl: typeof fetch): Promise<CodeHostDeps>` in `deps.ts`: imports keys once per isolate (cached promise); `waitUntil` is `c.executionCtx.waitUntil` on Workers and a detached `p.catch(() => {})` on Node
  - Routes under `/api/w/:workspaceId`:
    - `GET connections`, `POST connections` → 201 `{ connection, webhookSecret }`
    - `POST connections/:id/test`, `POST connections/:id/rotate-secret` → `{ webhookSecret }`
    - `PUT connections/:id/token`, `POST connections/:id/archive`, `GET connections/:id/deliveries`
    - `GET projects/:projectId/repos`, `POST projects/:projectId/repos` `{ connectionId, repoPath }`, `POST repos/:repoLinkId/unlink`
    - `PUT projects/:projectId/config` accepts `codeHost`
    - `GET projects/:projectId/contract-changes?status=`, `POST contract-changes/:id/acknowledge` `{ note? }` → `{ status, remainingRoles, mergeCheck }` (calls `syncContractStatus` after the transaction commits), `POST contract-changes/:id/sync-status` → `{ mergeCheck }`
  - Every connection route returns 503 `{ error: "connections are not configured on this server" }` when `CREDENTIALS_KEY` is unset
  - `POST /hooks/:workspaceId/:connectionId`: no session, no Origin check (it is outside `/api` and takes no cookie); reads `c.req.arrayBuffer()`, calls `handleWebhook`, returns `result.status` and `result.body`
  - `wrangler.jsonc`: `/hooks/*` is routed to the Worker alongside `/api`, `/auth` and `/mcp`
  - zod schemas `createConnectionBody`, `linkRepoBody`, `codeHostConfigBody`, `acknowledgeBody` exported from `schemas.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test("creating a connection returns the secret once; later reads never include the token or secret", async () => {
  const res = await post(`/api/w/${ws}/connections`, adminCookie, { provider: "github", displayName: "GitHub", token: GH_TEST_TOKEN });
  const { connection, webhookSecret } = await res.json();
  expect(res.status).toBe(201); expect(webhookSecret).toMatch(/^whs_/);
  const list = await (await get(`/api/w/${ws}/connections`, adminCookie)).text();
  expect(list).not.toContain(webhookSecret); expect(list).not.toContain(GH_TEST_TOKEN);
});
test("agent tokens get 403 on every connection and repo route, and on acknowledge", async () => {});
test("connection routes return 503 when CREDENTIALS_KEY is unset; createApp throws on a malformed key", async () => {});
test("the webhook route accepts a signed GitHub delivery without a cookie and rejects an unsigned one with 401", async () => {});
test("the webhook route returns 202 and records the failure when the provider API is down", async () => {});
test("acknowledging over HTTP posts the success check before responding and returns mergeCheck 'ok'", async () => {});
test("sync-status retries a failed check", async () => {});
test("a 1.5 MB webhook body returns 413", async () => {});
```

- [ ] **Step 2: Run `pnpm --filter api test`.** Expected: FAIL.
- [ ] **Step 3: Implement.** The webhook route sits before the session middleware. Error mapping is unchanged from Task 11.
- [ ] **Step 4: Run tests.** Expected: PASS, including every Phase 1 API test.
- [ ] **Step 5: Commit** `feat(api): connections, repositories, contract changes and webhook endpoint`.

### Task 28: MCP tool `get_contract_changes`

**Files:**
- Modify: `apps/api/src/mcp.ts`, `apps/api/src/mcp.test.ts`

**Interfaces:**
- Consumes: Task 25 `listContractChanges`
- Produces: tool `get_contract_changes` with input `{ project: string; status?: "pending" | "acknowledged" | "withdrawn" }` (default `pending`), calling `listContractChanges`. It is a read tool, so its result carries the untrusted-text prefix line. The tool list becomes exactly eight. `my_open_items` now returns `contractChanges` too, with no input change.

- [ ] **Step 1: Write the failing tests**

```ts
test("lists exactly the eight tools", async () => {
  expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(
    ["create_handoff", "get_by_ref", "get_contract_changes", "get_task_context", "my_open_items", "raise_blocker", "report_progress", "search"]);
});
test("there is no tool that acknowledges a contract change", async () => {
  expect((await client.listTools()).tools.some(t => /ack|acknowledge|approve/.test(t.name + t.description))).toBe(false);
});
test("get_contract_changes returns quoted file paths and refuses another project's key", async () => {});
test("my_open_items includes a pending contract change for the caller's role", async () => {});
```

- [ ] **Step 2: Run.** Expected: FAIL (seven tools).
- [ ] **Step 3: Implement.** Description, exactly: `"Contract changes (shared files changed by a change request) in a project. Read only: a person signs them off in Threadline."` It must pass the substring test above, so it does not say "acknowledge".
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): get_contract_changes MCP tool`.

### Task 29: Web UI for connections, project code-host settings, contract changes and evidence

**Files:**
- Create: `apps/web/src/pages/Connections.tsx`
- Modify: `apps/web/src/main.tsx` (route `/w/:ws/connections`), `api.ts`, `components/Header.tsx`, `pages/Project.tsx`, `pages/Inbox.tsx`, `pages/Task.tsx`
- Test: `apps/web/src/pages/Connections.test.tsx`, `ProjectSettings.test.tsx`, extend `Inbox.test.tsx`, `Task.test.tsx`

**Interfaces:**
- Consumes: the Task 27 routes and schemas
- Produces these screens (admin-only parts hidden without `workspace.admin`):
  - **Connections:** a list (provider, display name, base URL, last delivery status and time, archived). "Add connection" form: provider (GitLab or GitHub), base URL prefilled from the provider default and editable (self-hosted GitLab, GitHub Enterprise Server), display name, and token as a password input. After creation, a one-time panel shows the webhook URL and secret with copy buttons, plus the events to enable: GitLab "Merge request events, Pipeline events, Deployment events"; GitHub "Pull requests, Workflow runs, Deployment statuses". Content type `application/json`. Then a "Test connection" button showing the account or the error. Per connection: Test, Rotate secret (one-time panel again), Replace token, Archive, and a "Recent deliveries" table from `deliveries`.
  - **Project settings** (in `Project.tsx`): linked repositories (pick a connection, type `owner/name`, Link; Unlink); shared paths as a textarea with one glob per line; consumer roles as a multi-select of active roles; CI owner role as a select with "None". Server validation errors are shown inline.
  - **Inbox:** a "Contract changes" section between handoffs and blockers: change request reference as a link, title, changed files (first 10, then "and N more"), consumer roles with acknowledged ticks, merge-check state ("Merge blocked until acknowledged", "Merge check not supported here; a comment was posted", "Could not update the merge check" with a Retry button calling `sync-status`). "Acknowledge" with an optional note, shown only when the member holds an unacknowledged consumer role. `?contract=<id>` scrolls to and highlights that item.
  - **Header:** the Inbox count includes pending contract changes.
  - **Task:** evidence grouped by kind with neutral labels "Change requests", "Pipeline runs", "Deployments", "Other". Links only for `http`/`https`.

- [ ] **Step 1: Write the failing tests** with Testing Library and a mocked `api.ts`

```ts
test("Connections: the webhook secret is shown once and gone after navigating away and back", async () => {});
test("Connections: the token field is a password input and is cleared after submit", async () => {});
test("Connections: changing the provider resets the base URL default only if it was untouched", async () => {});
test("Connections: Test connection shows the account name or the error text", async () => {});
test("Project settings: shared paths are sent as one glob per line with blank lines dropped", async () => {});
test("Inbox: acknowledging calls the route and removes the item when no roles remain", async () => {});
test("Inbox: file paths and titles render as text, never HTML", async () => {
  render(<Inbox />);   // files.text = '<img src=x onerror=alert(1)>'
  expect(document.querySelector("img")).toBeNull();
});
test("Inbox: a failed merge check offers Retry, which calls sync-status", async () => {});
test("Task: evidence is grouped under 'Change requests' and 'Pipeline runs'", async () => {});
```

- [ ] **Step 2: Run `pnpm --filter web test`.** Expected: FAIL.
- [ ] **Step 3: Implement**, following the Task 13 rules (no `dangerouslySetInnerHTML`, brand tokens, no component library).
- [ ] **Step 4: Run tests and `pnpm --filter web build`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): connections, code-host settings, contract changes and evidence`.

### Task 30: Ready-made CI snippets

**Files:**
- Create: `integrations/ci/README.md`, `integrations/ci/github/api-report.yml`, `integrations/ci/github/unused-exports.yml`, `integrations/ci/gitlab/api-report.gitlab-ci.yml`, `integrations/ci/gitlab/unused-exports.gitlab-ci.yml`, `integrations/ci/templates/api-extractor.json`, `integrations/ci/templates/knip.json`
- Modify: root `package.json` (devDependency `yaml`; script `test:ci-snippets` = `node --test integrations/ci`)
- Test: `integrations/ci/ci.test.mjs`

**Interfaces:**
- Produces:
  - **Public-API report check** (API Extractor, `@microsoft/api-extractor` pinned to a major version, with the exact version stated in the README). Runs on change requests. It installs, builds declarations, then for each package listed in `API_REPORT_PACKAGES` (a space-separated variable at the top of the file) runs `npx api-extractor run --config <pkg>/api-extractor.json` **without** `--local`, so a public API that differs from the committed `<pkg>/etc/*.api.md` fails the job. The failure message tells the author to run `npx api-extractor run --local` and commit the report. The committed report then appears in the diff, which makes additive changes visible and can be a declared shared path.
  - **Unused-export check** (knip, pinned major): `npx knip --include exports,types,duplicates`.
  - Both GitHub files: `on: pull_request` and `push` to the default branch, `actions/checkout@v4`, `actions/setup-node@v4` with Node 22, an `INSTALL_COMMAND` env defaulting to `npm ci`, and a job name equal to the check name the README tells you to require (`api-report`, `unused-exports`).
  - Both GitLab files: a job with that name, `image: node:22`, `rules: [{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' }, { if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH' }]`, and the same variables. They are meant to be `include:`d or pasted in.
  - `templates/api-extractor.json`: minimal config with `apiReport.enabled: true`, `reportFolder: "<projectFolder>/etc/"`, `docModel` and `dtsRollup` disabled. `templates/knip.json`: a minimal config.
  - README: what each check catches, how to copy each file, how to make it required (GitHub: branch ruleset → required status checks; GitLab: Settings → Merge requests → "Pipelines must succeed"), and how it complements `threadline/contract` (the report file is a good shared path).

- [ ] **Step 1: Write the failing tests**

```js
test("every snippet is valid YAML", () => { for (const f of yamlFiles) assert.doesNotThrow(() => parse(read(f))); });
test("GitHub snippets run on pull_request with Node 22 and run the tool", () => {
  for (const [f, cmd] of [["github/api-report.yml", "api-extractor run"], ["github/unused-exports.yml", "knip"]]) {
    const y = parse(read(f)); assert.ok(y.on.pull_request !== undefined);
    const steps = Object.values(y.jobs).flatMap(j => j.steps);
    assert.ok(steps.some(s => s.with?.["node-version"] == 22));
    assert.ok(steps.some(s => s.run?.includes(cmd)));
  }
});
test("GitLab snippets run on merge request pipelines", () => { /* rules include merge_request_event; script includes the command */ });
test("the API report check fails on a difference instead of updating the report", () => {
  for (const f of ["github/api-report.yml", "gitlab/api-report.gitlab-ci.yml"]) {
    const run = Object.values(parse(read(f))).flatMap(j => [...(j?.steps ?? []).map(s => s.run ?? ""), ...(j?.script ?? [])]).join("\n");
    assert.match(run, /api-extractor run/); assert.doesNotMatch(run, /api-extractor run[^\n]*--local/);   // the hint text lives in echo/comments only
  }
});
test("templates are valid JSON and the README names every file", () => {});
test("no snippet contains a token-shaped string", () => { for (const f of allFiles) assert.ok(!/glpat-|gh[pousr]_|AKIA/.test(read(f))); });
```

- [ ] **Step 2: Run `pnpm test:ci-snippets`.** Expected: FAIL.
- [ ] **Step 3: Write the snippets, templates and README.**
- [ ] **Step 4: Run tests.** Expected: PASS. Also run each GitHub snippet once in a scratch repository (or with `act`) before release. That is a manual step, outside CI.
- [ ] **Step 5: Commit** `feat: CI snippets for public-API report and unused-export checks`.

### Task 31: End-to-end check, deployment and setup guide

**Files:**
- Create: `apps/api/src/codehost.e2e.test.ts`
- Modify: `README.md` (section "Connecting a code host"), `.github/workflows/ci.yml` (add `pnpm test:ci-snippets`), `apps/api/.dev.vars.example`

**Interfaces:**
- Consumes: everything above
- Produces:
  - `codehost.e2e.test.ts`, run for each provider in process (`createApp(env, { db, fetchImpl: fakeProviderFetch(…) })`):
    1. An admin creates a connection over HTTP, links `example-org/example-app` to project `ACME`, and sets shared paths `packages/shared/**` with consumer role `frontend`.
    2. A signed "change request opened" delivery (branch `feature/ACME-1-profile`, files include `packages/shared/profile.ts`) gives a pending `threadline/contract` on the head SHA and evidence on ACME-1.
    3. The frontend agent's `my_open_items` and `session-context` include the contract change.
    4. The frontend agent's bearer token gets 403 on acknowledge.
    5. The frontend member acknowledges, and `success` is posted.
    6. A failed pipeline delivery opens a blocker on ACME-1. A success delivery resolves it, and the `blocker.resolved` event has actor kind `connection`.
    7. Every delivery sent twice changes nothing the second time.
  - README "Connecting a code host":
    - Generate `CREDENTIALS_KEY` with `openssl rand -base64 32`, then `wrangler secret put CREDENTIALS_KEY`.
    - Token scopes. GitLab: personal or project access token with scope `api` and at least the Developer role. GitHub fine-grained token: Metadata read, Contents read, Pull requests read and write, Commit statuses read and write, Actions read, Deployments read.
    - Webhook URL, secret and events per provider.
    - Making the check block merges. GitHub: a branch ruleset requiring status check `threadline/contract`. GitLab: enable "Pipelines must succeed".
    - The GitLab caveat: the external status is attached when Threadline processes the webhook, so a change request merged in the seconds between a push and that delivery is not blocked.
    - `ALLOW_PRIVATE_CODE_HOSTS` for the Node deployment, with the note that hostnames are not resolved.
    - The CI snippets in `integrations/ci/`.

- [ ] **Step 1: Write `codehost.e2e.test.ts` and run `pnpm --filter api test codehost.e2e`.** Expected: PASS, since every piece exists by now. A failure names the numbered step, which points to the task to fix (Task 22 for the receiver, 23 for evidence, 24 for blockers, 25 for the check, 26 or 28 for agent context).
- [ ] **Step 2: Run `pnpm typecheck && pnpm test && pnpm test:ci-snippets`.** Expected: PASS.
- [ ] **Step 3: Deploy.** Run `pnpm migrate` (0008–0013), `wrangler secret put CREDENTIALS_KEY`, then `pnpm deploy`. Check `curl -X POST <PUBLIC_URL>/hooks/<uuid>/<uuid>` returns 401.
- [ ] **Step 4: Write the README section.**
- [ ] **Step 5: Commit** `chore: code host end-to-end test, deployment and setup guide`.

**Phase 2 exit check (with real test repositories, one on GitLab and one on GitHub):** for each, create a connection, add the webhook, link the repository, declare `packages/shared/**` with consumer role `frontend`, and require `threadline/contract` (GitHub ruleset; GitLab "Pipelines must succeed"). Then:
1. Open a change request named for a task that edits `packages/shared/`. The task shows it as evidence, and the frontend owner's Inbox and next agent session show the contract change.
2. The merge button is blocked. The frontend agent cannot acknowledge.
3. The frontend developer acknowledges in the Inbox, and the change request becomes mergeable.
4. A change request that touches nothing shared is mergeable at once.
5. A deliberately failing pipeline opens a blocker; fixing it closes the blocker.

Record what was learned below, then check the Phase 3 plan against the code before starting it.

## Changes to earlier code

Folded into the Phase 0–1 plan: `contract.ack` in `Permission` and `HUMAN_ONLY` (Task 2) and in the `pm`, `lead`, `frontend` and `backend` templates (Task 4), so no role migration is needed here; the substring rule for MCP tool descriptions and its test (Global Constraints, Task 12).

Made by this plan's tasks:

| Earlier code | Change | Task |
|---|---|---|
| `tenancy.ts` (Phase 0 Task 4) | `can` for a connection also requires an active `project_repos` link | 21 |
| `projects.ts` (Phase 0 Task 6) | `findProjectByRepoUrl` searches `project_repos`; `updateProjectConfig` and `getProject` carry `codeHost` | 21 |
| `context.ts` (Phase 1 Task 9) | `OpenItems.contractChanges`; `getByRef` returns `contractChanges`; section order Handoffs, Contract changes, Blockers, Tasks | 26 |
| `app.ts` (Phase 1 Task 11) | `Env` gains `CREDENTIALS_KEY`, `CREDENTIALS_KEY_PREVIOUS`, `ALLOW_PRIVATE_CODE_HOSTS`; `/hooks/*` outside session and Origin middleware | 27 |
| `wrangler.jsonc` (Phase 1 Task 15) | route `/hooks/*` to the Worker | 27 |
| `mcp.ts`, `mcp.test.ts` (Phase 1 Task 12) | eight tools, adding `get_contract_changes` | 28 |
| `ci.yml` (Phase 1 Task 15) | runs `pnpm test:ci-snippets` | 31 |
| Global Constraints | bookkeeping exemption for `webhook_deliveries`, `pipeline_states` and the merge-check sync columns (stated in this plan) | none |

## Notes after the phase

(To be filled in after the exit check.)
