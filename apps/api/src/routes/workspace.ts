// Everything under /api/w/:workspaceId. The caller is already resolved to an actor of that
// workspace (middleware.workspaceActor); permissions are checked by core.
import {
  archiveRole,
  createAgentToken,
  createHandoff,
  createInvite,
  createProject,
  createTask,
  getProject,
  getTaskContextById,
  listAgentTokens,
  listBlockers,
  listEvents,
  listInvites,
  listMembers,
  listProjects,
  listRoles,
  listTasks,
  myOpenItems,
  raiseBlocker,
  removeMember,
  reportProgress,
  requirePermission,
  resolveBlocker,
  resolveTaskRef,
  respondToHandoff,
  restoreRole,
  revokeAgentToken,
  revokeInvite,
  search,
  setBlockerCause,
  setMemberRoles,
  setTaskStatus,
  type Tx,
  updateProjectConfig,
  upsertRole,
} from "@threadline/core";
import { Hono } from "hono";
import { type AppEnv, body, type Ctx, fail, inWorkspace, query, uuidParam } from "../middleware.js";
import { blockerNotice, handoffNotice, notifyLater } from "../notices.js";
import {
  blockerCauseSchema,
  blockerListQuerySchema,
  taskListQuerySchema,
  createHandoffSchema,
  createInviteSchema,
  createProjectSchema,
  createTaskSchema,
  createTokenSchema,
  eventsQuerySchema,
  raiseBlockerSchema,
  reportProgressSchema,
  resolveBlockerSchema,
  respondToHandoffSchema,
  searchQuerySchema,
  setMemberRolesSchema,
  setTaskStatusSchema,
  updateProjectConfigSchema,
  updateRoleSchema,
  upsertRoleSchema,
} from "../schemas.js";


const OK = { ok: true } as const;

/** A task of the path's project, by ref or id, after checking the caller may read the project. */
async function taskIn(tx: Tx, c: Ctx, projectId: string, ref: string): Promise<string> {
  await requirePermission(tx, c.var.actor, "project.read", projectId);
  return resolveTaskRef(tx, projectId, ref);
}

export function workspaceRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Members and roles ------------------------------------------------------------------

  app.get("/members", async (c) => c.json(await inWorkspace(c, (tx) => listMembers(tx))));

  app.put("/members/:memberId/roles", async (c) => {
    const memberId = uuidParam(c, "memberId");
    const input = await body(c, setMemberRolesSchema);
    await inWorkspace(c, (tx, actor) => setMemberRoles(tx, actor, { memberId, ...input }));
    return c.json(OK);
  });

  app.post("/members/:memberId/remove", async (c) => {
    const memberId = uuidParam(c, "memberId");
    await inWorkspace(c, (tx, actor) => removeMember(tx, actor, memberId));
    return c.json(OK);
  });

  app.get("/roles", async (c) => c.json(await inWorkspace(c, (tx) => listRoles(tx))));

  app.post("/roles", async (c) => {
    const input = await body(c, upsertRoleSchema);
    const id = await inWorkspace(c, (tx, actor) => upsertRole(tx, actor, input));
    return c.json({ id }, 201);
  });

  app.put("/roles/:roleId", async (c) => {
    const roleId = uuidParam(c, "roleId");
    const input = await body(c, updateRoleSchema);
    await inWorkspace(c, async (tx, actor) => {
      // Roles are upserted by key; look the key up so the client can address roles by id.
      await requirePermission(tx, actor, "workspace.admin");
      const role = (await listRoles(tx)).find((r) => r.id === roleId);
      if (!role) throw fail(404, "role not found");
      await upsertRole(tx, actor, { key: role.key, ...input });
    });
    return c.json(OK);
  });

  app.post("/roles/:roleId/archive", async (c) => {
    const roleId = uuidParam(c, "roleId");
    await inWorkspace(c, (tx, actor) => archiveRole(tx, actor, roleId));
    return c.json(OK);
  });

  app.post("/roles/:roleId/restore", async (c) => {
    const roleId = uuidParam(c, "roleId");
    await inWorkspace(c, (tx, actor) => restoreRole(tx, actor, roleId));
    return c.json(OK);
  });

  // Invites and agent tokens -----------------------------------------------------------

  app.get("/invites", async (c) => c.json(await inWorkspace(c, (tx, actor) => listInvites(tx, actor))));

  app.post("/invites", async (c) => {
    const input = await body(c, createInviteSchema);
    return c.json(await inWorkspace(c, (tx, actor) => createInvite(tx, actor, input)), 201);
  });

  app.post("/invites/:inviteId/revoke", async (c) => {
    const inviteId = uuidParam(c, "inviteId");
    await inWorkspace(c, (tx, actor) => revokeInvite(tx, actor, inviteId));
    return c.json(OK);
  });

  app.get("/tokens", async (c) => c.json(await inWorkspace(c, (tx, actor) => listAgentTokens(tx, actor))));

  app.post("/tokens", async (c) => {
    const input = await body(c, createTokenSchema);
    return c.json(await inWorkspace(c, (tx, actor) => createAgentToken(tx, actor, input)), 201);
  });

  app.post("/tokens/:agentId/revoke", async (c) => {
    const agentId = uuidParam(c, "agentId");
    await inWorkspace(c, (tx, actor) => revokeAgentToken(tx, actor, agentId));
    return c.json(OK);
  });

  // Projects ---------------------------------------------------------------------------

  app.get("/projects", async (c) => c.json(await inWorkspace(c, (tx, actor) => listProjects(tx, actor))));

  app.post("/projects", async (c) => {
    const input = await body(c, createProjectSchema);
    const id = await inWorkspace(c, (tx, actor) => createProject(tx, actor, input));
    return c.json({ id }, 201);
  });

  app.get("/projects/:projectId", async (c) => {
    const projectId = uuidParam(c, "projectId");
    return c.json(await inWorkspace(c, (tx, actor) => getProject(tx, actor, projectId)));
  });

  app.patch("/projects/:projectId/config", async (c) => {
    const projectId = uuidParam(c, "projectId");
    const patch = await body(c, updateProjectConfigSchema);
    await inWorkspace(c, (tx, actor) => updateProjectConfig(tx, actor, projectId, patch));
    return c.json(OK);
  });

  app.get("/projects/:projectId/open-items", async (c) => {
    const projectId = uuidParam(c, "projectId");
    return c.json(await inWorkspace(c, (tx, actor) => myOpenItems(tx, actor, { projectId })));
  });

  app.get("/projects/:projectId/events", async (c) => {
    const projectId = uuidParam(c, "projectId");
    const { after, limit } = query(c, eventsQuerySchema);
    const events = await inWorkspace(c, async (tx, actor) => {
      await requirePermission(tx, actor, "project.read", projectId);
      return listEvents(tx, { projectId, ...(after ? { afterId: after } : {}), ...(limit ? { limit } : {}) });
    });
    return c.json(events);
  });

  app.get("/projects/:projectId/search", async (c) => {
    const projectId = uuidParam(c, "projectId");
    const { q, limit } = query(c, searchQuerySchema);
    return c.json(await inWorkspace(c, (tx, actor) => search(tx, actor, { projectId, query: q, ...(limit ? { limit } : {}) })));
  });

  // Tasks ------------------------------------------------------------------------------

  app.get("/projects/:projectId/tasks", async (c) => {
    const projectId = uuidParam(c, "projectId");
    const { status } = query(c, taskListQuerySchema);
    return c.json(await inWorkspace(c, (tx, actor) => listTasks(tx, actor, { projectId, ...(status ? { status } : {}) })));
  });

  app.post("/projects/:projectId/tasks", async (c) => {
    const projectId = uuidParam(c, "projectId");
    const input = await body(c, createTaskSchema);
    return c.json(await inWorkspace(c, (tx, actor) => createTask(tx, actor, { projectId, ...input })), 201);
  });

  app.get("/tasks/:taskId", async (c) => {
    const taskId = uuidParam(c, "taskId");
    return c.json(await inWorkspace(c, (tx, actor) => getTaskContextById(tx, actor, taskId)));
  });

  app.post("/tasks/:taskId/status", async (c) => {
    const taskId = uuidParam(c, "taskId");
    const { status } = await body(c, setTaskStatusSchema);
    await inWorkspace(c, (tx, actor) => setTaskStatus(tx, actor, taskId, status));
    return c.json(OK);
  });

  app.post("/tasks/:taskId/progress", async (c) => {
    const taskId = uuidParam(c, "taskId");
    const input = await body(c, reportProgressSchema);
    const id = await inWorkspace(c, (tx, actor) => reportProgress(tx, actor, { taskId, ...input }));
    return c.json({ id }, 201);
  });

  // Handoffs ---------------------------------------------------------------------------

  app.post("/projects/:projectId/handoffs", async (c) => {
    const projectId = uuidParam(c, "projectId");
    const { task, ...input } = await body(c, createHandoffSchema);
    const { result, notice } = await inWorkspace(c, async (tx, actor) => {
      const taskId = await taskIn(tx, c, projectId, task);
      const result = await createHandoff(tx, actor, { taskId, ...input });
      if (!result.created) return { result, notice: null };
      const notice = await handoffNotice(tx, actor, c.var.config.publicUrl, {
        projectId, taskId, handoffId: result.handoffId, toRoleId: input.toRoleId, unassigned: result.unassigned,
      });
      return { result, notice };
    });
    if (notice) notifyLater(c, c.var.actor.workspaceId, notice);
    return c.json(result, result.created ? 201 : 200);
  });

  app.post("/handoffs/:handoffId/respond", async (c) => {
    const handoffId = uuidParam(c, "handoffId");
    const input = await body(c, respondToHandoffSchema);
    await inWorkspace(c, (tx, actor) => respondToHandoff(tx, actor, { handoffId, ...input }));
    return c.json(OK);
  });

  // Blockers ---------------------------------------------------------------------------

  app.get("/projects/:projectId/blockers", async (c) => {
    const projectId = uuidParam(c, "projectId");
    const { status } = query(c, blockerListQuerySchema);
    return c.json(await inWorkspace(c, (tx, actor) => listBlockers(tx, actor, { projectId, ...(status ? { status } : {}) })));
  });

  app.post("/projects/:projectId/blockers", async (c) => {
    const projectId = uuidParam(c, "projectId");
    const { task, ...input } = await body(c, raiseBlockerSchema);
    const { id, notice } = await inWorkspace(c, async (tx, actor) => {
      const taskId = task === undefined ? undefined : await taskIn(tx, c, projectId, task);
      const id = await raiseBlocker(tx, actor, { projectId, ...(taskId ? { taskId } : {}), ...input });
      const notice = await blockerNotice(tx, actor, c.var.config.publicUrl, {
        projectId, ...(taskId ? { taskId } : {}), ownerRoleId: input.ownerRoleId,
      });
      return { id, notice };
    });
    notifyLater(c, c.var.actor.workspaceId, notice);
    return c.json({ id }, 201);
  });

  app.post("/blockers/:blockerId/cause", async (c) => {
    const blockerId = uuidParam(c, "blockerId");
    const input = await body(c, blockerCauseSchema);
    await inWorkspace(c, (tx, actor) => setBlockerCause(tx, actor, { blockerId, ...input }));
    return c.json(OK);
  });

  app.post("/blockers/:blockerId/resolve", async (c) => {
    const blockerId = uuidParam(c, "blockerId");
    const input = await body(c, resolveBlockerSchema);
    await inWorkspace(c, (tx, actor) => resolveBlocker(tx, actor, { blockerId, ...input }));
    return c.json(OK);
  });

  return app;
}
