// Tests for the workspace confinement ceiling.
//
// These run against a real temporary checkout, symlinks and all: the whole
// point of the module is what the filesystem does with links, and a mocked
// fs would test the mock. Each refusal the module promises is pinned here by
// the path that triggers it.

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as p from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MissingPathError, WorkspaceRefusal, createWorkspace } from "./workspace.mjs";

/** @type {string} */
let root;
/** @type {ReturnType<typeof createWorkspace>} */
let workspace;

beforeAll(() => {
  root = mkdtempSync(p.join(tmpdir(), "workspace-test-"));
  mkdirSync(p.join(root, "src"));
  mkdirSync(p.join(root, ".git", "refs", "heads"), { recursive: true });
  mkdirSync(p.join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(p.join(root, "src", "index.mjs"), "export {}\n");
  writeFileSync(p.join(root, ".git", "config"), "[core]\n");
  writeFileSync(p.join(root, ".github", "workflows", "ci.yml"), "on: push\n");
  writeFileSync(p.join(root, "readme.md"), "hi\n");
  // An inward link (target inside) and an outward one (target outside), plus
  // an intermediate directory link — the three cases the policy splits on.
  symlinkSync(p.join(root, "readme.md"), p.join(root, "src", "inward.md"));
  symlinkSync("/etc/hostname", p.join(root, "outward.md"));
  symlinkSync(p.join(root, "src"), p.join(root, "linked-dir"));
  workspace = createWorkspace({ root });
});

afterAll(() => {
  // Left to the OS tmp cleaner; unlinking every link is noise here.
});

describe("resolution inside the root", () => {
  it("resolves a plain file to its absolute location and kind", () => {
    const entry = workspace.resolve("src/index.mjs");
    expect(entry.kind).toBe("file");
    expect(entry.relative).toBe("src/index.mjs");
    expect(entry.absolute).toBe(p.join(realRoot(), "src", "index.mjs"));
  });

  it("resolves a directory", () => {
    expect(workspace.resolve("src").kind).toBe("directory");
  });

  it("normalises redundant separators and dot segments", () => {
    expect(workspace.resolve("./src/../src/index.mjs").relative).toBe("src/index.mjs");
    expect(workspace.resolve(".github/workflows/../workflows/ci.yml").kind).toBe("file");
  });

  it("treats a backslash as an ordinary character in a POSIX filename", () => {
    // No such file here — the point is it is NOT refused as a traversal.
    expect(() => workspace.resolve("src\\index.mjs")).toThrow(MissingPathError);
  });

  it("does not mistake a dot-prefixed filename for traversal", () => {
    writeFileSync(p.join(root, "..foo.md"), "legit\n");
    expect(workspace.resolve("..foo.md").kind).toBe("file");
    mkdirSync(p.join(root, "..."));
    expect(workspace.resolve("...").kind).toBe("directory");
  });
});

describe("refusals at the boundary", () => {
  it("refuses absolute paths instead of reinterpreting them", () => {
    expect(() => workspace.resolve("/etc/passwd")).toThrow(WorkspaceRefusal);
    expect(() => workspace.resolve("C:\\etc")).toThrow(WorkspaceRefusal);
  });

  it("refuses traversal that lands outside, however it is spelled", () => {
    expect(() => workspace.resolve("../outside.txt")).toThrow(WorkspaceRefusal);
    expect(() => workspace.resolve("src/../../outside.txt")).toThrow(WorkspaceRefusal);
  });

  it("refuses anything resolving into .git, and not .github", () => {
    expect(() => workspace.resolve(".git/config")).toThrow(/inside \.git/);
    expect(() => workspace.resolve(".git/refs/heads/x")).toThrow(/inside \.git/);
    expect(workspace.resolve(".github/workflows/ci.yml").kind).toBe("file");
  });

  it("refuses a case-variant .git directory too — the ceiling owns the rule, not the filesystem", () => {
    mkdirSync(p.join(root, ".GIT"));
    writeFileSync(p.join(root, ".GIT", "config"), "[core]\n");
    expect(() => workspace.resolve(".GIT/config")).toThrow(/inside \.git/);
  });

  it("refuses an intermediate symlink that escapes, via the realpath backstop", () => {
    // linked-dir points inwards; go through it and then climb out.
    expect(() => workspace.resolve("linked-dir/../../../etc/hostname")).toThrow(
      /resolves outside the workspace/,
    );
  });

  it("allows an intermediate symlink that stays inside", () => {
    const entry = workspace.resolve("linked-dir/index.mjs");
    expect(entry.kind).toBe("file");
    expect(entry.relative).toBe("src/index.mjs");
  });

  it("refuses a final-component symlink even when it points inward", () => {
    expect(() => workspace.resolve("src/inward.md")).toThrow(/symlink/);
  });

  it("refuses a final-component symlink aimed outside without reading through it", () => {
    expect(() => workspace.resolve("outward.md")).toThrow(/symlink/);
  });

  it("refuses empty, dot-only and NUL-carrying paths", () => {
    expect(() => workspace.resolve("")).toThrow(WorkspaceRefusal);
    expect(() => workspace.resolve(".")).toThrow(WorkspaceRefusal);
    expect(() => workspace.resolve("..")).toThrow(WorkspaceRefusal);
    expect(() => workspace.resolve("a\0b")).toThrow(WorkspaceRefusal);
  });

  it("refuses paths past its byte ceiling", () => {
    expect(() => workspace.resolve(`${"a/".repeat(2500)}x`)).toThrow(/bytes/);
  });
});

describe("absence", () => {
  it("is its own error, distinct from a refusal", () => {
    expect(() => workspace.resolve("src/nope.mjs")).toThrow(MissingPathError);
    expect(() => workspace.resolve("no-such-dir/nope.mjs")).toThrow(MissingPathError);
  });
});

function realRoot() {
  // The root the workspace resolved once at creation; tests compare against
  // it rather than assuming tmpdir spelling.
  return workspace.root;
}
