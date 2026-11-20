import { expect, test } from "vitest";
import { HUMAN_ONLY as CORE_HUMAN_ONLY, PERMISSIONS as CORE_PERMISSIONS } from "../../../packages/core/src/types";
import { HUMAN_ONLY, PERMISSION_LABELS, PERMISSIONS, permissionsOf } from "./permissions";

test("the permission lists match core exactly", () => {
  expect([...PERMISSIONS]).toEqual([...CORE_PERMISSIONS]);
  expect([...HUMAN_ONLY].sort()).toEqual([...CORE_HUMAN_ONLY].sort());
  expect(Object.keys(PERMISSION_LABELS).sort()).toEqual([...PERMISSIONS].sort());
});

test("permissionsOf counts workspace-wide and same-project roles, never archived ones or other projects", () => {
  const roles = [
    { key: "dev", permissions: ["task.write"] as const, archived: false },
    { key: "lead", permissions: ["task.accept"] as const, archived: false },
    { key: "old", permissions: ["workspace.admin"] as const, archived: true },
  ];
  const member = { roles: [{ key: "dev", projectId: null }, { key: "lead", projectId: "p1" }, { key: "old", projectId: null }] };
  expect([...permissionsOf(member, roles, "p1")].sort()).toEqual(["task.accept", "task.write"]);
  expect([...permissionsOf(member, roles, "p2")]).toEqual(["task.write"]);
  expect(permissionsOf(undefined, roles).size).toBe(0);
});
