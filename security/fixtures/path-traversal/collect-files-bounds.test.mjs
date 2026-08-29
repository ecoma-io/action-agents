// Collect-files ceiling — a crawl over a hostile tree terminates, stays
// inside the workspace, excludes `.git` and symlinks, and returns a bounded,
// deterministically ordered listing.
//
// attack attempted
//   - a tree with hundreds of real files
//   - a real `.git` directory (with secrets inside), nested or at the root
//   - a symlink cycle `cyc-a -> cyc-b -> cyc-a` under the crawl root
//   - a symlink pointing outside the workspace root
//   →
// capability remains bounded
//   - the crawl terminates (symlinks are skipped, so cycles cannot be
//     re-entered and no member duplicates)
//   - every listed member stays inside the root and `.git` is pruned at
//     every level, so no git secret reaches the listing
//   - `list_files` caps the listing at the registry ceiling
//     (`MAX_LIST_ENTRIES`) or the injected cap, and marks the cut
//   - members are byte-ordered, so which entries survive a cap never
//     depends on readdir order
//
// Deterministic and offline: real temp trees and real symlinks, cleaned up
// in `after`. No network, no model, no timers.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorkspace } from "#core/workspace.mjs";
import { utf8Compare } from "#core/order.mjs";
import { createEvidence } from "#core/untrusted.mjs";
import { MAX_LIST_ENTRIES, createTools } from "../../../review/src/tools.mjs";

const EVIDENCE_ID = "deadbeefdeadbeef";
const BEGIN = `[evidence:${EVIDENCE_ID} listing]`;
const END = `[end-evidence:${EVIDENCE_ID}]`;

/**
 * Extracts the listing body from an evidence-wrapped tool result.
 *
 * @param {string} output
 * @returns {string[]}
 */
function listingLines(output) {
  const start = output.indexOf(BEGIN);
  const end = output.indexOf(END);
  assert.ok(start !== -1 && end !== -1 && start < end, "listing output carries evidence framing");
  return output.slice(start + BEGIN.length + 1, end - 1).split("\n");
}

/** Writes `count` zero-padded files into `dir` and returns their names. */
function writeMany(dir, count, digits) {
  const names = [];
  for (let i = 0; i < count; i += 1) {
    const name = `file-${String(i).padStart(digits, "0")}`;
    writeFileSync(join(dir, name), `content ${name}\n`);
    names.push(name);
  }
  return names;
}

/** Adds the hostile fixtures — `.git`, a cycle, an outside link — to a tree. */
function addHostiles(root, outside, secrets) {
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "secret.txt"), secrets.git);
  mkdirSync(join(root, "d", ".git"), { recursive: true });
  writeFileSync(join(root, "d", ".git", "inner.txt"), secrets.nested);
  symlinkSync("cyc-b", join(root, "cyc-a"));
  symlinkSync("cyc-a", join(root, "cyc-b"));
  writeFileSync(join(outside, "hidden.txt"), "outside-secret-content\n");
  symlinkSync(outside, join(root, "out-link"));
}

describe("collect files: hostile trees stay bounded, ordered and inside-root", () => {
  /** @type {string[]} */
  const created = [];
  let outside;
  let bigWorkspace;
  let bigTools;
  let bulkTools;
  let smallTools;
  let exactTools;

  before(() => {
    outside = mkdtempSync(join(tmpdir(), "aa-collect-outside-"));
    created.push(outside);

    // Tree 1 — 250 real files plus `.git`, nested `.git`, a cycle and an
    // outside link. Under the default 500-entry ceiling: no cut.
    const big = mkdtempSync(join(tmpdir(), "aa-collect-big-"));
    created.push(big);
    mkdirSync(join(big, "a"), { recursive: true });
    mkdirSync(join(big, "b", "c"), { recursive: true });
    mkdirSync(join(big, "z"), { recursive: true });
    writeMany(join(big, "a"), 100, 3);
    writeMany(join(big, "b", "c"), 100, 3);
    writeMany(join(big, "z"), 50, 3);
    addHostiles(big, outside, {
      git: "git-secret-content\n",
      nested: "git-secret-inner\n",
    });
    bigWorkspace = createWorkspace({ root: big });
    bigTools = createTools({
      workspace: bigWorkspace,
      evidence: createEvidence(() => EVIDENCE_ID),
      ignore: [],
    });

    // Tree 2 — 600 files in one directory: over the default ceiling.
    const bulk = mkdtempSync(join(tmpdir(), "aa-collect-bulk-"));
    created.push(bulk);
    mkdirSync(join(bulk, "bulk"), { recursive: true });
    writeMany(join(bulk, "bulk"), 600, 4);
    bulkTools = createTools({
      workspace: createWorkspace({ root: bulk }),
      evidence: createEvidence(() => EVIDENCE_ID),
      ignore: [],
    });

    // Tree 3 — 30 files, listed under an injected 10-entry cap.
    const small = mkdtempSync(join(tmpdir(), "aa-collect-small-"));
    created.push(small);
    mkdirSync(join(small, "f"), { recursive: true });
    writeMany(join(small, "f"), 30, 2);
    smallTools = createTools({
      workspace: createWorkspace({ root: small }),
      evidence: createEvidence(() => EVIDENCE_ID),
      ignore: [],
      limits: { listEntries: 10 },
    });

    // Tree 4 — five entries, two real files: exactness and no duplication.
    const exact = mkdtempSync(join(tmpdir(), "aa-collect-exact-"));
    created.push(exact);
    writeFileSync(join(exact, "top.txt"), "top\n");
    mkdirSync(join(exact, "x"), { recursive: true });
    writeFileSync(join(exact, "x", "one.txt"), "one\n");
    addHostiles(exact, outside, {
      git: "git-secret-content\n",
      nested: "git-secret-inner\n",
    });
    exactTools = createTools({
      workspace: createWorkspace({ root: exact }),
      evidence: createEvidence(() => EVIDENCE_ID),
      ignore: [],
    });
  });

  after(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
  });

  it("lists all 250 real files, pruning .git, cycles and outside links", () => {
    const result = bigTools.execute("list_files", JSON.stringify({ path: "." }));
    assert.equal(result.ok, true);
    const lines = listingLines(result.output);
    assert.equal(lines.length, 250, "expected exactly the 250 real files");

    for (const line of lines) {
      assert.ok(!line.startsWith("../"), `member ${line} escaped the root`);
      assert.doesNotMatch(line, /\.git/i, `member ${line} reached inside .git`);
      assert.doesNotMatch(line, /^cyc-/, `member ${line} came from the symlink cycle`);
      assert.doesNotMatch(line, /^out-link/, `member ${line} came from the outside link`);
    }
    assert.ok(!result.output.includes("git-secret"), ".git secret reached the listing");
    assert.ok(!result.output.includes("outside-secret"), "outside content reached the listing");

    for (let i = 1; i < lines.length; i += 1) {
      assert.ok(utf8Compare(lines[i - 1], lines[i]) <= 0, `listing not byte-ordered at ${i}`);
    }
  });

  it("caps the listing at the registry ceiling and marks the cut", () => {
    const result = bulkTools.execute("list_files", JSON.stringify({ path: "." }));
    assert.equal(result.ok, true);
    const lines = listingLines(result.output);
    const members = lines.filter((line) => line.startsWith("bulk/"));
    assert.equal(members.length, MAX_LIST_ENTRIES, "listing must be cut at the ceiling");
    assert.equal(members[0], "bulk/file-0000");
    assert.equal(members[members.length - 1], "bulk/file-0499");
    assert.equal(
      lines[lines.length - 1],
      `(listing cut at ${String(MAX_LIST_ENTRIES)} entries)`,
      "the cut must be marked, never silent",
    );
  });

  it("honours an injected ceiling", () => {
    const result = smallTools.execute("list_files", JSON.stringify({ path: "." }));
    assert.equal(result.ok, true);
    const lines = listingLines(result.output);
    const members = lines.filter((line) => line.startsWith("f/"));
    assert.equal(members.length, 10, "injected cap must bind");
    assert.equal(members[0], "f/file-00");
    assert.equal(members[members.length - 1], "f/file-09");
    assert.equal(lines[lines.length - 1], "(listing cut at 10 entries)");
  });

  it("returns exactly the real files, byte-ordered, with no duplication", () => {
    const result = exactTools.execute("list_files", JSON.stringify({ path: "." }));
    assert.equal(result.ok, true);
    assert.deepEqual(listingLines(result.output), ["top.txt", "x/one.txt"]);
    assert.ok(!result.output.includes("git-secret"), ".git secret reached the listing");
    assert.ok(!result.output.includes("outside-secret"), "outside content reached the listing");
  });

  it("read_file cannot open .git members at the root or nested", () => {
    for (const hostile of [".git/secret.txt", "d/.git/inner.txt"]) {
      const result = bigTools.execute("read_file", JSON.stringify({ path: hostile }));
      assert.equal(result.ok, false, `expected refusal for '${hostile}'`);
      assert.match(result.output, /resolves inside \.git/);
      assert.ok(!result.output.includes("git-secret"), "git secret leaked into the refusal");
      assert.ok(!result.output.includes(tmpdir()), "runner path leaked into the refusal");
    }
  });

  it("every listed member resolves back inside the root", () => {
    const result = bigTools.execute("list_files", JSON.stringify({ path: "." }));
    for (const line of listingLines(result.output)) {
      const entry = bigWorkspace.resolve(line);
      assert.equal(entry.kind, "file", `listed member ${line} is not a real file`);
      assert.ok(entry.absolute.startsWith(bigWorkspace.root), `${line} resolves outside the root`);
    }
  });
});
