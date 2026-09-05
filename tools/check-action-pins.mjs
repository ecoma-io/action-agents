#!/usr/bin/env node
/**
 * Judges every action pin the covered documents show against one manifest, in
 * both directions.
 *
 * `tools/action-pins.json` is the single source of truth for the pins a
 * consumer may copy out of README.md, README.vi.md and the guides under
 * `docs/guides/`: the floating minor line the examples pin, the exact release
 * the pinning tables show, and the release the root-stub section cites. This
 * gate fails when the two drift apart in either direction:
 *
 *   1. a document shows a pin the manifest does not declare — the stale
 *      `@v0.5` examples #346 was filed over, caught at the next release
 *      instead of by the next audit; and
 *   2. the manifest declares a pin no covered document shows — a stale
 *      declaration, meaning the manifest was bumped without the documents
 *      (or a pin stopped being documented at all).
 *
 * WHY A MANIFEST AND NOT "PIN THE LATEST TAG". Deciding what "current" means
 * is a release decision, not something a grep can derive — the issue text's
 * own suggestion (@v0.9) was stale within hours of filing, because v0.10.0
 * shipped the same day. Bumping three fields in one JSON file on every
 * release is the whole maintenance cost, and release-please PRs are already
 * where version edits belong.
 *
 * Coverage is explicit: `DOC_PATHS` below names every file the gate reads. A
 * file on the list that is missing from the tree fails the run rather than
 * quietly shrinking coverage. The list starts exactly where #346 found the
 * drift; `docs/guides/harmonise.md` is the known next candidate — widening
 * the gate to it is one line here plus aligning that page's pins.
 *
 * Refs are matched in the same shape the documents actually write them —
 * `ecoma-io/action-agents[/action]@ref` — inside prose, tables and YAML
 * blocks alike, so a pin in a pinning-table row is judged exactly like one
 * in a `uses:` line. A SHA-shaped ref (six to forty hex characters) is
 * exempt without a manifest entry: it is immutable by definition. A line
 * carrying the explicit `<!-- historical ref -->` or `# roadmap ref` marker
 * is exempt the same way `check-uses-refs` exempts its future-facing refs —
 * a claim someone wrote down, counted in the output rather than passed in
 * silence.
 *
 * The facts are read from the filesystem by `readDocFiles` and `main`; the
 * judgment is the pure function `evaluate`, which takes those facts as
 * arguments, so the tests need no repository and no mocking library.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The documents the manifest governs, in the order the gate reports them.
 * Everything here is consumer-facing prose a reader copies a pin out of.
 *
 * @type {string[]}
 */
export const DOC_PATHS = [
  "README.md",
  "README.vi.md",
  "docs/guides/getting-started.md",
  "docs/guides/review.md",
  "docs/guides/triage.md",
];

/** Where the single source of truth lives, relative to the repository root. */
export const MANIFEST_PATH = "tools/action-pins.json";

/**
 * A pin this gate owns: `ecoma-io/action-agents[/action]@ref`. The action
 * segment is optional (the root stub is pinned bare) and not part of the
 * judgment — the ref is what the manifest declares.
 */
export const REF = /ecoma-io\/action-agents(?:\/([a-z0-9-]+))?@([A-Za-z0-9][A-Za-z0-9._-]*)/g;

/** A commit SHA — six to forty hex characters. Immutable, never declared. */
const SHA = /^[0-9a-f]{6,40}$/;
/** A floating minor tag: `v0.10`. */
const FLOAT = /^v\d+\.\d+$/;
/** An exact release tag: `v0.10.0`. */
const EXACT = /^v\d+\.\d+\.\d+$/;

/**
 * The same exemption markers `check-uses-refs` honours, in both the HTML
 * comment and the shell-comment form.
 */
export const MARKER =
  /(?:<!--\s*(?:roadmap ref|historical ref)\s*-->|#\s*(?:roadmap ref|historical ref))/;

/**
 * The pins a document may show, as parsed from the manifest.
 *
 * @typedef {object} Pins
 * @property {string} floating the current minor line the examples pin (`v0.10`)
 * @property {string} exact the exact release the pinning tables show (`v0.10.0`)
 * @property {string} rootExact the release the root-stub section cites (`v0.10.0`)
 */

/**
 * Parses and shape-checks the manifest text. Throws with a message a
 * maintainer can act on — a manifest this gate cannot trust must stop the
 * gate, never silently narrow it.
 *
 * @param {string} text the raw manifest file contents
 * @returns {Pins}
 */
export function parseManifest(text) {
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${MANIFEST_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${MANIFEST_PATH} must hold a JSON object with floating, exact and rootExact.`);
  }
  const { floating, exact, rootExact } = /** @type {Record<string, unknown>} */ (raw);
  for (const [field, value] of [
    ["floating", floating],
    ["exact", exact],
    ["rootExact", rootExact],
  ]) {
    if (typeof value !== "string" || value === "") {
      throw new Error(`${MANIFEST_PATH}: '${field}' must be a non-empty version string.`);
    }
  }
  if (!FLOAT.test(/** @type {string} */ (floating))) {
    throw new Error(
      `${MANIFEST_PATH}: 'floating' must be a minor tag like 'v0.10', got '${floating}'.`,
    );
  }
  for (const field of ["exact", "rootExact"]) {
    const value = /** @type {Record<string, unknown>} */ (raw)[field];
    if (!EXACT.test(/** @type {string} */ (value))) {
      throw new Error(
        `${MANIFEST_PATH}: '${field}' must be an exact release tag like 'v0.10.0', got '${value}'.`,
      );
    }
  }
  return {
    floating,
    exact: /** @type {string} */ (exact),
    rootExact: /** @type {string} */ (rootExact),
  };
}

/**
 * The minor number of a `v<major>.<minor>[.<patch>]` tag.
 *
 * @param {string} ref
 * @returns {string}
 */
function minorOf(ref) {
  return ref.split(".").slice(0, 2).join(".");
}

/**
 * @param {object} input
 * @param {{ path: string, text: string }[]} input.files the covered documents
 * @param {Pins} input.pins the parsed manifest
 * @returns {{
 *   failures: string[],
 *   found: number,
 *   checked: number,
 *   shaExempt: number,
 *   markerExempt: number,
 *   declared: string[],
 * }}
 */
export function evaluate({ files, pins }) {
  /** @type {string[]} */
  const failures = [];
  const declared = [pins.floating, pins.exact, pins.rootExact];
  const declaredSet = new Set(declared);
  /** Every declared value at least one document shows. */
  const used = new Set();
  let found = 0;
  let checked = 0;
  let shaExempt = 0;
  let markerExempt = 0;

  for (const file of files) {
    for (const [index, line] of file.text.split(/\n/).entries()) {
      const where = `${file.path}:${String(index + 1)}`;
      for (const match of line.matchAll(REF)) {
        found += 1;
        const action = match[1] ?? "";
        const ref = match[2] ?? "";

        if (MARKER.test(line)) {
          markerExempt += 1;
          continue;
        }
        if (SHA.test(ref)) {
          shaExempt += 1;
          continue;
        }
        if (!FLOAT.test(ref) && !EXACT.test(ref)) {
          failures.push(
            `${where}: ecoma-io/action-agents/${action}@${ref} — a ref shape this gate does not ` +
              `parse. Declare it in ${MANIFEST_PATH}, mark the line \`<!-- historical ref -->\`, ` +
              `or teach this gate the shape.`,
          );
          continue;
        }
        checked += 1;
        if (declaredSet.has(ref)) {
          used.add(ref);
          continue;
        }
        failures.push(
          `${where}: pin \`${action === "" ? "" : `${action}@`}${ref}\` is not declared in ` +
            `${MANIFEST_PATH} — the manifest declares ${formatDeclared(declared)}. Update the ` +
            `document to a declared pin, or declare the pin in the manifest and show it.`,
        );
      }
    }
  }

  // Direction 2: a declared pin nothing shows is a stale declaration. The
  // exact and root-example slots usually hold the same release, so the check
  // is per distinct value with the declaring fields named — one coherent
  // complaint instead of two identical lines.
  /** @type {Map<string, string[]>} */
  const fieldsByValue = new Map();
  for (const [field, ref] of [
    ["floating", pins.floating],
    ["exact", pins.exact],
    ["rootExact", pins.rootExact],
  ]) {
    const fields = fieldsByValue.get(ref) ?? [];
    fields.push(field);
    fieldsByValue.set(ref, fields);
  }
  for (const [ref, fields] of fieldsByValue) {
    if (!used.has(ref)) {
      failures.push(
        `stale pin: \`${ref}\` (${fields.join(", ")}) is declared in ${MANIFEST_PATH} but no covered ` +
          `document shows it — fix the documents or the manifest.`,
      );
    }
  }

  // The manifest must not drift against itself: the floating line and both
  // exact examples belong to the same minor line, or the documents are being
  // told two different stories about what is current.
  const minors = new Set(declared.map(minorOf));
  if (minors.size > 1) {
    failures.push(
      `${MANIFEST_PATH}: floating, exact and rootExact disagree on the minor line ` +
        `(${declared.map((ref) => `${ref} → v${minorOf(ref).slice(1)}`).join(", ")}) — one release, three fields.`,
    );
  }

  // A gate that read nothing has not passed — same rule as check-uses-refs.
  if (found === 0) {
    failures.push(
      "no `ecoma-io/action-agents[/action]@ref` pin was found in any covered document. Either the " +
        "documentation stopped showing how to use these actions, or this gate's REF pattern no " +
        "longer matches how they are written.",
    );
  }

  return { failures, found, checked, shaExempt, markerExempt, declared };
}

/**
 * The declared pins as a readable list for failure messages.
 *
 * @param {string[]} declared
 * @returns {string}
 */
function formatDeclared(declared) {
  return [...new Set(declared)].map((ref) => `\`${ref}\``).join(", ");
}

/**
 * Whether this file was RUN rather than imported, compared on real paths. The
 * same shape as the sibling gates, and not shared with them for the same
 * reason: a helper imported across the gates would make each one's failure
 * depend on a third file.
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

/**
 * The covered documents off the disk. A listed path that is missing fails the
 * run in `main` — an explicit list that silently shrank would be a gate that
 * reports green while reading less than it claims.
 *
 * @returns {{ path: string, text: string }[]}
 */
function readDocFiles() {
  return DOC_PATHS.map((path) => ({ path, text: readFileSync(path, "utf8") }));
}

function main() {
  /** @type {string[]} */
  const failures = [];
  if (!existsSync(MANIFEST_PATH)) {
    console.error(
      `✗ ${MANIFEST_PATH} is missing — the pin manifest is the source of truth this gate judges against.`,
    );
    process.exit(1);
  }

  /** @type {Pins} */
  let pins;
  try {
    pins = parseManifest(readFileSync(MANIFEST_PATH, "utf8"));
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  for (const path of DOC_PATHS) {
    if (!existsSync(path)) {
      failures.push(
        `${path}: listed in DOC_PATHS but missing from the tree — restore it or take it off the list.`,
      );
    }
  }
  const covered = readDocFiles().filter((file) =>
    failures.every((failure) => !failure.startsWith(`${file.path}:`)),
  );

  const result = evaluate({ files: covered, pins });
  failures.push(...result.failures);

  if (failures.length > 0) {
    for (const failure of failures) console.error(`✗ ${failure}`);
    console.error(
      `\n${String(failures.length)} action pin failure(s) ` +
        `(${String(result.checked)} checked, ${String(result.shaExempt)} sha-exempt, ` +
        `${String(result.markerExempt)} marker-exempt of ${String(result.found)} found).`,
    );
    process.exit(1);
  }

  console.log(
    `✔ ${String(result.checked)} documented pin(s) match ${MANIFEST_PATH} ` +
      `(${String(result.found)} found, ${String(result.shaExempt)} sha-exempt, ` +
      `${String(result.markerExempt)} marker-exempt)`,
  );
}

if (isProgramEntry(import.meta.url)) main();
