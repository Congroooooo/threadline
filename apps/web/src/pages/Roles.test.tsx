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

const admin = role("admin", "Admin", { permissions: ["project.read", "workspace.admin"] });

beforeEach(() => {
  resetFakeApi();
  fakeApi.roles.mockResolvedValue([role("dev", "Developer"), admin, role("legacy", "Legacy reviewer", { archived: true })]);
  // The signed-in person (fakeApi.me: memberId m1) is a workspace admin.
  fakeApi.members.mockResolvedValue([{ memberId: "m1", displayName: "Ada", status: "active", roles: [{ key: "admin", projectId: null }] }]);
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

test("Roles: 'Saved' stays visible after the roles are refetched with the new name", async () => {
  renderRoles();
  const dev = await screen.findByRole("form", { name: "Role dev" });
  const name = within(dev).getByLabelText("Name");
  await userEvent.clear(name);
  await userEvent.type(name, "Engineer");
  fakeApi.roles.mockResolvedValue([role("dev", "Engineer"), admin]);
  await userEvent.click(within(dev).getByRole("button", { name: "Save" }));
  const form = await screen.findByRole("form", { name: "Role dev" });
  expect((await within(form).findByRole("status")).textContent).toBe("Saved");
  expect((within(form).getByLabelText("Name") as HTMLInputElement).value).toBe("Engineer");
  expect(within(form).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
});

test("Roles: permissions stored in another order do not count as a change", async () => {
  fakeApi.roles.mockResolvedValue([role("dev", "Developer", { permissions: ["task.write", "project.read"] }), admin]);
  renderRoles();
  const dev = await screen.findByRole("form", { name: "Role dev" });
  expect(within(dev).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  await userEvent.click(within(dev).getByRole("checkbox", { name: /Hand work over/ }));
  expect(within(dev).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false);
});

test("Roles: without workspace.admin roles are read-only", async () => {
  fakeApi.members.mockResolvedValue([{ memberId: "m1", displayName: "Ada", status: "active", roles: [{ key: "dev", projectId: null }] }]);
  renderRoles();
  expect(await screen.findByText("Only workspace admins can change roles.")).toBeTruthy();
  const dev = screen.getByRole("form", { name: "Role dev" });
  expect(within(dev).queryByRole("button", { name: "Save" })).toBeNull();
  expect(within(dev).queryByRole("button", { name: "Archive" })).toBeNull();
  expect((within(dev).getByLabelText("Name") as HTMLInputElement).disabled).toBe(true);
  expect(screen.queryByRole("form", { name: "New role" })).toBeNull();
});
