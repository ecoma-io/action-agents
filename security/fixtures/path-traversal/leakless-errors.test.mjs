// Leakless errors — filesystem error text and absolute runner paths never
// reach a model-visible surface.
//
// attack attempted
//   - a path whose parent is a regular file (fs throws ENOTDIR)
//   - a path whose parent chain is a symlink cycle (fs throws ELOOP)
//   - a single component over the filesystem's name limit (fs throws
//     ENAMETOOLONG where the filesystem enforces it)
//   - an absolute path where a workspace-relative path is expected
//   →
// capability remains bounded
//   - the caller always receives a typed safe refusal / absence error, never
//     the raw `Error: ENOTDIR …` the OS raised
//   - the message a model-facing caller can observe names only what was
//     asked for and the fixed refusal text — no OS error code, no
//     "too many levels of symbolic links", no resolved absolute path from
//     the runner's filesystem
//
// Deterministic and offline: a real temp tree with a real symlink cycle,
// cleaned up in `after`. No network, no model, no timers.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MissingPathError, WorkspaceRefusal, createWorkspace } from "#core/workspace.mjs";
import { createTools } from "../../../review/src/tools.mjs";
import { createEvidence } from "#core/untrusted.mjs";

/** The fixed refusal text every untyped filesystem error is mapped onto. */
const SAFE_REFUSAL = (requested) =>
  `refusing '${requested}': it cannot be resolved safely on this filesystem`;

/** The fixed refusal text when the final target itself cannot be inspected. */
const INSPECT_REFUSAL = (requested) =>
  `refusing '${requested}': it cannot be inspected safely on this filesystem`;

/** The fixed absence text `resolveOrRefuse` maps MissingPathError onto. */
const ABSENT = (requested) => `'${requested}' does not exist`;

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
  assert.fail("expected the call to fail, but it succeeded");
}

describe("leakless errors: OS text and absolute paths stay out of the error surface", () => {
  let root;
  let workspace;
  let tools;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "aa-leakless-errors-"));

    // `file.txt` is a regular file: a path beneath it (`file.txt/child`)
    // passes the parent realpath (realpath of a file succeeds) and then hits
    // ENOTDIR at the final lstat, while `file.txt/child/x` hits ENOTDIR
    // inside the parent realpath itself. Both branches must carry a fixed,
    // typed refusal.
    writeFileSync(join(root, "file.txt"), "I am a file, not a directory\n");

    // A self-contained symlink cycle: `cyc-a -> cyc-b -> cyc-a`.
    symlinkSync("cyc-b", join(root, "cyc-a"));
    symlinkSync("cyc-a", join(root, "cyc-b"));

    // A normal file so the model-visible path at least has real content.
    mkdirSync(join(root, "ok"), { recursive: true });
    writeFileSync(join(root, "ok", "file.txt"), "fine\n");

    workspace = createWorkspace({ root });
    tools = createTools({
      workspace,
      evidence: createEvidence(() => "deadbeefdeadbeef"),
      ignore: [],
    });
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("maps an ENOTDIR on the final target to the typed safe refusal", () => {
    // `file.txt/child`: the parent chain realpaths fine, the lstat of the
    // joined target raises ENOTDIR — mapped onto the fixed "cannot be
    // inspected" refusal.
    const error = capture(() => workspace.resolve("file.txt/child"));
    assert.ok(error instanceof WorkspaceRefusal, "expected a typed WorkspaceRefusal");
    assert.equal(error.message, INSPECT_REFUSAL("file.txt/child"));
    assert.doesNotMatch(error.message, /ENOTDIR|not a directory/i);
    assert.ok(!error.message.includes(root), "message must not carry the resolved path");
    assert.ok(!error.message.includes(tmpdir()), "message must not carry the runner's tmpdir");
  });

  it("maps an ENOTDIR inside the parent realpath to the typed safe refusal", () => {
    // `file.txt/child/x`: the intermediate component is a regular file, so
    // the parent realpath itself raises ENOTDIR — mapped onto the fixed
    // "cannot be resolved safely" refusal.
    const error = capture(() => workspace.resolve("file.txt/child/x"));
    assert.ok(error instanceof WorkspaceRefusal, "expected a typed WorkspaceRefusal");
    assert.equal(error.message, SAFE_REFUSAL("file.txt/child/x"));
    assert.doesNotMatch(error.message, /ENOTDIR|not a directory/i);
    assert.ok(!error.message.includes(root), "message must not carry the resolved path");
    assert.ok(!error.message.includes(tmpdir()), "message must not carry the runner's tmpdir");
  });

  it("maps an ELOOP parent chain to the typed safe refusal, with no OS text", () => {
    const error = capture(() => workspace.resolve("cyc-a/x"));
    assert.ok(error instanceof WorkspaceRefusal, "expected a typed WorkspaceRefusal");
    assert.equal(error.message, SAFE_REFUSAL("cyc-a/x"));
    assert.doesNotMatch(error.message, /ELOOP|too many symbolic|circular/i);
    assert.ok(!error.message.includes(root), "message must not carry the resolved path");
    assert.ok(!error.message.includes(tmpdir()), "message must not carry the runner's tmpdir");
  });

  it("keeps an over-long component a typed refusal or absence, never OS text", () => {
    // A 300-byte single component exceeds NAME_MAX on Linux filesystems, so
    // fs raises ENAMETOOLONG here; where a filesystem accepted it, the
    // missing entry is the typed absence. Either way no OS text escapes.
    const long = "z".repeat(300);
    const requested = `${long}/file`;
    const error = capture(() => workspace.resolve(requested));
    assert.ok(
      error instanceof WorkspaceRefusal || error instanceof MissingPathError,
      "expected a typed refusal or typed absence",
    );
    assert.doesNotMatch(error.message, /ENAMETOOLONG|file name too long/i);
    assert.ok(!error.message.includes(root), "message must not carry the resolved path");
    assert.ok(!error.message.includes(tmpdir()), "message must not carry the runner's tmpdir");
  });

  it("refuses absolute inputs before any filesystem interaction", () => {
    for (const hostile of ["/etc/passwd", "/abs/path", "C:\\windows\\win.ini", "c:/windows"]) {
      const error = capture(() => workspace.resolve(hostile));
      assert.ok(error instanceof WorkspaceRefusal, `expected a refusal for '${hostile}'`);
      assert.match(error.message, /absolute path/);
    }
  });

  it("shows the model only the fixed refusal text for the ELOOP parent", () => {
    const result = tools.execute("read_file", JSON.stringify({ path: "cyc-a/x" }));
    assert.equal(result.ok, false);
    assert.equal(result.output, SAFE_REFUSAL("cyc-a/x"));
    assert.ok(!result.output.includes(root) && !result.output.includes(tmpdir()));
  });

  it("shows the model only the fixed refusal text for the ENOTDIR target", () => {
    const result = tools.execute("read_file", JSON.stringify({ path: "file.txt/child" }));
    assert.equal(result.ok, false);
    assert.equal(result.output, INSPECT_REFUSAL("file.txt/child"));
    assert.ok(!result.output.includes(root) && !result.output.includes(tmpdir()));
  });

  it("shows the model absence text, not ENOENT, for a missing path", () => {
    const result = tools.execute("read_file", JSON.stringify({ path: "absent-123/thing" }));
    assert.equal(result.ok, false);
    assert.equal(result.output, ABSENT("absent-123/thing"));
    assert.doesNotMatch(result.output, /ENOENT|no such file/i);
    assert.ok(!result.output.includes(root) && !result.output.includes(tmpdir()));
  });

  it("refuses an absolute path at the model-visible layer too", () => {
    const result = tools.execute("read_file", JSON.stringify({ path: "/etc/passwd" }));
    assert.equal(result.ok, false);
    // The refusal echoes what was ASKED for (the attacker's own string) and
    // names the fixed reason; the runner's own filesystem paths stay out.
    assert.equal(
      result.output,
      "refusing '/etc/passwd': an absolute path is asked for relatively or not at all",
    );
    assert.ok(!result.output.includes(root) && !result.output.includes(tmpdir()));
  });
});
