import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// In development the API runs on :8787 (wrangler dev or the Node entry). Proxying keeps
// every request same-origin, so the session cookie and the API's Origin check just work.
const API = process.env.THREADLINE_API ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: API, changeOrigin: false },
      "/auth": { target: API, changeOrigin: false },
    },
  },
  test: {
    name: "@threadline/web",
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
