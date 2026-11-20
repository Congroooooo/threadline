// Sign-in and sign-out: OAuth (GitHub, GitLab) or, on localhost only, a single local user.
import { createSession, endSession, findOrCreateUser } from "@threadline/core";
import { ArcticFetchError, generateCodeVerifier, generateState, UnexpectedResponseError } from "arctic";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import type { Config } from "../env.js";
import { type AppEnv, type Ctx, fail, originCheck, SESSION_COOKIE } from "../middleware.js";
import { authorizationUrl, oauthProvider } from "../oauth.js";
import { oauthCallbackQuerySchema } from "../schemas.js";

const STATE_COOKIE = "tl_oauth_state";
const VERIFIER_COOKIE = "tl_oauth_verifier";
const OAUTH_COOKIE_SECONDS = 600;

function base(config: Config, path: string): CookieOptions {
  return { httpOnly: true, secure: config.secureCookies, sameSite: "Lax", path };
}

async function startSession(c: Ctx, userId: string): Promise<void> {
  const { token, expiresAt } = await createSession(c.var.db, userId);
  setCookie(c, SESSION_COOKIE, token, {
    ...base(c.var.config, "/"),
    expires: expiresAt,
    maxAge: Math.floor((expiresAt.getTime() - Date.now()) / 1000),
  });
}

export function authRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/:provider/start", (c) => {
    const provider = oauthProvider(c.var.config, c.req.param("provider"));
    if (!provider) throw fail(404, "sign-in provider not available");
    const state = generateState();
    const verifier = generateCodeVerifier();
    // Scoped to this provider's callback path, so one provider's flow cannot finish another's.
    const opts = { ...base(c.var.config, `/auth/${provider.name}`), maxAge: OAUTH_COOKIE_SECONDS };
    setCookie(c, STATE_COOKIE, state, opts);
    setCookie(c, VERIFIER_COOKIE, verifier, opts);
    return c.redirect(authorizationUrl(provider, state, verifier).toString(), 302);
  });

  app.get("/:provider/callback", async (c) => {
    const provider = oauthProvider(c.var.config, c.req.param("provider"));
    if (!provider) throw fail(404, "sign-in provider not available");
    const expectedState = getCookie(c, STATE_COOKIE);
    const verifier = getCookie(c, VERIFIER_COOKIE);
    const cookiePath = { ...base(c.var.config, `/auth/${provider.name}`) };
    deleteCookie(c, STATE_COOKIE, cookiePath);
    deleteCookie(c, VERIFIER_COOKIE, cookiePath);
    // Every failure sends the browser back to the app, which shows a sign-in error; the
    // reason is logged, never put in the URL.
    const failed = (reason: string, err?: unknown) => {
      if (err === undefined) console.warn(`oauth sign-in failed: ${reason}`);
      else console.error(`oauth sign-in failed: ${reason}`, err);
      return c.redirect(`${c.var.config.publicUrl}/?signin=failed`, 302);
    };
    const parsed = oauthCallbackQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return failed(c.req.query("error") ? "the provider returned an error" : "malformed callback");
    if (!expectedState || !verifier || parsed.data.state !== expectedState) return failed("state mismatch");

    let accessToken: string;
    try {
      // GitHub reports errors in a 200 response, which the generic client returns as tokens
      // without an access_token: accessToken() then throws, and that is a refusal too.
      accessToken = (await provider.client.validateAuthorizationCode(provider.tokenUrl, parsed.data.code, verifier)).accessToken();
    } catch (err) {
      if (err instanceof ArcticFetchError || err instanceof UnexpectedResponseError) return failed("token exchange failed", err);
      return failed("the provider refused the code");
    }
    let profile;
    try {
      profile = await provider.profile(accessToken, c.var.fetchImpl);
    } catch (err) {
      return failed("profile request failed", err);
    }
    const userId = await findOrCreateUser(c.var.db, {
      provider: provider.name,
      providerUserId: profile.id,
      displayName: profile.displayName,
      login: profile.login,
      ...(profile.email ? { email: profile.email } : {}),
    });
    await startSession(c, userId);
    return c.redirect(`${c.var.config.publicUrl}/`, 302);
  });

  // Local development only: loadConfig refuses AUTH_MODE=local unless PUBLIC_URL is localhost.
  app.post("/local", originCheck(true), async (c) => {
    if (c.var.config.authMode !== "local") throw fail(404, "local sign-in is not enabled");
    const userId = await findOrCreateUser(c.var.db, {
      provider: "local",
      providerUserId: "local",
      displayName: "Local user",
      login: "local",
    });
    await startSession(c, userId);
    return c.json({ ok: true });
  });

  app.post("/sign-out", originCheck(), async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await endSession(c.var.db, token);
    deleteCookie(c, SESSION_COOKIE, base(c.var.config, "/"));
    return c.json({ ok: true });
  });

  return app;
}
