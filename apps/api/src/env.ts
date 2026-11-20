// Deployment configuration: the Env bindings (Workers vars and secrets, or process.env on
// Node) and the settings derived from them once, when the app is created.
import { parseHttpUrl } from "@threadline/core";

export type Env = {
  DATABASE_URL: string;
  PUBLIC_URL: string;
  AUTH_MODE: "oauth" | "local";
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITLAB_CLIENT_ID?: string;
  GITLAB_CLIENT_SECRET?: string;
  GITLAB_BASE_URL?: string;
  WORKSPACE_CREATORS?: string;
};

/** Every Env key, for .dev.vars.example and Node's process.env reader. */
export const ENV_KEYS = [
  "DATABASE_URL",
  "PUBLIC_URL",
  "AUTH_MODE",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITLAB_CLIENT_ID",
  "GITLAB_CLIENT_SECRET",
  "GITLAB_BASE_URL",
  "WORKSPACE_CREATORS",
] as const satisfies readonly (keyof Env)[];

export type OAuthCredentials = { clientId: string; clientSecret: string };

export type Config = {
  env: Env;
  /** PUBLIC_URL without a trailing slash, e.g. https://threadline.example.com */
  publicUrl: string;
  /** The origin browsers send in the Origin header for this deployment. */
  publicOrigin: string;
  /** Cookies carry Secure except on plain-http localhost (local development). */
  secureCookies: boolean;
  authMode: "oauth" | "local";
  github: OAuthCredentials | null;
  gitlab: (OAuthCredentials & { baseUrl: string }) | null;
  /** Lower-cased `provider:login` entries; null means anyone may create workspaces. */
  workspaceCreators: Set<string> | null;
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function credentials(id: string | undefined, secret: string | undefined): OAuthCredentials | null {
  const clientId = id?.trim();
  const clientSecret = secret?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** Validates the environment. Throws (refusing to start) on anything unsafe or malformed. */
export function loadConfig(env: Env): Config {
  if (typeof env.DATABASE_URL !== "string" || env.DATABASE_URL.trim() === "") throw new Error("DATABASE_URL is required");
  let url: URL;
  try {
    url = new URL(env.PUBLIC_URL);
  } catch {
    throw new Error("PUBLIC_URL must be an absolute URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("PUBLIC_URL must be http(s)");
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol === "http:" && !local) throw new Error("PUBLIC_URL must use https unless it is localhost");
  const authMode = env.AUTH_MODE ?? "oauth";
  if (authMode !== "oauth" && authMode !== "local") throw new Error('AUTH_MODE must be "oauth" or "local"');
  if (authMode === "local" && !local) {
    throw new Error("AUTH_MODE=local signs anyone in without a password; it is only allowed when PUBLIC_URL is localhost");
  }

  const gitlabCreds = credentials(env.GITLAB_CLIENT_ID, env.GITLAB_CLIENT_SECRET);
  const gitlabBase = parseHttpUrl(env.GITLAB_BASE_URL?.trim() || "https://gitlab.com", "GITLAB_BASE_URL", {
    maxLength: 500,
    allowHttp: "local",
  }).replace(/\/+$/, "");

  const creators = (env.WORKSPACE_CREATORS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "");
  for (const entry of creators) {
    if (!/^(github|gitlab|local):[^\s:]+$/.test(entry)) {
      throw new Error(`WORKSPACE_CREATORS entries look like github:<login> or gitlab:<username>, not "${entry}"`);
    }
  }

  return {
    env,
    publicUrl: url.origin + url.pathname.replace(/\/+$/, ""),
    publicOrigin: url.origin,
    secureCookies: !(url.protocol === "http:" && local),
    authMode,
    github: credentials(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET),
    gitlab: gitlabCreds ? { ...gitlabCreds, baseUrl: gitlabBase } : null,
    workspaceCreators: env.WORKSPACE_CREATORS?.trim() ? new Set(creators) : null,
  };
}
