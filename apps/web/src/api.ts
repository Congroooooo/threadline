// The typed client for the Threadline JSON API (apps/api). Every call is same-origin with
// the session cookie; browsers add the Origin header the API checks on POST/PUT/PATCH.
// Response types mirror packages/core's return types (kept here so the browser bundle
// never imports core). Free text and people names arrive as Quoted: render `.text` only.
import type { Permission } from "./permissions";

export type Quoted = { untrusted: true; source: string; text: string };
export type TaskStatus = "todo" | "in_progress" | "in_review" | "done";
export type EvidenceKind = "change_request" | "commit" | "pipeline_run" | "deployment" | "ticket" | "file" | "message";
export type Evidence = { kind: EvidenceKind; url: string; externalId?: string; version?: string; connectionId?: string };

export type Me = {
  user: { id: string; displayName: string; email: string | null; identities: { provider: string; login: string | null }[] };
  memberships: { workspaceId: string; memberId: string; workspaceName: string }[];
  mayCreateWorkspaces: boolean;
};
export type Member = {
  memberId: string;
  displayName: string;
  status: "active" | "removed";
  roles: { key: string; projectId: string | null }[];
};
export type Role = { id: string; key: string; name: string; permissions: Permission[]; archived: boolean; memberCount: number };
export type Invite = {
  id: string;
  roleKeys: string[];
  projectId: string | null;
  createdBy: string;
  createdByName: string;
  expiresAt: string;
  createdAt: string;
};
export type AgentToken = {
  id: string;
  memberId: string;
  ownerName: string;
  name: string;
  projectIds: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};
export type ProjectSummary = { id: string; key: string; name: string };
/** The sign-in options the deployment offers. */
export type Providers = { github: boolean; gitlab: boolean; local: boolean };
export type Project = ProjectSummary & { repoUrls: string[]; notifier: { kind: string; configured: true } | null };
export type TaskView = {
  id: string;
  ref: string;
  title: Quoted;
  description: Quoted | null;
  status: TaskStatus;
  ownerRole: string;
  branch: string | null;
  blocked: boolean;
};
export type HandoffView = {
  id: string;
  taskRef: string;
  from: Quoted;
  toRole: string;
  unassigned: boolean;
  delivered: Quoted;
  requiredAction: Quoted;
  knownLimits: Quoted | null;
  status: "pending" | "accepted" | "needs_changes";
  evidence: Evidence[];
  createdAt: string;
};
export type BlockerView = {
  id: string;
  taskRef: string | null;
  observed: Quoted;
  cause: Quoted | null;
  causeStatus: "none" | "suspected" | "verified";
  ownerRole: string;
  status: "open" | "resolved";
  createdAt: string;
};
export type ProgressView = { id: string; by: Quoted; note: Quoted; createdAt: string };
export type OpenItems = { handoffs: HandoffView[]; blockers: BlockerView[]; tasks: TaskView[] };
export type TaskContext = {
  task: TaskView;
  dependencies: TaskView[];
  blockedBy: { dependencies: string[]; blockers: string[] };
  handoffs: HandoffView[];
  blockers: BlockerView[];
  progress: ProgressView[];
  evidence: Evidence[];
};
export type EventRow = {
  id: string;
  workspaceId: string;
  projectId: string | null;
  actorKind: "member" | "agent" | "connection" | "system";
  actorId: string;
  type: string;
  subjectKind: string;
  subjectId: string;
  data: Record<string, unknown>;
  createdAt: string;
};
export type SearchHit = { kind: "task" | "handoff" | "blocker" | "progress"; id: string; ref?: string; snippet: Quoted };

/** A non-2xx answer: `status` is the HTTP status, `error` the API's message. */
export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    readonly status: number,
    readonly error: string,
  ) {
    super(error);
  }
}

/** Where a 401 sends the browser. Replaceable for tests. */
export const session = {
  onUnauthorized(): void {
    const here = window.location.pathname;
    if (here !== "/signin") window.location.assign("/signin");
  },
};

type Method = "GET" | "POST" | "PUT" | "PATCH";

export async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", headers: { Accept: "application/json" } };
  if (body !== undefined) {
    init.headers = { Accept: "application/json", "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, "Threadline could not be reached. Check your connection and try again.");
  }
  const payload: unknown = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      payload !== null && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
        ? (payload as { error: string }).error
        : `request failed (${res.status})`;
    if (res.status === 401) session.onUnauthorized();
    throw new ApiError(res.status, message);
  }
  return payload as T;
}

const e = encodeURIComponent;
const w = (ws: string) => `/api/w/${e(ws)}`;
const qs = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : "";
};

type Ok = { ok: true };

export const api = {
  // Account and sign-in
  me: () => request<Me>("GET", "/api/me"),
  createWorkspace: (name: string) => request<{ workspaceId: string; memberId: string }>("POST", "/api/workspaces", { name }),
  acceptInvite: (code: string) => request<{ workspaceId: string; memberId: string }>("POST", "/api/invites/accept", { code }),
  providers: () => request<Providers>("GET", "/auth/providers"),
  signInLocal: () => request<Ok>("POST", "/auth/local"),
  signOut: () => request<Ok>("POST", "/auth/sign-out"),

  // Members and roles
  members: (ws: string) => request<Member[]>("GET", `${w(ws)}/members`),
  setMemberRoles: (ws: string, memberId: string, input: { roleKeys: string[]; projectId?: string }) =>
    request<Ok>("PUT", `${w(ws)}/members/${e(memberId)}/roles`, input),
  removeMember: (ws: string, memberId: string) => request<Ok>("POST", `${w(ws)}/members/${e(memberId)}/remove`),
  roles: (ws: string) => request<Role[]>("GET", `${w(ws)}/roles`),
  createRole: (ws: string, input: { key: string; name: string; permissions: Permission[] }) =>
    request<{ id: string }>("POST", `${w(ws)}/roles`, input),
  updateRole: (ws: string, roleId: string, input: { name: string; permissions: Permission[] }) =>
    request<Ok>("PUT", `${w(ws)}/roles/${e(roleId)}`, input),
  archiveRole: (ws: string, roleId: string) => request<Ok>("POST", `${w(ws)}/roles/${e(roleId)}/archive`),
  restoreRole: (ws: string, roleId: string) => request<Ok>("POST", `${w(ws)}/roles/${e(roleId)}/restore`),

  // Invites and agent tokens
  invites: (ws: string) => request<Invite[]>("GET", `${w(ws)}/invites`),
  createInvite: (ws: string, input: { roleKeys: string[]; projectId?: string; expiresInDays?: number }) =>
    request<{ inviteId: string; code: string }>("POST", `${w(ws)}/invites`, input),
  revokeInvite: (ws: string, inviteId: string) => request<Ok>("POST", `${w(ws)}/invites/${e(inviteId)}/revoke`),
  tokens: (ws: string) => request<AgentToken[]>("GET", `${w(ws)}/tokens`),
  createToken: (ws: string, input: { name: string; projectIds: string[] }) =>
    request<{ agentId: string; token: string }>("POST", `${w(ws)}/tokens`, input),
  revokeToken: (ws: string, agentId: string) => request<Ok>("POST", `${w(ws)}/tokens/${e(agentId)}/revoke`),

  // Projects
  projects: (ws: string) => request<ProjectSummary[]>("GET", `${w(ws)}/projects`),
  project: (ws: string, projectId: string) => request<Project>("GET", `${w(ws)}/projects/${e(projectId)}`),
  createProject: (ws: string, input: { key: string; name: string }) => request<{ id: string }>("POST", `${w(ws)}/projects`, input),
  updateProjectConfig: (
    ws: string,
    projectId: string,
    patch: { repoUrls?: string[]; notifier?: { kind: "mattermost" | "slack"; webhookUrl: string } | null },
  ) => request<Ok>("PATCH", `${w(ws)}/projects/${e(projectId)}/config`, patch),
  openItems: (ws: string, projectId: string) => request<OpenItems>("GET", `${w(ws)}/projects/${e(projectId)}/open-items`),
  events: (ws: string, projectId: string, opts: { after?: string; limit?: number } = {}) =>
    request<EventRow[]>("GET", `${w(ws)}/projects/${e(projectId)}/events${qs(opts)}`),
  search: (ws: string, projectId: string, q: string) =>
    request<SearchHit[]>("GET", `${w(ws)}/projects/${e(projectId)}/search${qs({ q })}`),

  // Tasks
  tasks: (ws: string, projectId: string, status?: TaskStatus) =>
    request<TaskView[]>("GET", `${w(ws)}/projects/${e(projectId)}/tasks${qs({ status })}`),
  createTask: (
    ws: string,
    projectId: string,
    input: { title: string; description?: string; ownerRoleId: string; branch?: string; dependsOn?: string[] },
  ) => request<{ taskId: string; ref: string }>("POST", `${w(ws)}/projects/${e(projectId)}/tasks`, input),
  task: (ws: string, taskId: string) => request<TaskContext>("GET", `${w(ws)}/tasks/${e(taskId)}`),
  setTaskStatus: (ws: string, taskId: string, status: TaskStatus) =>
    request<Ok>("POST", `${w(ws)}/tasks/${e(taskId)}/status`, { status }),
  reportProgress: (ws: string, taskId: string, input: { note: string; evidence?: Evidence[] }) =>
    request<{ id: string }>("POST", `${w(ws)}/tasks/${e(taskId)}/progress`, input),

  // Handoffs and blockers
  respondToHandoff: (ws: string, handoffId: string, input: { response: "accepted" | "needs_changes"; note?: string }) =>
    request<Ok>("POST", `${w(ws)}/handoffs/${e(handoffId)}/respond`, input),
  blockers: (ws: string, projectId: string, status?: "open" | "resolved") =>
    request<BlockerView[]>("GET", `${w(ws)}/projects/${e(projectId)}/blockers${qs({ status })}`),
  resolveBlocker: (ws: string, blockerId: string, resolution: string) =>
    request<Ok>("POST", `${w(ws)}/blockers/${e(blockerId)}/resolve`, { resolution }),
};

export type Api = typeof api;
