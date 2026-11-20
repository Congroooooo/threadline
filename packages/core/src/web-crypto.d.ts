// The slice of Web Crypto used by tokens.ts. Available as a global on Cloudflare Workers
// and Node 20+. Declared here so the package keeps `types: []` and `lib: ["ES2022"]`.
declare var crypto: {
  getRandomValues<T extends Uint8Array>(array: T): T;
  subtle: { digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer> };
};
