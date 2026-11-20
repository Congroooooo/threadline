// The Threadline HTTP API: sign-in under /auth, the MCP endpoint at /mcp, everything else
// under /api. Runs unchanged on Cloudflare Workers (worker.ts) and Node (node.ts).
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type Env, loadConfig } from "./env.js";
import {
  type AppDeps,
  type AppEnv,
  agentBearer,
  authenticate,
  errorResponse,
  fail,
  localHostOnly,
  originCheck,
  resources,
  securityHeaders,
  workspaceActor,
} from "./middleware.js";
import { mcpHandler } from "./mcp.js";
import { accountRoutes } from "./routes/account.js";
import { agentRoutes } from "./routes/agent.js";
import { authRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";
import { workspaceRoutes } from "./routes/workspace.js";

export type { AppDeps, AppEnv } from "./middleware.js";
export type { Env } from "./env.js";

/** Largest request body accepted: well above any valid request (text is capped at 10,000 characters). */
export const MAX_BODY_BYTES = 256 * 1024;

/** Builds the app. Throws when the environment is unsafe (see loadConfig), so it never starts. */
export function createApp(env: Env, deps: AppDeps = {}): Hono<AppEnv> {
  const config = loadConfig(env);
  const app = new Hono<AppEnv>();
  app.onError(errorResponse);
  app.notFound((c) => c.json({ error: "not found" }, 404));

  app.use("*", securityHeaders);
  app.use("*", localHostOnly(config));
  app.use("*", resources(config, deps));
  app.use("*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: () => { throw fail(413, "request body too large"); } }));

  app.route("/auth", authRoutes());
  app.route("/api/health", healthRoutes());

  // Agents only, by bearer token (so no Origin check and no cookies). See mcp.ts.
  app.all("/mcp", agentBearer, mcpHandler);

  app.use("/api/*", originCheck());
  app.use("/api/*", authenticate);
  app.use("/api/w/:workspaceId/*", workspaceActor);
  app.route("/api/w/:workspaceId", workspaceRoutes());
  app.route("/api/agent", agentRoutes());
  app.route("/api", accountRoutes());
  return app;
}
