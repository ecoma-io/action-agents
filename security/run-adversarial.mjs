#!/usr/bin/env node
/**
 * The Security Adversarial Corpus runner.
 *
 * Discovers and runs every adversarial test under `security/fixtures/` with
 * the Node test runner — the same shape as `pnpm test:tools`. There is no
 * separate harness to trust: `node --test` is the runner and each fixture is
 * a plain `*.test.mjs` that imports the real production modules and asserts
 * that an attack attempted stays bounded.
 *
 * The corpus is deterministic and offline. It never calls a live model or a
 * network endpoint, which is deliberate: the point is to prove each ceiling
 * holds independent of model strength or provider behaviour — including the
 * weak and keyless paths — so a regression on any boundary turns red here
 * without needing anything but the runner's own Node.
 *
 * Run with:  pnpm security
 */
import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Glob of every adversarial test file, relative to this runner. */
const FIXTURE_GLOB = join(here, "fixtures", "**", "*.test.mjs");

/**
 * The adversarial test files that actually exist. `globSync` returns them in
 * path order, so the corpus's order is deterministic across runs and machines.
 */
const FIXTURE_FILES = globSync(FIXTURE_GLOB);

/**
 * Run the corpus and exit with the runner's status. Returns `undefined` so this
 * process's exit code is this call's. A signal or an aborted spawn is also a
 * failure, never a pass.
 */
export function main() {
  // Fail closed on an empty corpus. A run with zero fixtures proves nothing and
  // must not be green: the "-1 tests" of an unpopulated directory are the exact
  // false-green this gate exists to refuse, just as `ci-gate` refuses an empty
  // result set rather than treating "no result" as success.
  if (FIXTURE_FILES.length === 0) {
    console.error(
      "security: no adversarial test files found under security/fixtures/ — refusing to pass.",
    );
    process.exit(1);
  }

  const result = spawnSync(process.execPath, ["--test", ...FIXTURE_FILES], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
