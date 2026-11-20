// Request plumbing shared by every route: the per-request database, deferred work, who is
// calling (session cookie or agent token), the Origin check, the workspace actor, request
// parsing and the error-to-status mapping.
import {
  type Actor,
  createDb,
  type Db,
  listMemberships,
  resolveAgentToken,
  resolveSession,
  type Tx,
  withWorkspace,
} from "@threadline/core";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import type { Config } from "./env.js";

export const SESSION_COOKIE = "tl_session";

export type AppDeps = {
  /** A shared database (tests, Node). Without it each request opens and closes its own. */
  db?: Db;
  /** Outgoing HTTP for chat webhooks and OAuth profile lookups. */
  fetchImpl?: typeof fetch;
  /** Runs work after the response; by default waitUntil on Workers, awaited on Node. */
  defer?: (work: Promise<unknown>) => void;
};

export type Principal =
  | { kind: "user"; userId: string }
  | { kind: "agent"; actor: Actor & { kind: "agent" } };

export type AppEnv = {
  Variables: {
    config: Config;
    db: Db;
    fetchImpl: typeof fetch;
    defer: (work: Promise<unknown>) => void;
    principal: Principal;
    /** The caller in the path's workspace (set under /api/w/:workspaceId). */
    actor: Actor;
  };
};

export type Ctx = Context<AppEnv>;

// ---------------------------------------------------------------------------------------
// Errors

export const fail = (status: ContentfulStatusCode, message: string) => new HTTPException(status, { message });

const STATUS_BY_NAME: Record<string, ContentfulStatusCode> = {
  ValidationError: 400,
  ForbiddenError: 403,
  NotFoundError: 404,
};

/** Maps core's errors by name; anything unexpected is a bare 500 that leaks nothing. */
export function errorResponse(err: unknown, c: Context): Response {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status as ContentfulStatusCode);
  const name = (err as { name?: unknown } | null)?.name;
  const status = typeof name === "string" ? STATUS_BY_NAME[name] : undefined;
  if (status !== undefined) return c.json({ error: (err as Error).message }, status);
  console.error("unhandled error", err);
  return c.json({ error: "internal error" }, 500);
}

// ---------------------------------------------------------------------------------------
// Response hardening

/** Sent on every API response; apps/web/public/_headers sets the same on the static app. */
export const SECURITY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  const apply = () => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!c.res.headers.has(name)) c.res.headers.set(name, value);
    }
  };
  try {
    apply();
  } catch {
    // Immutable headers (a response passed through from fetch): copy it first.
    c.res = new Response(c.res.body, c.res);
    apply();
  }
};

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

/**
 * Local mode signs anyone in without a password, so it must only answer the local machine.
 * Refuses (403) any request whose Host header is not localhost, 127.0.0.1 or [::1] (any port),
 * which also stops DNS-rebinding pages from reaching the API through a browser.
 */
export function localHostOnly(config: Config): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (config.authMode === "local") {
      const host = c.req.header("host") ?? new URL(c.req.url).host;
      if (!LOCAL_HOST.test(host)) return c.json({ error: "local mode only answers requests to localhost" }, 403);
    }
    await next();
  };
}

// ---------------------------------------------------------------------------------------
// Per-request resources

/**
 * Sets the database and the deferral helper. Without an injected database it creates one
 * per request (never sharing a Neon pool across Workers requests) and closes it once the
 * response and all deferred work are done: through waitUntil on Workers, awaited on Node.
 */
export function resources(config: Config, deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const pending: Promise<unknown>[] = [];
    let close: (() => Promise<void>) | undefined;
    let db = deps.db;
    if (!db) {
      const made = createDb(config.env.DATABASE_URL);
      db = made.db;
      close = made.close;
    }
    c.set("config", config);
    c.set("db", db);
    c.set("fetchImpl", deps.fetchImpl ?? ((...args) => fetch(...args)));
    c.set("defer", deps.defer ?? ((work) => void pending.push(work)));
    try {
      await next();
    } finally {
      const done = Promise.allSettled(pending)
        .then(() => close?.())
        .catch((err) => console.error("closing the database failed", err));
      let waitUntil: ((p: Promise<unknown>) => void) | undefined;
      try {
        const ctx = c.executionCtx;
        waitUntil = (p) => ctx.waitUntil(p);
      } catch {
        // No ExecutionContext: Node or app.request in tests.
      }
      if (waitUntil) waitUntil(done);
      else await done;
    }
  };
}

// ---------------------------------------------------------------------------------------
// Authentication

const BEARER = /^Bearer\s+(\S+)$/i;
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Cookie-authenticated state changes must come from our own pages: the Origin header has
 * to equal PUBLIC_URL's origin. Bearer requests are exempt (browsers cannot attach them
 * cross-site). `always` also covers requests without a session cookie (signing in).
 */
export function originCheck(always = false): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (UNSAFE.has(c.req.method) && !c.req.header("authorization")) {
      const hasSession = getCookie(c, SESSION_COOKIE) !== undefined;
      if ((always || hasSession) && c.req.header("origin") !== c.var.config.publicOrigin) {
        throw fail(403, "cross-origin request refused");
      }
    }
    await next();
  };
}

/**
 * Resolves the caller. An Authorization header must be `Bearer tl_…` and wins over any
 * cookie sent with it; otherwise the `tl_session` cookie. Neither (or invalid): 401.
 */
export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("authorization");
  if (header !== undefined) {
    const token = BEARER.exec(header.trim())?.[1];
    const actor = token ? await resolveAgentToken(c.var.db, token) : null;
    if (!actor || actor.kind !== "agent") throw fail(401, "invalid or revoked agent token");
    c.set("principal", { kind: "agent", actor });
  } else {
    const token = getCookie(c, SESSION_COOKIE);
    const session = token ? await resolveSession(c.var.db, token) : null;
    if (!session) throw fail(401, "sign in required");
    c.set("principal", { kind: "user", userId: session.userId });
  }
  await next();
};

/**
 * Agents only (the MCP endpoint): an Authorization header `Bearer tl_…` that resolves to an
 * active agent token. Cookies are ignored. Anything else is 401 before the route runs.
 */
export const agentBearer: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = BEARER.exec(c.req.header("authorization")?.trim() ?? "")?.[1];
  const actor = token ? await resolveAgentToken(c.var.db, token) : null;
  if (!actor || actor.kind !== "agent") {
    return c.json({ error: "invalid or revoked agent token" }, 401, { "WWW-Authenticate": 'Bearer realm="threadline"' });
  }
  c.set("principal", { kind: "agent", actor });
  c.set("actor", actor);
  await next();
};

/** The signed-in person's user id; agents get 403 on routes meant for people. */
export function requireUser(c: Ctx): string {
  const p = c.var.principal;
  if (p.kind !== "user") throw fail(403, "this endpoint is for people signed in to the web app");
  return p.userId;
}

/** The calling agent; people get 403 on agent-only routes. */
export function requireAgent(c: Ctx): Actor & { kind: "agent" } {
  const p = c.var.principal;
  if (p.kind !== "agent") throw fail(403, "this endpoint needs an agent token");
  return p.actor;
}

/**
 * Under /api/w/:workspaceId: the caller as an actor of that workspace. People must be an
 * active member; agent tokens only work in their own workspace. Otherwise 403, the same
 * for a workspace that does not exist.
 */
export const workspaceActor: MiddlewareHandler<AppEnv> = async (c, next) => {
  const workspaceId = uuidParam(c, "workspaceId");
  const p = c.var.principal;
  if (p.kind === "agent") {
    if (p.actor.workspaceId !== workspaceId) throw fail(403, "this token belongs to another workspace");
    c.set("actor", p.actor);
  } else {
    const membership = (await listMemberships(c.var.db, p.userId)).find((m) => m.workspaceId === workspaceId);
    if (!membership) throw fail(403, "not a member of this workspace");
    c.set("actor", { kind: "member", workspaceId, memberId: membership.memberId });
  }
  await next();
};

/** Runs `fn` in a transaction scoped to the actor's workspace. */
export function inWorkspace<T>(c: Ctx, fn: (tx: Tx, actor: Actor) => Promise<T>): Promise<T> {
  const actor = c.var.actor;
  return withWorkspace(c.var.db, actor.workspaceId, (tx) => fn(tx, actor));
}

// ---------------------------------------------------------------------------------------
// Parsing

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path parameter that must be a UUID (400 otherwise, before core is called). */
export function uuidParam(c: Context, name: string): string {
  const value = c.req.param(name);
  if (typeof value !== "string" || !UUID.test(value)) throw fail(400, `${name} must be a UUID`);
  return value.toLowerCase();
}

function describe(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid request";
  const path = issue.path.map(String).join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** The JSON body parsed by `schema`; 400 when it is not JSON or does not match. */
export async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw fail(400, "request body must be JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw fail(400, describe(parsed.error));
  return parsed.data;
}

/** The query string parsed by `schema`; 400 when it does not match. */
export function query<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) throw fail(400, describe(parsed.error));
  return parsed.data;
}
