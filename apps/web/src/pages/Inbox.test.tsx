import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import type { HandoffView, OpenItems } from "../api";
import { fakeApi, quoted, resetFakeApi } from "../test/fakeApi";
import { renderAt } from "../test/render";
import { Inbox } from "./Inbox";

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), api: (await import("../test/fakeApi")).fakeApi }));

const handoff = (over: Partial<HandoffView> = {}): HandoffView => ({
  id: "h1",
  taskRef: "ACME-3",
  from: quoted("Grace"),
  toRole: "frontend",
  unassigned: false,
  delivered: quoted("Login API is live", "handoff:h1"),
  requiredAction: quoted("Wire up the sign-in form", "handoff:h1"),
  knownLimits: null,
  status: "pending",
  evidence: [],
  createdAt: "2026-11-20T10:00:00.000Z",
  ...over,
});
const items = (handoffs: HandoffView[]): OpenItems => ({ handoffs, blockers: [], tasks: [] });

const renderInbox = () => renderAt("/w/w1/inbox", <Route path="/w/:ws/inbox" element={<Inbox />} />);

beforeEach(() => {
  resetFakeApi();
  fakeApi.projects.mockResolvedValue([{ id: "p1", key: "ACME", name: "Acme site" }]);
});

test("accepting a handoff calls respond and removes it from the list", async () => {
  // The server stops listing it once it has been answered.
  fakeApi.openItems.mockResolvedValueOnce(items([handoff()])).mockResolvedValue(items([]));
  renderInbox();
  const card = (await screen.findByText("Login API is live")).closest("article")!;
  await userEvent.click(within(card as HTMLElement).getByRole("button", { name: "Accept" }));
  expect(fakeApi.respondToHandoff).toHaveBeenCalledWith("w1", "h1", { response: "accepted" });
  await waitFor(() => expect(screen.queryByText("Login API is live")).toBeNull());
});

test("'Needs changes' cannot be submitted without a note", async () => {
  fakeApi.openItems.mockResolvedValue(items([handoff()]));
  renderInbox();
  await screen.findByText("Login API is live");
  await userEvent.click(screen.getByRole("button", { name: "Needs changes" }));
  const send = screen.getByRole("button", { name: "Send back" });
  expect((send as HTMLButtonElement).disabled).toBe(true);
  await userEvent.type(screen.getByLabelText("What needs to change?"), "   ");
  expect((send as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(send);
  expect(fakeApi.respondToHandoff).not.toHaveBeenCalled();

  await userEvent.type(screen.getByLabelText("What needs to change?"), "Missing error states");
  expect((send as HTMLButtonElement).disabled).toBe(false);
  await userEvent.click(send);
  expect(fakeApi.respondToHandoff).toHaveBeenCalledWith("w1", "h1", {
    response: "needs_changes",
    note: "Missing error states",
  });
});

test("text written by others is rendered as text, never as HTML", async () => {
  const evil = "<img src=x onerror=alert(1)>";
  fakeApi.openItems.mockResolvedValue({
    handoffs: [handoff({ delivered: quoted(evil), from: quoted("<b>Mallory</b>"), knownLimits: quoted("<script>x()</script>") })],
    blockers: [
      {
        id: "b1", taskRef: null, observed: quoted("<img src=y onerror=alert(2)>"), cause: null, causeStatus: "none",
        ownerRole: "frontend", status: "open", createdAt: "2026-11-20T10:00:00.000Z",
      },
    ],
    tasks: [],
  });
  renderInbox();
  expect(await screen.findByText(evil)).toBeTruthy();
  expect(screen.getByText("<img src=y onerror=alert(2)>")).toBeTruthy();
  expect(document.querySelector("img")).toBeNull();
  expect(document.querySelector("b")).toBeNull();
  expect(document.querySelector("script")).toBeNull();
});

test("evidence links are only links when the scheme is http or https", async () => {
  fakeApi.openItems.mockResolvedValue(
    items([
      handoff({
        evidence: [
          { kind: "change_request", url: "https://git.example.com/acme/pull/7" },
          { kind: "file", url: "javascript:alert(1)" },
        ],
      }),
    ]),
  );
  renderInbox();
  const link = await screen.findByRole("link", { name: /git\.example\.com\/acme\/pull\/7/ });
  expect(link.getAttribute("href")).toBe("https://git.example.com/acme/pull/7");
  expect(link.getAttribute("rel")).toContain("noopener");
  expect(screen.getByText(/javascript:alert\(1\)/).closest("a")).toBeNull();
});
