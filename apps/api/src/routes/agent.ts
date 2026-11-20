// Endpoints for coding agents, authenticated with their `tl_` token.
import {
  can,
  findProjectByRepoUrl,
  getTaskContext,
  myOpenItems,
  renderSessionContext,
  withWorkspace,
} from "@threadline/core";
import { Hono } from "hono";
import { type AppEnv, query, requireAgent } from "../middleware.js";
import { sessionContextQuerySchema } from "../schemas.js";

export function agentRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /**
   * Plain text for the session-start hook: the caller's open items in the project that owns
   * `repo`, plus the full context of their not-done task on `branch`, if there is one. An
   * unknown repository, or one whose project is outside the agent's scope, is an empty 200,
   * so the hook stays quiet outside the agent's Threadline projects.
   */
  app.get("/session-context", async (c) => {
    const actor = requireAgent(c);
    const { repo, branch } = query(c, sessionContextQuerySchema);
    const text = await withWorkspace(c.var.db, actor.workspaceId, async (tx) => {
      const projectId = await findProjectByRepoUrl(tx, repo);
      if (projectId === null || !(await can(tx, actor, "project.read", projectId))) return "";
      const items = await myOpenItems(tx, actor, { projectId });
      const task = branch === undefined ? undefined : items.tasks.find((t) => t.branch === branch);
      const context = task ? await getTaskContext(tx, actor, { projectId, task: task.id }) : undefined;
      return renderSessionContext(items, context);
    });
    return c.text(text);
  });

  return app;
}
