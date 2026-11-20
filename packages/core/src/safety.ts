import { type Quoted, ValidationError } from "./types.js";

export const MAX_TEXT = 10_000;

const REDACTED = "[REDACTED]";

// Every pattern here must run in linear time on hostile input (cleanText runs on all free
// text). Rules kept throughout: a pattern may only start at the beginning of a run of its
// own characters (a negative lookbehind), so two starts never rescan the same run, and no
// two adjacent quantifiers can match the same characters. safety.test.ts times this.

const TOKEN_PATTERNS: RegExp[] = [
  // PEM private keys, including a block cut off before its END line (redact to end of text).
  /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$(?![\s\S]))/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AKIA[A-Z0-9]{16}/g,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /xox[baprs]-[A-Za-z0-9-]+/g,
  /https?:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]+/gi,
];

/**
 * Anthropic (sk-ant-api03-...) and OpenAI-style (sk-..., sk-proj-...) API keys. The callback
 * keeps word-like names such as sk-learn-compatible-models-v2: a key has a digit and either a
 * long dash-free stretch (16+) or a long body (40+).
 */
const SK_KEY = /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g;

function redactSkKey(match: string): string {
  const body = match.slice(3);
  if (!/\d/.test(body)) return match;
  const longest = Math.max(...body.split("-").map((s) => s.length));
  return longest >= 16 || body.length >= 40 ? REDACTED : match;
}

/** scheme://user:password@host — keep everything but the password. */
const URL_CREDENTIALS = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:)([^\s@/]+)@/gi;

/** `Authorization: Bearer <opaque>` — any token shape, as long as it looks like one (8+ chars, has a digit). */
const BEARER = /\b(Bearer\s+)(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{8,}=*/gi;

/**
 * key=value, key: value, "key": "value" and 'key': 'value'. The identifier is matched once
 * (from the start of its run, at most 64 characters) and redactKeyValue decides whether it
 * names a secret. The value stops at whitespace, quotes, & @ / , ; }.
 */
const KEY_VALUE = /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{1,64})(["']?)(\s*[=:]\s*)(["']?)([^\s"'&@/,;}]+)/g;

/** Last part of a key name that makes it a secret (DB_PASSWORD, client_secret, GITHUB_TOKEN). */
const SECRET_LAST = new Set(["password", "passwd", "secret", "token", "apikey"]);
/** Last two parts that make it a secret (API_KEY, private_key, secret_key). */
const SECRET_LAST_TWO = new Set(["api_key", "private_key", "secret_key", "access_key"]);

/**
 * Whether a key names a secret: its last part (split on _, - and camelCase) is one of the
 * secret words. Words that merely contain one (tokens, Passwords, Tokenizer, token_count) are
 * prose. Returns "password" for password keys, which redact any value.
 */
function secretKind(key: string): "password" | "secret" | null {
  const parts = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[_-]+/).filter((p) => p !== "");
  const last = parts[parts.length - 1] ?? "";
  if (last === "password" || last === "passwd") return "password";
  if (SECRET_LAST.has(last) || SECRET_LAST_TWO.has(parts.slice(-2).join("_"))) return "secret";
  return null;
}

function redactKeyValue(
  match: string, key: string, q1: string, sep: string, q2: string, value: string, offset: number, whole: string,
): string {
  const kind = secretKind(key);
  if (kind === null) return match;
  // Password keys and URL query parameters (?token=...) redact any value; other keys only a
  // value that looks like a secret (8+ chars), so prose such as "token: expired" is kept.
  const isQueryParam = q1 === "" && (whole[offset - 1] === "?" || whole[offset - 1] === "&");
  if (kind !== "password" && !isQueryParam && value.length < 8) return match;
  return `${key}${q1}${sep}${q2}${REDACTED}`;
}

export function capText(text: string, field: string): string {
  if (text.length > MAX_TEXT) {
    throw new ValidationError(`${field} exceeds ${MAX_TEXT} characters`);
  }
  return text;
}

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(SK_KEY, redactSkKey);
  out = out.replace(URL_CREDENTIALS, `$1${REDACTED}@`);
  out = out.replace(BEARER, `$1${REDACTED}`);
  return out.replace(KEY_VALUE, redactKeyValue);
}

export function cleanText(text: string, field: string): string {
  return redactSecrets(capText(text, field));
}

export function quote(text: string, source: string): Quoted {
  return { untrusted: true, source, text };
}

/**
 * Parses an absolute http(s) URL strictly and returns its normalised form, or throws
 * ValidationError. Rejects backslashes, whitespace, embedded credentials and anything over
 * `maxLength`. Plain http is allowed only when `allowHttp` is "any", or "local" and the host
 * is the local machine.
 */
export function parseHttpUrl(raw: unknown, field: string, opts: { maxLength: number; allowHttp: "any" | "local" }): string {
  const bad = () =>
    new ValidationError(`${field} must be an absolute ${opts.allowHttp === "any" ? "http(s)" : "https"} URL`);
  if (typeof raw !== "string" || raw.length > opts.maxLength) throw bad();
  if (raw.includes("\\") || /\s/.test(raw)) throw bad();
  let u: InstanceType<typeof URL>;
  try {
    u = new URL(raw);
  } catch {
    throw bad();
  }
  if (u.username !== "" || u.password !== "") throw bad();
  const httpOk = opts.allowHttp === "any" || ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (!(u.protocol === "https:" || (u.protocol === "http:" && httpOk))) throw bad();
  if (u.href.length > opts.maxLength) throw bad();
  return u.href;
}
