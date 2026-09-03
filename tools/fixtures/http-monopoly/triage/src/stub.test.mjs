// Inert under node --test: pnpm test:tools discovers tools/**/*.test.mjs by
// glob, fixtures included, and executes this file. It must run cleanly.
import { ok } from "node:assert/strict";
import { test } from "node:test";

test("inert fixture module", () => {
  ok(true);
});
