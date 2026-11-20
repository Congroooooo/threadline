import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { resetFakeApi } from "../test/fakeApi";
import { renderAt } from "../test/render";
import { inviteCodeFrom, Welcome } from "./Start";

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), api: (await import("../test/fakeApi")).fakeApi }));

beforeEach(() => resetFakeApi());

test("inviteCodeFrom reads a link or a bare code, and treats a malformed escape as invalid", () => {
  expect(inviteCodeFrom("https://t.example/join/abc_123")).toBe("abc_123");
  expect(inviteCodeFrom("abc_123")).toBe("abc_123");
  expect(inviteCodeFrom("https://t.example/join/%E0%A4%A")).toBeNull();
  expect(inviteCodeFrom("not a code!")).toBeNull();
});

test("Welcome survives a malformed pasted link and keeps Join disabled", async () => {
  renderAt("/welcome", <Route path="/welcome" element={<Welcome />} />);
  await userEvent.type(screen.getByLabelText("Invite link"), "https://t.example/join/%E0%A4%A");
  expect(screen.getByRole("button", { name: "Join" }).hasAttribute("disabled")).toBe(true);
});
