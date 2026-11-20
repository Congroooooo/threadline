// Sign-in providers: GitHub and GitLab through arctic's OAuth 2.0 client with PKCE (S256).
// Only providers whose client id and secret are both set are offered.
import { CodeChallengeMethod, OAuth2Client } from "arctic";
import { z } from "zod";
import type { Config } from "./env.js";

export type ProviderName = "github" | "gitlab";

export type Profile = { id: string; login: string; displayName: string; email?: string };

export type OAuthProvider = {
  name: ProviderName;
  client: OAuth2Client;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Reads the signed-in account with the access token. Throws on any failure. */
  profile(accessToken: string, fetchImpl: typeof fetch): Promise<Profile>;
};

const githubUser = z.object({
  id: z.number().int().nonnegative(),
  login: z.string().min(1).max(100),
  name: z.string().max(200).nullish(),
  email: z.string().max(320).nullish(),
});

const gitlabUser = z.object({
  id: z.number().int().nonnegative(),
  username: z.string().min(1).max(255),
  name: z.string().max(255).nullish(),
  email: z.string().max(320).nullish(),
});

async function getJson(fetchImpl: typeof fetch, url: string, accessToken: string, headers: Record<string, string> = {}) {
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "User-Agent": "Threadline", ...headers },
    redirect: "manual",
  });
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`profile request failed with status ${res.status}`);
  }
  return res.json();
}

function profileOf(id: number, login: string, name: string | null | undefined, email: string | null | undefined): Profile {
  return {
    id: String(id),
    login,
    displayName: name?.trim() || login,
    ...(email ? { email } : {}),
  };
}

export function oauthProvider(config: Config, name: string): OAuthProvider | null {
  if (config.authMode !== "oauth") return null;
  const redirect = `${config.publicUrl}/auth/${name}/callback`;
  if (name === "github" && config.github) {
    const { clientId, clientSecret } = config.github;
    return {
      name,
      client: new OAuth2Client(clientId, clientSecret, redirect),
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: [],
      async profile(accessToken, fetchImpl) {
        const u = githubUser.parse(
          await getJson(fetchImpl, "https://api.github.com/user", accessToken, { Accept: "application/vnd.github+json" }),
        );
        return profileOf(u.id, u.login, u.name, u.email);
      },
    };
  }
  if (name === "gitlab" && config.gitlab) {
    const { clientId, clientSecret, baseUrl } = config.gitlab;
    return {
      name,
      client: new OAuth2Client(clientId, clientSecret, redirect),
      authorizeUrl: `${baseUrl}/oauth/authorize`,
      tokenUrl: `${baseUrl}/oauth/token`,
      scopes: ["read_user"],
      async profile(accessToken, fetchImpl) {
        const u = gitlabUser.parse(await getJson(fetchImpl, `${baseUrl}/api/v4/user`, accessToken));
        return profileOf(u.id, u.username, u.name, u.email);
      },
    };
  }
  return null;
}

export function authorizationUrl(p: OAuthProvider, state: string, codeVerifier: string): URL {
  return p.client.createAuthorizationURLWithPKCE(p.authorizeUrl, state, CodeChallengeMethod.S256, codeVerifier, p.scopes);
}
