import { sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { listEvents, recordEvent } from "../events.js";
import { withSystem, withWorkspace } from "./client.js";
import { events, workspaces } from "./schema.js";
import {
  assertAllTablesHaveForcedRls,
  createTestDb,
  rawQuery,
  sampleEvent,
  seedTwoWorkspaces,
} from "./testing.js";

describe("row-level security", () => {
  test("every table in public has RLS enabled and forced", async () => {
    const db = await createTestDb();
    await expect(assertAllTablesHaveForcedRls(db)).resolves.toBeUndefined();
  });

  test("the forced-RLS check fails for a table without forced RLS", async () => {
    const db = await createTestDb();
    await rawQuery(db, "create table public.leaky (id int)");
    await expect(assertAllTablesHaveForcedRls(db)).rejects.toThrow(/leaky/);
  });

  test("app queries run as app_user, which is not superuser, cannot bypass RLS and owns nothing", async () => {
    const db = await createTestDb();
    const res = await db.execute(sql`
      select current_user as "user", r.rolsuper as "super", r.rolbypassrls as "bypass",
             (select count(*)::int from pg_class c
               where c.relowner = r.oid and c.relnamespace = 'public'::regnamespace) as "owned"
      from pg_roles r where r.rolname = current_user`);
    expect((res as { rows: unknown[] }).rows).toEqual([{ user: "app_user", super: false, bypass: false, owned: 0 }]);
  });

  test("a workspace reads its own events", async () => {
    const db = await createTestDb();
    const [a] = await seedTwoWorkspaces(db);
    const id = await withWorkspace(db, a, (tx) => recordEvent(tx, sampleEvent(a)));
    const seen = await withWorkspace(db, a, (tx) => listEvents(tx, {}));
    expect(seen.map((e) => e.id)).toEqual([id]);
  });

  test("a workspace cannot read another workspace's events", async () => {
    const db = await createTestDb();
    const [a, b] = await seedTwoWorkspaces(db);
    await withWorkspace(db, a, (tx) => recordEvent(tx, sampleEvent(a)));
    const seen = await withWorkspace(db, b, (tx) => listEvents(tx, {}));
    expect(seen).toHaveLength(0);
    // The row exists: RLS hid it, the insert did not fail.
    expect(await rawQuery(db, "select id from events")).toHaveLength(1);
  });

  test("queries outside withWorkspace see nothing", async () => {
    const db = await createTestDb();
    const [a] = await seedTwoWorkspaces(db);
    await withWorkspace(db, a, (tx) => recordEvent(tx, sampleEvent(a)));
    expect(await db.select().from(events)).toHaveLength(0);
    expect(await db.select().from(workspaces)).toHaveLength(0);
  });

  test("writing a row for a different workspace is rejected", async () => {
    const db = await createTestDb();
    const [a, b] = await seedTwoWorkspaces(db);
    await expect(withWorkspace(db, a, (tx) => recordEvent(tx, sampleEvent(b)))).rejects.toThrow();
    expect(await rawQuery(db, "select id from events")).toHaveLength(0);
  });

  test("events cannot be updated or deleted", async () => {
    const db = await createTestDb();
    const [a] = await seedTwoWorkspaces(db);
    await withWorkspace(db, a, (tx) => recordEvent(tx, sampleEvent(a)));
    await expect(withWorkspace(db, a, (tx) => tx.delete(events))).rejects.toThrow();
    await expect(
      withWorkspace(db, a, (tx) => tx.update(events).set({ type: "tampered" })),
    ).rejects.toThrow();
    expect(await rawQuery(db, "select type from events")).toEqual([{ type: "test.sample" }]);
  });

  test("a workspace sees only its own workspace row", async () => {
    const db = await createTestDb();
    const [a] = await seedTwoWorkspaces(db);
    const rows = await withWorkspace(db, a, (tx) => tx.select().from(workspaces));
    expect(rows.map((w) => w.id)).toEqual([a]);
  });

  test("withSystem sees every workspace but no events", async () => {
    const db = await createTestDb();
    const [a, b] = await seedTwoWorkspaces(db);
    await withWorkspace(db, a, (tx) => recordEvent(tx, sampleEvent(a)));
    const rows = await withSystem(db, (tx) => tx.select().from(workspaces));
    expect(rows.map((w) => w.id).sort()).toEqual([a, b].sort());
    expect(await withSystem(db, (tx) => tx.select().from(events))).toHaveLength(0);
  });

  test("settings do not leak past the transaction", async () => {
    const db = await createTestDb();
    const [a] = await seedTwoWorkspaces(db);
    await withWorkspace(db, a, (tx) => recordEvent(tx, sampleEvent(a)));
    await withSystem(db, async () => undefined);
    expect(await db.select().from(events)).toHaveLength(0);
    expect(await db.select().from(workspaces)).toHaveLength(0);
  });
});
