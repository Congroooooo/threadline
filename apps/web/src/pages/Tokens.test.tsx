import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, Outlet, Route } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { fakeApi, resetFakeApi } from "../test/fakeApi";
import { renderAt } from "../test/render";
import { Tokens } from "./Tokens";

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), api: (await import("../test/fakeApi")).fakeApi }));

const SECRET = "tl_s3cr3t_value_shown_once";

beforeEach(() => {
  resetFakeApi();
  fakeApi.projects.mockResolvedValue([
    { id: "p1", key: "ACME", name: "Acme site" },
    { id: "p2", key: "OPS", name: "Operations" },
  ]);
  fakeApi.createToken.mockResolvedValue({ agentId: "a1", token: SECRET });
});

test("a new token is shown once and is gone after navigating away and back", async () => {
  const shell = (
    <>
      <Link to="/w/w1/elsewhere">Leave</Link>
      <Outlet />
    </>
  );
  const { client } = renderAt(
    "/w/w1/tokens",
    <Route element={shell}>
      <Route path="/w/:ws/tokens" element={<Tokens />} />
      <Route path="/w/:ws/elsewhere" element={<Link to="/w/w1/tokens">Back to tokens</Link>} />
    </Route>,
  );
  await userEvent.type(await screen.findByLabelText("Token name"), "Ada's laptop");
  await userEvent.click(await screen.findByRole("checkbox", { name: /ACME/ }));
  await userEvent.click(screen.getByRole("button", { name: "Create token" }));

  expect(fakeApi.createToken).toHaveBeenCalledWith("w1", { name: "Ada's laptop", projectIds: ["p1"] });
  expect(await screen.findByText(SECRET, { exact: false })).toBeTruthy();
  // Both setup snippets from the integration guide.
  expect(screen.getByText(/"mcpServers"/)).toBeTruthy();
  expect(screen.getByText(/"SessionStart"/)).toBeTruthy();

  // Kept only in component state: nothing in the query or mutation caches holds it.
  const cached = JSON.stringify([
    client.getQueryCache().getAll().map((q) => q.state.data),
    client.getMutationCache().getAll().map((m) => m.state.data),
  ]);
  expect(cached).not.toContain(SECRET);

  await userEvent.click(screen.getByRole("link", { name: "Leave" }));
  await userEvent.click(await screen.findByRole("link", { name: "Back to tokens" }));
  await screen.findByRole("button", { name: "Create token" });
  expect(screen.queryByText(SECRET, { exact: false })).toBeNull();
});

test("tokens are listed and can be revoked", async () => {
  fakeApi.tokens.mockResolvedValue([
    {
      id: "a9", memberId: "m1", ownerName: "Ada", name: "CI runner", projectIds: ["p1"],
      createdAt: "2026-11-01T00:00:00.000Z", lastUsedAt: null, revokedAt: null,
    },
  ]);
  renderAt("/w/w1/tokens", <Route path="/w/:ws/tokens" element={<Tokens />} />);
  expect(await screen.findByText("CI runner")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Revoke CI runner" }));
  expect(fakeApi.revokeToken).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Yes, revoke" }));
  expect(fakeApi.revokeToken).toHaveBeenCalledWith("w1", "a9");
});
