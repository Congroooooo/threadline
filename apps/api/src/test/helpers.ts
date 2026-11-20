// Shared setup for the API tests: an app over a fresh PGlite database, signed-in people and
// a fake fetch that records every outgoing request instead of touching the network.
import { createSession, type Db, findOrCreateUser } from "@threadline/core";
import { createTestDb } from "@threadline/core/testing";
import { type AppDeps, createApp } from "../app.js";
import type { Env } from "../env.js";

export const ORIGIN = "https://threadline.test";

export const baseEnv: Env = {
  DATABASE_URL: "postgres://unused.invalid/threadline",
  PUBLIC_URL: ORIGIN,
  AUTH_MODE: "oauth",
  GITHUB_CLIENT_ID: "gh-client",
  GITHUB_CLIENT_SECRET: "gh-secret",
};

export type FakeFetch = typeof fetch & { calls: { url: string; init: RequestInit | undefined; body: string }[] };

/** Answers every request with `respond(url)` (default: 200 "ok") and records it. */
export function fakeFetch(respond: (url: string, init?: RequestInit) => Response | Promise<Response> = () => new Response("ok")): FakeFetch {
  const calls: FakeFetch["calls"] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const body = req.body ? await req.clone().text() : "";
    calls.push({ url: req.url, init, body });
    return respond(req.url, init);
  }) as FakeFetch;
  f.calls = calls;
  return f;
}

export type Harness = {
  db: Db;
  app: ReturnType<typeof createApp>;
  fetch: FakeFetch;
  /** Signs a person in (as github:<login>) and returns their cookie header value. */
  signIn(name: string, login?: string): Promise<string>;
  /** A JSON request; `auth` is a cookie (sent with the right Origin) or a `tl_` token. */
  call(method: string, path: string, auth?: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
};

export async function harness(env: Partial<Env> = {}, deps: AppDeps = {}): Promise<Harness> {
  const db = await createTestDb();
  const fetch = fakeFetch();
  const app = createApp({ ...baseEnv, ...env }, { db, fetchImpl: fetch, ...deps });
  let n = 0;
  return {
    db,
    app,
    fetch,
    async signIn(name, login = name.toLowerCase()) {
      const userId = await findOrCreateUser(db, { provider: "github", providerUserId: String(1000 + ++n), displayName: name, login });
      const { token } = await createSession(db, userId);
      return `tl_session=${token}`;
    },
    call(method, path, auth, body, headers = {}) {
      const h: Record<string, string> = { ...headers };
      if (auth?.startsWith("tl_session=")) {
        h.cookie = auth;
        h.origin ??= ORIGIN;
      } else if (auth) {
        h.authorization = `Bearer ${auth}`;
      }
      if (body !== undefined) h["content-type"] = "application/json";
      return Promise.resolve(app.request(path, { method, headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
    },
  };
}

/** The parsed JSON body, failing loudly with the body text when the status is unexpected. */
export async function json<T = any>(res: Response | Promise<Response>, status: number): Promise<T> {
  const r = await res;
  const text = await r.text();
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${text}`);
  return (text === "" ? undefined : JSON.parse(text)) as T;
}
