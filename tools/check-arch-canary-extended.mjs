// The checks that keep the boundary gate's config contracts honest.
//
// `tools/check-arch-canary.mjs` pins how the gate judges edges — a resolvable
// illegal edge is judged and named, an unresolvable one refuses with its site
// still named. This script pins four contracts that live one level out from
// edge judgment, in how archkeep loads a workspace and compares its tags,
// measured the same way: not assumed. Each assertion below was taken from a
// real run of the pinned binary against its fixture, and any drift is a gate
// change to be reviewed, never absorbed:
//
//   boundary-canary-exemption-inside-root — a `coverage.exempt` glob may not
//   claim a file a project owns. The run refuses at load — exit 3, no JSON
//   envelope at all, the refusal naming the row: "coverage.exempt: … matches
//   no unclaimed file". An exemption that could blind a project's interior
//   would let one glob silence any file inside it.
//
//   boundary-canary-unowned-file — every tracked, analyzable file must be
//   owned by a project. A clean tracked `.mjs` at the fixture root, outside
//   every project, refuses the run — exit 3, run status "no-verdict", verdict
//   "unknown", the file named in `coverage.notAnalyzed` as "not owned by any
//   project" — while the owned file beside it still counts as analyzed, so
//   the refusal is demonstrably about the stray file.
//
//   boundary-canary-dynamic-computed — the declared limit of the refusal
//   lane. A dynamic import over a computed specifier is a blind spot, flagged
//   `dynamic: true`, naming file and line — and it does NOT withhold the
//   verdict: exit 0, verdict "pass", `coverage.complete: true`. Complete WITH
//   a declared blind spot is the contract; either half moving is a reviewed
//   gate change. Contrast the unresolved-import canary: a literal the
//   resolver cannot resolve refuses the run — a specifier that was never a
//   literal cannot, and that asymmetry is upstream's narrowing decision,
//   pinned here so it cannot drift unannounced.
//
//   boundary-canary-tag-prefix — tag comparison in the depConstraints table
//   is exact on both axes. `scope:shared` does not accept `scope:shared-2`,
//   and `layer:core` does not accept `layer:corex`: exactly two violations,
//   both `onlyTagsConstraintViolation`, over the two impostor edges, while
//   the control edge to the real core stays legal — proving the row can still
//   say yes. A prefix match here is a fail-open no resolution canary would
//   catch, because every other one turns on how an import resolves, not on
//   how a tag string is compared.
//
// Each fixture is judged from its own directory, so the fixture's
// `archkeep.json` is the project graph the run judges — the same trick
// tools/check-arch-canary.mjs uses, and the only way to point archkeep at a
// workspace other than the repository root (the `--config` flag names a
// boundary LAW, not a project graph).
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
    // itself a finding against the pinned contract — or, for the
    // exemption-refusal canary, the pinned contract itself.
  }
  return { status: run.status, envelope, report };
}

/** @type {string[]} */
const failures = [];

// ── 1. An exemption may not claim a file a project owns ──────────────────
//
// Measured at this pin (0.27.0): exit 3, EMPTY stdout — the config is
// refused before a run exists, so there is no envelope to read a verdict
// from — and a refusal on stderr naming the row and the reason.

const exempted = runArchkeep("boundary-canary-exemption-inside-root");
if (exempted === null) {
  failures.push(
    "archkeep could not run against tools/fixtures/boundary-canary-exemption-inside-root",
  );
} else if (exempted.status !== 3 || exempted.envelope !== null) {
  failures.push(
    `boundary-canary-exemption-inside-root: expected the load-refusal contract — exit 3 and no ` +
      `JSON envelope, because the config is refused before any run exists — got exit ` +
      `${String(exempted.status)} and ${exempted.envelope === null ? "no envelope" : "an envelope"}. ` +
      `A verdict over a config like this means the exemption was HONORED, and an exemption ` +
      `honored over a project's own files blinds the gate's interior. It said:`,
  );
  failures.push(exempted.report.trim());
} else if (
  !exempted.report.includes("coverage.exempt:") ||
  !exempted.report.includes("matches no unclaimed file") ||
  !exempted.report.includes("canary-review/**")
) {
  failures.push(
    "boundary-canary-exemption-inside-root: the refusal must name the row and its reason — " +
      "coverage.exempt: 'canary-review/**' … matches no unclaimed file. A refusal without a " +
      "name is undiagnosable. It said:",
  );
  failures.push(exempted.report.trim());
}

// ── 2. A tracked, analyzable file must be owned by a project ─────────────
//
// Measured at this pin (0.27.0): exit 3, run status "no-verdict", verdict
// "unknown", coverage.complete false — and `coverage.notAnalyzed` naming the
// stray file and nothing else, with the owned file beside it still counted
// as analyzed.

const unowned = runArchkeep("boundary-canary-unowned-file");
if (unowned === null) {
  failures.push("archkeep could not run against tools/fixtures/boundary-canary-unowned-file");
} else if (unowned.envelope === null) {
  failures.push(
    "boundary-canary-unowned-file: archkeep did not answer with the versioned JSON envelope the pinned contract names. It said:",
  );
  failures.push(unowned.report.trim());
} else {
  const env =
    /** @type {{ status?: unknown, exitCode?: unknown, coverage?: { complete?: unknown, analyzedFiles?: unknown, notAnalyzed?: { file?: unknown, reason?: unknown }[] | null }, decision?: { verdict?: unknown, reason?: unknown }, result?: { violations?: unknown[] } }} */ (
      unowned.envelope
    );
  if (
    unowned.status !== 3 ||
    env.exitCode !== 3 ||
    env.status !== "no-verdict" ||
    env.decision?.verdict !== "unknown" ||
    typeof env.decision?.reason !== "string" ||
    !env.decision.reason.includes("could not be analyzed")
  ) {
    failures.push(
      `boundary-canary-unowned-file: expected the refusal contract (exit 3, run status ` +
        `"no-verdict", verdict "unknown", a reason naming the unanalyzed file), got exit ` +
        `${String(unowned.status)}, status ${JSON.stringify(env.status)}, verdict ` +
        `${JSON.stringify(env.decision?.verdict)}, reason ` +
        `${JSON.stringify(env.decision?.reason)}. A skip-and-pass here is the fail-open ` +
        `this fixture exists to catch — re-measure, never absorb.`,
    );
  }
  if (env.coverage?.complete !== false) {
    failures.push(
      `boundary-canary-unowned-file: expected coverage.complete false — a file nothing ` +
        `analyzed is a hole, and a hole must refuse the verdict. Got ` +
        `${JSON.stringify(env.coverage?.complete)}.`,
    );
  }
  const notAnalyzed = env.coverage?.notAnalyzed ?? [];
  const stray =
    notAnalyzed.length === 1 &&
    notAnalyzed[0] !== undefined &&
    notAnalyzed[0].file === "unowned.mjs" &&
    typeof notAnalyzed[0].reason === "string" &&
    notAnalyzed[0].reason.includes("is not owned by any project");
  if (!stray) {
    failures.push(
      "boundary-canary-unowned-file: expected coverage.notAnalyzed to name exactly the stray " +
        'file — unowned.mjs, reason reading "is not owned by any project". A file the ' +
        "project graph cannot place must be visible BY NAME. Got:",
    );
    failures.push(JSON.stringify(notAnalyzed, null, 2));
  }
  if (env.coverage?.analyzedFiles !== 1) {
    failures.push(
      `boundary-canary-unowned-file: expected coverage.analyzedFiles 1 — the owned, clean ` +
        `file beside the stray one must still be analyzed, or the refusal could not be ` +
        `attributed to the stray file. Got ${JSON.stringify(env.coverage?.analyzedFiles)}.`,
    );
  }
  if ((env.result?.violations ?? []).length !== 0) {
    failures.push(
      "boundary-canary-unowned-file: expected no violations — the owned file imports nothing, " +
        "so the refusal must be about ownership, not about the law. Got:",
    );
    failures.push(JSON.stringify(env.result?.violations, null, 2));
  }
}

// ── 3. A dynamic site is a named, declared blind spot — not a refusal ────
//
// Measured at this pin (0.27.0): exit 0, run status "ok", verdict "pass",
// coverage.complete TRUE — complete with exactly one blind spot, flagged
// `dynamic: true`, naming the import site's file and line.

const dynamic = runArchkeep("boundary-canary-dynamic-computed");
if (dynamic === null) {
  failures.push("archkeep could not run against tools/fixtures/boundary-canary-dynamic-computed");
} else if (dynamic.envelope === null) {
  failures.push(
    "boundary-canary-dynamic-computed: archkeep did not answer with the versioned JSON envelope the pinned contract names. It said:",
  );
  failures.push(dynamic.report.trim());
} else {
  const env =
    /** @type {{ status?: unknown, exitCode?: unknown, coverage?: { complete?: unknown, blindSpots?: { file?: unknown, line?: unknown, reason?: unknown, dynamic?: unknown }[] | null }, decision?: { verdict?: unknown } }} */ (
      dynamic.envelope
    );
  if (
    dynamic.status !== 0 ||
    env.exitCode !== 0 ||
    env.status !== "ok" ||
    env.decision?.verdict !== "pass" ||
    env.coverage?.complete !== true
  ) {
    failures.push(
      `boundary-canary-dynamic-computed: expected the declared-limit contract (exit 0, run ` +
        `status "ok", verdict "pass", coverage.complete true — a computed import is a ` +
        `documented blind spot, not a refusal), got exit ${String(dynamic.status)}, status ` +
        `${JSON.stringify(env.status)}, verdict ${JSON.stringify(env.decision?.verdict)}, ` +
        `complete ${JSON.stringify(env.coverage?.complete)}. The unresolved-import canary ` +
        `holds the OTHER half of this asymmetry; if this half moved, both moved — ` +
        `re-measure both, never absorb.`,
    );
  }
  const blindSpots = env.coverage?.blindSpots ?? [];
  const spot =
    blindSpots.length === 1 &&
    blindSpots[0] !== undefined &&
    blindSpots[0].file === "canary-dynamic/src/index.mjs" &&
    blindSpots[0].line === 22 &&
    blindSpots[0].dynamic === true &&
    typeof blindSpots[0].reason === "string" &&
    blindSpots[0].reason.includes("non-literal argument");
  if (!spot) {
    failures.push(
      "boundary-canary-dynamic-computed: expected exactly one blind spot — " +
        "canary-dynamic/src/index.mjs:22, dynamic: true, reason naming the non-literal " +
        "argument. A pass that stops NAMING the site is the silent hole this fixture exists " +
        "to forbid. Got:",
    );
    failures.push(JSON.stringify(blindSpots, null, 2));
  }
}

// ── 4. Tag comparison is exact, on both axes ─────────────────────────────
//
// Measured at this pin (0.27.0): exit 1, run status "findings", verdict
// "fail", coverage.complete true, and EXACTLY two violations, both
// `onlyTagsConstraintViolation` — canary-app -> canary-corex (the layer-axis
// impostor `layer:corex`) and canary-core -> canary-corex (the scope-axis
// impostor `scope:shared-2`) — while the control edge canary-app ->
// canary-core stays legal.

const tagged = runArchkeep("boundary-canary-tag-prefix");
if (tagged === null) {
  failures.push("archkeep could not run against tools/fixtures/boundary-canary-tag-prefix");
} else if (tagged.envelope === null) {
  failures.push(
    "boundary-canary-tag-prefix: archkeep did not answer with the versioned JSON envelope the pinned contract names. It said:",
  );
  failures.push(tagged.report.trim());
} else {
  const env =
    /** @type {{ status?: unknown, exitCode?: unknown, coverage?: { complete?: unknown } | null, decision?: { verdict?: unknown }, result?: { violations?: { sourceProject?: unknown, targetProject?: unknown, messageId?: unknown }[] } }} */ (
      tagged.envelope
    );
  const violations = env.result?.violations ?? [];
  if (
    tagged.status !== 1 ||
    env.exitCode !== 1 ||
    env.status !== "findings" ||
    env.decision?.verdict !== "fail" ||
    env.coverage?.complete !== true
  ) {
    failures.push(
      `boundary-canary-tag-prefix: expected the judged contract (exit 1, run status ` +
        `"findings", verdict "fail", coverage.complete true), got exit ` +
        `${String(tagged.status)}, status ${JSON.stringify(env.status)}, verdict ` +
        `${JSON.stringify(env.decision?.verdict)}, complete ` +
        `${JSON.stringify(env.coverage?.complete)}. Re-measure, never absorb.`,
    );
  }
  if (violations.length !== 2) {
    failures.push(
      `boundary-canary-tag-prefix: expected exactly two violations — the two impostor edges — ` +
        `got ${String(violations.length)}. One means an impostor edge went quiet (a prefix ` +
        `match, the fail-open this fixture exists to catch); three means the legal control ` +
        `edge was judged too. Got:`,
    );
    failures.push(JSON.stringify(violations, null, 2));
  }
  const edges = violations
    .map((v) => `${String(v.sourceProject)}->${String(v.targetProject)}`)
    .sort();
  const expectedEdges = JSON.stringify(["canary-app->canary-corex", "canary-core->canary-corex"]);
  if (
    JSON.stringify(edges) !== expectedEdges ||
    violations.some((v) => v.messageId !== "onlyTagsConstraintViolation")
  ) {
    failures.push(
      "boundary-canary-tag-prefix: expected the two impostor edges — canary-app -> " +
        "canary-corex (layer:corex is not layer:core) and canary-core -> canary-corex " +
        "(scope:shared-2 is not scope:shared) — each through onlyTagsConstraintViolation, " +
        "and no violation over the legal control edge canary-app -> canary-core. Tag " +
        "matching must be exact on both axes. Got:",
    );
    failures.push(JSON.stringify(violations, null, 2));
  }
}

// ── Verdict ───────────────────────────────────────────────────────────────

if (failures.length > 0) {
  for (const f of failures) console.error(`✗ ${f}`);
  console.error(
    "\nThe boundary gate no longer honors the contract a canary pins — " +
      "fix the gate, never the canary.",
  );
  process.exitCode = 1;
} else {
  console.log(
    "boundary-gate extended canaries: the exemption is refused, the unowned file is refused " +
      "by name, the dynamic site is a declared blind spot over a green verdict, and tag " +
      "matching is exact on both axes — the config contracts are loud.",
  );
}
