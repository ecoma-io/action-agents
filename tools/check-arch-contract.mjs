// The contract gate for the Archkeep runtime-evidence reader.
//
// `core/src/architecture.mjs` reads a `archkeep delta` report envelope and
// the recipe's manifest, and judges the pair against the protocol this
// repository froze in its design record. Unit tests pin that judgement over
// hand-written bytes; this gate pins the bytes themselves — it grows real
// git trees in temp directories, runs the pinned devDependency against
// them, normalizes what came back, and diffs it against the goldens under
// `tools/fixtures/arch-reports/`. Measured, not assumed: every golden was
// blessed from a real run, and any drift is a contract change to be
// reviewed, never absorbed silently. `--bless` re-pins after a review.
//
// The scenarios, one per golden:
//
//   pass      — a clean tree whose head changes an owned file without
//               touching boundaries. Exit 0, status ok, verdict pass, every
//               bucket empty: the only shape a PASS verdict honestly comes
//               from.
//
//   findings  — the head introduces one relative import across projects.
//               Exit 1, status findings, verdict fail, exactly one
//               introduced row named by project, file, line and messageId —
//               the row `pass`'s absence of is the whole point of the
//               compare.
//
//   resolved  — the base held the illegal import and the head removes it.
//               Exit 0, status ok, verdict pass, one resolved row with its
//               base sites: a delta that only resolves is still a pass,
//               because the verdict is about what this change introduces.
//
//   no-verdict — a tracked file no project owns (no coverage.exempt for the
//               boundary law). The capture step refuses (exit 3, empty
//               bytes) and the delta answers a full no-verdict envelope:
//               exit 3, verdict unknown, a reason, coverage complete false,
//               the stray file named in notAnalyzed — and no result block.
//
//   no-envelope — a malformed boundary law. The delta refuses at load with
//               exit 3 and not one byte of JSON: the absent-envelope lane
//               the manifest's exit record exists to adjudicate.
//
//   family    — the baseline file is a `graph` envelope, not an evidence
//               snapshot. The delta refuses (exit 3, no JSON), naming the
//               family mismatch in stderr — the same law the reader enforces
//               one layer out, pinned here from the producer's side.
//
//   unchanged — the illegal import sits on BOTH sides of the compare: known
//               pre-existing debt. Exit 0, one unchanged row, no note — the
//               verdict is about what this change introduces, and this
//               change introduces nothing.
//
//   occurrence-growth — the base holds one illegal import, the head two (a
//               second file gains the same import): the same violation, more
//               occurrences. Exit 1, one introduced row whose reason names
//               the growth — the loud direction the producer pins.
//
//   occurrence-reduction — the base holds two illegal imports, the head one:
//               the violation shrank without resolving. Exit 0, one unchanged
//               row carrying the producer's verbatim occurrencesReduced note
//               — a shrink is never a resolution.
//
//   rename-pair — the head renames the project (b-lib → c-lib, root kept), so
//               the file, its import and its site stay byte-identical while
//               the violation's source identity moves. Exit 1: one introduced
//               row at the new name, one resolved row at the old name, over
//               identical sites — the move the reader pairs and a wash
//               rendering would hide.
//
//   waived    — the law carries a waiver for the importing file with a
//               far-future term (2999): the same introduction `findings`
//               shows, accepted. Exit 0, one introduced row annotated
//               waived with the covering row verbatim — path, messageId,
//               reason, expiresAt.
//
//   waiver-expired — the same trees and the same waiver, far-past term
//               (2000). Exit 1, one introduced row with waived false and NO
//               covering row — the producer annotates only active waivers,
//               so the re-assertion rides the non-waived lane and the pair
//               of goldens is the flip the run contract's waiver-time
//               sentence is about.
//
//   policy-changed — the law itself moves between the sides: the base side
//               was captured under a law that allowed b → a, the head judges
//               under the law that forbids it. Exit 0, one unchanged row,
//               policyChanged true with differing fingerprints — the debt is
//               the law's artifact, not this change's.
//
// Beyond the byte diff, each scenario feeds its real output through the
// reader with a manifest synthesized exactly as the recipe would write it,
// and the golden records what the reader said: verdict, staleness,
// incompleteness, and the derived counts (introduced, introducedWaived,
// resolved, unchanged, renamePairs, occurrencesReduced, custom and
// unresolvable counts) — the eleven-state arithmetic, pinned from the
// producer's own bytes. A golden the reader cannot reproduce from the bytes
// that produced it is a divergence, in either direction — the gate exists
// so the frozen protocol and the pinned tool cannot drift apart unannounced.
//
// Determinism is checked, not hoped for: the pass scenario's delta runs
// twice and the raw stdout bytes must be identical, and every commit the
// generator makes carries fixed author and committer dates so the tree's
// provenance is stable across machines. SHAs, paths and the tool version
// are normalized to placeholders in the goldens — everything else is
// verbatim, including the policy fingerprints.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readArchitectureReport } from "#core/architecture.mjs";
import { createWorkspace } from "#core/workspace.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const archkeepBin = join(repoRoot, "node_modules", ".bin", "archkeep");
const goldensDir = join(here, "fixtures", "arch-reports");

/** A fixed identity and clock: the generator owns every provenance fact. */
const GIT_DATES = {
  EMAIL: "contract@action-agents.invalid",
  NAME: "archkeep contract gate",
  BASE: "2026-01-01T00:00:00+00:00",
  HEAD: "2026-01-02T00:00:00+00:00",
};

// ── The fixture: one miniature workspace, judged from its own root ────────

/**
 * The project graph every scenario shares — the exempt-less variant omits
 * the coverage block, and `bName` re-names the b-lib project for the rename
 * scenario (the root stays `b-lib`, so files and sites stay byte-identical).
 *
 * @param {{ exemptLaw: boolean, bName?: string }} options
 */
function archkeepJson({ exemptLaw, bName = "b-lib" }) {
  const coverage = exemptLaw
    ? `,\n  "coverage": {\n    "exempt": [\n      { "path": "module-boundaries.config.mjs", "reason": "the boundary law itself, owned by no project" }\n    ]\n  }`
    : "";
  return `{\
\n  "projects": {\
\n    "declared": [\
\n      { "name": "a-lib", "root": "a-lib", "tags": ["scope:a"] },\
\n      { "name": "${bName}", "root": "b-lib", "tags": ["scope:b"] }\
\n    ]\
\n  }${coverage}\
\n}\n`;
}

const BOUNDARY_LAW = `\
export const depConstraints = [
  { sourceTag: "scope:a", onlyDependOnLibsWithTags: ["scope:a"], description: "a alone" },
  { sourceTag: "scope:b", onlyDependOnLibsWithTags: ["scope:b"], description: "b alone" },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: [],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`;

/**
 * The law the base side of the policy-changed scenario was captured under:
 * scope:b may depend on scope:a, so the illegal import below was legal when
 * the baseline was taken.
 */
const PERMISSIVE_LAW = `\
export const depConstraints = [
  { sourceTag: "scope:a", onlyDependOnLibsWithTags: ["scope:a"], description: "a alone" },
  {
    sourceTag: "scope:b",
    onlyDependOnLibsWithTags: ["scope:a", "scope:b"],
    description: "b may depend on a",
  },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: [],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`;

/**
 * The law with a waiver over the importing file, far-dated so the CLI's
 * un-injectable clock cannot flip the term between machines: 2999 is always
 * active, 2000 always expired.
 *
 * @param {string} expiresAt
 */
const waivedLaw = (expiresAt) => `${BOUNDARY_LAW}\
export const boundarySuppressions = [
  {
    path: "b-lib/src/index.mjs",
    messageId: "noRelativeOrAbsoluteImportsAcrossLibraries",
    reason: "accepted while the split lands",
    expiresAt: "${expiresAt}",
  },
];
`;

const MALFORMED_LAW =
  "export const depConstraints = [];\nexport const moduleBoundaryOptions = { allow: [] };\n";

const TSCONFIG = `\
{
  "compilerOptions": {
    "target": "es2024",
    "lib": ["es2024"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "allowJs": true,
    "checkJs": false,
    "noEmit": true,
    "skipLibCheck": true
  }
}
`;

const CLEAN_B = "export const b = 2;\n";
const ILLEGAL_B = 'import { a } from "../../a-lib/src/index.mjs";\nexport const b = 2;\n';
/** The same illegal import in a second b-lib file — a second occurrence, not a second violation. */
const ILLEGAL_EXTRA =
  'import { a } from "../../a-lib/src/index.mjs";\nexport const extra = true;\n';

// ── The scenarios ─────────────────────────────────────────────────────────

/**
 * @typedef {object} Scenario
 * @property {string} name
 * @property {{ exemptLaw: boolean }} graph
 * @property {string} baseB the b-lib content at the base commit
 * @property {string} headB the b-lib content at the head commit
 * @property {string} headA the a-lib content at the head commit
 * @property {"evidence" | "graph" | "none"} baseline which baseline the delta step reads
 * @property {boolean} malformedLaw whether the law is broken before the delta runs
 * @property {string | undefined} baseGraphBName the name the BASE side's graph gives the b-lib root — the rename scenario's old name
 * @property {string | undefined} headGraphBName the name the HEAD side's graph gives the b-lib root — the rename scenario's new name
 * @property {string | undefined} baseLaw the base side's boundary law — omitted means the shared law
 * @property {string | undefined} headLaw the head side's boundary law — omitted means the shared law
 * @property {string | undefined} baseExtraB the b-lib/src/extra.mjs content at the base commit — omitted writes no file
 * @property {string | undefined} headExtraB the b-lib/src/extra.mjs content at the head commit — omitted writes no file
 */

/** @type {Scenario[]} */
export const SCENARIOS = [
  {
    name: "pass",
    graph: { exemptLaw: true },
    baseB: CLEAN_B,
    headB: CLEAN_B,
    headA: "export const a = 1; // the head changes an owned file\n",
    baseline: "evidence",
    malformedLaw: false,
  },
  {
    name: "findings",
    graph: { exemptLaw: true },
    baseB: CLEAN_B,
    headB: ILLEGAL_B,
    headA: "export const a = 1;\n",
    baseline: "evidence",
    malformedLaw: false,
  },
  {
    name: "resolved",
    graph: { exemptLaw: true },
    baseB: ILLEGAL_B,
    headB: CLEAN_B,
    headA: "export const a = 1;\n",
    baseline: "evidence",
    malformedLaw: false,
  },
  {
    name: "no-verdict",
    graph: { exemptLaw: false },
    baseB: CLEAN_B,
    headB: CLEAN_B,
    headA: "export const a = 1;\n",
    baseline: "evidence",
    malformedLaw: false,
  },
  {
    name: "no-envelope",
    graph: { exemptLaw: true },
    baseB: CLEAN_B,
    headB: CLEAN_B,
    headA: "export const a = 1;\n",
    baseline: "evidence",
    malformedLaw: true,
  },
  {
    name: "family",
    graph: { exemptLaw: true },
    baseB: CLEAN_B,
    headB: CLEAN_B,
    headA: "export const a = 1;\n",
    baseline: "graph",
    malformedLaw: false,
  },
  {
    // Known pre-existing debt: the illegal import on both sides.
    name: "unchanged",
    graph: { exemptLaw: true },
    baseB: ILLEGAL_B,
    headB: ILLEGAL_B,
    headA: "export const a = 1;\n",
    baseline: "evidence",
    malformedLaw: false,
  },
  {
    // One occurrence at base, two at head: the same violation, grown.
    name: "occurrence-growth",
    graph: { exemptLaw: true },
    baseB: ILLEGAL_B,
    headB: ILLEGAL_B,
    headExtraB: ILLEGAL_EXTRA,
    headA: "export const a = 1;\n",
    baseline: "evidence",
    malformedLaw: false,
  },
  {
    // Two occurrences at base, one at head: shrinking, never resolved.
    name: "occurrence-reduction",
    graph: { exemptLaw: true },
    baseB: ILLEGAL_B,
    baseExtraB: ILLEGAL_EXTRA,
    headB: ILLEGAL_B,
    headA: "export const a = 1;\n",
    baseline: "evidence",
    malformedLaw: false,
  },
  {
    // The head renames the project, root kept: sites byte-identical, the
    // violation's source identity moves.
    name: "rename-pair",
    graph: { exemptLaw: true },
    baseGraphBName: "b-lib",
    headGraphBName: "c-lib",
    baseB: ILLEGAL_B,
    headB: ILLEGAL_B,
    headA: "export const a = 1;\n",
    baseline: "evidence",
    malformedLaw: false,
  },
  {
    // The same introduction `findings` shows, under an active acceptance.
    // The waiver law sits on BOTH sides, so the fingerprints agree and the
    // only difference from `waiver-expired` is the term.
    name: "waived",
    graph: { exemptLaw: true },
    baseB: CLEAN_B,
    headB: ILLEGAL_B,
    baseLaw: waivedLaw("2999-01-01T00:00:00Z"),
    headLaw: waivedLaw("2999-01-01T00:00:00Z"),
    headA: "export const a = 1;\n",
    baseline: "evidence",
    malformedLaw: false,
  },
  {
    // The same trees and waiver, term lapsed long ago: the re-assertion.
    name: "waiver-expired",
    graph: { exemptLaw: true },
    baseB: CLEAN_B,
    headB: ILLEGAL_B,
    baseLaw: waivedLaw("2000-01-01T00:00:00Z"),
    headLaw: waivedLaw("2000-01-01T00:00:00Z"),
    headA: "export const a = 1;\n",
    baseline: "evidence",
    malformedLaw: false,
  },
  {
    // The law moved between the sides: the debt is the law's artifact.
    name: "policy-changed",
    graph: { exemptLaw: true },
    baseB: ILLEGAL_B,
    headB: ILLEGAL_B,
    baseLaw: PERMISSIVE_LAW,
    headA: "export const a = 1;\n",
    baseline: "evidence",
    malformedLaw: false,
  },
];

// ── The generator: real git trees with owned provenance ───────────────────

/**
 * @typedef {object} GeneratedTree
 * @property {string} root
 * @property {string} baseCommit
 * @property {string} headCommit
 * @property {{ exit: number, stdout: string }} capture
 * @property {{ exitCode: number, stdout: string, stderr: string }} delta
 * @property {boolean} repeatable whether a second delta over the same tree produced byte-identical stdout
 */

/**
 * Grows one scenario's tree, captures its baseline and runs the delta step —
 * the recipe, by hand, with every commit the gate itself made.
 *
 * @param {Scenario} scenario
 * @returns {GeneratedTree}
 */
export function runScenario(scenario) {
  const root = mkdtempSync(join(tmpdir(), "arch-contract-"));
  const git = (/** @type {string[]} */ args, env = {}) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
  const commit = (message, date) => {
    // --allow-empty: some scenarios change nothing between the two commits —
    // the head commit exists for provenance, not for content.
    const run = git(["commit", "--quiet", "--allow-empty", "-m", message], {
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    });
    if (run.status !== 0) {
      throw new Error(`git commit failed: ${String(run.stderr || run.stdout)}`);
    }
  };

  // The base commit, then the baseline captured AT it — the recipe's order.
  writeTree(root, scenario, "base");
  git(["init", "--quiet", "-b", "main"]);
  git(["config", "user.email", GIT_DATES.EMAIL]);
  git(["config", "user.name", GIT_DATES.NAME]);
  git(["add", "-A"]);
  commit("base", GIT_DATES.BASE);
  const baseCommit = revParse(root, "HEAD");

  // The capture step — tolerated at exit {1,3} exactly as the recipe does,
  // and its exit is part of the pinned contract. The bytes stay untracked,
  // so the head side's provenance is not dirtied by them.
  const baselinePath = scenario.baseline === "graph" ? "graph-base.json" : "base.json";
  let capture = { exit: 0, stdout: "" };
  if (scenario.baseline === "graph") {
    // The family scenario's baseline is produced at head, below.
  } else {
    const taken = archkeep(root, ["delta", "--capture", "--format", "json"]);
    writeFileSync(join(root, baselinePath), taken.stdout);
    capture = { exit: taken.status ?? -1, stdout: taken.stdout };
  }

  // The head commit — the only side the delta judges.
  writeTree(root, scenario, "head");
  git(["add", "-A"]);
  commit("head", GIT_DATES.HEAD);
  const headCommit = revParse(root, "HEAD");

  if (scenario.baseline === "graph") {
    const graph = archkeep(root, ["graph", "--format", "json"]);
    writeFileSync(join(root, baselinePath), graph.stdout);
  }

  const delta = archkeep(root, ["delta", baselinePath, "--format", "json"]);
  // Determinism, checked not hoped for: a second delta over the same tree,
  // paths and all, must answer byte-identical stdout — the law the reader's
  // volatile-field strip defends one layer in. Same tree, so the only thing
  // that could differ is a clock or a seed in the envelope itself.
  const repeat = archkeep(root, ["delta", baselinePath, "--format", "json"]);
  return {
    root,
    baseCommit,
    headCommit,
    capture,
    delta: { exitCode: delta.status ?? -1, stdout: delta.stdout, stderr: delta.stderr },
    repeatable: repeat.stdout === delta.stdout && (repeat.status ?? -1) === (delta.status ?? -1),
  };
}

/**
 * Writes the scenario's files for one side of the compare. The head side of
 * a malformed-law scenario commits the broken law — the refusal then judges
 * a clean tree, not a dirty one. Per-side graph names, laws and extra files
 * are the delta-semantics scenarios' levers: a side falls back to the shared
 * fixture when its override is absent.
 *
 * @param {string} root
 * @param {Scenario} scenario
 * @param {"base" | "head"} side
 */
function writeTree(root, scenario, side) {
  mkdirSync(join(root, "a-lib", "src"), { recursive: true });
  mkdirSync(join(root, "b-lib", "src"), { recursive: true });
  const bName =
    side === "base" ? (scenario.baseGraphBName ?? "b-lib") : (scenario.headGraphBName ?? "b-lib");
  writeFileSync(join(root, "archkeep.json"), archkeepJson({ ...scenario.graph, bName }));
  const law =
    side === "base" ? (scenario.baseLaw ?? BOUNDARY_LAW) : (scenario.headLaw ?? BOUNDARY_LAW);
  writeFileSync(join(root, "module-boundaries.config.mjs"), law);
  writeFileSync(join(root, "tsconfig.base.json"), TSCONFIG);
  writeFileSync(
    join(root, "a-lib", "src", "index.mjs"),
    side === "base" ? "export const a = 1;\n" : scenario.headA,
  );
  writeFileSync(
    join(root, "b-lib", "src", "index.mjs"),
    side === "base" ? scenario.baseB : scenario.headB,
  );
  const extra = side === "base" ? scenario.baseExtraB : scenario.headExtraB;
  if (extra !== undefined) {
    writeFileSync(join(root, "b-lib", "src", "extra.mjs"), extra);
  } else {
    // A side that does not declare the extra occurrence must not inherit it
    // from the other side's write: the tree on disk is cumulative across the
    // two writes, the commit is not. The shrink scenario's whole point is
    // that the file is gone at head.
    rmSync(join(root, "b-lib", "src", "extra.mjs"), { force: true });
  }
  if (side === "head" && scenario.malformedLaw) {
    writeFileSync(join(root, "module-boundaries.config.mjs"), MALFORMED_LAW);
  }
}

/**
 * @param {string} root
 * @param {string} ref
 * @returns {string}
 */
function revParse(root, ref) {
  const run = spawnSync("git", ["rev-parse", ref], { cwd: root, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git rev-parse failed: ${String(run.stderr)}`);
  return String(run.stdout).trim();
}

/**
 * Runs the pinned archkeep binary against a tree.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function archkeep(cwd, args) {
  const run = spawnSync(archkeepBin, args, { cwd, encoding: "utf8" });
  if (run.error !== undefined) {
    throw new Error(`archkeep could not run: ${String(run.error.message)}`);
  }
  return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

// ── Normalization: placeholders for what a run makes, verbatim the rest ───

/**
 * @typedef {object} NormalizedResult
 * @property {number} captureExit
 * @property {number} exitCode
 * @property {number} stdoutBytes
 * @property {string} stderrDigest sha256 over the path-normalized stderr
 * @property {unknown} envelope the normalized envelope, or null when the delta produced no JSON
 * @property {{ verdict: string, stale: boolean, incompleteness: { reason: string, note: string } | null, counts: { introduced: number, introducedWaived: number, resolved: number, unchanged: number, renamePairs: number, occurrencesReduced: number, customFindings: { introduced: number, resolved: number, unchanged: number, unknown: number } | null, unresolvable: { introduced: number, resolved: number, unchanged: number, unknown: number } } }} reader
 */

/**
 * Normalizes one scenario's measured run into the golden shape: SHAs, tree
 * paths and the tool version become placeholders; volatile `*Ms`/`sampleTime`
 * fields are stripped; everything else is verbatim. The reader outcome is
 * measured over the raw bytes with a manifest exactly as the recipe writes
 * it — never derived from the normalized envelope.
 *
 * @param {Scenario} scenario
 * @param {GeneratedTree} run
 * @returns {NormalizedResult}
 */
export function normalizeResult(scenario, run) {
  const placeholders = new Map([
    [run.root, "@tree@"],
    [run.baseCommit, "@base-commit@"],
    [run.headCommit, "@head-commit@"],
  ]);
  const substitute = (/** @type {string} */ text) => {
    let out = text;
    for (const [value, placeholder] of placeholders) out = out.split(value).join(placeholder);
    return out;
  };

  let envelope = null;
  if (run.delta.stdout.trim().length > 0) {
    envelope = stripVolatile(JSON.parse(run.delta.stdout));
    // The version rides with the pin; the golden pins structure, and the
    // canary already pins the version where it is the fact under test.
    if (typeof envelope === "object" && envelope !== null) {
      if ("tool" in envelope && typeof envelope.tool === "object" && envelope.tool !== null) {
        envelope.tool.version = "@version@";
      }
      if (
        "result" in envelope &&
        typeof envelope.result === "object" &&
        envelope.result !== null &&
        "baseline" in envelope.result &&
        typeof envelope.result.baseline === "object" &&
        envelope.result.baseline !== null &&
        "tool" in envelope.result.baseline &&
        typeof envelope.result.baseline.tool === "object" &&
        envelope.result.baseline.tool !== null
      ) {
        envelope.result.baseline.tool.version = "@version@";
      }
    }
    envelope = JSON.parse(substitute(JSON.stringify(envelope)));
  }

  // The recipe's manifest, written the way the recipe writes it: the step's
  // real exit, the digest of its path-normalized stderr, both commits.
  const stderrText = substitute(run.delta.stderr);
  const manifest = JSON.stringify({
    exitCode: run.delta.exitCode,
    stderrDigest: sha256(stderrText),
    base: {
      capturePath: scenario.baseline === "graph" ? "graph-base.json" : "base.json",
      commit: run.baseCommit,
    },
    head: { commit: run.headCommit },
  });
  const reportPath = "report.json";
  const manifestPath = "manifest.json";
  writeFileSync(join(run.root, reportPath), run.delta.stdout);
  writeFileSync(join(run.root, manifestPath), manifest);
  const evidence = readArchitectureReport({
    workspace: createWorkspace({ root: run.root }),
    reportPath,
    manifestPath,
    expect: { headSha: run.headCommit },
  });

  return {
    captureExit: run.capture.exit,
    exitCode: run.delta.exitCode,
    stdoutBytes: Buffer.byteLength(run.delta.stdout, "utf8"),
    stderrDigest: sha256(stderrText),
    repeatable: run.repeatable,
    envelope,
    reader: {
      verdict: evidence.verdict,
      stale: evidence.stale,
      incompleteness: evidence.incompleteness,
      // The derived counts — the eleven-state arithmetic, measured from the
      // producer's own bytes through the reader's normalization. The
      // envelope half above pins the rows these counts are counted from.
      counts: {
        introduced: evidence.introduced.length,
        introducedWaived: evidence.introducedWaived,
        resolved: evidence.resolved.length,
        unchanged: evidence.unchangedCount,
        renamePairs: evidence.renamePairs.length,
        occurrencesReduced: evidence.occurrencesReduced.length,
        customFindings:
          evidence.customRules === null
            ? null
            : {
                introduced: evidence.customRules.findings.introduced.count,
                resolved: evidence.customRules.findings.resolved.count,
                unchanged: evidence.customRules.findings.unchanged.count,
                unknown: evidence.customRules.findings.unknown.count,
              },
        unresolvable: evidence.unresolvable,
      },
    },
  };
}

// ── Comparison and blessing ───────────────────────────────────────────────

/**
 * Compares a normalized result against a golden, returning null when they
 * agree or a human-readable divergence when they do not. The comparison is
 * canonical — key order is not a contract, so it is sorted away on both
 * sides before the diff.
 *
 * @param {string} name
 * @param {NormalizedResult} actual
 * @param {NormalizedResult | undefined} golden
 * @returns {string | null}
 */
export function compareGolden(name, actual, golden) {
  if (golden === undefined) {
    return `${name}: no golden under tools/fixtures/arch-reports/ — run 'pnpm arch:contract -- --bless' to pin it`;
  }
  if (canonical(actual) !== canonical(golden)) {
    const goldenText = `${JSON.stringify(golden, null, 2)}\n`;
    const actualText = `${JSON.stringify(actual, null, 2)}\n`;
    return `${name}: the measured contract diverged from the pinned golden — re-measure, never absorb:\n--- golden\n${goldenText}\n--- measured\n${actualText}`;
  }
  return null;
}

/**
 * A canonical JSON text: keys sorted recursively, no whitespace. Key order
 * is not part of any contract this gate pins.
 *
 * @param {unknown} value
 * @returns {string}
 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

/**
 * The gate itself: run every scenario, compare (or bless), and report.
 *
 * @param {{ bless: boolean }} options
 * @returns {number} the process exit code
 */
export function main(options) {
  /** @type {string[]} */
  const divergences = [];
  mkdirSync(goldensDir, { recursive: true });
  /** @type {string[]} */
  const blessed = [];
  for (const scenario of SCENARIOS) {
    const goldenPath = join(goldensDir, `${scenario.name}.json`);
    const run = runScenario(scenario);
    let actual;
    try {
      actual = normalizeResult(scenario, run);
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
    if (options.bless) {
      writeFileSync(goldenPath, `${JSON.stringify(actual, null, 2)}\n`);
      blessed.push(scenario.name);
      continue;
    }
    let golden;
    try {
      golden = JSON.parse(readFileSync(goldenPath, "utf8"));
    } catch {
      golden = undefined;
    }
    const divergence = compareGolden(scenario.name, actual, golden);
    if (divergence !== null) divergences.push(divergence);
  }
  if (options.bless) {
    console.log(
      `archkeep contract gate: blessed ${String(blessed.length)} goldens under tools/fixtures/arch-reports/ — ` +
        "commit them with the change that moved the contract.",
    );
    return 0;
  }
  if (divergences.length > 0) {
    for (const divergence of divergences) console.error(`✗ ${divergence}`);
    console.error(
      "\nThe pinned Archkeep contract moved — review the divergence, then re-pin with 'pnpm arch:contract -- --bless'.",
    );
    return 1;
  }
  console.log(
    `archkeep contract gate: ${String(SCENARIOS.length)} scenarios measured against their goldens — ` +
      "the reader's protocol and the pinned tool still agree.",
  );
  return 0;
}

// ── Small helpers ─────────────────────────────────────────────────────────

/**
 * @param {string} text
 * @returns {string}
 */
function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Strips volatile, time-relative fields (`sampleTime`, `*Ms`) deeply.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  /** @type {Record<string, unknown>} */
  const copy = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "sampleTime" || key.endsWith("Ms")) continue;
    copy[key] = stripVolatile(nested);
  }
  return copy;
}

// Script entry: only when invoked directly.
if (process.argv[1] !== undefined && process.argv[1].endsWith("check-arch-contract.mjs")) {
  const bless = process.argv.includes("--bless");
  process.exit(main({ bless }));
}
