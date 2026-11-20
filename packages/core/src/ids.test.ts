import { expect, test } from "vitest";
import { newId } from "./ids.js";

test("newId returns sortable v7 uuids", () => {
  const a = newId();
  const b = newId();
  expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(a < b).toBe(true);
});

test("newId sorts across a burst in one millisecond", () => {
  const ids = Array.from({ length: 1000 }, () => newId());
  expect([...ids].sort()).toEqual(ids);
});
