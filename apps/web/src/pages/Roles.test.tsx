import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import type { Role } from "../api";
import { fakeApi, resetFakeApi } from "../test/fakeApi";
import { renderAt } from "../test/render";
import { Members } from "./Members";
import { Roles } from "./Roles";

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), api: (await import("../test/fakeApi")).fakeApi }));

const role = (key: string, name: string, over: Partial<Role> = {}): Role => ({
  id: `r-${key}`, key, name, permissions: ["project.read"], archived: false, memberCount: 0, ...over,
});

beforeEach(() => {
  resetFakeApi();
  fakeApi.roles.mockResolvedValue([role("dev", "Developer"), role("legacy", "Legacy reviewer", { archived: true })]);
  fakeApi.members.mockResolvedValue([{ memberId: "m1", displayName: "Ada", status: "active", roles: [] }]);
});

const renderRoles = () => renderAt("/w/w1/roles", <Route path="/w/:ws/roles" element={<Roles />} />);

test("Roles: creating a role with two permission boxes ticked sends exactly those permissions", async () => {
  renderRoles();
  const form = await screen.findByRole("form", { name: "New role" });
  await userEvent.type(within(form).getByLabelText("Key"), "qa");
  await userEvent.type(within(form).getByLabelText("Name"), "QA");
  await userEvent.click(within(form).getByRole("checkbox", { name: /See the project/ }));
  await userEvent.click(within(form).getByRole("checkbox", { name: /Mark tasks done/ }));
  await userEvent.click(within(form).getByRole("button", { name: "Create role" }));
  expect(fakeApi.createRole).toHaveBeenCalledWith("w1", { key: "qa", name: "QA", permissions: ["project.read", "task.accept"] });
});

test("Roles: the six human-only permissions are labelled 'people only, never agents'", async () => {
  renderRoles();
  const form = await screen.findByRole("form", { name: "New role" });
  expect(within(form).getAllByText("people only, never agents")).toHaveLength(6);
});

test("Roles: renaming, archiving and restoring call their routes", async () => {
  renderRoles();
  const dev = await screen.findByRole("form", { name: "Role dev" });
  const name = within(dev).getByLabelText("Name");
  await userEvent.clear(name);
  await userEvent.type(name, "Engineer");
  await userEvent.click(within(dev).getByRole("button", { name: "Save" }));
  expect(fakeApi.updateRole).toHaveBeenCalledWith("w1", "r-dev", { name: "Engineer", permissions: ["project.read"] });
  await userEvent.click(within(dev).getByRole("button", { name: "Archive" }));
  expect(fakeApi.archiveRole).toHaveBeenCalledWith("w1", "r-dev");
  const legacy = screen.getByRole("form", { name: "Role legacy" });
  await userEvent.click(within(legacy).getByRole("button", { name: "Restore" }));
  expect(fakeApi.restoreRole).toHaveBeenCalledWith("w1", "r-legacy");
});

test("Roles: archived roles are hidden from the member role picker", async () => {
  renderAt("/w/w1/members", <Route path="/w/:ws/members" element={<Members />} />);
  await userEvent.click(await screen.findByRole("button", { name: "Add role to Ada" }));
  const picker = within(screen.getByRole("form", { name: "Add a role to Ada" })).getByLabelText("Role");
  const options = within(picker).getAllByRole("option").map((o) => (o as HTMLOptionElement).value);
  expect(options).toContain("dev");
  expect(options).not.toContain("legacy");
  const invite = screen.getByRole("form", { name: "Invite people" });
  expect(within(invite).queryByRole("checkbox", { name: /Legacy reviewer/ })).toBeNull();
});
