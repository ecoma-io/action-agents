#!/usr/bin/env node
// Rewrites the vendored `arch-*` skills from a Archkeep source tree, in both
// directories the three supported agents scan, and records what they were taken
// from so `check-skills.mjs` can hold them to it.
//
// This is the ONLY sanctioned way those files change. The argument for that,
// and for why there are two copies at all, is in `check-skills.mjs` — this
// file is the writer, that one is the law.
//
// WHERE THE BYTES COME FROM. `@ecoma-io/archkeep` does not publish `skills/` to
// npm today (measured against the 0.13.0 tarball, whose `files` field is
// `index.mjs`, `nx.mjs`, `cli.mjs`, `lsp.mjs`, `src/`, `presets/`, `LICENSE`
// and `README.md` — no `skills/`), so the default source below does not exist
// yet and `--from` is how a maintainer names one. When upstream adds
// `skills/` to the package's `files`, the default starts resolving and the
// re-sync becomes `pnpm sync-skills` with no argument and no clone — the
// version pinned in `package.json` is then the version on disk, by
// construction. Nothing here needs to change on that day.
//
// Until then, either of these produces the same bytes as the pinned release:
//
//   pnpm sync-skills --from ../archkeep/skills          # a clone at the right tag
//   curl -sL https://github.com/ecoma-io/archkeep/archive/refs/tags/v0.13.0.tar.gz | tar xz
//   pnpm sync-skills --from archkeep-0.13.0/skills
//
// The written trees are always wiped first rather than merged into: a skill
// deleted upstream must disappear here, and a copy that only ever gains files
// keeps serving one that upstream retired.

import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MANIFEST_PATH,
  SKILL_TREES,
  SOURCE_PACKAGE,
  pinnedSourceVersion,
  sha256,
} from "./check-skills.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The note written into each tree beside the copies. It exists because the
// duplication is invisible from inside one tree: someone who opens
// `.claude/skills/arch-check/SKILL.md` sees a file, not a copy, and nothing
// there says an identical one lives elsewhere or that editing this one is a
// red gate. The argument for the arrangement is in `check-skills.mjs`; this is
// the pointer at it, at the place a reader actually lands.
//
// It cannot go in the SKILL.md files themselves — those are held byte-identical
// to upstream, so a note inside one is exactly the edit the gate refuses.
export const TREE_README = `# Vendored agent skills — do not edit

The \`arch-*/SKILL.md\` files here are byte-identical copies of the
\`@ecoma-io/archkeep\` release this repository pins. This directory is one of
two: the same files are committed in the other one too, because the three
supported agents do not scan the same directory —

| Host        | \`.claude/skills/\` | \`.agents/skills/\` |
| ----------- | ------------------ | ------------------ |
| Claude Code | reads              | does not read      |
| Codex       | does not read      | reads              |
| opencode    | reads              | reads              |

— so neither one alone reaches Claude Code and Codex both.

\`pnpm check-skills\` fails on any difference between the two trees, on any
difference from the pinned release, and on a dependency bump that left them
behind. Editing a file here is that failure, not a fix: the text belongs to
\`https://github.com/ecoma-io/archkeep\`, and a change made here is lost at the
next sync.

Both this file and the copies beside it are written by
\`scripts/sync-skills.mjs\`, which is the only sanctioned way either changes.
The reasoning — why copies rather than a symlink, why committed rather than
generated at install time — is in \`scripts/check-skills.mjs\`.
`;

// Where the skills will live once upstream ships them in the package. Named
// here rather than inline so the failure message can point at it.
export const DEFAULT_SOURCE = join("node_modules", SOURCE_PACKAGE, "skills");

/**
 * The source directory to copy from: `--from <dir>` when given, else the
 * installed package's own `skills/`.
 *
 * @param {string[]} argv arguments after the script name
 * @returns {{from: string} | {error: string}}
 */
export function parseArgs(argv) {
  const index = argv.indexOf("--from");
  if (index === -1) return { from: DEFAULT_SOURCE };
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    return { error: "--from needs a directory holding `<skill-name>/SKILL.md` entries" };
  }
  return { from: value };
}

/**
 * Every `<name>/SKILL.md` in a source tree, as `relative path → contents`.
 *
 * Only that shape is collected, because only that shape is a skill: a host
 * scanning `.claude/skills/` or `.agents/skills/` reads `<name>/SKILL.md` and
 * nothing else, so copying a stray README into the vendored trees would ship a
 * file no agent reads and this repository would then have to keep in sync for
 * no reader.
 *
 * @param {string} sourceDir absolute path to a `skills/` directory
 * @returns {Record<string, string>} relative skill path → file contents
 */
function readSource(sourceDir) {
  const skills = {};
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const relative = join(entry.name, "SKILL.md");
    let text;
    try {
      text = readFileSync(join(sourceDir, relative), "utf8");
    } catch {
      continue;
    }
    skills[relative] = text;
  }
  return skills;
}

/**
 * The manifest `check-skills.mjs` judges against: what the copies were taken
 * from, and a hash per file. Pure, so a test can state the whole record it
 * expects without writing one.
 *
 * `skills` and `notes` are kept apart because their failure messages differ —
 * a drifted copy is fixed upstream, a drifted note is fixed in this script.
 *
 * @param {string} version the pinned source version
 * @param {Record<string, string>} skills relative skill path → contents, from upstream
 * @param {Record<string, string>} notes relative path → contents, written here
 * @returns {{source: object, skills: Record<string, string>, notes: Record<string, string>}}
 */
export function buildManifest(version, skills, notes = {}) {
  const hashes = {};
  for (const path of Object.keys(skills).sort()) hashes[path] = sha256(skills[path]);
  const noteHashes = {};
  for (const path of Object.keys(notes).sort()) noteHashes[path] = sha256(notes[path]);
  return {
    $comment:
      "Written by scripts/sync-skills.mjs, judged by scripts/check-skills.mjs. Not hand-edited: " +
      "these hashes are what makes an edit to a vendored skill loud instead of silent.",
    source: {
      package: SOURCE_PACKAGE,
      version,
      repository: "https://github.com/ecoma-io/archkeep",
      ref: `v${version}`,
    },
    skills: hashes,
    notes: noteHashes,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if ("error" in args) {
    console.error(`✗ ${args.error}`);
    process.exit(1);
  }

  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const pinned = pinnedSourceVersion(packageJson);
  if ("error" in pinned) {
    console.error(`✗ ${pinned.error}`);
    process.exit(1);
  }

  const sourceDir = resolve(root, args.from);
  let skills;
  try {
    skills = readSource(sourceDir);
  } catch {
    console.error(`✗ ${args.from} is not a readable directory.`);
    console.error(
      `  ${SOURCE_PACKAGE} does not publish skills/ to npm yet, so ${DEFAULT_SOURCE} usually does not exist.`,
    );
    console.error(
      `  Pass --from <dir> naming a archkeep checkout's skills/ at tag v${pinned.version}.`,
    );
    process.exit(1);
  }

  if (Object.keys(skills).length === 0) {
    console.error(
      `✗ ${args.from} holds no <name>/SKILL.md entries, so there is nothing to vendor.`,
    );
    process.exit(1);
  }

  const notes = { "README.md": TREE_README };

  for (const tree of SKILL_TREES) {
    const absolute = join(root, tree);
    rmSync(absolute, { recursive: true, force: true });
    for (const [relative, text] of Object.entries({ ...skills, ...notes })) {
      mkdirSync(join(absolute, dirname(relative)), { recursive: true });
      writeFileSync(join(absolute, relative), text);
    }
  }

  writeFileSync(
    join(root, MANIFEST_PATH),
    `${JSON.stringify(buildManifest(pinned.version, skills, notes), null, 2)}\n`,
  );

  const names = Object.keys(skills)
    .map((path) => dirname(path))
    .sort();
  console.log(
    `vendored ${names.length} skills from ${SOURCE_PACKAGE}@${pinned.version} into ${SKILL_TREES.join(" and ")}`,
  );
  for (const name of names) console.log(`  ${name}`);
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
