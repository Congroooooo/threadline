// The slice of Web Crypto used by tokens.ts. Available as a global on Cloudflare Workers
// and Node 20+. Declared here so the package keeps `types: []` and `lib: ["ES2022"]`.
declare var crypto: {
  getRandomValues<T extends Uint8Array>(array: T): T;
  subtle: { digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer> };
};

// The slice of the WHATWG URL class used by safety.ts (global on Workers and Node).
declare var URL: {
  new (input: string): { protocol: string; hostname: string; username: string; password: string; href: string };
};
