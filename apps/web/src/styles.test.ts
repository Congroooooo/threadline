// @vitest-environment node
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// Read from disk: under vitest a `?raw` CSS import is emptied by the CSS handling.
const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

/** The hex value of the first `--name` declaration in `block`. */
function token(block: string, name: string): string {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
  if (!m) throw new Error(`--${name} not found`);
  return m[1]!;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const light = css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme: dark)"));
const dark = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));

test("the focus ring has at least 3:1 contrast on every background, in both themes", () => {
  for (const theme of [light, dark]) {
    const focus = token(theme, "focus");
    for (const bg of ["bg", "surface", "surface-2"]) {
      expect(contrast(focus, token(theme, bg)), `${focus} on --${bg}`).toBeGreaterThanOrEqual(3);
    }
  }
});

test("blocker cards have no coloured side stripe", () => {
  const rules = css.match(/\.item-blocker[^{]*\{[^}]*\}/g) ?? [];
  expect(rules.length).toBeGreaterThan(0);
  for (const rule of rules) expect(rule).not.toMatch(/border-left/);
});
