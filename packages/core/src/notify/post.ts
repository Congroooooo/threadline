export type NotifyFailureReason = "http_error" | "network_error" | "timeout";

export class NotifyError extends Error {
  override name = "NotifyError";
  constructor(
    readonly reason: NotifyFailureReason,
    readonly status?: number,
  ) {
    super(`notification failed: ${reason}`);
  }
}

export const NOTIFY_TIMEOUT_MS = 5000;

/** POSTs JSON; redirects are never followed (a 3xx is a failure), so a webhook cannot bounce us to another host. */
export async function postJson(fetchImpl: typeof fetch, url: string, body: unknown): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    throw new NotifyError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error");
  }
  if (res.status < 200 || res.status >= 300) throw new NotifyError("http_error", res.status);
}
