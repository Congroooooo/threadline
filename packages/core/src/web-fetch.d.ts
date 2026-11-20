// The slice of fetch used by notify/ (globals on Cloudflare Workers and Node 20+). Declared here
// so the package keeps `types: []` and `lib: ["ES2022"]`.
interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  redirect?: "follow" | "manual" | "error";
  signal?: AbortSignal;
}

interface AbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  addEventListener(type: "abort", listener: () => void): void;
}
declare var AbortSignal: { timeout(milliseconds: number): AbortSignal };

declare class Response {
  constructor(body?: string | null, init?: { status?: number });
  readonly status: number;
  readonly ok: boolean;
}
declare class Request {
  constructor(input: string, init?: FetchInit);
  readonly url: string;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}
declare function fetch(input: string, init?: FetchInit): Promise<Response>;
