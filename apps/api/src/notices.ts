// Chat notices for new handoffs and blockers, shared by the HTTP routes and the MCP tools.
// Messages are pointer-only (ref, who, which role) and are sent after the response.
import {
  type Actor,
  blockerMessage,
  getTaskContext,
  handoffMessage,
  listRoles,
  notifyProject,
  type Tx,
} from "@threadline/core";
import type { Ctx } from "./middleware.js";

export type Notice = { projectId: string; text: string; link: string };

/** The role's display name, for chat messages. */
async function roleName(tx: Tx, roleId: string): Promise<string> {
  return (await listRoles(tx)).find((r) => r.id === roleId)?.name ?? "unknown role";
}

function taskLink(publicUrl: string, workspaceId: string, taskId: string): string {
  return `${publicUrl}/w/${workspaceId}/tasks/${taskId}`;
}

/** The notice for a handoff just created on `taskId` (call inside the creating transaction). */
export async function handoffNotice(
  tx: Tx,
  actor: Actor,
  publicUrl: string,
  input: { projectId: string; taskId: string; handoffId: string; toRoleId: string; unassigned: boolean },
): Promise<Notice> {
  const context = await getTaskContext(tx, actor, { projectId: input.projectId, task: input.taskId });
  const view = context.handoffs.find((h) => h.id === input.handoffId);
  const text = handoffMessage({
    ref: context.task.ref,
    fromName: view?.from.text ?? "someone",
    toRoleName: await roleName(tx, input.toRoleId),
    unassigned: input.unassigned,
  });
  return { projectId: input.projectId, text, link: taskLink(publicUrl, actor.workspaceId, input.taskId) };
}

/** The notice for a blocker just raised in the project, on `taskId` when given. */
export async function blockerNotice(
  tx: Tx,
  actor: Actor,
  publicUrl: string,
  input: { projectId: string; taskId?: string; ownerRoleId: string },
): Promise<Notice> {
  const { projectId, taskId } = input;
  const ref = taskId ? (await getTaskContext(tx, actor, { projectId, task: taskId })).task.ref : undefined;
  const text = blockerMessage({ ...(ref ? { ref } : {}), ownerRoleName: await roleName(tx, input.ownerRoleId) });
  const link = taskId ? taskLink(publicUrl, actor.workspaceId, taskId) : `${publicUrl}/w/${actor.workspaceId}/projects/${projectId}`;
  return { projectId, text, link };
}

/** Sends the notice to the project's chat after the response; never fails the request. */
export function notifyLater(c: Ctx, workspaceId: string, notice: Notice): void {
  const { db, fetchImpl, defer } = c.var;
  defer(notifyProject(db, workspaceId, notice.projectId, { text: notice.text, link: notice.link }, fetchImpl));
}
