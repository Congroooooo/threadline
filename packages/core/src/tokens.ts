// Random secrets (session tokens, agent tokens, invite codes) and their stored form.
// Web Crypto only, so this runs on Workers and Node. Secrets are never stored: only the
// SHA-256 hex of the full string, and lookups compare hashes, never plaintext.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Unpadded base64url. */
function base64url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let c = 0; c < chars; c++) out += ALPHABET[(n >> (18 - 6 * c)) & 63];
  }
  return out;
}

/** `prefix` followed by `byteCount` random bytes as unpadded base64url. */
export function randomSecret(prefix: string, byteCount: number): string {
  return prefix + base64url(crypto.getRandomValues(new Uint8Array(byteCount)));
}

/** SHA-256 hex of an ASCII secret. Callers check the format first (see `secretPattern`). */
export async function hashSecret(secret: string): Promise<string> {
  const bytes = new Uint8Array(secret.length);
  for (let i = 0; i < secret.length; i++) bytes[i] = secret.charCodeAt(i) & 0xff;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** Exact shape of a secret made by `randomSecret(prefix, byteCount)`. */
export function secretPattern(prefix: string, byteCount: number): RegExp {
  return new RegExp(`^${prefix}[A-Za-z0-9_-]{${Math.ceil((byteCount * 8) / 6)}}$`);
}

export const SESSION_BYTES = 32;
export const AGENT_TOKEN_PREFIX = "tl_";
export const AGENT_TOKEN_BYTES = 32;
export const INVITE_CODE_PREFIX = "tli_";
export const INVITE_CODE_BYTES = 24;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
