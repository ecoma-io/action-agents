/**
 * The deterministic PR-side signals: scope facts, risk categories,
 * dependency/release signals, readiness, and review routing. Everything here
 * is computed by code from the forge reads in `evidence.pr` and `evidence.files`
 * — the model contributes a separate bounded judgement (`parsePrDimension`)
 * that lands in `assessment.dimensions.pr` alongside these facts. No signal
 * in this module can mutate anything: the caller (policy) turns them into
 * rationale/comment text at most.
 *
 * Review routing is deliberately OFF unless the config declares a reviewer
 * mapping, and even then this module only reports expected/missing coverage —
 * it never assigns and never @mentions.
 */

/** Path prefixes that read like generated output rather than hand-written source. */
const GENERATED_FILE_PATTERNS = [
  /(^|\/)(dist|build|out|target|coverage|\.next|\.nuxt)\//,
  /(^|\/)vendor\//,
  /\.(min|bundle)\.(js|css)$/,
  /(^|\/)generated\//,
];

/** Path patterns that surface an API surface a consumer may depend on. */
const API_SURFACE_PATTERNS = [
  /(^|\/)src\/(index|api|client|server)\./,
  /(^|\/)api\//,
  /(^|\/)(openapi|swagger)\.[^.]+$/,
];

/** Path patterns that change a migration/schema — a compatibility risk. */
const MIGRATION_SCHEMA_PATTERNS = [
  /(^|\/)migrations?\//,
  /(^|\/)(schema|migration)\.[^.]+$/,
  /prisma\/migrations?/,
  /\.sql$/,
];

/** Path patterns that touch authentication or security-sensitive logic. */
const AUTH_SECURITY_PATTERNS = [
  /(^|\/)auth[^/]*\//,
  /(^|\/)src\/auth/,
  /(^|\/)security/,
  /(rbac|acl|permissions?|oauth|oidc|jwt)[^/]*\./i,
];

/** Path patterns that describe a dependency manifest. */
const DEPENDENCY_PATTERNS = [
  /(^|\/)(package\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|go\.mod|go\.sum|Cargo\.(toml|lock)|requirements.*\.txt|pyproject\.toml|poetry\.lock)$/i,
];

/** The lockfile paths that make a diff lockfile-only. */
const LOCKFILE_ONLY_MARKERS = [
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)Cargo\.lock$/,
];

/** A path that looks like a test file, for the tests-present readiness signal. */
const TEST_FILE_PATTERNS = [
  /\.(test|spec)\./,
  /(^|\/)(tests?|__tests__|spec|test|e2e|integration)\//,
  /(^|\/)(cypress|playwright)\//,
];

/**
 * @typedef {object} PrSignals
 * @property {object} scope
 * @property {number} scope.fileCount
 * @property {number} scope.totalAdditions
 * @property {number} scope.totalDeletions
 * @property {string[]} scope.categories the path categories the diff touches — "code", "docs", "config", "generated", "lockfile", "assets", "tests", "other"
 * @property {boolean} scope.lockfileOnly the diff is nothing but a lockfile
 * @property {object} risk
 * @property {string[]} risk.categories the present risk categories — "api-surface", "migration-schema", "auth-security", "generated-files", "lockfile", "dependency"
 * @property {Array<{ package: string, from: string, to: string, file: string }>} risk.majorVersionBumps deterministic major-version upgrades read from dependency-manifest patch hunks — bounded, never a full resolver
 * @property {object} dependency
 * @property {boolean} dependency.releasePlease the base branch names the release-please convention
 * @property {boolean} dependency.lockfileOnly the diff is nothing but a lockfile
 * @property {object} readiness
 * @property {boolean} readiness.draft
 * @property {boolean} readiness.merged
 * @property {boolean | null} readiness.mergeable null while the forge computes it
 * @property {boolean} readiness.hasConflicts
 * @property {boolean} readiness.testsPresent a test-path heuristic, never certainty
 * @property {boolean} readiness.descriptionPresent presence-only — an empty description is a fact
 * @property {{ present: boolean, failing: number, pending: number, success: number }} readiness.checks the head's check-run rollup, when the forge reports one
 * @property {boolean} readiness.ready derived: not a draft, no conflicts, no failing checks, mergeability not false — a signal, never an action
 * @property {object} routing
 * @property {boolean} routing.active false unless a reviewer mapping exists
 * @property {string[]} routing.requested logins asked to review
 * @property {string[]} routing.reviewed the decision states ("APPROVED", "CHANGES_REQUESTED") already submitted — coverage only, never logins to address
 */

/**
 * Computes the deterministic PR signals from the evidence.
 *
 * @param {import("./evidence.mjs").Evidence} evidence
 * @returns {PrSignals}
 */
export function computePrSignals(evidence) {
  const files = evidence.files;
  const pr = evidence.pr;

  const scope = scopeOf(files);
  const readiness = readinessOf(pr, files);
  const releasePlease =
    typeof pr?.base?.ref === "string" && /release-please--branches--/.test(pr.base.ref);

  return {
    scope,
    risk: riskOf(files),
    dependency: {
      releasePlease,
      lockfileOnly: scope.lockfileOnly,
    },
    readiness,
    routing: routingOf(pr),
  };
}

/**
 * @param {import("./evidence.mjs").PullRequestFile[]} files
 */
function scopeOf(files) {
  let additions = 0;
  let deletions = 0;
  /** @type {Set<string>} */
  const categories = new Set();
  for (const file of files) {
    additions += file.additions || 0;
    deletions += file.deletions || 0;
    categories.add(categoryOf(file.filename));
  }
  const lockfileOnly =
    files.length > 0 &&
    files.every((file) => LOCKFILE_ONLY_MARKERS.some((re) => re.test(file.filename)));
  return {
    fileCount: files.length,
    totalAdditions: additions,
    totalDeletions: deletions,
    categories: [...categories],
    lockfileOnly,
  };
}

/**
 * @param {string} filename
 * @returns {string}
 */
function categoryOf(filename) {
  if (LOCKFILE_ONLY_MARKERS.some((re) => re.test(filename))) return "lockfile";
  if (TEST_FILE_PATTERNS.some((re) => re.test(filename))) return "tests";
  if (GENERATED_FILE_PATTERNS.some((re) => re.test(filename))) return "generated";
  if (/\.(md|mdx|txt)$/i.test(filename) || /(^|\/)(docs?|\.github)\//i.test(filename)) {
    return "docs";
  }
  if (/\.(json|ya?ml|toml|ini|config|conf|env)$/i.test(filename)) return "config";
  if (/\.(png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf)$/i.test(filename)) return "assets";
  if (
    /\.(js|mjs|cjs|ts|tsx|jsx|rs|go|py|java|kt|rb|php|c|cpp|h|cs|swift|sh|sql)$/i.test(filename)
  ) {
    return "code";
  }
  return "other";
}

/**
 * The leading numeric major of a semver-ish version fragment, or null when
 * the fragment is not a version (a tag like `latest`, a URL, a git ref).
 * Requires a full `x.y.z` body so `"resolved": "https://…"` never matches.
 *
 * @param {string} version
 * @returns {number | null}
 */
function majorOf(version) {
  const m = /([0-9]+)\.([0-9]+)\.([0-9]+)/.exec(version);
  const major = m?.[1];
  return major === undefined ? null : Number(major);
}

/**
 * Pulls a `{name, version, major}` dependency reading out of one manifest
 * diff line (the `+`/`-` marker already stripped). Handles three shapes the
 * forge ships: a JSON `"name": "range"` pair, a lockfile `"name@range"` key,
 * and a `go.mod`-style `name v1.2.3`. Metadata keys (the manifest's own
 * `version`, `name`, `engines`, …) are refused so they never read as a
 * dependency bump. Returns null when the line carries no versioned dependency.
 *
 * @param {string} rawLine a manifest diff line, the `+`/`-` marker already stripped
 * @returns {{ name: string, version: string, major: number } | null}
 */
function parseManifestDependency(rawLine) {
  const line = rawLine.trim();
  const json = /^"([^"]+)":\s*"([^"]+)"/.exec(line);
  if (json) {
    const name = json[1];
    const version = json[2];
    if (name === undefined || version === undefined) return null;
    // The manifest's own top-level metadata fields are not dependencies.
    if (
      name === "version" ||
      name === "name" ||
      name === "description" ||
      name === "main" ||
      name === "module" ||
      name === "types" ||
      name === "typings" ||
      name === "license" ||
      name === "author" ||
      name === "engines" ||
      name === "packageManager" ||
      name === "type"
    ) {
      return null;
    }
    const major = majorOf(version);
    return major === null ? null : { name, version, major };
  }
  const lock = /^"([^"@]+)@(?:[^"0-9]*)([0-9]+\.[0-9]+\.[0-9]+)"/.exec(line);
  if (lock) {
    const name = lock[1];
    const version = lock[2];
    if (name === undefined || version === undefined) return null;
    const major = Number(version.split(".")[0]);
    return { name, version, major };
  }
  const go = /^(\S+)\s+v?([0-9]+\.[0-9]+\.[0-9]+)/.exec(line);
  if (go) {
    const name = go[1];
    const version = go[2];
    // The `go` directive (go.mod's own language version) is not a dependency.
    if (name === undefined || version === undefined || name === "go") return null;
    const major = Number(version.split(".")[0]);
    return { name, version, major };
  }
  return null;
}

/**
 * The most major-version bumps disclosed per diff — a bound so a hostile or
 * enormous manifest cannot grow the payload without limit.
 */
const MAX_MAJOR_BUMPS = 20;

/**
 * @param {import("./evidence.mjs").PullRequestFile[]} files
 */
function riskOf(files) {
  /** @type {Set<string>} */
  const categories = new Set();
  /** @type {Array<{ package: string, from: string, to: string, file: string }>} */
  const majorVersionBumps = [];
  for (const file of files) {
    if (API_SURFACE_PATTERNS.some((re) => re.test(file.filename))) categories.add("api-surface");
    if (MIGRATION_SCHEMA_PATTERNS.some((re) => re.test(file.filename)))
      categories.add("migration-schema");
    if (AUTH_SECURITY_PATTERNS.some((re) => re.test(file.filename)))
      categories.add("auth-security");
    if (GENERATED_FILE_PATTERNS.some((re) => re.test(file.filename)))
      categories.add("generated-files");
    if (LOCKFILE_ONLY_MARKERS.some((re) => re.test(file.filename))) categories.add("lockfile");
    if (DEPENDENCY_PATTERNS.some((re) => re.test(file.filename))) categories.add("dependency");
    // Major-version detection is bounded to dependency manifest patch hunks —
    // pure version regex over the diff text, never fed to the model.
    if (
      typeof file.patch === "string" &&
      DEPENDENCY_PATTERNS.some((re) => re.test(file.filename))
    ) {
      /** @type {Map<string, { version: string, major: number }>} */
      const removed = new Map();
      /** @type {Map<string, { version: string, major: number }>} */
      const added = new Map();
      for (const raw of file.patch.split(/\r?\n/)) {
        const header = raw[0];
        if (header === "+") {
          const dep = parseManifestDependency(raw.slice(1));
          if (dep) added.set(dep.name, { version: dep.version, major: dep.major });
        } else if (header === "-") {
          const dep = parseManifestDependency(raw.slice(1));
          if (dep) removed.set(dep.name, { version: dep.version, major: dep.major });
        }
      }
      for (const [name, now] of added) {
        const before = removed.get(name);
        if (before && now.major > before.major) {
          majorVersionBumps.push({
            package: name,
            from: before.version,
            to: now.version,
            file: file.filename,
          });
        }
      }
    }
  }
  majorVersionBumps.length = Math.min(majorVersionBumps.length, MAX_MAJOR_BUMPS);
  return { categories: [...categories], majorVersionBumps };
}

/**
 * @param {import("./evidence.mjs").PrEvidence | null} pr
 * @param {import("./evidence.mjs").PullRequestFile[]} files
 */
function readinessOf(pr, files) {
  const checks = pr?.checks ?? null;
  const byConclusion = checks?.byConclusion ?? {};
  const failing =
    (byConclusion["failure"] ?? 0) +
    (byConclusion["action_required"] ?? 0) +
    (byConclusion["timed_out"] ?? 0);
  const pending = (byConclusion["pending"] ?? 0) + (byConclusion["cancelled"] ?? 0);
  const success = byConclusion["success"] ?? 0;
  const present = (checks?.total ?? 0) > 0;
  const draft = pr?.draft ?? false;
  const merged = pr?.merged ?? false;
  const mergeable = pr?.mergeable ?? null;
  const hasConflicts = pr?.hasConflicts ?? false;
  // Without PR evidence there are no facts to vouch for — readiness is a
  // claim, so it stays false rather than defaulting to true on nothing.
  // Absent check data is ABSENT, never green: a forge-error read (checks
  // null) and a genuinely CI-less repo (total 0) both leave ready false.
  const ready =
    pr !== null &&
    !draft &&
    !hasConflicts &&
    !merged &&
    (mergeable === null || mergeable) &&
    checks !== null &&
    present &&
    failing === 0;
  return {
    draft,
    merged,
    mergeable,
    hasConflicts,
    testsPresent: files.some((file) => TEST_FILE_PATTERNS.some((re) => re.test(file.filename))),
    descriptionPresent: typeof pr?.body === "string" && pr.body.trim() !== "",
    checks: { present, failing, pending, success },
    ready,
  };
}

/**
 * @param {import("./evidence.mjs").PrEvidence | null} pr
 */
function routingOf(pr) {
  /** @type {string[]} */
  const reviewed = [];
  for (const review of pr?.reviews ?? []) {
    if (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED")
      reviewed.push(review.state);
  }
  return {
    // OFF by default: no reviewer mapping is declared in the shipped config,
    // and triage never assigns or @mentions even when active.
    active: false,
    requested: pr?.reviewRequested ?? [],
    reviewed,
  };
}
