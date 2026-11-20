import { defineConfig } from "drizzle-kit";

// For drizzle-kit introspection and studio only. Migrations are hand-written SQL in
// src/db/migrations (RLS policies and grants cannot be expressed in the Drizzle schema),
// so do not run `drizzle-kit generate` or `push` against a real database.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
