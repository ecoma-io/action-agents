// Inert under node --test and skipped by the verb scan: a test module.
import { ok } from "node:assert/strict";
import { test } from "node:test";

test("inert fixture module", () => {
  ok(true);
});
