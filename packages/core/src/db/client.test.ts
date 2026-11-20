import { expect, test } from "vitest";
import { checkDatabaseRole, createDb, type Db } from "./client.js";
import { createTestDb } from "./testing.js";

test("createDb builds a Neon pool without connecting", async () => {
  const { db, close } = createDb("postgres://app_user:unused@127.0.0.1:1/threadline");
  expect(typeof db.transaction).toBe("function");
  await close();
});

test("checkDatabaseRole passes for app_user and names what is wrong otherwise", async () => {
  expect(await checkDatabaseRole(await createTestDb())).toEqual({ ok: true });
  const as = (row: Record<string, unknown>) => ({ execute: async () => ({ rows: [row] }) }) as unknown as Db;
  const fine = { role: "app_user", superuser: false, bypassrls: false, owned: 0 };
  expect(await checkDatabaseRole(as({ ...fine, superuser: true }))).toEqual({ ok: false, reason: "database role app_user is a superuser" });
  expect(await checkDatabaseRole(as({ ...fine, bypassrls: true }))).toEqual({ ok: false, reason: "database role app_user has BYPASSRLS" });
  expect(await checkDatabaseRole(as({ ...fine, owned: 3 }))).toEqual({ ok: false, reason: "database role app_user owns 3 tables in public" });
});
