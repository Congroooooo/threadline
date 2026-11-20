// The permission vocabulary, copied from packages/core/src/types.ts so the browser bundle
// never imports core. permissions.test.ts fails if the two lists drift apart.
export const PERMISSIONS = [
  "project.read", "task.write", "handoff.create", "handoff.ack", "contract.ack", "blocker.write",
  "requirement.propose", "requirement.approve", "decision.propose", "decision.approve", "task.accept", "workspace.admin",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Never granted to agents, whatever their role says (enforced by the server in `can`). */
export const HUMAN_ONLY: readonly Permission[] = [
  "handoff.ack", "contract.ack", "requirement.approve", "decision.approve", "task.accept", "workspace.admin",
];

/** What each permission lets someone do, in plain words. */
export const PERMISSION_LABELS: Record<Permission, string> = {
  "project.read": "See the project",
  "task.write": "Create and update tasks",
  "handoff.create": "Hand work over",
  "handoff.ack": "Accept or return handoffs",
  "contract.ack": "Accept contracts",
  "blocker.write": "Raise and resolve blockers",
  "requirement.propose": "Propose requirements",
  "requirement.approve": "Approve requirements",
  "decision.propose": "Propose decisions",
  "decision.approve": "Approve decisions",
  "task.accept": "Mark tasks done",
  "workspace.admin": "Manage the workspace",
};

/**
 * The permissions a member holds in a project (or workspace-wide when `projectId` is
 * omitted): every active role assigned workspace-wide or for that project.
 */
export function permissionsOf(
  member: { roles: { key: string; projectId: string | null }[] } | undefined,
  roles: { key: string; permissions: readonly Permission[]; archived: boolean }[],
  projectId?: string,
): Set<Permission> {
  const out = new Set<Permission>();
  if (!member) return out;
  for (const assigned of member.roles) {
    if (assigned.projectId !== null && assigned.projectId !== projectId) continue;
    const role = roles.find((r) => r.key === assigned.key && !r.archived);
    for (const p of role?.permissions ?? []) out.add(p);
  }
  return out;
}
