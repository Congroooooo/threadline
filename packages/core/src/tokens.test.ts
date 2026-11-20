import { describe, expect, test } from "vitest";
import { hashSecret, randomSecret, secretPattern } from "./tokens.js";

describe("secrets", () => {
  test("hashSecret is SHA-256 hex", async () => {
    expect(await hashSecret("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("random secrets have the documented shape and do not repeat", () => {
    const agent = randomSecret("tl_", 32);
    const invite = randomSecret("tli_", 24);
    expect(agent).toMatch(/^tl_[A-Za-z0-9_-]{43}$/);
    expect(invite).toMatch(/^tli_[A-Za-z0-9_-]{32}$/);
    expect(secretPattern("tl_", 32).test(agent)).toBe(true);
    expect(secretPattern("tli_", 24).test(invite)).toBe(true);
    expect(new Set(Array.from({ length: 100 }, () => randomSecret("", 32))).size).toBe(100);
  });
});
