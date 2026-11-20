// Request schemas for every body and query the API accepts. The web client imports these
// (`@threadline/api/schemas`) to validate forms with the same rules, so this module imports
// only zod and core *types*: nothing that would pull the database driver into a browser.
import type { ExternalRefInput, Permission, TaskStatus } from "@threadline/core";
import { z } from "zod";

/** Free text written by any actor is capped at 10,000 characters (core enforces it too). */
export const MAX_TEXT = 10_000;
const MAX_LABEL = 200;
const MAX_URL = 2000;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export const PERMISSION_VALUES = [
  "project.read", "task.write", "handoff.create", "handoff.ack", "contract.ack", "blocker.write",
  "requirement.propose", "requirement.approve", "decision.propose", "decision.approve", "task.accept", "workspace.admin",
] as const;
export const TASK_STATUS_VALUES = ["todo", "in_progress", "in_review", "done"] as const;
export const EVIDENCE_KIND_VALUES = [
  "change_request", "commit", "pipeline_run", "deployment", "ticket", "file", "message",
] as const;
// Compile-time checks that these lists match core's types exactly.
const permissionsMatch: Same<(typeof PERMISSION_VALUES)[number], Permission> = true;
const statusesMatch: Same<(typeof TASK_STATUS_VALUES)[number], TaskStatus> = true;
const kindsMatch: Same<(typeof EVIDENCE_KIND_VALUES)[number], ExternalRefInput["kind"]> = true;
void [permissionsMatch, statusesMatch, kindsMatch];

const text = (max = MAX_TEXT) => z.string().max(max);
const required = (max = MAX_TEXT) => z.string().trim().min(1).max(max);
const uuid = () => z.uuid();
const roleKey = () => z.string().max(40);

export const evidenceSchema = z.object({
  kind: z.enum(EVIDENCE_KIND_VALUES),
  url: z.string().min(1).max(MAX_URL),
  externalId: text(MAX_LABEL).optional(),
  version: text(MAX_LABEL).optional(),
  connectionId: uuid().optional(),
});
const evidenceList = z.array(evidenceSchema).max(20).optional();

// Workspaces, people and roles ------------------------------------------------------------

export const createWorkspaceSchema = z.object({ name: required(MAX_LABEL) });
export const acceptInviteSchema = z.object({ code: z.string().min(1).max(100) });
export const createInviteSchema = z.object({
  roleKeys: z.array(roleKey()).max(50),
  projectId: uuid().optional(),
  expiresInDays: z.number().int().min(1).max(30).optional(),
});
export const createTokenSchema = z.object({
  name: required(MAX_LABEL),
  projectIds: z.array(uuid()).min(1).max(50),
});
export const setMemberRolesSchema = z.object({
  roleKeys: z.array(roleKey()).max(50),
  projectId: uuid().optional(),
});
export const upsertRoleSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/, "role key must be a-z, 0-9 and _, starting with a letter"),
  name: required(MAX_LABEL),
  permissions: z.array(z.enum(PERMISSION_VALUES)).max(PERMISSION_VALUES.length),
});
export const updateRoleSchema = upsertRoleSchema.omit({ key: true });

// Projects ---------------------------------------------------------------------------------

export const createProjectSchema = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/, "key must be 2 to 10 characters: A-Z, then A-Z or 0-9"),
  name: required(MAX_LABEL),
});
export const notifierSchema = z.object({
  kind: z.enum(["mattermost", "slack"]),
  webhookUrl: z.string().min(1).max(1000),
});
export const updateProjectConfigSchema = z
  .object({
    repoUrls: z.array(z.string().min(1).max(500)).max(20).optional(),
    notifier: notifierSchema.nullable().optional(),
  })
  .refine((v) => v.repoUrls !== undefined || v.notifier !== undefined, "nothing to update");

// Work -------------------------------------------------------------------------------------

/** A task in the path's project, as a ref (`ACME-12`) or an id. */
const taskRef = () => z.string().trim().min(1).max(MAX_LABEL);

export const createTaskSchema = z.object({
  title: required(),
  description: text().optional(),
  ownerRoleId: uuid(),
  branch: text(MAX_LABEL).optional(),
  dependsOn: z.array(uuid()).max(50).optional(),
});
export const setTaskStatusSchema = z.object({ status: z.enum(TASK_STATUS_VALUES) });
export const reportProgressSchema = z.object({
  note: required(),
  runId: uuid().optional(),
  evidence: evidenceList,
});

export const createHandoffSchema = z.object({
  task: taskRef(),
  toRoleId: uuid(),
  delivered: required(),
  requiredAction: required(),
  knownLimits: text().optional(),
  evidence: evidenceList,
  idempotencyKey: z.string().min(1).max(200).optional(),
});
export const respondToHandoffSchema = z.object({
  response: z.enum(["accepted", "needs_changes"]),
  note: text().optional(),
});

export const raiseBlockerSchema = z.object({
  task: taskRef().optional(),
  observed: required(),
  suspectedCause: text().optional(),
  ownerRoleId: uuid(),
  evidence: evidenceList,
});
export const blockerCauseSchema = z.object({ cause: required(), verified: z.boolean() });
export const resolveBlockerSchema = z.object({ resolution: required() });

// Queries ----------------------------------------------------------------------------------

export const eventsQuerySchema = z.object({
  after: uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export const taskListQuerySchema = z.object({ status: z.enum(TASK_STATUS_VALUES).optional() });
export const blockerListQuerySchema = z.object({ status: z.enum(["open", "resolved"]).optional() });
export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(1000),
  limit: z.coerce.number().int().min(1).max(25).optional(),
});
export const sessionContextQuerySchema = z.object({
  repo: z.string().trim().min(1).max(500),
  branch: z.string().trim().min(1).max(MAX_LABEL).optional(),
});
export const oauthCallbackQuerySchema = z.object({
  code: z.string().min(1).max(2000),
  state: z.string().min(1).max(200),
});
