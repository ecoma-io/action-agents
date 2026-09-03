// The check that keeps the boundary gate honest.
//
// `pnpm arch` proves the boundary law holds on the real tree. It cannot prove
// the law still BITES: the root `module-boundaries.config.mjs` header records
// how this gate once reported "no boundary violations" over a graph with zero
// edges — an unresolved import is reported `allowed`, so the gate fails open,
// silently, in the one direction nothing else would catch. This script runs
// the same `archkeep check` against two miniature workspaces under
// `tools/fixtures/` and asserts the measured contract at the pinned
// archkeep version — measured, not assumed; each assertion below was taken
// from a real run, and any drift is a gate change to be reviewed, never
// absorbed:
//
//   boundary-canary — `canary-triage` imports across into `canary-review`
//   over a RELATIVE specifier, so the edge stays resolvable and must be
//   JUDGED: exit 1, verdict "fail", and exactly one violation, named by
//   project, file, line and messageId. Reason-parity with
//   tools/check-transport-seam.mjs: the refusal must name its reason, not
//   merely exist.
//
//   boundary-canary-unresolved — the same import over a subpath specifier no
//   compiler options can resolve. Measured reality at this pin: archkeep
//   exits 0 with verdict "pass" and records the import site in
//   `coverage.blindSpots`. This gate asserts the site is NAMED there —
//   visibility, not verdict. Whether archkeep should also fail such a tree
//   is a question for archkeep (filed upstream); nobody may tighten this
//   assertion into a pass/fail claim without re-measuring first, because an
//   assertion the tool does not honor is a new fail-open in this directory.
//
// Each fixture is judged from its own directory, so the fixture's
// `archkeep.json` is the project graph the run judges — the fixture is a
// workspace, and this is the only way to point archkeep at a workspace other
// than the repository root (the `--config` flag names a boundary LAW, not a
// project graph).
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Runs `archkeep check --format json` inside `fixtureName` and returns the
 * process result with the parsed envelope attached, or null when the
 * process could not start.
 *
 * @param {string} fixtureName directory under tools/fixtures/
 * @returns {{ status: number | null, envelope: object | null, report: string } | null}
 */
function runArchkeep(fixtureName) {
  const run = spawnSync("pnpm", ["exec", "archkeep", "check", "--format", "json"], {
    cwd: join(here, "fixtures", fixtureName),
    encoding: "utf8",
  });
  if (run.error !== undefined) {
    console.error(
      `boundary-gate canary could not run archkeep for ${fixtureName}: ${run.error.message}`,
    );
    return null;
  }
  const report = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  let envelope = null;
  try {
    envelope = JSON.parse(run.stdout ?? "");
  } catch {
    // Parsed below by the caller's failure reporting; a non-JSON answer is
    // itself a finding against the pinned contract.
  }
  return { status: run.status, envelope, report };
}

/** @type {string[]} */
const failures = [];

// ── 1. The resolvable illegal edge must be judged, and its reason named ──

const judged = runArchkeep("boundary-canary");
if (judged === null) {
  failures.push("archkeep could not run against tools/fixtures/boundary-canary");
} else if (judged.envelope === null) {
  failures.push(
    "boundary-canary: archkeep did not answer with the versioned JSON envelope the pinned contract names. It said:",
  );
  failures.push(judged.report.trim());
} else {
  const env =
    /** @type {{ status?: unknown, exitCode?: unknown, coverage?: { complete?: unknown, blindSpots?: unknown[] }, result?: { violations?: { sourceFile?: string, line?: number, messageId?: string, sourceProject?: string, targetProject?: string }[] }, decision?: { verdict?: string } }} */ (
      judged.envelope
    );
  const violations = env.result?.violations ?? [];
  const expected = {
    sourceFile: "canary-triage/src/index.mjs",
    line: 11,
    messageId: "noRelativeOrAbsoluteImportsAcrossLibraries",
    sourceProject: "canary-triage",
    targetProject: "canary-review",
  };
  if (judged.status !== 1 || env.exitCode !== 1) {
    failures.push(
      `boundary-canary: expected exit 1 for the resolvable illegal import, got ${String(judged.status)}. A quiet gate here is the fail-open this file exists to catch.`,
    );
  }
  if (env.decision?.verdict !== "fail") {
    failures.push(
      `boundary-canary: expected decision.verdict "fail", got ${JSON.stringify(env.decision?.verdict)}.`,
    );
  }
  if (env.coverage?.complete !== true) {
    failures.push(
      `boundary-canary: expected coverage.complete true — the edge must be judged, not excused into a blind spot. Got ${JSON.stringify(env.coverage)}.`,
    );
  }
  const match =
    violations.length === 1 &&
    violations[0] !== undefined &&
    (
      /** @returns {boolean} */ () => {
        const v = violations[0];
        return (
          v.sourceFile === expected.sourceFile &&
          v.line === expected.line &&
          v.messageId === expected.messageId &&
          v.sourceProject === expected.sourceProject &&
          v.targetProject === expected.targetProject
        );
      }
    )();
  if (!match) {
    failures.push(
      "boundary-canary: expected exactly one violation — canary-triage/src/index.mjs:11, " +
        "messageId noRelativeOrAbsoluteImportsAcrossLibraries, canary-triage -> canary-review. Got:",
    );
    failures.push(JSON.stringify(violations, null, 2));
  }
}

// ── 2. The unresolvable illegal edge must stay VISIBLE — not judged ──────
//
// Visibility, not verdict: this fixture asserts archkeep NAMES the import
// site in coverage.blindSpots. It deliberately does not assert pass or fail —
// measured behavior at this pin is exit 0 / verdict "pass", and if archkeep
// ever changes that, this check should still hold or fail for the right
// reason (a missing name), never because a verdict was pinned.

const visible = runArchkeep("boundary-canary-unresolved");
if (visible === null) {
  failures.push("archkeep could not run against tools/fixtures/boundary-canary-unresolved");
} else if (visible.envelope === null) {
  failures.push(
    "boundary-canary-unresolved: archkeep did not answer with a JSON envelope. It said:",
  );
  failures.push(visible.report.trim());
} else {
  const env =
    /** @type {{ coverage?: { blindSpots?: { file?: string, reason?: string }[] } | null, decision?: { verdict?: string } }} */ (
      visible.envelope
    );
  const exitSupported = visible.status === 0 || visible.status === 1;
  if (!exitSupported) {
    failures.push(
      `boundary-canary-unresolved: expected exit 0 or 1 (verdict-agnostic), got ${String(visible.status)}. The fixture may be broken rather than blind-spotted.`,
    );
  }
  const blindSpots = env.coverage?.blindSpots ?? [];
  const named = blindSpots.some(
    (spot) =>
      spot.file === "canary-triage/src/index.mjs" &&
      typeof spot.reason === "string" &&
      spot.reason.includes("#canary-review/src/index.mjs"),
  );
  if (!named) {
    failures.push(
      "boundary-canary-unresolved: the unresolvable import site is not named in coverage.blindSpots " +
        "(expected canary-triage/src/index.mjs naming #canary-review/src/index.mjs). " +
        "An edge nobody can see is an edge nobody judges — this is the exact fail-open the " +
        "root gate once suffered. Got:",
    );
    failures.push(JSON.stringify(blindSpots, null, 2));
  }
}

// ── Verdict ───────────────────────────────────────────────────────────────

if (failures.length > 0) {
  for (const f of failures) console.error(`✗ ${f}`);
  console.error(
    "\nThe boundary gate no longer honors the contract this canary pins — " +
      "fix the gate, never the canary.",
  );
  process.exitCode = 1;
} else {
  console.log(
    "boundary-gate canary: the resolvable illegal edge is judged and named, " +
      "and the unresolvable one stays visible in coverage.blindSpots — the law is loud.",
  );
}
