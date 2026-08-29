// Symlink maze — a symlinked path must never resolve into `.git`, outside
// the workspace, or into a resolution loop.
//
// attack attempted
//   - a mid-chain symlink landing inside a nested `.git`
//   - a symlink pointing outside the workspace root
//   - a symlink cycle (`a -> b -> a`) in a parent chain
//   - a symlink as the final component of a requested path
//   →
// capability remains bounded
//   - every resolution touching `.git` is refused (intermediate symlinks
//     are realpath'd before judgement, so where a link LANDED is what is
//     checked)
//   - nothing outside the root is ever resolved, so nothing outside the
//     root can be handed to a read
//   - a cycle is refused with the fixed "cannot be resolved safely" refusal
//     — no ELOOP text, no hang, no unbounded resolution
//   - a final-component symlink is refused by type, whichever way it points
//
// Deterministic and offline: a real temp tree with real symlinks, cleaned
// up in `after`. No network, no model, no timers.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkspaceRefusal, createWorkspace } from "#core/workspace.mjs";

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

describe("symlink maze: resolution stays inside the workspace", () => {
  let root;
  let outside;
  let workspace;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "aa-symlink-maze-"));
    outside = mkdtempSync(join(tmpdir(), "aa-symlink-outside-"));

    // A real `.git` the attacks must never reach.
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "OBJECTS"), "git-secret-objects\n");

    // A real nested entry and a mid-chain symlink landing in `.git`.
    mkdirSync(join(root, "sub", "dir"), { recursive: true });
    writeFileSync(join(root, "sub", "dir", "entry.txt"), "innocent\n");
    symlinkSync("../../.git", join(root, "sub", "dir", "link"));

    // A symlink to a directory outside the workspace root.
    writeFileSync(join(outside, "secret.txt"), "outside-secret-content\n");
    symlinkSync(outside, join(root, "escape"));

    // A symlink cycle under the root: a -> b -> a.
    symlinkSync("b", join(root, "a"));
    symlinkSync("a", join(root, "b"));

    writeFileSync(join(root, "plain.txt"), "plain\n");
    workspace = createWorkspace({ root });
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("refuses a mid-chain symlink landing in a nested .git", () => {
    // `sub/dir/link` -> `../../.git`; resolving through it must be judged
    // where the link physically lands: inside the workspace's `.git`.
    const error = capture(() => workspace.resolve("sub/dir/link/HEAD"));
    assert.ok(error instanceof WorkspaceRefusal, "expected a typed WorkspaceRefusal");
    assert.match(error.message, /resolves inside \.git/);
  });

  it("refuses a final-component symlink by type, without following it", () => {
    // `sub/dir/link` itself: the last component is never followed, so the
    // link is refused whether it points into `.git` or anywhere else.
    const error = capture(() => workspace.resolve("sub/dir/link"));
    assert.ok(error instanceof WorkspaceRefusal, "expected a typed WorkspaceRefusal");
    assert.match(error.message, /symlink/);
  });

  it("refuses a symlink whose parent chain escapes the root", () => {
    const error = capture(() => workspace.resolve("escape/secret.txt"));
    assert.ok(error instanceof WorkspaceRefusal, "expected a typed WorkspaceRefusal");
    assert.match(error.message, /resolves outside the workspace/);
    // The refusal names what was asked for, never where the link landed.
    assert.ok(!error.message.includes(outside), "refusal must not name the outside path");
  });

  it("refuses an escaping symlink as the final component as well", () => {
    const error = capture(() => workspace.resolve("escape"));
    assert.ok(error instanceof WorkspaceRefusal, "expected a typed WorkspaceRefusal");
    assert.match(error.message, /symlink/);
    assert.ok(!error.message.includes(outside), "refusal must not name the outside path");
  });

  it("refuses a symlink cycle in the parent chain with a fixed message", () => {
    // `a -> b -> a`: realpath must abort (ELOOP) and the refusal must not
    // carry the OS's loop description or any resolved path.
    const error = capture(() => workspace.resolve("a/x"));
    assert.ok(error instanceof WorkspaceRefusal, "expected a typed WorkspaceRefusal");
    assert.equal(error.message, "refusing 'a/x': it cannot be resolved safely on this filesystem");
  });

  it("refuses a cycle as the final component by type", () => {
    const error = capture(() => workspace.resolve("a"));
    assert.ok(error instanceof WorkspaceRefusal, "expected a typed WorkspaceRefusal");
    assert.match(error.message, /symlink/);
  });

  it("never lets a refused path reach the outside file", () => {
    // Every attack above was refused: resolution never produced the outside
    // absolute path, so it could not be opened. The sentinel file is still
    // exactly the bytes written at setup.
    assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "outside-secret-content\n");
    const error = capture(() => workspace.resolve("escape/secret.txt"));
    assert.ok(error instanceof WorkspaceRefusal);
    assert.ok(!error.message.includes("outside-secret-content"), "content must never be echoed");
  });

  it("still resolves a legitimate nested file through the maze", () => {
    const entry = workspace.resolve("sub/dir/entry.txt");
    assert.equal(entry.kind, "file");
    assert.equal(entry.relative, "sub/dir/entry.txt");
    assert.equal(readFileSync(entry.absolute, "utf8"), "innocent\n");
  });
});
