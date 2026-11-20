import { type Quoted, ValidationError } from "./types.js";

export const MAX_TEXT = 10_000;

const REDACTED = "[REDACTED]";

const TOKEN_PATTERNS: RegExp[] = [
  // PEM private keys, including a block cut off before its END line (redact to end of text).
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$(?![\s\S]))/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AKIA[A-Z0-9]{16}/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /xox[baprs]-[A-Za-z0-9-]+/g,
  // Anthropic (sk-ant-...) and OpenAI-style (sk-..., sk-proj-...) API keys.
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /https?:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]+/gi,
];

/** scheme://user:password@host — keep everything but the password. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:)([^\s@/]+)@/gi;

/** `Authorization: Bearer <opaque>` — any token shape, as long as it looks like one (8+ chars, has a digit). */
const BEARER = /\b(Bearer\s+)(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{8,}=*/gi;

/**
 * key=value, key: value, "key": "value" and 'key': 'value' where the key name contains a
 * secret-ish word (client_secret, private_key, access_token, DB_PASSWORD, ...). Password keys
 * and URL query parameters (?token=...) redact any value; other keys only redact a value that
 * looks like a secret (8+ chars, no spaces), so prose such as "token: expired" is left alone.
 */
const SECRET_KEY = String.raw`[A-Za-z0-9_-]*?(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key)[A-Za-z0-9_-]*`;
const KEY_VALUE = new RegExp(String.raw`(["']?)\b(${SECRET_KEY})\1(\s*[=:]\s*)(["']?)([^\s"',;}&]+)`, "gi");

function redactKeyValue(
  match: string, q1: string, key: string, sep: string, q2: string, value: string, offset: number, whole: string,
): string {
  const isPassword = /pass(?:word|wd)/i.test(key);
  const isQueryParam = q1 === "" && (whole[offset - 1] === "?" || whole[offset - 1] === "&");
  if (!isPassword && !isQueryParam && value.length < 8) return match;
  return `${q1}${key}${q1}${sep}${q2}${REDACTED}`;
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
