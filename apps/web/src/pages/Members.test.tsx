import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import type { Role } from "../api";
import { fakeApi, resetFakeApi } from "../test/fakeApi";
import { renderAt } from "../test/render";
import { Members } from "./Members";

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), api: (await import("../test/fakeApi")).fakeApi }));

const role = (key: string, name: string, over: Partial<Role> = {}): Role => ({
  id: `r-${key}`, key, name, permissions: ["project.read"], archived: false, memberCount: 0, ...over,
});

const renderMembers = () => renderAt("/w/w1/members", <Route path="/w/:ws/members" element={<Members />} />);

beforeEach(() => {
  resetFakeApi();
  fakeApi.members.mockResolvedValue([
    { memberId: "m1", displayName: "Ada", status: "active", roles: [{ key: "dev", projectId: null }] },
    { memberId: "m2", displayName: "Grace", status: "active", roles: [] },
  ]);
  fakeApi.roles.mockResolvedValue([role("dev", "Developer"), role("reviewer", "Reviewer")]);
  fakeApi.projects.mockResolvedValue([{ id: "p1", key: "ACME", name: "Acme site" }]);
});

test("Members: adding a second role to a member calls the roles route with both keys", async () => {
  renderMembers();
  await userEvent.click(await screen.findByRole("button", { name: "Add role to Ada" }));
  const form = screen.getByRole("form", { name: "Add a role to Ada" });
  await userEvent.selectOptions(within(form).getByLabelText("Role"), "reviewer");
  await userEvent.click(within(form).getByRole("button", { name: "Add" }));
  expect(fakeApi.setMemberRoles).toHaveBeenCalledWith("w1", "m1", { roleKeys: ["dev", "reviewer"] });
});

test("Members: a role limited to one project keeps the member's other roles in that project", async () => {
  fakeApi.members.mockResolvedValue([
    { memberId: "m1", displayName: "Ada", status: "active", roles: [{ key: "dev", projectId: null }, { key: "dev", projectId: "p1" }] },
  ]);
  renderMembers();
  await userEvent.click(await screen.findByRole("button", { name: "Add role to Ada" }));
  const form = screen.getByRole("form", { name: "Add a role to Ada" });
  await userEvent.selectOptions(within(form).getByLabelText("Role"), "reviewer");
  await userEvent.selectOptions(within(form).getByLabelText("Where"), "p1");
  await userEvent.click(within(form).getByRole("button", { name: "Add" }));
  expect(fakeApi.setMemberRoles).toHaveBeenCalledWith("w1", "m1", { roleKeys: ["dev", "reviewer"], projectId: "p1" });
});

test("Members: removing a role chip sends the remaining keys for that scope", async () => {
  fakeApi.members.mockResolvedValue([
    { memberId: "m1", displayName: "Ada", status: "active", roles: [{ key: "dev", projectId: null }, { key: "reviewer", projectId: null }] },
  ]);
  renderMembers();
  await userEvent.click(await screen.findByRole("button", { name: "Remove role dev from Ada" }));
  expect(fakeApi.setMemberRoles).toHaveBeenCalledWith("w1", "m1", { roleKeys: ["reviewer"] });
});

test("Members: an invite link is shown once and contains /join/", async () => {
  fakeApi.createInvite.mockResolvedValue({ inviteId: "i1", code: "inv_once_only" });
  const { client } = renderMembers();
  const form = await screen.findByRole("form", { name: "Invite people" });
  await userEvent.click(await within(form).findByRole("checkbox", { name: /Developer/ }));
  await userEvent.click(within(form).getByRole("button", { name: "Create invite link" }));
  expect(fakeApi.createInvite).toHaveBeenCalledWith("w1", { roleKeys: ["dev"] });

  const link = (await screen.findByLabelText("Invite link")) as HTMLInputElement;
  expect(link.value).toBe(`${window.location.origin}/join/inv_once_only`);
  expect(link.value).toContain("/join/");
  expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
  const cached = JSON.stringify([
    client.getQueryCache().getAll().map((q) => q.state.data),
    client.getMutationCache().getAll().map((m) => m.state.data),
  ]);
  expect(cached).not.toContain("inv_once_only");

  await userEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByLabelText("Invite link")).toBeNull();
  expect(document.body.textContent).not.toContain("inv_once_only");
});

test("Members: pending invites can be revoked", async () => {
  fakeApi.invites.mockResolvedValue([
    {
      id: "i7", roleKeys: ["dev"], projectId: null, createdBy: "m1", createdByName: "Ada",
      expiresAt: "2026-11-27T00:00:00.000Z", createdAt: "2026-11-20T00:00:00.000Z",
    },
  ]);
  renderMembers();
  await userEvent.click(await screen.findByRole("button", { name: "Revoke invite for dev" }));
  expect(fakeApi.revokeInvite).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Yes, revoke" }));
  expect(fakeApi.revokeInvite).toHaveBeenCalledWith("w1", "i7");
});

test("Members: removing a member asks first, then calls the remove route", async () => {
  renderMembers();
  await userEvent.click(await screen.findByRole("button", { name: "Remove Grace" }));
  expect(fakeApi.removeMember).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Yes, remove" }));
  expect(fakeApi.removeMember).toHaveBeenCalledWith("w1", "m2");
});
