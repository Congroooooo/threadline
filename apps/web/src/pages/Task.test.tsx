import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import type { Role, TaskContext } from "../api";
import { fakeApi, quoted, resetFakeApi } from "../test/fakeApi";
import { renderAt } from "../test/render";
import { Task } from "./Task";

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), api: (await import("../test/fakeApi")).fakeApi }));

const role = (key: string, permissions: Role["permissions"]): Role => ({
  id: `r-${key}`, key, name: key, permissions, archived: false, memberCount: 1,
});

const context: TaskContext = {
  task: {
    id: "t1", ref: "ACME-4", title: quoted("Ship the login page", "task:t1"), description: quoted("<i>soon</i>", "task:t1"),
    status: "in_review", ownerRole: "dev", branch: "feat/login", blocked: false,
  },
  dependencies: [],
  blockedBy: { dependencies: [], blockers: [] },
  handoffs: [],
  blockers: [],
  progress: [{ id: "n1", by: quoted("Grace (agent)", "agent:a1"), note: quoted("Tests pass", "progress:n1"), createdAt: "2026-11-20T10:00:00.000Z" }],
  evidence: [{ kind: "commit", url: "https://git.example.com/acme/commit/abc" }],
};

const renderTask = () => renderAt("/w/w1/t/t1", <Route path="/w/:ws/t/:taskId" element={<Task />} />);

beforeEach(() => {
  resetFakeApi();
  fakeApi.task.mockResolvedValue(context);
  fakeApi.projects.mockResolvedValue([{ id: "p1", key: "ACME", name: "Acme site" }]);
});

test("'Mark done' is shown to a member holding task.accept in the task's project, and sets the status", async () => {
  fakeApi.roles.mockResolvedValue([role("dev", ["task.write"]), role("lead", ["task.accept"])]);
  fakeApi.members.mockResolvedValue([
    { memberId: "m1", displayName: "Ada", status: "active", roles: [{ key: "dev", projectId: null }, { key: "lead", projectId: "p1" }] },
  ]);
  renderTask();
  await userEvent.click(await screen.findByRole("button", { name: "Mark done" }));
  expect(fakeApi.setTaskStatus).toHaveBeenCalledWith("w1", "t1", "done");
});

test("'Mark done' is hidden without task.accept", async () => {
  fakeApi.roles.mockResolvedValue([role("dev", ["task.write"]), role("lead", ["task.accept"])]);
  // lead only in another project.
  fakeApi.members.mockResolvedValue([
    { memberId: "m1", displayName: "Ada", status: "active", roles: [{ key: "dev", projectId: null }, { key: "lead", projectId: "p2" }] },
  ]);
  renderTask();
  await screen.findByRole("button", { name: "Move to “To do”" });
  expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();
});

test("task text, progress and evidence render as text and safe links", async () => {
  renderTask();
  expect(await screen.findByText("<i>soon</i>")).toBeTruthy();
  expect(document.querySelector("i")).toBeNull();
  expect(screen.getByText("Tests pass")).toBeTruthy();
  expect(screen.getByText("Grace (agent)")).toBeTruthy();
  expect(screen.getByRole("link", { name: "git.example.com/acme/commit/abc" }).getAttribute("href")).toBe(
    "https://git.example.com/acme/commit/abc",
  );
});
