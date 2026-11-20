// @vitest-environment node
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// public/_headers is copied into dist, and Workers static assets apply it to every static
// response (the API sets the same headers on its own responses).
test("static responses carry the security headers", () => {
  const text = readFileSync(fileURLToPath(new URL("../public/_headers", import.meta.url)), "utf8");
  const [path, ...rules] = text.trim().split("\n");
  expect(path).toBe("/*");
  expect(rules.map((r) => r.trim())).toEqual([
    "X-Frame-Options: DENY",
    "Content-Security-Policy: frame-ancestors 'none'",
    "X-Content-Type-Options: nosniff",
    "Referrer-Policy: strict-origin-when-cross-origin",
  ]);
});
