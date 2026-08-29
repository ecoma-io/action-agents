// Dotgit ladder — no spelling of a `.git` path resolves, and the allowed
// baseline still works.
//
// attack attempted
//   - `x/.git`, `x/./.git`, `x/../.git`, `.git`, `.Git`, `a/b/.git/HEAD`
//   - a `.git`-shaped path whose parent does not exist
//   →
// capability remains bounded
//   - every `.git` component in the resolved path is refused, case-
//     insensitively, whether it is the final component or a mid-chain
//     segment; `x/../.git` normalises onto the same-root `.git` and is
//     refused there
//   - an absent `.git` path is a typed absence (MissingPathError), never a
//     silently resolved entry
//   - `.github` (the deliberately allowed carve-out) still resolves
//   - a normal `src/foo.ts` still resolves and reads
//
// Deterministic and offline: a real temp tree, cleaned up in `after`.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MissingPathError, WorkspaceRefusal, createWorkspace } from "#core/workspace.mjs";

/**
 * Runs `fn` and returns what it threw, failing the test if it did not throw.
 *
 * @param {() => unknown} fn
 * @returns {unknown}
 */
function capture(fn) {
  try {
    fn();
  } catch (cause) {
    return cause;
  }
  assert.fail("expected the call to be refused, but it succeeded");
}

describe("dotgit ladder: every .git spelling stays refused", () => {
  let root;
  let workspace;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "aa-dotgit-ladder-"));

    // A real repository-shaped `.git`, plus a case variant `.Git`.
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(root, ".Git"));
    writeFileSync(join(root, ".Git", "case-secret"), "case-secret\n");

    // Nested `.git` directories for mid-chain and final-component attacks.
    mkdirSync(join(root, "x", ".git"), { recursive: true });
    mkdirSync(join(root, "a", "b", ".git"), { recursive: true });

    // The allowed carve-out and the allowed baseline.
    mkdirSync(join(root, "x", ".github"), { recursive: true });
    writeFileSync(join(root, "x", ".github", "ok.txt"), "allowed\n");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "foo.ts"), "export const ok = 1;\n");

    workspace = createWorkspace({ root });
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses x/.git when it exists", () => {
    const error = capture(() => workspace.resolve("x/.git"));
    assert.ok(error instanceof WorkspaceRefusal, "expected a typed WorkspaceRefusal");
    assert.match(error.message, /resolves inside \.git/);
  });

  it("refuses x/./.git (the ./ is normalised away)", () => {
    const error = capture(() => workspace.resolve("x/./.git"));
    assert.ok(error instanceof WorkspaceRefusal, "expected a typed WorkspaceRefusal");
    assert.match(error.message, /resolves inside \.git/);
  });

  it("refuses x/../.git (it normalises onto the same-root .git)", () => {
    const error = capture(() => workspace.resolve("x/../.git"));
    assert.ok(error instanceof WorkspaceRefusal, "expected a typed WorkspaceRefusal");
    assert.match(error.message, /resolves inside \.git/);
  });

  it("refuses the bare .git", () => {
    const error = capture(() => workspace.resolve(".git"));
    assert.ok(error instanceof WorkspaceRefusal, "expected a typed WorkspaceRefusal");
    assert.match(error.message, /resolves inside \.git/);
  });

  it("refuses a path reaching into .git through a mid-chain segment", () => {
    const error = capture(() => workspace.resolve("a/b/.git/HEAD"));
    assert.ok(error instanceof WorkspaceRefusal, "expected a typed WorkspaceRefusal");
    assert.match(error.message, /resolves inside \.git/);
  });

  it("refuses .Git case-insensitively", () => {
    const error = capture(() => workspace.resolve(".Git"));
    assert.ok(error instanceof WorkspaceRefusal, "expected a typed WorkspaceRefusal");
    assert.match(error.message, /resolves inside \.git/);
  });

  it("reports an absent .git-shaped path as a typed absence, never an entry", () => {
    // `never/.git` does not exist: the answer is the typed missing error —
    // a resolution that "succeeds" would be the leak this fixture exists to
    // catch, because absence must not become the softer answer.
    const error = capture(() => workspace.resolve("never/.git"));
    assert.ok(error instanceof MissingPathError, "expected a typed MissingPathError");
    assert.equal(error.message, "'never/.git' does not exist in the workspace");
  });

  it("leaves .github (the documented carve-out) resolvable", () => {
    const entry = workspace.resolve("x/.github/ok.txt");
    assert.equal(entry.kind, "file");
    assert.equal(entry.relative, "x/.github/ok.txt");
    assert.equal(readFileSync(entry.absolute, "utf8"), "allowed\n");
  });

  it("still resolves and reads the allowed baseline src/foo.ts", () => {
    const entry = workspace.resolve("src/foo.ts");
    assert.equal(entry.kind, "file");
    assert.equal(entry.absolute.startsWith(workspace.root), true);
    assert.equal(entry.relative, "src/foo.ts");
    assert.equal(readFileSync(entry.absolute, "utf8"), "export const ok = 1;\n");
  });

  it("never leaks the runner's own paths in any ladder refusal", () => {
    for (const hostile of ["x/.git", "x/./.git", "x/../.git", ".git", "a/b/.git/HEAD", ".Git"]) {
      const error = capture(() => workspace.resolve(hostile));
      assert.ok(error instanceof WorkspaceRefusal, `expected a refusal for '${hostile}'`);
      assert.ok(
        !error.message.includes(root) && !error.message.includes(tmpdir()),
        `refusal for '${hostile}' must not carry a runner-side path`,
      );
    }
  });
});
