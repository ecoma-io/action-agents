#!/usr/bin/env node
// Fails on any local reference to a document that does not exist, in either of
// the two shapes a reference takes in this repository:
//
//   1. Markdown links `[text](target)` — the target's file must exist, resolved
//      relative to the file that carries the link, and a `#anchor` fragment
//      naming a heading in that SAME file must match a heading actually there.
//      A link carried by a page INSIDE docs/ must land INSIDE docs/: the
//      documentation is a self-contained tree, so a docs page that links to
//      `../CONTRIBUTING.md` or `../../packages/…` is a failure — its subject
//      belongs in docs/, and a reader of docs/ is a docs reader. Markdown
//      files OUTSIDE docs/ keep the right to link INTO docs/ (the direction a
//      reader is steered toward); only the reverse is refused.
//   2. Prose citations `docs/...` or `../docs/...` in `.mjs` comments and
//      strings and in `.md` prose — resolved from the workspace root when they
//      begin with `docs/`, from the carrying file when they begin with `../` or
//      `./`.
//   3. Path references in `.yml`/`.yaml` — a workflow input, a glob, a comment
//      citing a file. A reference counts as a claim about THIS tree only when
//      its first segment is a real entry at the repository root; that one test
//      is what keeps `actions/checkout@…`, `repos/$REPO/git/refs/…` and
//      `/usr/bin/bash` out of the judgment without a list of exceptions to
//      maintain. Judged from the repository root, and a glob is judged by the
//      longest prefix before its first wildcard.
//
//      A reference is judged only when it names a FILE — it carries an
//      extension, or a wildcard. `core/action` in the prose "the core/action
//      boundary" is two English words with a slash between them, and no rule
//      about repository paths can tell it from a path; requiring an extension
//      is what separates them, and the cost is that a bare directory
//      reference like `.github/semgrep` goes unjudged. Comments stay in scope
//      deliberately: a comment citing a workflow that was renamed is the same
//      lie as an input naming it.
//
//      A path that belongs to the CONSUMER's repository rather than to this
//      one is marked `# consumer path` on its line — `review/action.yaml`'s
//      `instructions-path` default is the case that exists, and its own
//      description says missing is fine. The marker is a claim someone wrote
//      down, the way `tools/check-uses-refs.mjs` takes `# roadmap ref`.
//
// Shape 3 exists because of a specific failure. `analysis.yml` carried
// `config-file: .github/codeql/config.yml` — a file inherited from a previous
// repository and never created here. Every local gate passed, and CodeQL went
// red on the first push with "the configuration file does not exist". The gate
// that should have caught it was reading `.md`, `.mjs` and `.js` only, so the
// one reference shape a workflow uses was the one shape nothing read.
//
// WHY this script exists. The docs live in docs/, and a reader of docs/ is a
// docs reader: a page there must not link out to a root markdown file or a
// package README, and no reference — markdown link or prose citation — may
// point at a path that does not exist. No existing gate saw either failure:
// Prettier formats markdown but does not resolve a link, markdownlint's
// closest rule (MD051) checks only `#anchor` fragments within one file, and
// ESLint never reads prose. A broken reference is invisible until someone
// clicks it.
//
// The facts are read from the filesystem by `readFacts`; the judgment is the
// pure function `evaluate`, which takes those facts as arguments and returns
// verdicts, so the tests need no filesystem and no mocking library.
//
// Resolution rules, stated once:
//   - a markdown link target resolves relative to the file that carries it;
//   - a citation beginning with `docs/` resolves from the workspace root
//     (this repository's convention for prose references);
//   - a citation beginning with `../` or `./` resolves from its carrying file;
//   - a page inside docs/ may only link to another page inside docs/;
//   - everything else is not a reference to this repository's docs and is
//     ignored.
//
// External targets (`http:`, `https:`, `mailto:`) and fragment-only targets
// on a DIFFERENT file are not resolved: the first lives outside the tree this
// gate can see, and the second is a promise about another file's headings that
// GitHub's own anchor handling does not even guarantee — a `#fragment` on the
// same file is checked because markdownlint's MD051 does it and it is cheap;
// a `file.md#fragment` one is checked only for the file half.

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import GithubSlugger from "github-slugger";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Tracked files whose content is a candidate for any reference shape.
export const SCANNED_EXTENSIONS = [".md", ".mjs", ".js", ".yml", ".yaml"];
// The subset judged by shape 3 rather than by shapes 1 and 2.
export const YAML_EXTENSIONS = [".yml", ".yaml"];
// Tracked files that deliberately look broken and must not fail the gate:
// the gates' own test files, whose failure-direction cases hand them
// references that do not resolve on purpose (a gone target is the input,
// not a defect in the tree); and the two vendored skill trees, whose
// `SKILL.md` files are byte-identical copies of ecoma-io/archkeep and cite
// that repository's docs/ pages, which are real there and absent here. They
// are not this repository's prose to fix — editing one to satisfy this gate
// is exactly what `scripts/check-skills.mjs` fails on — so they are judged by
// their hashes rather than by a docs law written for pages this repository
// authors.
export const IGNORED_PREFIXES = [
  "scripts/check-docs-links.test.mjs",
  "tools/check-anchors.test.mjs",
  "tools/check-uses-refs.test.mjs",
  ".claude/skills/",
  ".agents/skills/",
];
// The directory a docs/ page may link into — and only into.
export const DOCS_DIR = "docs";
// Marks a path reference as naming a file in the CONSUMER's repository rather
// than in this one, so the gate counts it and does not resolve it. Written on
// the same line as the reference.
export const EXEMPT_MARKER = "# consumer path";

/**
 * Extracts the local targets of every `[text](target)` markdown link in text.
 * External targets and fragment-only anchors are dropped here: external ones
 * are out of this tree's reach, and a bare `#anchor` is the same-file heading
 * check `evaluate` performs, not a path to resolve.
 *
 * @param {string} text contents of a markdown file
 * @returns {{target: string, line: number}[]} local link targets, 1-based line
 */
export function parseMarkdownLinks(text) {
  const links = [];
  const re = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = re.exec(text))) {
    const target = match[1];
    if (/^(https?:|mailto:|data:|tel:|\/\/)/i.test(target)) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith(".")) continue;
    // A bare `#anchor` stays: it is the same-file heading check `evaluate`
    // performs, not a path to resolve.
    links.push({ target, line: text.slice(0, match.index).split("\n").length });
  }
  return links;
}

/**
 * Extracts prose citations of this repository's docs from a text: `docs/…`
 * (workspace-root relative) or `../docs/…` / `./docs/…` (carrying-file
 * relative). Markdown link syntax is removed first so a target that was
 * already judged as a link is not judged a second time by different rules.
 *
 * @param {string} text contents of a `.md`, `.mjs`, or `.js` file
 * @returns {{target: string, line: number}[]} citation targets, 1-based line
 */
export function parseDocCitations(text) {
  const withoutLinks = text.replace(/!?\[[^\]]*\]\([^)]*\)/g, "");
  const citations = [];
  const re = /((?:\.\.?\/)*)(docs\/[a-z0-9_.-]+\/[a-z0-9_.-]+\.md)/g;
  let match;
  while ((match = re.exec(withoutLinks))) {
    const prefix = match[1];
    const target = `${prefix}${match[2]}`;
    citations.push({ target, line: text.slice(0, match.index).split("\n").length });
  }
  return citations;
}

/**
 * The part of a path that can be resolved before its first wildcard, so a glob
 * is judged by the directory it is rooted in rather than by a literal string
 * that can never exist. `.claude/skills/**` is a claim that `.claude/skills`
 * is there; `docs/**' + '/*.md` is a claim about `docs`.
 *
 * @param {string} target a path reference, possibly containing wildcards
 * @returns {string} the longest wildcard-free prefix, `""` if the first
 *   segment is itself a wildcard
 */
export function globPrefix(target) {
  const segments = target.split("/");
  const wildcard = segments.findIndex((segment) => /[*?[\]{}]/.test(segment));
  return wildcard === -1 ? target : segments.slice(0, wildcard).join("/");
}

/**
 * Extracts every path-shaped reference from a YAML file, with its line.
 *
 * Three removals come first, and each is a class of text that reads like a
 * repository path without being one. `${{ … }}` is a value GitHub computes on
 * the runner, so `${{ runner.temp }}/results.sarif` is a claim about the
 * runner rather than about this tree. A URL carries a `host/path` pair that is
 * indistinguishable from a repository path once the scheme is gone. Both are
 * blanked rather than deleted, so every line number below still counts the
 * lines the file actually has.
 *
 * Then a leading `/` that follows a quote, a bracket or whitespace is dropped:
 * that is how semgrep's `paths:` globs anchor at the repository root, and
 * without this `/.github/workflows/**` would be skipped by a scan whose whole
 * subject is `.github/workflows`. `/usr/bin/bash` survives the same treatment
 * and is refused later, by the first-segment test rather than by a special
 * case for it.
 *
 * Deciding which references are about THIS repository is deliberately NOT done
 * here: it needs the set of paths that exist, which is `evaluate`'s argument
 * and not this function's business.
 *
 * @param {string} text contents of a `.yml` or `.yaml` file
 * @returns {{target: string, line: number, exempt: boolean}[]} path references
 */
export function parseYamlPathReferences(text) {
  const blank = (matched) => matched.replace(/[^\n]/g, " ");
  const scannable = text
    .replace(/\$\{\{[\s\S]*?\}\}/g, blank)
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, blank)
    .replace(/(^|["'\s([])\/(?=[\w.])/gm, "$1");

  const lines = text.split("\n");
  const references = [];
  // The lookbehind is what keeps a match from starting mid-path: without it
  // `actions/checkout` would also yield `checkout` alone from a later offset,
  // and `a@b/c` would yield `b/c`.
  const re = /(?<![\w@$/-])((?:[\w.*-]+\/)+[\w.*-]+)/g;
  let match;
  while ((match = re.exec(scannable))) {
    // Prose puts a path at the end of a sentence; the punctuation is the
    // sentence's, not the path's.
    const target = match[1].replace(/[.,;:]+$/, "");
    if (target === "") continue;
    // Only a reference that names a file is judged. Without this, English
    // prose with a slash in it (`the core/action boundary`) is indistinguishable
    // from a path, and the gate spends its credibility on wording.
    if (!/\.[a-z0-9]+$/i.test(globPrefix(target)) && !/[*?[\]{}]/.test(target)) continue;
    const line = scannable.slice(0, match.index).split("\n").length;
    references.push({
      target,
      line,
      exempt: (lines[line - 1] ?? "").includes(EXEMPT_MARKER),
    });
  }
  return references;
}

/**
 * GitHub's heading anchor: lowercase, keep letters/numbers/spaces/hyphens/
 * underscores, spaces become hyphens. This is the same normalization GitHub
 * applies when rendering `#heading` links.
 *
 * @param {string} heading raw heading text
 * @returns {string} the anchor GitHub would give it
 */
export function githubSlug(heading) {
  // Delegate to github-slugger, the package GitHub renders anchors with (and
  // the one `tools/check-anchors.mjs` pins). Hand-rolled sluggers drift: an
  // em-dash heading must anchor `d12--capacity-…` (double dash) — github-slugger
  // removes the dash and keeps BOTH surrounding spaces, which collapse to two
  // hyphens — and `0.2.1 (2026-08-13)` keeps its hyphens but drops periods.
  // A fresh instance per call keeps the slug stateless (no `-1` duplicate
  // suffixes), which is what a link target check needs.
  return new GithubSlugger().slug(heading);
}

/**
 * The set of anchors a document's headings produce, including GitHub's
 * duplicate-heading suffixes: the second heading with a slug gets `-1`, the
 * third `-2`, and so on.
 *
 * @param {string} text contents of a markdown file
 * @returns {Set<string>} every `#anchor` the file's headings legitimately have
 */
export function headingAnchors(text) {
  const anchors = new Set();
  const seen = new Map();
  const re = /^#{1,6}\s+(.+)$/gm;
  let match;
  while ((match = re.exec(text))) {
    const slug = githubSlug(match[1]);
    const count = seen.get(slug) ?? 0;
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
    seen.set(slug, count + 1);
  }
  return anchors;
}

/**
 * Adds every parent directory of the given paths. A markdown link may point
 * at a directory (`[docs](../usage/)`) and that is a real destination GitHub
 * renders — so a directory counts as existing, and git cannot track an empty
 * one, which means every parent of a tracked path exists on disk by
 * construction.
 *
 * @param {string[]} paths absolute tracked file paths
 * @returns {Set<string>} the paths and every directory containing them
 */
export function withDirectories(paths) {
  const result = new Set(paths);
  for (const path of paths) {
    let dir = dirname(path);
    while (dir !== path && dir !== "/") {
      result.add(dir);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return result;
}

/**
 * Whether an absolute path lies inside `docs/` (or is that directory itself).
 *
 * @param {string} resolved absolute path
 * @param {string} docsDir absolute path of the docs/ directory
 * @returns {boolean}
 */
function insideDocs(resolved, docsDir) {
  return resolved === docsDir || resolved.startsWith(`${docsDir}${sep}`);
}

/**
 * Judges the reference facts and returns verdict lines and failures.
 *
 * `files` maps a repository-relative path to what its content references; each
 * reference is checked for the existence of its target file, and a `#anchor`
 * fragment on the same file is checked against the headings. `existingPaths`
 * is the set of absolute paths that exist, supplied by the caller — the
 * judgment never touches the filesystem itself, so a test drives it with a
 * hand-built set. Anything that cannot resolve is a failure — an empty verdict
 * list must mean "no broken reference", and nothing else.
 *
 * @param {object} input
 * @param {{path: string, links: {target: string, line: number}[], citations: {target: string, line: number}[], paths?: {target: string, line: number}[], headings: Set<string>}[]} input.files
 *   per-file references and same-file heading anchors
 * @param {Set<string>} input.existingPaths absolute paths that exist on disk
 * @param {string} input.root absolute path of the repository root
 * @returns {{lines: string[], failures: string[]}}
 */
export function evaluate({ files, existingPaths, root }) {
  const lines = [];
  const failures = [];
  let exempt = 0;

  if (files.length === 0) {
    failures.push(
      "no files were scanned — the gate found nothing to judge, which reads as " +
        "a clean run but means the docs could have broken links in them. If " +
        "this repository has no tracked `.md`/`.mjs`/`.js`/`.yml`/`.yaml` " +
        "files, say so explicitly instead of relying on an empty scan.",
    );
    return { lines, failures };
  }

  lines.push(`scanning ${files.length} files for doc references`);

  const docsDir = join(root, DOCS_DIR);

  for (const file of files) {
    const absolute = join(root, file.path);
    const inDocs = file.path.startsWith(`${DOCS_DIR}/`);
    for (const { target, line } of file.links) {
      const [pathPart, fragment] = target.split("#", 2);
      // A bare `#anchor` resolves to the carrying file itself: the part
      // before the fragment is empty and the headings check below applies.
      const resolved = pathPart === "" ? absolute : resolve(dirname(absolute), pathPart);
      if (inDocs && !insideDocs(resolved, docsDir)) {
        failures.push(
          `${file.path}:${line} links to \`${target}\` — a file OUTSIDE docs/. ` +
            `Documentation may link only within docs/, so a page in docs/ cannot ` +
            `point at \`${pathPart || "(this file)"}\` (which resolves to ${resolved}). ` +
            `Name the file in plain text instead of linking it.`,
        );
        continue;
      }
      if (!existingPaths.has(resolved)) {
        failures.push(
          `${file.path}:${line} links to \`${target}\` but \`${pathPart || "(this file)"}\` resolves to ` +
            `${resolved} — which does not exist.`,
        );
        continue;
      }
      if (fragment !== undefined && pathPart !== "") {
        // A fragment naming another file's heading is not checked: GitHub's
        // own anchor handling does not guarantee the heading, so a failure
        // here would be a promise the tool itself cannot keep.
        continue;
      }
      const anchor = fragment ?? "";
      if (anchor !== "" && !file.headings.has(anchor)) {
        failures.push(
          `${file.path}:${line} links to \`#${anchor}\` but no heading in that ` +
            `file produces that anchor.`,
        );
      }
    }
    for (const { target, line } of file.citations) {
      const [pathPart] = target.split("#", 2);
      const base = /^\.\.?\//.test(pathPart) ? dirname(absolute) : root;
      const resolved = resolve(base, pathPart);
      if (!existingPaths.has(resolved)) {
        failures.push(
          `${file.path}:${line} cites \`${target}\` but it resolves to ` +
            `${resolved} — which does not exist.`,
        );
      }
    }
    for (const reference of file.paths ?? []) {
      const { target, line } = reference;
      // The whole noise filter, in one test. A first segment that names no
      // real entry at the repository root means the reference is not about
      // this tree — `actions/checkout`, `repos/$REPO/git/refs`, `usr/bin/bash`
      // — and judging it would be judging someone else's namespace. Stating it
      // as "the root entry must exist" rather than as a list of hosts and
      // prefixes is what keeps the filter from needing maintenance every time
      // a workflow gains a new third-party action.
      if (reference.exempt) {
        exempt += 1;
        continue;
      }
      const first = target.split("/")[0];
      if (first === undefined || first === "" || !existingPaths.has(join(root, first))) continue;
      const probe = globPrefix(target);
      if (probe === "") continue;
      const resolved = join(root, probe);
      if (existingPaths.has(resolved)) continue;
      failures.push(
        `${file.path}:${line} names \`${target}\`` +
          (probe === target ? "" : ` (glob rooted at \`${probe}\`)`) +
          `, which resolves to ${resolved} — and that does not exist. A workflow ` +
          `input or glob naming a path this repository does not have fails on a ` +
          `runner, not here, which is the whole reason this is checked here.`,
      );
    }
  }

  lines.push(
    (failures.length === 0
      ? "no broken doc references"
      : `${failures.length} broken doc references`) +
      (exempt === 0 ? "" : ` (${exempt} path(s) exempt by marker)`),
  );
  return { lines, failures };
}

/**
 * The tracked files the gate judges: every file `git ls-files` reports —
 * that list IS `existingPaths`, the set a reference may resolve to, so the
 * judgment and the existence set agree by construction — minus the
 * deliberately unsafe fixtures, plus the parsed references of every
 * `.md`/`.mjs`/`.js` file. Deliberately untested: a test that stubbed this
 * answer would pin the stub, and `git ls-files` is where "tracked" is defined.
 */
function readFacts() {
  const result = spawnSync("git", ["ls-files"], {
    cwd: root,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    console.error(result.stdout ?? "");
    console.error(result.stderr ?? "");
    console.error("`git ls-files` failed, so the tracked file list could not be read.");
    process.exit(1);
  }

  const tracked = result.stdout.split("\n").filter((path) => path !== "");
  const existingPaths = withDirectories(tracked.map((path) => join(root, path)));

  const files = [];
  for (const path of tracked) {
    if (!SCANNED_EXTENSIONS.some((ext) => path.endsWith(ext))) continue;
    if (IGNORED_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;
    const text = readFileSync(join(root, path), "utf8");
    const isMarkdown = path.endsWith(".md");
    // YAML is judged by shape 3 alone. Running the citation scan over it too
    // would report one bad `docs/…/x.md` twice, under two names, for one line.
    const isYaml = YAML_EXTENSIONS.some((ext) => path.endsWith(ext));
    files.push({
      path,
      links: isMarkdown ? parseMarkdownLinks(text) : [],
      citations: isYaml ? [] : parseDocCitations(text),
      paths: isYaml ? parseYamlPathReferences(text) : [],
      headings: isMarkdown ? headingAnchors(text) : new Set(),
    });
  }
  return { files, existingPaths };
}

function main() {
  const { files, existingPaths } = readFacts();
  const { lines, failures } = evaluate({ files, existingPaths, root });

  for (const line of lines) console.log(line);

  if (failures.length > 0) {
    console.error("");
    for (const failure of failures) console.error(`✗ ${failure}`);
    process.exit(1);
  }
}

/**
 * Whether this file was RUN rather than imported, compared on real paths.
 *
 * `import.meta.url === pathToFileURL(process.argv[1]).href` is the usual form
 * and it is wrong here: pnpm invokes a script through a path that may traverse
 * a symlink, so the two spell the same file differently and the gate silently
 * does nothing when run. Comparing `realpath` on both sides is what makes
 * "imported by a test" and "run by CI" reliably distinguishable.
 *
 * Every gate carries its own copy rather than importing a shared one. A helper
 * shared across the gates would make each gate's ability to run depend on a
 * third file — and a gate that cannot run is the failure mode all of these
 * exist to prevent.
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
