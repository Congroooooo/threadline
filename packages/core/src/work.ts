// Tasks, their dependencies, runs, progress notes and evidence.
//
// Permissions: every write needs task.write in the task's project, except that moving a task
// to or from `done` needs task.accept (never held by agents). Tasks are loaded before the
// permission check, so an id outside the workspace is NotFoundError, while a task in a
// project the actor cannot reach is a ForbiddenError that carries nothing of the task.
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Tx } from "./db/client.js";
import {
  blockers as blockersTable,
  evidence,
  type EvidenceRow,
  progressNotes,
  type ProgressNoteRow,
  projects,
  roles,
  runs,
  taskDependencies,
  tasks,
  type TaskRow,
} from "./db/schema.js";
import { actorId, recordEvent } from "./events.js";
import { newId } from "./ids.js";
import { cleanText, parseHttpUrl, redactSecrets } from "./safety.js";
import { label, requirePermission } from "./tenancy.js";
import { UUID } from "./tokens.js";
import { type Actor, type ExternalRefInput, ForbiddenError, NotFoundError, ValidationError } from "./types.js";

export type { EvidenceRow, ProgressNoteRow, TaskRow };

export type TaskStatus = "todo" | "in_progress" | "in_review" | "done";
export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";

export const TASK_STATUSES: readonly TaskStatus[] = ["todo", "in_progress", "in_review", "done"];
export const EVIDENCE_KINDS: readonly ExternalRefInput["kind"][] = [
  "change_request", "commit", "pipeline_run", "deployment", "ticket", "file", "message",
];
export const MAX_DEPENDENCIES = 50;
export const MAX_EVIDENCE = 20;
export const MAX_EVIDENCE_URL = 2000;
/** externalId, version, branch and similar short identifiers. */
export const MAX_REF_LENGTH = 200;

// ---------------------------------------------------------------------------------------
// Shared helpers (also used by coordination.ts)

/** The member behind a member or agent actor. Connections act for no member. */
export function memberOf(actor: Actor): string {
  if (actor.kind === "connection") throw new ForbiddenError("connections cannot do this");
  return actor.memberId;
}

/** The task, or NotFoundError. `lock` takes a row lock for the rest of the transaction. */
export async function loadTask(tx: Tx, taskId: string, lock = false): Promise<TaskRow> {
  if (typeof taskId !== "string" || !UUID.test(taskId)) throw new NotFoundError("task not found");
  const q = tx.select().from(tasks).where(eq(tasks.id, taskId));
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw new NotFoundError("task not found");
  return row;
}

/** ValidationError unless `roleId` is a role of this workspace that is not archived. */
export async function requireActiveRole(tx: Tx, roleId: string, field: string): Promise<void> {
  const bad = new ValidationError(`${field} must be an active role`);
  if (typeof roleId !== "string" || !UUID.test(roleId)) throw bad;
  const [role] = await tx.select({ archivedAt: roles.archivedAt }).from(roles).where(eq(roles.id, roleId));
  if (!role || role.archivedAt !== null) throw bad;
}

/** Optional free text: null when omitted or blank, otherwise capped and redacted. */
export function optionalText(text: string | undefined | null, field: string): string | null {
  if (text === undefined || text === null) return null;
  if (typeof text !== "string") throw new ValidationError(`${field} must be text`);
  const out = cleanText(text, field).trim();
  return out === "" ? null : out;
}

function shortRef(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ValidationError(`${field} must be text`);
  const out = cleanText(value, field).trim();
  if (out === "" || out.length > MAX_REF_LENGTH || /[\x00-\x1f\x7f]/.test(out)) {
    throw new ValidationError(`${field} must be 1 to ${MAX_REF_LENGTH} characters`);
  }
  return out;
}

export type ParsedEvidence = {
  kind: ExternalRefInput["kind"];
  url: string;
  externalId: string | null;
  version: string | null;
  connectionId: string | null;
};

/** Validates evidence before anything is written. URLs must be http(s), without credentials. */
export function parseEvidence(input: ExternalRefInput[] | undefined, actor: Actor): ParsedEvidence[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > MAX_EVIDENCE) {
    throw new ValidationError(`evidence must be a list of at most ${MAX_EVIDENCE} items`);
  }
  return input.map((e, i) => {
    const field = `evidence[${i}]`;
    if (e === null || typeof e !== "object") throw new ValidationError(`${field} must be an object`);
    if (!EVIDENCE_KINDS.includes(e.kind)) throw new ValidationError(`${field}.kind must be one of ${EVIDENCE_KINDS.join(", ")}`);
    const url = redactSecrets(parseHttpUrl(e.url, `${field}.url`, { maxLength: MAX_EVIDENCE_URL, allowHttp: "any" }));
    let connectionId: string | null = actor.kind === "connection" ? actor.connectionId : null;
    if (e.connectionId !== undefined && e.connectionId !== null) {
      if (typeof e.connectionId !== "string" || !UUID.test(e.connectionId)) {
        throw new ValidationError(`${field}.connectionId must be a connection id`);
      }
      connectionId = e.connectionId;
    }
    return {
      kind: e.kind,
      url,
      externalId: shortRef(e.externalId, `${field}.externalId`),
      version: shortRef(e.version, `${field}.version`),
      connectionId,
    };
  });
}

/** Appends parsed evidence to a subject and returns the new ids, in order. */
export async function attachEvidence(
  tx: Tx,
  actor: Actor,
  projectId: string,
  subjectKind: EvidenceRow["subjectKind"],
  subjectId: string,
  items: ParsedEvidence[],
): Promise<string[]> {
  if (items.length === 0) return [];
  const rows = items.map((e) => ({ id: newId(), workspaceId: actor.workspaceId, projectId, subjectKind, subjectId, ...e }));
  await tx.insert(evidence).values(rows);
  return rows.map((r) => r.id);
}

/** Raw evidence rows of one subject, oldest first. For use inside core. */
export function listEvidence(tx: Tx, subjectKind: EvidenceRow["subjectKind"], subjectId: string): Promise<EvidenceRow[]> {
  return tx
    .select()
    .from(evidence)
    .where(and(eq(evidence.subjectKind, subjectKind), eq(evidence.subjectId, subjectId)))
    .orderBy(asc(evidence.id));
}

/** Locks the project row (serialising numbering and dependency edits) and returns its key. */
export async function lockActiveProject(tx: Tx, projectId: string): Promise<string> {
  const [p] = await tx
    .select({ key: projects.key, archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.id, projectId))
    .for("update");
  if (!p || p.archivedAt !== null) throw new NotFoundError("project not found");
  return p.key;
}

function parseBranch(branch: string | undefined): string | null {
  if (branch === undefined || branch === null) return null;
  if (
    typeof branch !== "string" ||
    branch.length === 0 ||
    branch.length > MAX_REF_LENGTH ||
    /[\s\x00-\x1f\x7f~^:?*[\\]/.test(branch) ||
    branch.includes("..")
  ) {
    throw new ValidationError("branch must be a valid branch name");
  }
  return branch;
}

const SAME_PROJECT = "dependencies must be existing tasks in the same project";

/** ValidationError unless every id is a task of `projectId`. The message names none of them. */
async function requireSameProjectTasks(tx: Tx, projectId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  if (!ids.every((id) => typeof id === "string" && UUID.test(id))) throw new ValidationError(SAME_PROJECT);
  const rows = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(inArray(tasks.id, ids), eq(tasks.projectId, projectId)));
  if (rows.length !== ids.length) throw new ValidationError(SAME_PROJECT);
}

// ---------------------------------------------------------------------------------------
// Tasks

/**
 * Creates a task numbered after the last one in its project, under a lock on the project
 * row so concurrent creates never collide. Needs task.write in the project.
 */
export async function createTask(
  tx: Tx,
  actor: Actor,
  input: { projectId: string; title: string; description?: string; ownerRoleId: string; branch?: string; dependsOn?: string[] },
): Promise<{ taskId: string; ref: string }> {
  const { projectId } = input;
  if (typeof projectId !== "string" || !UUID.test(projectId)) throw new NotFoundError("project not found");
  await requirePermission(tx, actor, "task.write", projectId);
  const createdBy = memberOf(actor);
  const title = label(input.title, "title");
  const description = optionalText(input.description, "description");
  const branch = parseBranch(input.branch);
  await requireActiveRole(tx, input.ownerRoleId, "ownerRoleId");
  if (input.dependsOn !== undefined && (!Array.isArray(input.dependsOn) || input.dependsOn.length > MAX_DEPENDENCIES)) {
    throw new ValidationError(`dependsOn must be a list of at most ${MAX_DEPENDENCIES} task ids`);
  }
  const dependsOn = [...new Set(input.dependsOn ?? [])];

  const key = await lockActiveProject(tx, projectId);
  await requireSameProjectTasks(tx, projectId, dependsOn);
  const [{ next } = { next: 1 }] = await tx
    .select({ next: sql<number>`coalesce(max(${tasks.number}), 0)::int + 1` })
    .from(tasks)
    .where(eq(tasks.projectId, projectId));
  const taskId = newId();
  await tx.insert(tasks).values({
    id: taskId,
    workspaceId: actor.workspaceId,
    projectId,
    number: next,
    title,
    description,
    ownerRoleId: input.ownerRoleId,
    branch,
    createdBy,
  });
  if (dependsOn.length > 0) {
    await tx.insert(taskDependencies).values(
      dependsOn.map((d) => ({ id: newId(), workspaceId: actor.workspaceId, projectId, taskId, dependsOnTaskId: d })),
    );
  }
  const ref = `${key}-${next}`;
  await recordEvent(tx, {
    actor,
    type: "task.created",
    subjectKind: "task",
    subjectId: taskId,
    projectId,
    data: { ref, ownerRoleId: input.ownerRoleId, dependsOn },
  });
  return { taskId, ref };
}

/** The raw task row, or NotFoundError. For use inside core; views come in Task 9. */
export function getTask(tx: Tx, taskId: string): Promise<TaskRow> {
  return loadTask(tx, taskId);
}

/**
 * Resolves `ACME-12` (key case-insensitive) or a task id to a task id of `projectId`.
 * Checks no permission: callers must check permission (project.read on `projectId`) first.
 */
export async function resolveTaskRef(tx: Tx, projectId: string, refOrId: string): Promise<string> {
  const notFound = () => new NotFoundError("task not found");
  if (typeof projectId !== "string" || !UUID.test(projectId) || typeof refOrId !== "string") throw notFound();
  const ref = refOrId.trim();
  if (UUID.test(ref)) {
    const [row] = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, ref), eq(tasks.projectId, projectId)));
    if (!row) throw notFound();
    return row.id;
  }
  const m = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,9})$/.exec(ref);
  if (!m) throw notFound();
  const [row] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(tasks.projectId, projectId), eq(projects.key, m[1]!.toUpperCase()), eq(tasks.number, Number(m[2]))));
  if (!row) throw notFound();
  return row.id;
}

/**
 * Sets a task's status. Needs task.write, or task.accept when the task moves to or from
 * `done` (reopening an accepted task is an acceptance decision too). Same status: no-op.
 */
export async function setTaskStatus(tx: Tx, actor: Actor, taskId: string, status: TaskStatus): Promise<void> {
  if (!TASK_STATUSES.includes(status)) throw new ValidationError(`status must be one of ${TASK_STATUSES.join(", ")}`);
  const task = await loadTask(tx, taskId, true);
  const accepting = status === "done" || task.status === "done";
  await requirePermission(tx, actor, accepting ? "task.accept" : "task.write", task.projectId);
  if (task.status === status) return;
  await changeStatus(tx, actor, task, status);
}

async function changeStatus(tx: Tx, actor: Actor, task: TaskRow, to: TaskStatus, extra: Record<string, unknown> = {}) {
  await tx.update(tasks).set({ status: to, updatedAt: sql`now()` }).where(eq(tasks.id, task.id));
  await recordEvent(tx, {
    actor,
    type: "task.status_changed",
    subjectKind: "task",
    subjectId: task.id,
    projectId: task.projectId,
    data: { from: task.status, to, ...extra },
  });
}

// ---------------------------------------------------------------------------------------
// Dependencies

/**
 * Makes `taskId` depend on `dependsOnTaskId`, a task in the same project. Rejects cycles.
 * Already present: no-op. Needs task.write. Edits are serialised per project.
 */
export async function addDependency(tx: Tx, actor: Actor, taskId: string, dependsOnTaskId: string): Promise<void> {
  const task = await loadTask(tx, taskId);
  await requirePermission(tx, actor, "task.write", task.projectId);
  if (dependsOnTaskId === taskId) throw new ValidationError("a task cannot depend on itself");
  await lockActiveProject(tx, task.projectId);
  await requireSameProjectTasks(tx, task.projectId, [dependsOnTaskId]);
  const [existing] = await tx
    .select({ id: taskDependencies.id })
    .from(taskDependencies)
    .where(and(
      eq(taskDependencies.taskId, taskId),
      eq(taskDependencies.dependsOnTaskId, dependsOnTaskId),
      isNull(taskDependencies.removedAt),
    ));
  if (existing) return;
  // Would close a cycle if taskId is already reachable from dependsOnTaskId.
  const cycle = await tx.execute(sql`
    with recursive reach(id) as (
      select depends_on_task_id from task_dependencies
       where task_id = ${dependsOnTaskId} and removed_at is null
      union
      select d.depends_on_task_id from task_dependencies d
        join reach r on d.task_id = r.id
       where d.removed_at is null
    )
    select 1 as hit from reach where id = ${taskId} limit 1`);
  if (rowsOf(cycle).length > 0) throw new ValidationError("that dependency would create a cycle");
  await tx.insert(taskDependencies).values({
    id: newId(),
    workspaceId: actor.workspaceId,
    projectId: task.projectId,
    taskId,
    dependsOnTaskId,
  });
  await recordEvent(tx, {
    actor,
    type: "task.dependency_added",
    subjectKind: "task",
    subjectId: taskId,
    projectId: task.projectId,
    data: { dependsOnTaskId },
  });
}

/** Removes the dependency (the row is kept, marked removed). Absent: no-op. Needs task.write. */
export async function removeDependency(tx: Tx, actor: Actor, taskId: string, dependsOnTaskId: string): Promise<void> {
  const task = await loadTask(tx, taskId);
  await requirePermission(tx, actor, "task.write", task.projectId);
  if (typeof dependsOnTaskId !== "string" || !UUID.test(dependsOnTaskId)) return;
  const removed = await tx
    .update(taskDependencies)
    .set({ removedAt: sql`now()` })
    .where(and(
      eq(taskDependencies.taskId, taskId),
      eq(taskDependencies.dependsOnTaskId, dependsOnTaskId),
      isNull(taskDependencies.removedAt),
    ))
    .returning({ id: taskDependencies.id });
  if (removed.length === 0) return;
  await recordEvent(tx, {
    actor,
    type: "task.dependency_removed",
    subjectKind: "task",
    subjectId: taskId,
    projectId: task.projectId,
    data: { dependsOnTaskId },
  });
}

/**
 * What keeps a task blocked: its dependencies that are not done (ordered by number) and
 * its open blockers. Blocked is computed here, never stored.
 * Checks no permission: callers must check permission on the task's project first.
 */
export async function blockedBy(tx: Tx, taskId: string): Promise<{ dependencies: string[]; blockers: string[] }> {
  await loadTask(tx, taskId);
  const deps = await tx
    .select({ id: tasks.id })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
    .where(and(eq(taskDependencies.taskId, taskId), isNull(taskDependencies.removedAt), ne(tasks.status, "done")))
    .orderBy(asc(tasks.number));
  const open = await tx
    .select({ id: blockersTable.id })
    .from(blockersTable)
    .where(and(eq(blockersTable.taskId, taskId), eq(blockersTable.status, "open")))
    .orderBy(asc(blockersTable.id));
  return { dependencies: deps.map((d) => d.id), blockers: open.map((b) => b.id) };
}

// ---------------------------------------------------------------------------------------
// Runs and progress

/**
 * Starts a run of the task by the actor and returns its id. A `todo` task moves to
 * `in_progress`; a `done` task cannot be worked on. Needs task.write.
 */
export async function startRun(tx: Tx, actor: Actor, taskId: string): Promise<string> {
  const task = await loadTask(tx, taskId, true);
  await requirePermission(tx, actor, "task.write", task.projectId);
  if (task.status === "done") throw new ValidationError("task is done; reopen it first");
  const runId = newId();
  await tx.insert(runs).values({ id: runId, workspaceId: actor.workspaceId, taskId, actorKind: actor.kind, actorId: actorId(actor) });
  await recordEvent(tx, {
    actor,
    type: "run.started",
    subjectKind: "run",
    subjectId: runId,
    projectId: task.projectId,
    data: { taskId },
  });
  if (task.status === "todo") await changeStatus(tx, actor, task, "in_progress", { runId });
  return runId;
}

const FINISHED: readonly Exclude<RunStatus, "running">[] = ["succeeded", "failed", "cancelled"];

/**
 * Finishes a running run. Never changes the task's status. Needs task.write; an agent may
 * finish only its own runs, a member any run of a task they can write.
 */
export async function finishRun(tx: Tx, actor: Actor, runId: string, status: Exclude<RunStatus, "running">): Promise<void> {
  if (!FINISHED.includes(status)) throw new ValidationError(`status must be one of ${FINISHED.join(", ")}`);
  if (typeof runId !== "string" || !UUID.test(runId)) throw new NotFoundError("run not found");
  const [run] = await tx
    .select({ taskId: runs.taskId, actorKind: runs.actorKind, actorId: runs.actorId, projectId: tasks.projectId })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(eq(runs.id, runId));
  if (!run) throw new NotFoundError("run not found");
  await requirePermission(tx, actor, "task.write", run.projectId);
  if (actor.kind === "agent" && !(run.actorKind === "agent" && run.actorId === actor.agentId)) {
    throw new ForbiddenError("an agent may finish only its own runs");
  }
  const done = await tx
    .update(runs)
    .set({ status, finishedAt: sql`now()` })
    .where(and(eq(runs.id, runId), eq(runs.status, "running")))
    .returning({ id: runs.id });
  if (done.length === 0) throw new ValidationError("run has already finished");
  await recordEvent(tx, {
    actor,
    type: "run.finished",
    subjectKind: "run",
    subjectId: runId,
    projectId: run.projectId,
    data: { taskId: run.taskId, status },
  });
}

/**
 * Appends a progress note (redacted) to the task, optionally tied to one of its runs, with
 * evidence. Returns the note id. Needs task.write.
 */
export async function reportProgress(
  tx: Tx,
  actor: Actor,
  input: { taskId: string; note: string; runId?: string; evidence?: ExternalRefInput[] },
): Promise<string> {
  const task = await loadTask(tx, input.taskId);
  await requirePermission(tx, actor, "task.write", task.projectId);
  const note = label(input.note, "note");
  const items = parseEvidence(input.evidence, actor);
  const runId = input.runId ?? null;
  if (runId !== null) {
    const bad = new ValidationError("runId must be a run of this task");
    if (typeof runId !== "string" || !UUID.test(runId)) throw bad;
    const [run] = await tx.select({ id: runs.id }).from(runs).where(and(eq(runs.id, runId), eq(runs.taskId, task.id)));
    if (!run) throw bad;
  }
  const id = newId();
  await tx.insert(progressNotes).values({
    id,
    workspaceId: actor.workspaceId,
    taskId: task.id,
    runId,
    note,
    actorKind: actor.kind,
    actorId: actorId(actor),
  });
  const evidenceIds = await attachEvidence(tx, actor, task.projectId, "progress", id, items);
  await recordEvent(tx, {
    actor,
    type: "task.progress_reported",
    subjectKind: "task",
    subjectId: task.id,
    projectId: task.projectId,
    data: { progressId: id, runId, evidenceIds },
  });
  return id;
}

/** Raw progress notes of a task, oldest first. For use inside core. */
export function listProgress(tx: Tx, taskId: string): Promise<ProgressNoteRow[]> {
  return tx.select().from(progressNotes).where(eq(progressNotes.taskId, taskId)).orderBy(asc(progressNotes.id));
}

/** Rows from `tx.execute`, whichever driver returned them. */
export function rowsOf(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  return (result as { rows?: unknown[] }).rows ?? [];
}
