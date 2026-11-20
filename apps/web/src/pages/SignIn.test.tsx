import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "../api";
import { fakeApi, resetFakeApi } from "../test/fakeApi";
import { renderAt } from "../test/render";
import { SignIn } from "./SignIn";

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), api: (await import("../test/fakeApi")).fakeApi }));

beforeEach(() => resetFakeApi());

test("SignIn shows the name and tagline", async () => {
  renderAt("/signin", <Route path="/signin" element={<SignIn />} />);
  expect(screen.getByText("One shared context. Every step connected.")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Threadline" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Continue with GitHub" }).getAttribute("href")).toBe("/auth/github/start");
  expect(screen.getByRole("link", { name: "Continue with GitLab" }).getAttribute("href")).toBe("/auth/gitlab/start");
});

test("SignIn explains a failed sign-in", async () => {
  renderAt("/signin?signin=failed", <Route path="/signin" element={<SignIn />} />);
  expect(screen.getByRole("alert").textContent).toMatch(/didn.t finish/);
});

test("local sign-in reports when the server does not allow it", async () => {
  fakeApi.signInLocal.mockRejectedValue(new ApiError(404, "local sign-in is not enabled"));
  renderAt("/signin", <Route path="/signin" element={<SignIn />} />);
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/local sign-in is not enabled/);
});
