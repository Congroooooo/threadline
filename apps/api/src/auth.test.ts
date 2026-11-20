import { afterEach, describe, expect, test, vi } from "vitest";
import { fakeFetch, harness, json, ORIGIN } from "./test/helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Cookie name=value pairs from a response's Set-Cookie headers. */
function cookies(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const i = pair!.indexOf("=");
    out[pair!.slice(0, i)] = pair!.slice(i + 1);
  }
  return out;
}

/** Failed sign-ins send the browser back to the app with ?signin=failed and no session. */
function expectFailedSignIn(res: Response): void {
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(`${ORIGIN}/?signin=failed`);
  expect(res.headers.getSetCookie().some((c) => c.startsWith("tl_session=") && !c.startsWith("tl_session=;"))).toBe(false);
}

function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

/** A provider that issues token "gho_test" for code "good" and serves `profile` for it. */
function provider(profile: Record<string, unknown>) {
  return fakeFetch(async (url, init) => {
    if (url.endsWith("/login/oauth/access_token") || url.endsWith("/oauth/token")) {
      return Response.json({ access_token: "access-test", token_type: "bearer", scope: "" });
    }
    if (url === "https://api.github.com/user" || url.endsWith("/api/v4/user")) {
      const auth = new Headers(init?.headers).get("authorization");
      if (auth !== "Bearer access-test") return new Response("unauthorized", { status: 401 });
      return Response.json(profile);
    }
    return new Response("not found", { status: 404 });
  });
}

async function start(h: Awaited<ReturnType<typeof harness>>, name = "github") {
  const res = await h.app.request(`/auth/${name}/start`);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location")!);
  return { res, location, jar: cookies(res) };
}

describe("OAuth sign-in", () => {
  test("start redirects to the provider with state and a PKCE challenge in short-lived HttpOnly cookies", async () => {
    const h = await harness();
    const { res, location } = await start(h);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("gh-client");
    expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/github/callback`);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const state = location.searchParams.get("state")!;
    expect(state.length).toBeGreaterThanOrEqual(20);
    const set = res.headers.getSetCookie().join("\n");
    expect(set).toContain(`tl_oauth_state=${state}`);
    expect(set).toMatch(/tl_oauth_state=[^\n]*HttpOnly/);
    expect(set).toMatch(/tl_oauth_state=[^\n]*Secure/);
    expect(set).toMatch(/tl_oauth_state=[^\n]*Max-Age=600/);
    expect(set).toMatch(/tl_oauth_verifier=[^\n]*HttpOnly/);
  });

  test("the OAuth callback rejects a state value that does not match the cookie", async () => {
    const h = await harness();
    const { jar } = await start(h);
    const res = await h.app.request("/auth/github/callback?code=good&state=forged-state-value", {
      headers: { cookie: cookieHeader(jar) },
    });
    expectFailedSignIn(res);
    // No cookie at all is refused the same way.
    expectFailedSignIn(await h.app.request("/auth/github/callback?code=good&state=x"));
  });

  test("a provider error (the person declined) redirects back without a session", async () => {
    const h = await harness();
    const { location, jar } = await start(h);
    const state = location.searchParams.get("state")!;
    const res = await h.app.request(`/auth/github/callback?error=access_denied&state=${state}`, {
      headers: { cookie: cookieHeader(jar) },
    });
    expectFailedSignIn(res);
  });

  test("a GitHub callback with a valid state signs the person in with the numeric id and stores the login", async () => {
    const f = provider({ id: 4242, login: "Octo-Dana", name: null, email: "dana@example.com" });
    vi.stubGlobal("fetch", f); // arctic's token request uses the global fetch
    const h = await harness({}, { fetchImpl: f });
    const { location, jar } = await start(h);
    const state = location.searchParams.get("state")!;
    const res = await h.app.request(`/auth/github/callback?code=good&state=${state}`, { headers: { cookie: cookieHeader(jar) } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/`);
    const set = res.headers.getSetCookie().find((c) => c.startsWith("tl_session="))!;
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/Secure/);
    expect(set).toMatch(/SameSite=Lax/);
    expect(set).toMatch(/Path=\//);
    const token = cookies(res).tl_session!;

    // The token exchange sent the PKCE verifier from the cookie.
    const exchange = f.calls.find((c) => c.url.endsWith("/login/oauth/access_token"))!;
    expect(new URLSearchParams(exchange.body).get("code_verifier")).toBe(jar.tl_oauth_verifier);

    const me = await json(h.call("GET", "/api/me", `tl_session=${token}`), 200);
    // display name = name || login
    expect(me.user).toMatchObject({ displayName: "Octo-Dana", identities: [{ provider: "github", login: "Octo-Dana" }] });

    // Signing in again maps to the same user.
    const again = await start(h);
    const res2 = await h.app.request(`/auth/github/callback?code=good&state=${again.location.searchParams.get("state")}`, {
      headers: { cookie: cookieHeader(again.jar) },
    });
    const me2 = await json(h.call("GET", "/api/me", `tl_session=${cookies(res2).tl_session}`), 200);
    expect(me2.user.id).toBe(me.user.id);
  });

  test("GitLab uses GITLAB_BASE_URL and the profile's name", async () => {
    const f = provider({ id: 77, username: "sam", name: "Sam Lee" });
    vi.stubGlobal("fetch", f);
    const h = await harness(
      { GITLAB_CLIENT_ID: "gl-client", GITLAB_CLIENT_SECRET: "gl-secret", GITLAB_BASE_URL: "https://gitlab.example.com" },
      { fetchImpl: f },
    );
    const { location, jar } = await start(h, "gitlab");
    expect(location.origin + location.pathname).toBe("https://gitlab.example.com/oauth/authorize");
    const res = await h.app.request(`/auth/gitlab/callback?code=good&state=${location.searchParams.get("state")}`, {
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.status).toBe(302);
    expect(f.calls.map((c) => c.url)).toContain("https://gitlab.example.com/api/v4/user");
    const me = await json(h.call("GET", "/api/me", `tl_session=${cookies(res).tl_session}`), 200);
    expect(me.user).toMatchObject({ displayName: "Sam Lee", identities: [{ provider: "gitlab", login: "sam" }] });
  });

  test("a provider without client credentials is not offered; a failed exchange signs nobody in", async () => {
    const h = await harness();
    expect((await h.app.request("/auth/gitlab/start")).status).toBe(404);
    expect((await h.app.request("/auth/bitbucket/start")).status).toBe(404);
    expect((await h.app.request("/auth/local", { method: "POST", headers: { origin: ORIGIN } })).status).toBe(404);

    vi.stubGlobal("fetch", fakeFetch(() => Response.json({ error: "bad_verification_code" })));
    const { location, jar } = await start(h);
    const res = await h.app.request(`/auth/github/callback?code=bad&state=${location.searchParams.get("state")}`, {
      headers: { cookie: cookieHeader(jar) },
    });
    expectFailedSignIn(res);
  });

  test("an unreachable provider or unreadable profile also redirects back", async () => {
    vi.stubGlobal("fetch", fakeFetch(() => Promise.reject(new TypeError("network down"))));
    const h = await harness({}, { fetchImpl: fakeFetch(() => new Response("nope", { status: 500 })) });
    const finish = async () => {
      const { location, jar } = await start(h);
      return h.app.request(`/auth/github/callback?code=good&state=${location.searchParams.get("state")}`, {
        headers: { cookie: cookieHeader(jar) },
      });
    };
    expectFailedSignIn(await finish());
    vi.stubGlobal("fetch", provider({ id: 1, login: "x" }));
    expectFailedSignIn(await finish()); // the token works, the profile request fails
  });
});

describe("local mode", () => {
  test("POST /auth/local signs in the single local user, without Secure on http://localhost", async () => {
    const h = await harness({ AUTH_MODE: "local", PUBLIC_URL: "http://localhost:8787" });
    const signIn = () => h.app.request("/auth/local", { method: "POST", headers: { origin: "http://localhost:8787" } });
    const res = await signIn();
    expect(res.status).toBe(200);
    const set = res.headers.getSetCookie().find((c) => c.startsWith("tl_session="))!;
    expect(set).not.toMatch(/Secure/);
    const token = cookies(res).tl_session!;
    const me = await json(h.app.request("/api/me", { headers: { cookie: `tl_session=${token}` } }), 200);
    expect(me.user.identities).toEqual([{ provider: "local", login: "local" }]);
    const again = await json(h.app.request("/api/me", { headers: { cookie: `tl_session=${cookies(await signIn()).tl_session}` } }), 200);
    expect(again.user.id).toBe(me.user.id);
    // Cross-site sign-in is refused, and OAuth is off.
    expect((await h.app.request("/auth/local", { method: "POST", headers: { origin: "https://evil.test" } })).status).toBe(403);
    expect((await h.app.request("/auth/github/start")).status).toBe(404);
  });
});
