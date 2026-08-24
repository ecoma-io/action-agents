#!/usr/bin/env node
// Fails when the vendored `arch-*` skills stop being an exact copy of the
// Archkeep release this repository pins.
//
// WHY THERE ARE TWO COPIES. The five skills come from `@ecoma-io/archkeep`,
// which is where the architecture law this repository is governed by lives
// (`archkeep.json`, `module-boundaries.config.mjs`, `pnpm arch`). A skill
// reaches an agent only from a directory that agent scans, and the three
// agents this repository supports do not scan the same one — measured on this
// machine, not assumed:
//
//   Claude Code 2.1.241   .claude/skills/   yes    .agents/skills/   NO
//   Codex 0.149.0         .claude/skills/   NO     .agents/skills/   yes
//   opencode 1.18.21      .claude/skills/   yes    .agents/skills/   yes
//
// So `.claude/skills/` and `.agents/skills/` together are the smallest set
// that reaches all three, and neither one alone reaches Claude Code and Codex
// both. opencode reads both and de-duplicates by skill name — one entry, and
// WHICH copy it resolves to varies between runs (it logs `duplicate skill
// name` naming whichever it saw first). That is precisely why this gate holds
// the two byte-identical rather than merely both-present: a reader must not be
// able to tell which one they got.
//
// WHY COPIES RATHER THAN A SYMLINK. Git on Windows without symlink support
// checks a symlink out as a plain text file holding a path. `.claude/skills/`
// would then contain five text files and no skill, and nothing would say so —
// a contributor on Windows would simply have no skills and no error. A copy
// checks out as files everywhere.
//
// WHY COMMITTED RATHER THAN GENERATED AT INSTALL TIME. The requirement is that
// anyone who clones this repository and opens one of the three agents sees the
// skills. A `postinstall` step would leave the window between `git clone` and
// `pnpm install` empty, which is exactly when a first-time contributor opens an
// agent to ask what this repository is.
//
// WHAT THIS GATE CATCHES, and why each case needs catching:
//
//   1. A hand-edit to a vendored file. These are not this repository's text to
//      edit — a fix belongs upstream in ecoma-io/archkeep, or it is lost on the
//      next sync. The hashes in `scripts/skills-manifest.json` make an edit
//      loud instead of silent.
//   2. The two trees drifting apart. Both are checked against the same hashes,
//      so one tree updated and the other forgotten fails here rather than
//      showing Codex one version of a skill and Claude Code another.
//   3. A `@ecoma-io/archkeep` bump with no re-sync. The manifest records the
//      version the copies were taken from; a dependency bump that leaves it
//      behind means the skills describe a CLI this repository no longer has.
//      This is the case a byte-comparison alone cannot see, because both
//      copies stay perfectly consistent while both go stale.
//
// The facts are read from the filesystem by `readFacts`; the judgment is the
// pure function `evaluate`, which takes those facts as arguments and returns
// verdicts, so the tests need no filesystem and no mocking library.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The upstream package the skills belong to. Its version in `devDependencies`
// is the pin the manifest is checked against — one place where "which Archkeep
// is this repository on" is written down, not two.
export const SOURCE_PACKAGE = "@ecoma-io/archkeep";
// Every directory a copy must exist in, in the order a failure lists them.
// Adding an agent that scans somewhere else is one entry here plus a re-sync.
export const SKILL_TREES = [".claude/skills", ".agents/skills"];
// Provenance and hashes, written by `sync-skills.mjs` and read by nothing else.
export const MANIFEST_PATH = "scripts/skills-manifest.json";

/**
 * The exact version `devDependencies` pins the skill source at.
 *
 * A range (`^0.13.0`, `~0.13.0`, `*`) is refused rather than resolved: this
 * gate's whole claim is that the vendored bytes came from ONE known release,
 * and a range means the installed CLI can move under the copies without any
 * file in the tree changing.
 *
 * @param {{devDependencies?: Record<string, string>, dependencies?: Record<string, string>}} packageJson
 * @returns {{version: string} | {error: string}} the pin, or why there is none
 */
export function pinnedSourceVersion(packageJson) {
  const declared =
    packageJson?.devDependencies?.[SOURCE_PACKAGE] ?? packageJson?.dependencies?.[SOURCE_PACKAGE];

  if (declared === undefined) {
    return {
      error: `${SOURCE_PACKAGE} is not a dependency, so the vendored skills have no source`,
    };
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(declared)) {
    return {
      error:
        `${SOURCE_PACKAGE} is pinned as "${declared}", which is a range: the vendored skills ` +
        `could then go stale without any file changing. Pin an exact version.`,
    };
  }
  return { version: declared };
}

/**
 * The hash the manifest records a file by. Content-addressed rather than
 * mtime- or size-addressed so that a reformat is a failure like any other
 * edit — Prettier reflowing a vendored skill is still this repository editing
 * a file it does not own.
 *
 * @param {string} text file contents
 * @returns {string} lowercase hex sha256
 */
export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Judges the vendored trees against the manifest and the manifest against the
 * dependency pin.
 *
 * The manifest carries two maps and they are not interchangeable. `skills` is
 * what came from upstream — the bytes this repository must not touch. `notes`
 * is what `sync-skills.mjs` wrote itself: the README standing beside those
 * files, saying at the place a reader actually lands what they are looking at
 * and why there are two of them. Both are hashed, because a note nobody may
 * edit by hand is still a note that must say the same thing in both trees; only
 * `skills` is counted as a skill.
 *
 * @param {object} facts
 * @param {{version: string} | {error: string}} facts.pinned result of `pinnedSourceVersion`
 * @param {{source?: {version?: string}, skills?: Record<string, string>, notes?: Record<string, string>} | null} facts.manifest parsed manifest, or null when unreadable
 * @param {Record<string, Record<string, string>>} facts.trees tree path → (relative path → contents)
 * @returns {{lines: string[], failures: string[]}} report lines and blocking failures
 */
export function evaluate({ pinned, manifest, trees }) {
  const lines = [];
  const failures = [];

  if (manifest === null) {
    return {
      lines: [`${MANIFEST_PATH} is missing or unreadable`],
      failures: [
        `${MANIFEST_PATH} could not be read, so nothing pins the vendored skills to a release. ` +
          `Run \`pnpm sync-skills\`.`,
      ],
    };
  }

  const vendored = manifest.skills ?? {};
  const expected = { ...vendored, ...(manifest.notes ?? {}) };
  const expectedPaths = Object.keys(expected).sort();
  const skillPaths = Object.keys(vendored);

  // An empty manifest would let every tree pass by having nothing to compare,
  // which reads exactly like a clean run. The skills are the reason this gate
  // exists; none of them is a failure, not a quiet success.
  if (skillPaths.length === 0) {
    failures.push(
      `${MANIFEST_PATH} records no skills, so this gate would pass on an empty tree. ` +
        `Run \`pnpm sync-skills\`.`,
    );
  }

  if ("error" in pinned) {
    failures.push(pinned.error);
  } else if (manifest.source?.version !== pinned.version) {
    failures.push(
      `the vendored skills were synced from ${SOURCE_PACKAGE}@${manifest.source?.version ?? "an unrecorded version"}, ` +
        `but this repository now pins ${pinned.version}. Run \`pnpm sync-skills\`.`,
    );
  }

  for (const tree of SKILL_TREES) {
    const actual = trees[tree] ?? {};
    const actualPaths = Object.keys(actual).sort();

    for (const path of expectedPaths) {
      if (!(path in actual)) {
        failures.push(`${tree}/${path} is missing. Run \`pnpm sync-skills\`.`);
        continue;
      }
      const digest = sha256(actual[path]);
      if (digest !== expected[path]) {
        failures.push(
          `${tree}/${path} does not match what \`pnpm sync-skills\` writes ` +
            `(expected sha256 ${expected[path].slice(0, 12)}…, found ${digest.slice(0, 12)}…). ` +
            (path in vendored
              ? `This file is a copy of ecoma-io/archkeep — fix it there and re-sync, not here.`
              : `This file is written by scripts/sync-skills.mjs — change it there, not here.`),
        );
      }
    }

    for (const path of actualPaths) {
      if (!(path in expected)) {
        failures.push(
          `${tree}/${path} is not part of the vendored release. Remove it, or re-sync if it is new upstream.`,
        );
      }
    }
  }

  const version = "error" in pinned ? "an unpinned version" : pinned.version;
  const count = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  lines.push(
    failures.length === 0
      ? `${count(skillPaths.length, "skill")} vendored from ${SOURCE_PACKAGE}@${version}, ` +
          `identical in ${SKILL_TREES.join(" and ")}`
      : `${count(failures.length, "problem")} with the vendored skills`,
  );
  return { lines, failures };
}

/**
 * Reads one skill tree as `relative path → contents`. Only `SKILL.md` files
 * one directory deep are collected, which is the layout every host requires:
 * a skill is `<name>/SKILL.md`, never a bare `<name>.md`. Anything else in the
 * tree is reported by `evaluate` as unexpected rather than ignored here — a
 * gate that silently skips what it does not recognise is a gate a stray file
 * walks past.
 *
 * @param {string} treePath tree directory, relative to the repository root
 * @returns {Record<string, string>} relative skill path → file contents
 */
function readSkillTree(treePath) {
  const absolute = join(root, treePath);
  const files = {};
  let entries;
  try {
    entries = readdirSync(absolute, { withFileTypes: true, recursive: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const relative = join(entry.parentPath ?? entry.path, entry.name).slice(absolute.length + 1);
    files[relative] = readFileSync(join(absolute, relative), "utf8");
  }
  return files;
}

/**
 * Deliberately untested: it exists to read four paths off disk, and a test that
 * stubbed the answer would only pin the stub. The real thing runs in CI against
 * the real tree.
 */
function readFacts() {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, MANIFEST_PATH), "utf8"));
  } catch {
    // Missing, or not JSON. Either way nothing pins the copies to a release,
    // which `evaluate` reports as the failure it is rather than as an absence
    // of anything to check.
    manifest = null;
  }

  const trees = {};
  for (const tree of SKILL_TREES) trees[tree] = readSkillTree(tree);

  return { pinned: pinnedSourceVersion(packageJson), manifest, trees };
}

function main() {
  const { lines, failures } = evaluate(readFacts());

  for (const line of lines) console.log(line);

  if (failures.length > 0) {
    console.error("");
    for (const failure of failures) console.error(`✗ ${failure}`);
    process.exit(1);
  }
}

/**
 * Whether this file was RUN rather than imported, compared on real paths.
 * See `check-docs-links.mjs` for the reason this exists and why it is not
 * shared.
 */
function isProgramEntry(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(argv1) === real(fileURLToPath(moduleUrl));
}

if (isProgramEntry(import.meta.url)) main();
