import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { EventRow } from "./api";
import { fakeApi, resetFakeApi } from "./test/fakeApi";
import { POLL_MS, useTimeline } from "./timeline";

vi.mock("./api", async (orig) => ({ ...(await orig<typeof import("./api")>()), api: (await import("./test/fakeApi")).fakeApi }));

const ev = (iso: string, n: number, type = "task.created", actorKind: EventRow["actorKind"] = "member"): EventRow => {
  const hex = new Date(iso).getTime().toString(16).padStart(12, "0");
  return {
    id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-${n.toString(16).padStart(12, "0")}`,
    workspaceId: "w1", projectId: "p1", actorKind, actorId: "x", type, subjectKind: "task", subjectId: "t1", data: {}, createdAt: iso,
  };
};

function Probe() {
  const { events } = useTimeline("w1", "p1");
  return <p data-testid="ids">{events.map((e) => e.type).join(",")}</p>;
}

let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  resetFakeApi();
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const flush = () => act(async () => {
  await vi.advanceTimersByTimeAsync(0);
});

test("polls every 15 seconds with an overlap cursor, merging late events by id", async () => {
  const a = ev("2026-11-20T10:00:00.000Z", 1, "task.created");
  const b = ev("2026-11-20T10:00:40.000Z", 3, "handoff.created");
  const late = ev("2026-11-20T10:00:30.000Z", 2, "notify.failed", "system");
  fakeApi.events.mockResolvedValueOnce([a, b]).mockResolvedValueOnce([late, b]);

  render(<Probe />);
  await flush();
  expect(screen.getByTestId("ids").textContent).toBe("task.created,handoff.created");
  expect(fakeApi.events).toHaveBeenCalledTimes(1);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_MS);
  });
  expect(fakeApi.events).toHaveBeenCalledTimes(2);
  // Re-requested from `a`, the newest event at least 30 s older than `b`.
  expect(fakeApi.events.mock.calls[1]![2]).toMatchObject({ after: a.id });
  expect(screen.getByTestId("ids").textContent).toBe("task.created,notify.failed,handoff.created");
});

test("stops polling while the tab is hidden and polls again when it becomes visible", async () => {
  fakeApi.events.mockResolvedValue([]);
  render(<Probe />);
  await flush();
  expect(fakeApi.events).toHaveBeenCalledTimes(1);

  visibility = "hidden";
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);
  });
  expect(fakeApi.events).toHaveBeenCalledTimes(1);

  visibility = "visible";
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await flush();
  expect(fakeApi.events).toHaveBeenCalledTimes(2);
});
