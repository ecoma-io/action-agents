#!/usr/bin/env node
/**
 * Resolves every `uses: ecoma-io/action-agents/<action>@<ref>` in README.md and
 * `docs/` against the tags and action manifests that actually exist at this ref.
 *
 * Kills the broken-example class permanently: a doc that pins `@v0.1` for an
 * action that ships only in `v0.6`, or cites `@v0.1.3` when no such release
 * exists, fails CI instead of reaching a first-contact user as an example that
 * cannot work.
 *
 * WHY THIS FILE STATES ITS COVERAGE. It previously carried the regex
 * `ecoma-io/reeve` while its own documentation said `ecoma-io/action-agents`,
 * so after the rename it matched nothing and printed "All documented uses: refs
 * resolve against real tags" on every run. A gate that goes red gets fixed; a
 * gate that reports green while checking nothing gets trusted. Two things now
 * make that failure impossible to repeat:
 *
 *   1. A clean run prints how many refs it found, how many it checked and how
 *      many were deliberately exempt. "No problems" is a claim about coverage
 *      as much as about correctness.
 *   2. Finding zero refs at all is a FAILURE, not a pass. README.md documents
 *      how to use these actions, so a scan that finds no `uses:` line has
 *      stopped reading the thing it exists to read.
 *
 * Lines may be exempted by appending the explicit marker `<!-- roadmap ref -->`
 * or `# roadmap ref` (or the `historical ref` forms) to the ref-bearing line —
 * the guard around a deliberately-future (`@v2`) or deliberately-historical
 * (`@v0.1`) example, never an accident.
 *
 * Checks, in order, one per `uses:` line:
 *   1. the ref names an action subdirectory — there is no action at the
 *      repository root, so `ecoma-io/action-agents@v1` can never resolve;
 *   2. the ref parses as a commit SHA (immutable, always valid), a `vX.Y` / `vX`
 *      floating tag, or a `vX.Y.Z` exact release;
 *   3. a SHA is treated as valid without further lookup;
 *   4. a tag ref must exist as a git tag at this moment;
 *   5. the action's own `action.yaml` must exist inside the tree at that tag —
 *      which is what catches an action documented before the release it debuts
 *      in.
 *
 * The facts are read from git and the filesystem by `readFacts`; the judgment
 * is the pure function `evaluate`, which takes those facts as arguments, so the
 * tests need no repository and no mocking library.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** A reference this gate owns and must resolve. */
export const REF = /uses:\s+ecoma-io\/action-agents(\/[a-z0-9-]+)?@([^\s#`,]+)/g;
/** Anything naming this repository in a shape the line above did not parse. */
export const UNPARSED = /uses:\s+ecoma-io\/action-agents?[^\s]*/g;
export const MARKER =
  /(?:<!--\s*(roadmap ref|historical ref)\s*-->|#\s*(roadmap ref|historical ref))/;

const SHA = /^[0-9a-f]{40}$/;
const FLOAT = /^v\d+(\.\d+)?$/;
const EXACT = /^v\d+\.\d+\.\d+$/;

/** The manifests an action may ship under. GitHub accepts either spelling. */
export const MANIFEST_NAMES = ["action.yaml", "action.yml"];

/**
 * @typedef {object} DocFile
 * @property {string} path path as it should be reported
 * @property {string} text the file's contents
 */

/**
 * @param {object} input
 * @param {DocFile[]} input.files
 * @param {Set<string>} input.tags every tag that exists right now
 * @param {(tag: string, action: string) => boolean} input.hasManifest whether `<action>/action.yaml` exists at a tag
 * @returns {{ failures: string[], found: number, checked: number, exempt: number }}
 */
export function evaluate({ files, tags, hasManifest }) {
  /** @type {string[]} */
  const failures = [];
  let found = 0;
  let checked = 0;
  let exempt = 0;

  for (const file of files) {
    for (const [index, line] of file.text.split(/\n/).entries()) {
      const where = `${file.path}:${String(index + 1)}`;

      const refs = [...line.matchAll(REF)];
      found += refs.length;

      // A line that names this repository but parses as no ref at all is the
      // rename failure this gate was blind to. Reported rather than ignored.
      if (refs.length === 0 && UNPARSED.test(line)) {
        failures.push(
          `${where}: names ecoma-io/action-agents but does not parse as ` +
            `\`ecoma-io/action-agents/<action>@<ref>\`. If the repository was renamed, ` +
            `this gate's REF pattern must be renamed with it.`,
        );
      }
      UNPARSED.lastIndex = 0;

      for (const match of refs) {
        const action = (match[1] ?? "").replace(/^\//, "");
        const ref = match[2] ?? "";

        if (MARKER.test(line)) {
          exempt += 1;
          continue;
        }
        checked += 1;

        if (action === "") {
          failures.push(
            `${where}: ecoma-io/action-agents@${ref} — there is no action at the repository ` +
              `root. Name the action's directory, e.g. ecoma-io/action-agents/review@${ref}.`,
          );
          continue;
        }
        if (SHA.test(ref)) continue;
        if (!FLOAT.test(ref) && !EXACT.test(ref)) {
          failures.push(`${where}: ecoma-io/action-agents/${action}@${ref} — unparseable ref.`);
          continue;
        }
        if (!tags.has(ref)) {
          failures.push(
            `${where}: ecoma-io/action-agents/${action}@${ref} — no such tag in this repository.`,
          );
          continue;
        }
        if (!hasManifest(ref, action)) {
          failures.push(
            `${where}: ecoma-io/action-agents/${action}@${ref} — no ${action}/action.yaml at ${ref}. ` +
              `The action likely debuts in a later tag.`,
          );
        }
      }
    }
  }

  // See point 2 in this file's header: a scan that read nothing has not passed.
  if (found === 0) {
    failures.push(
      "no `uses: ecoma-io/action-agents/<action>@<ref>` was found in README.md or docs/. " +
        "Either the documentation stopped showing how to use these actions, or this " +
        "gate's REF pattern no longer matches how they are written.",
    );
  }

  return { failures, found, checked, exempt };
}

/** Every tag in this repository, fresh from git — never a cached list. */
function readTags() {
  return new Set(execFileSync("git", ["tag"], { encoding: "utf8" }).split(/\n/).filter(Boolean));
}

/**
 * @param {string} tag
 * @param {string} action
 * @returns {boolean}
 */
function manifestExistsAtTag(tag, action) {
  return MANIFEST_NAMES.some((name) => {
    try {
      execFileSync("git", ["cat-file", "-e", `${tag}:${join(action, name)}`], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * README.md plus every markdown page under `docs/`, which may not exist.
 *
 * @returns {DocFile[]}
 */
function readDocFiles() {
  /** @type {string[]} */
  const paths = [];
  if (existsSync("README.md")) paths.push("README.md");
  if (existsSync("docs")) {
    for (const entry of readdirSync("docs", { recursive: true })) {
      const rel = String(entry);
      if (rel.endsWith(".md")) paths.push(join("docs", rel));
    }
  }
  return paths.map((path) => ({ path, text: readFileSync(path, "utf8") }));
}

function main() {
  const { failures, found, checked, exempt } = evaluate({
    files: readDocFiles(),
    tags: readTags(),
    hasManifest: manifestExistsAtTag,
  });

  if (failures.length > 0) {
    for (const failure of failures) console.error(`✗ ${failure}`);
    console.error(`\n${String(failures.length)} broken uses ref(s) in docs.`);
    process.exit(1);
  }

  console.log(
    `✔ ${String(checked)} documented uses: ref(s) resolve against real tags ` +
      `(${String(found)} found, ${String(exempt)} exempt by marker)`,
  );
}

/**
 * Whether this file was RUN rather than imported, compared on real paths. The
 * same shape as the two gates in `scripts/`, and not shared with them for the
 * same reason: a helper imported across the gates would make each one's
 * failure depend on a third file.
 *
 * @param {string} moduleUrl
 * @param {string | undefined} [argv1]
 * @returns {boolean}
 */
function isProgramEntry(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const real = (/** @type {string} */ path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(argv1) === real(fileURLToPath(moduleUrl));
}

if (isProgramEntry(import.meta.url)) main();
