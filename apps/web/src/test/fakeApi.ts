// A stand-in for `api` in page tests: every method is a vi.fn with a harmless default.
// Test files install it with
//   vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), api: (await import("../test/fakeApi")).fakeApi }));
import { vi, type Mock } from "vitest";
import type { Api } from "../api";

type Fake = { [K in keyof Api]: Mock<Api[K]> };

const defaults: { [K in keyof Api]: () => Awaited<ReturnType<Api[K]>> } = {
  me: () => ({
    user: { id: "u1", displayName: "Ada", email: null, identities: [{ provider: "github", login: "ada" }] },
    memberships: [{ workspaceId: "w1", memberId: "m1", workspaceName: "Acme" }],
    mayCreateWorkspaces: true,
  }),
  createWorkspace: () => ({ workspaceId: "w1", memberId: "m1" }),
  acceptInvite: () => ({ workspaceId: "w1", memberId: "m1" }),
  providers: () => ({ github: true, gitlab: true, local: true }),
  signInLocal: () => ({ ok: true }),
  signOut: () => ({ ok: true }),
  members: () => [],
  setMemberRoles: () => ({ ok: true }),
  removeMember: () => ({ ok: true }),
  roles: () => [],
  createRole: () => ({ id: "r-new" }),
  updateRole: () => ({ ok: true }),
  archiveRole: () => ({ ok: true }),
  restoreRole: () => ({ ok: true }),
  invites: () => [],
  createInvite: () => ({ inviteId: "i1", code: "inv_code" }),
  revokeInvite: () => ({ ok: true }),
  tokens: () => [],
  createToken: () => ({ agentId: "a1", token: "tl_token" }),
  revokeToken: () => ({ ok: true }),
  projects: () => [],
  project: () => ({ id: "p1", key: "ACME", name: "Acme", repoUrls: [], notifier: null }),
  createProject: () => ({ id: "p1" }),
  updateProjectConfig: () => ({ ok: true }),
  openItems: () => ({ handoffs: [], blockers: [], tasks: [] }),
  events: () => [],
  search: () => [],
  tasks: () => [],
  createTask: () => ({ taskId: "t1", ref: "ACME-1" }),
  task: () => {
    throw new Error("no task stubbed");
  },
  setTaskStatus: () => ({ ok: true }),
  reportProgress: () => ({ id: "n1" }),
  respondToHandoff: () => ({ ok: true }),
  blockers: () => [],
  resolveBlocker: () => ({ ok: true }),
};

export const fakeApi = Object.fromEntries(Object.keys(defaults).map((k) => [k, vi.fn()])) as unknown as Fake;

/** Restores every method to its default answer and clears recorded calls. */
export function resetFakeApi(): void {
  for (const [k, make] of Object.entries(defaults)) {
    const fn = (fakeApi as unknown as Record<string, Mock>)[k]!;
    fn.mockReset();
    fn.mockImplementation(async () => make());
  }
}

export const quoted = (text: string, source = "member:m2") => ({ untrusted: true as const, source, text });
