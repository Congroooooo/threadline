import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

function Broken(): never {
  throw new Error("boom");
}

test("a render error shows a friendly message instead of a blank page", () => {
  const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
  render(
    <ErrorBoundary>
      <Broken />
    </ErrorBoundary>,
  );
  expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  expect(screen.queryByText("boom")).toBeNull();
  quiet.mockRestore();
});

test("children render normally when nothing fails", () => {
  render(
    <ErrorBoundary>
      <p>fine</p>
    </ErrorBoundary>,
  );
  expect(screen.getByText("fine")).toBeTruthy();
});
