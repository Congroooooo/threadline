// Cloudflare Workers entry. Env holds the vars and secrets (see .dev.vars.example).
import type { Hono } from "hono";
import { type AppEnv, createApp } from "./app.js";
import type { Env } from "./env.js";

let cached: { env: Env; app: Hono<AppEnv> } | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    // One app per isolate and environment; databases are still opened per request.
    if (cached?.env !== env) cached = { env, app: createApp(env) };
    return cached.app.fetch(request, env, ctx);
  },
};
