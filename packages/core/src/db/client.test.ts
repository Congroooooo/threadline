import { expect, test } from "vitest";
import { createDb } from "./client.js";

test("createDb builds a Neon pool without connecting", async () => {
  const { db, close } = createDb("postgres://app_user:unused@127.0.0.1:1/threadline");
  expect(typeof db.transaction).toBe("function");
  await close();
});
