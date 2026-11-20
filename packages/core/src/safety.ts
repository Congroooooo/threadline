import { type Quoted, ValidationError } from "./types.js";

export const MAX_TEXT = 10_000;

const REDACTED = "[REDACTED]";

const TOKEN_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AKIA[A-Z0-9]{16}/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /xox[baprs]-[A-Za-z0-9-]+/g,
];

const KEY_VALUE = /(password|passwd|secret|token|api[_-]?key)(\s*[=:]\s*)\S+/gi;

export function capText(text: string, field: string): string {
  if (text.length > MAX_TEXT) {
    throw new ValidationError(`${field} exceeds ${MAX_TEXT} characters`);
  }
  return text;
}

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  return out.replace(KEY_VALUE, `$1$2${REDACTED}`);
}

export function cleanText(text: string, field: string): string {
  return redactSecrets(capText(text, field));
}

export function quote(text: string, source: string): Quoted {
  return { untrusted: true, source, text };
}
