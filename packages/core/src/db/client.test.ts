import { expect, test } from "vitest";
import { checkDatabaseRole, createDb, type Db } from "./client.js";
import { createTestDb, rawQuery } from "./testing.js";

test("createDb builds a Neon pool without connecting", async () => {
  const { db, close } = createDb("postgres://app_user:unused@127.0.0.1:1/threadline");
  expect(typeof db.transaction).toBe("function");
  await close();
});

test("checkDatabaseRole passes for app_user and names what is wrong otherwise", async () => {
  expect(await checkDatabaseRole(await createTestDb())).toEqual({ ok: true });
  const as = (row: Record<string, unknown>) => ({ execute: async () => ({ rows: [row] }) }) as unknown as Db;
  const fine = { role: "app_user", superuser: null, bypassrls: null, owned: 0 };
  expect(await checkDatabaseRole(as({ ...fine, superuser: "app_user" }))).toEqual({ ok: false, reason: "database role app_user is a superuser" });
  expect(await checkDatabaseRole(as({ ...fine, bypassrls: "app_user" }))).toEqual({ ok: false, reason: "database role app_user has BYPASSRLS" });
  expect(await checkDatabaseRole(as({ ...fine, owned: 3 }))).toEqual({
    ok: false,
    reason: "database role app_user owns 3 tables in public (directly or through membership)",
  });
});

test("checkDatabaseRole fails when app_user inherits BYPASSRLS through role membership", async () => {
  const db = await createTestDb();
  await rawQuery(db, "CREATE ROLE rls_bypasser NOLOGIN BYPASSRLS");
  await rawQuery(db, "GRANT rls_bypasser TO app_user");
  expect(await checkDatabaseRole(db)).toEqual({
    ok: false,
    reason: "database role app_user has BYPASSRLS through membership of rls_bypasser",
  });
});

test("checkDatabaseRole fails when app_user is a member of a superuser role", async () => {
  const db = await createTestDb();
  await rawQuery(db, "CREATE ROLE super_group NOLOGIN SUPERUSER");
  await rawQuery(db, "GRANT super_group TO app_user");
  expect(await checkDatabaseRole(db)).toEqual({
    ok: false,
    reason: "database role app_user is a superuser through membership of super_group",
  });
});

test("checkDatabaseRole counts tables owned by a role app_user is a member of", async () => {
  const db = await createTestDb();
  await rawQuery(db, "CREATE ROLE table_owner NOLOGIN");
  await rawQuery(db, "GRANT table_owner TO app_user");
  await rawQuery(db, "ALTER TABLE projects OWNER TO table_owner");
  expect(await checkDatabaseRole(db)).toEqual({
    ok: false,
    reason: "database role app_user owns 1 tables in public (directly or through membership)",
  });
});
