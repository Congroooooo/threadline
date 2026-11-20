// Vitest setup file: frees each test's in-memory databases when the test ends, so a worker
// does not keep dozens of PGlite instances alive while other files boot theirs.
import { afterEach } from "vitest";
import { closeTestDbs } from "./testing.js";

afterEach(closeTestDbs);
