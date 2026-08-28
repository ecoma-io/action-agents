/**
 * The risk classifier — the code-owned authority for how risky a pull
 * request's changed files are. A fixed table of path heuristics turns the
 * changed-file list into a risk level, the lanes a review must run, and the
 * machine-readable signals that evidence both. The model is never in a
 * position to decide any of it: nothing here reads a thread, a diff body or
 * a repository file, `filename` is the only field that steers the result,
 * and a path is evidence, never instruction.
 *
 * Every rule is a plain test on the posix-normalised path, case-folded for
 * matching — whole segments for the rules that are about directory shape
 * (`auth`, `network`, `persistence`, `tests`), substrings for the ones that
 * are about content (`crypto`, `concurrency`). A backslash folds to a slash
 * before any of that, so `src\auth\login.ts` cannot hide from a rule, and a
 * signal carries the normalised path, which is what makes deduplication and
 * ordering well-defined. The tests are plain rather than glob patterns
 * because a fixed table needs no dialect, and the row itself — kind, lanes,
 * floor, predicate — is the seam a later config-driven table will widen.
 *
 * Aggregation is mechanical. Risk is the maximum floor any single file
 * earned, with one pinned promotion: a file that matches `ci-workflow` AND
 * `auth` or `crypto` is `critical` — the one combination that both ships
 * executable CI and sits on the credential surface. `network` shares the
 * security lane but is not a trigger, so a workflow under an `api/` segment
 * stays `high`. Lanes are the union, always including `correctness`,
 * reported in the fixed order below. Signals are deduplicated `(kind, path)`
 * pairs sorted byte-wise by kind then path — the same collation
 * `./order.mjs` gives the inventory — so two runs cannot disagree about what
 * the evidence was or where it sat.
 *
 * Miss risk is accepted and deliberate. The table is a floor of obvious
 * cases, not an exhaustive map of every dangerous change, and a risky file
 * no rule recognises lands at `low`; making the table config-extensible is
 * the later PR that widens that floor. It is not model judgement, which
 * would put the risk decision back where this module exists to keep it out.
 */

import { utf8Compare } from "./order.mjs";

/**
 * The structural subset of the forge's pull-request file the classifier
 * consumes. Declared locally rather than imported: the contract is exactly
 * the four fields the table can read, so the module reaches into nothing —
 * `core/` included.
 *
 * @typedef {object} ChangedFile
 * @property {string} filename the path at the reviewed head
 * @property {string} status the forge's change status (`added`, `modified`, …)
 * @property {number} additions lines added
 * @property {number} deletions lines removed
 */

/**
 * @typedef {"low" | "medium" | "high" | "critical"} RiskLevel
 */

/**
 * @typedef {"correctness" | "security" | "reliability" | "testing"} Lane
 */

/**
 * One piece of machine-readable evidence: the rule `kind` that fired, and
 * the normalised path it fired on.
 *
 * @typedef {object} Signal
 * @property {string} kind
 * @property {string} path
 */

/**
 * @typedef {object} RiskPlan
 * @property {RiskLevel} risk the maximum floor any file earned, `critical` per the pinned combination
 * @property {Lane[]} lanes the union over every matched rule, always including `correctness`
 * @property {Signal[]} signals deduplicated evidence, byte-wise by kind then path
 */

/**
 * Everything one file's rules test against, computed once: the normalised
 * path, its case-folded twin, the basename, and the segment list.
 *
 * @typedef {object} FileContext
 * @property {string} path the posix-normalised path, original case preserved
 * @property {string} lower the path case-folded, for the substring rules
 * @property {string} base the last path segment
 * @property {string} baseLower the basename case-folded
 * @property {string[]} segments the path split on slashes, empties dropped
 * @property {Set<string>} segmentSet the segments case-folded, for the segment rules
 */

/**
 * One row of the table: what it is called, what a match demands of the
 * review, and the predicate that decides membership. `risk` is a floor — a
 * file the rule matches cannot land below it.
 *
 * @typedef {object} RiskRule
 * @property {string} kind the signal kind the rule emits
 * @property {Lane[]} lanes the lanes the rule contributes
 * @property {RiskLevel} risk the floor a match earns
 * @property {(context: FileContext) => boolean} test
 */

/**
 * The one ordering risk levels mean, so "maximum" is a lookup rather than an
 * opinion.
 *
 * @type {Record<RiskLevel, number>}
 */
const RISK_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * The lane order a plan reports in, whatever order the rules matched in.
 *
 * @type {Lane[]}
 */
const LANES = ["correctness", "security", "reliability", "testing"];

/** Path segments that put a file on the credential surface. */
const AUTH_SEGMENTS = [
  "auth",
  "auths",
  "login",
  "logins",
  "session",
  "sessions",
  "token",
  "tokens",
  "permission",
  "permissions",
  "acl",
  "acls",
];

/** Path segments that name the HTTP surface. */
const NETWORK_SEGMENTS = ["api", "server", "http"];

/** Path segments that name persistence — the stores and the shape changes to them. */
const PERSISTENCE_SEGMENTS = ["migration", "migrations", "schema", "db", "database"];

/** Path segments that name a test tree. */
const TEST_SEGMENTS = ["test", "tests", "spec", "specs", "__tests__"];

/**
 * Classifies the changed files into a risk plan. Pure: no I/O, no clock, no
 * randomness — the same list always yields the same plan.
 *
 * @param {ChangedFile[]} files the forge's file list, in API order
 * @returns {RiskPlan}
 */
export function classifyRisk(files) {
  /** @type {Set<Lane>} */
  const laneSet = new Set(["correctness"]);
  /** @type {RiskLevel} */
  let risk = "low";
  /** @type {Signal[]} */
  const signals = [];
  const seen = new Set();
  for (const file of files) {
    const context = fileContext(file.filename);
    /** @type {RiskLevel} */
    let fileRisk = "low";
    let shipsWorkflow = false;
    let touchesCredentials = false;
    for (const rule of RULES) {
      if (!rule.test(context)) continue;
      if (rule.kind === "ci-workflow") shipsWorkflow = true;
      if (rule.kind === "auth" || rule.kind === "crypto") touchesCredentials = true;
      if (RISK_RANK[rule.risk] > RISK_RANK[fileRisk]) fileRisk = rule.risk;
      for (const lane of rule.lanes) laneSet.add(lane);
      const key = `${rule.kind}\u0000${context.path}`;
      if (!seen.has(key)) {
        seen.add(key);
        signals.push({ kind: rule.kind, path: context.path });
      }
    }
    // The pinned promotion, and the only road to `critical`: one file that
    // both ships a workflow and sits on the credential surface.
    if (shipsWorkflow && touchesCredentials) fileRisk = "critical";
    if (RISK_RANK[fileRisk] > RISK_RANK[risk]) risk = fileRisk;
  }
  signals.sort((a, b) => utf8Compare(a.kind, b.kind) || utf8Compare(a.path, b.path));
  return { risk, lanes: LANES.filter((lane) => laneSet.has(lane)), signals };
}

/**
 * The table. Order here is presentation only — every matching rule
 * contributes, and the plan sorts what comes out.
 *
 * @type {RiskRule[]}
 */
const RULES = [
  {
    kind: "ci-workflow",
    lanes: ["correctness", "reliability"],
    risk: "high",
    test: ({ path, baseLower }) =>
      path.startsWith(".github/workflows/") || /^action\.ya?ml$/.test(baseLower),
  },
  {
    kind: "auth",
    lanes: ["security"],
    risk: "high",
    test: ({ segmentSet }) => AUTH_SEGMENTS.some((segment) => segmentSet.has(segment)),
  },
  {
    kind: "crypto",
    lanes: ["security"],
    risk: "high",
    test: ({ lower }) => /crypt|cipher|hash|secret/.test(lower),
  },
  {
    kind: "network",
    lanes: ["reliability", "security"],
    risk: "medium",
    test: ({ segmentSet, baseLower }) =>
      NETWORK_SEGMENTS.some((segment) => segmentSet.has(segment)) ||
      /^(fetch|client|request)/.test(baseLower),
  },
  {
    kind: "persistence",
    lanes: ["reliability"],
    risk: "medium",
    test: ({ segmentSet, baseLower }) =>
      PERSISTENCE_SEGMENTS.some((segment) => segmentSet.has(segment)) || /\.sql$/.test(baseLower),
  },
  {
    kind: "dependencies",
    lanes: ["reliability"],
    risk: "medium",
    test: ({ baseLower }) => baseLower === "package.json" || baseLower === "pnpm-lock.yaml",
  },
  {
    kind: "release",
    lanes: ["reliability"],
    risk: "low",
    test: ({ baseLower }) =>
      /^release-please/.test(baseLower) ||
      /^\.release/.test(baseLower) ||
      baseLower === "version" ||
      baseLower === "version.txt" ||
      baseLower === "version.json",
  },
  {
    kind: "concurrency",
    lanes: ["reliability"],
    risk: "low",
    // The lockfile manifest is the dependencies rule's evidence, not a
    // runtime lock, so the lock keyword leaves it alone.
    test: ({ lower, baseLower }) =>
      baseLower !== "pnpm-lock.yaml" && /concurren|lock|mutex|queue|state/.test(lower),
  },
  {
    kind: "api-surface",
    lanes: ["correctness"],
    risk: "low",
    test: ({ path, baseLower }) => !path.includes("/") && /^index\./.test(baseLower),
  },
  {
    kind: "tests",
    lanes: ["testing"],
    risk: "low",
    test: ({ segmentSet, baseLower }) =>
      TEST_SEGMENTS.some((segment) => segmentSet.has(segment)) || /\.(test|spec)\./.test(baseLower),
  },
];

/**
 * Computes one file's context. A missing name degrades to the empty string,
 * which matches nothing — an odd shape costs a baseline file, never a throw.
 *
 * @param {string} filename
 * @returns {FileContext}
 */
function fileContext(filename) {
  const path = normalise(filename);
  const base = basename(path);
  const segments = path.split("/").filter((segment) => segment !== "");
  return {
    path,
    lower: path.toLowerCase(),
    base,
    baseLower: base.toLowerCase(),
    segments,
    segmentSet: new Set(segments.map((segment) => segment.toLowerCase())),
  };
}

/**
 * Posix-normalises a filename: backslashes fold to slashes, repeated slashes
 * collapse, and one leading `./` or `/` is dropped. A leading dot survives —
 * `.github` is a name, not a here-marker — so a top-level file is one with
 * no slash left in it.
 *
 * @param {string} filename
 * @returns {string}
 */
function normalise(filename) {
  return String(filename ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.?\//, "");
}

/**
 * The last path segment, or the whole path when there is no slash — the
 * shape the basename rules test.
 *
 * @param {string} path a normalised posix path
 * @returns {string}
 */
function basename(path) {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}
