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
  expect((await screen.findByRole("link", { name: "Continue with GitHub" })).getAttribute("href")).toBe("/auth/github/start");
  expect(screen.getByRole("link", { name: "Continue with GitLab" }).getAttribute("href")).toBe("/auth/gitlab/start");
});

test("SignIn shows only the providers the deployment has turned on", async () => {
  fakeApi.providers.mockResolvedValue({ github: true, gitlab: false, local: false });
  renderAt("/signin", <Route path="/signin" element={<SignIn />} />);
  expect(await screen.findByRole("link", { name: "Continue with GitHub" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Continue with GitLab" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
});

test("SignIn in local mode offers only Continue", async () => {
  fakeApi.providers.mockResolvedValue({ github: false, gitlab: false, local: true });
  renderAt("/signin", <Route path="/signin" element={<SignIn />} />);
  expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: /Continue with/ })).toBeNull();
});

test("SignIn explains a failed sign-in", async () => {
  renderAt("/signin?signin=failed", <Route path="/signin" element={<SignIn />} />);
  expect(screen.getByRole("alert").textContent).toMatch(/didn.t finish/);
});

test("local sign-in reports when the server does not allow it", async () => {
  fakeApi.signInLocal.mockRejectedValue(new ApiError(404, "local sign-in is not enabled"));
  renderAt("/signin", <Route path="/signin" element={<SignIn />} />);
  await userEvent.click(await screen.findByRole("button", { name: "Continue" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/local sign-in is not enabled/);
});
