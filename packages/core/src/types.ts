export type Actor =
  | { kind: "member"; workspaceId: string; memberId: string }
  | { kind: "agent"; workspaceId: string; memberId: string; agentId: string; projectIds: string[] }
  | { kind: "connection"; workspaceId: string; connectionId: string };

export type Permission =
  | "project.read" | "task.write" | "handoff.create" | "handoff.ack"
  | "contract.ack"                                    // used from Phase 2
  | "blocker.write" | "requirement.propose" | "requirement.approve"   // requirements used from Phase 3
  | "decision.propose" | "decision.approve"          // used from Phase 4
  | "task.accept" | "workspace.admin";

export const HUMAN_ONLY: Permission[] =
  ["handoff.ack", "contract.ack", "requirement.approve", "decision.approve", "task.accept", "workspace.admin"];

export type ExternalRefInput = {
  connectionId?: string;
  kind: "change_request" | "commit" | "pipeline_run" | "deployment" | "ticket" | "file" | "message";
  url: string;
  externalId?: string;
  version?: string;
};

export type Quoted = { untrusted: true; source: string; text: string };

export class ForbiddenError extends Error {
  override name = "ForbiddenError";
}
export class NotFoundError extends Error {
  override name = "NotFoundError";
}
export class ValidationError extends Error {
  override name = "ValidationError";
}
