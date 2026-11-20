// Node entry: `pnpm --filter @threadline/api start`. Reads the same keys as the Worker from
// the environment, shares one node-postgres pool, and serves the built web app
// (apps/web/dist) when it exists. The only file in apps/api/src that may use Node APIs.
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { checkDatabaseRole, type Db } from "@threadline/core";
import { drizzle } from "drizzle-orm/node-postgres";
import { Hono } from "hono";
import pg from "pg";
import { createApp } from "./app.js";
import { securityHeaders } from "./middleware.js";
import { ENV_KEYS, type Env } from "./env.js";

function readEnv(): Env {
  const env: Record<string, string> = {};
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined && value !== "") env[key] = value;
  }
  return { AUTH_MODE: "oauth", ...env } as Env;
}

async function main(): Promise<void> {
  const env = readEnv();
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  // No schema needed: core only uses the query builder, never relational queries.
  const db = drizzle({ client: pool }) as unknown as Db;
  const api = createApp(env, { db });

  const health = await checkDatabaseRole(db);
  if (!health.ok) throw new Error(`refusing to start: ${health.reason}`);

  const app = new Hono();
  // The API sets these itself; this covers the static web app (Workers use web/public/_headers).
  app.use("*", securityHeaders);
  app.all("/api/*", (c) => api.fetch(c.req.raw));
  app.all("/auth/*", (c) => api.fetch(c.req.raw));
  app.all("/mcp", (c) => api.fetch(c.req.raw));

  const webDist = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  // `wrangler dev` creates an empty dist (its assets directory must exist), so look for index.html.
  if (existsSync(resolve(webDist, "index.html"))) {
    const root = relative(process.cwd(), webDist) || ".";
    app.use("*", serveStatic({ root }));
    // Single-page app: unknown paths get index.html.
    const index = readFileSync(resolve(webDist, "index.html"), "utf8");
    app.get("*", (c) => c.html(index));
  }

  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: app.fetch, port }, (info) => console.log(`Threadline listening on http://localhost:${info.port}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
