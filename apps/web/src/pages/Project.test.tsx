import { screen, within } from "@testing-library/react";
import { Route } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "../api";
import { fakeApi, resetFakeApi } from "../test/fakeApi";
import { renderAt } from "../test/render";
import { Project } from "./Project";

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), api: (await import("../test/fakeApi")).fakeApi }));

beforeEach(() => resetFakeApi());

test("Project: a failed blocker list says so instead of looking empty", async () => {
  fakeApi.blockers.mockRejectedValue(new ApiError(500, "internal error"));
  renderAt("/w/w1/p/p1", <Route path="/w/:ws/p/:projectId" element={<Project />} />);
  const section = await screen.findByRole("region", { name: "Open blockers" });
  expect((await within(section).findByRole("alert")).textContent).toBe("Could not load blockers: internal error");
  expect(within(section).queryByText("Nothing is blocked.")).toBeNull();
});
