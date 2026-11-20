import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, ApiError, session } from "./api";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("requests are same-origin JSON with the session cookie", async () => {
  fetchMock.mockResolvedValue(json(201, { inviteId: "i1", code: "c" }));
  await api.createInvite("w1", { roleKeys: ["dev"] });
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe("/api/w/w1/invites");
  expect(init?.method).toBe("POST");
  expect(init?.credentials).toBe("same-origin");
  expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  expect(init?.body).toBe(JSON.stringify({ roleKeys: ["dev"] }));
});

test("query strings are encoded and omitted when empty", async () => {
  fetchMock.mockResolvedValue(json(200, []));
  await api.events("w1", "p1", { after: "a b" });
  await api.tasks("w1", "p1");
  expect(fetchMock.mock.calls[0]![0]).toBe("/api/w/w1/projects/p1/events?after=a+b");
  expect(fetchMock.mock.calls[1]![0]).toBe("/api/w/w1/projects/p1/tasks");
});

test("errors throw ApiError with the status and the API's error text", async () => {
  fetchMock.mockResolvedValue(json(403, { error: "not allowed" }));
  const err = await api.members("w1").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(403);
  expect((err as ApiError).error).toBe("not allowed");
});

test("a 401 sends the browser to sign-in", async () => {
  const spy = vi.spyOn(session, "onUnauthorized").mockImplementation(() => {});
  fetchMock.mockResolvedValue(json(401, { error: "sign in required" }));
  await expect(api.me()).rejects.toMatchObject({ status: 401 });
  expect(spy).toHaveBeenCalledOnce();
  spy.mockRestore();
});

test("a network failure is an ApiError with status 0", async () => {
  fetchMock.mockRejectedValue(new TypeError("failed to fetch"));
  await expect(api.me()).rejects.toMatchObject({ status: 0 });
});
