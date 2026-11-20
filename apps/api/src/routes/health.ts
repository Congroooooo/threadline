// GET /api/health: the database answers and the app's role cannot get around row-level
// security (no superuser, no BYPASSRLS, owns no tables in public).
import { checkDatabaseRole } from "@threadline/core";
import { Hono } from "hono";
import type { AppEnv } from "../middleware.js";

export function healthRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get("/", async (c) => {
    let result: Awaited<ReturnType<typeof checkDatabaseRole>>;
    try {
      result = await checkDatabaseRole(c.var.db);
    } catch (err) {
      console.error("health check failed", err);
      return c.json({ ok: false, reason: "database unreachable" }, 500);
    }
    if (result.ok) return c.json(result);
    // The detail (role name, what is wrong) is for operators, not for anyone who can reach the URL.
    console.error("health check failed:", result.reason);
    return c.json({ ok: false, reason: "database role is not safe" }, 500);
  });
  return app;
}
