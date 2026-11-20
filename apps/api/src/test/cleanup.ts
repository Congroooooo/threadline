// Frees each test's in-memory databases when the test ends.
import { closeTestDbs } from "@threadline/core/testing";
import { afterEach } from "vitest";

afterEach(closeTestDbs);
