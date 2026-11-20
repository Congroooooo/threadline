// The signed-in person: who they are, their workspaces, creating one, accepting an invite.
import { acceptInvite, createWorkspace, getUser, listMemberships } from "@threadline/core";
import { Hono } from "hono";
import type { Config } from "../env.js";
import { type AppEnv, body, type Ctx, fail, requireUser } from "../middleware.js";
import { acceptInviteSchema, createWorkspaceSchema } from "../schemas.js";

async function currentUser(c: Ctx) {
  const user = await getUser(c.var.db, requireUser(c));
  if (!user) throw fail(401, "sign in required");
  return user;
}

/** WORKSPACE_CREATORS unset: anyone. Otherwise one of the user's provider logins must be listed. */
export function mayCreateWorkspaces(config: Config, identities: { provider: string; login: string | null }[]): boolean {
  const allowed = config.workspaceCreators;
  if (allowed === null) return true;
  return identities.some((i) => i.login !== null && allowed.has(`${i.provider}:${i.login.toLowerCase()}`));
}

export function accountRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/me", async (c) => {
    const user = await currentUser(c);
    const memberships = await listMemberships(c.var.db, user.id);
    return c.json({ user, memberships, mayCreateWorkspaces: mayCreateWorkspaces(c.var.config, user.identities) });
  });

  app.post("/workspaces", async (c) => {
    const user = await currentUser(c);
    if (!mayCreateWorkspaces(c.var.config, user.identities)) {
      throw fail(403, "this deployment only lets listed people create workspaces; ask for an invite");
    }
    const { name } = await body(c, createWorkspaceSchema);
    const created = await createWorkspace(c.var.db, { name, userId: user.id, displayName: user.displayName });
    return c.json(created, 201);
  });

  app.post("/invites/accept", async (c) => {
    const user = await currentUser(c);
    const { code } = await body(c, acceptInviteSchema);
    return c.json(await acceptInvite(c.var.db, { userId: user.id, displayName: user.displayName, code }));
  });

  return app;
}
