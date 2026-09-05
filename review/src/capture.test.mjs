// Tests for the capture boundary: every published finding's evidence is
// read from the reviewed bytes at its own (file, line) anchor, and every
// way that read can fail refuses the run rather than skipping. The matrix
// pins the happy path, digest stability across checkouts, and every refusal
// class — each naming the file and line it could not capture.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as p from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { createWorkspace } from "#core/workspace.mjs";

import { contentDigest } from "./digest.mjs";
import { EVIDENCE_EXCERPT_CHARS } from "./verify.mjs";
import { CaptureRefusal, captureFindingEvidence } from "./capture.mjs";

/** @type {string} */
let root;
/** @type {ReturnType<typeof createWorkspace>} */
let workspace;

beforeAll(() => {
  root = mkdtempSync(p.join(tmpdir(), "capture-test-"));
  mkdirSync(p.join(root, "src"));
  writeFileSync(p.join(root, "src", "a.mjs"), "first line\nsecond line\nthird line\n");
  writeFileSync(p.join(root, "src", "crlf.mjs"), "one\r\ntwo\r\n");
  writeFileSync(p.join(root, "src", "empty.mjs"), "");
  writeFileSync(p.join(root, "src", "bin.mjs"), "a\x00b\n");
  writeFileSync(p.join(root, "src", "hostile.mjs"), "@maintainer <script>alert(1)</script> ok\n");
  workspace = createWorkspace({ root });
});

/**
 * Asserts a refusal and returns its message — every class must name the
 * anchor it could not capture.
 *
 * @param {string} file
 * @param {number} line
 * @returns {string}
 */
function refusalOf(file, line) {
  try {
    captureFindingEvidence({ workspace, file, line });
  } catch (cause) {
    expect(cause).toBeInstanceOf(CaptureRefusal);
    return /** @type {CaptureRefusal} */ (cause).message;
  }
  throw new Error(`expected a capture refusal for ${file}:${String(line)}`);
}

describe("captureFindingEvidence", () => {
  it("binds the anchor line, its digest and its sanitiser-safe excerpt", () => {
    const evidence = captureFindingEvidence({ workspace, file: "src/a.mjs", line: 2 });
    expect(evidence.subject).toBe("second line");
    expect(evidence.digest).toBe(contentDigest("second line"));
    expect(evidence.excerpt).toBe("second line");
  });

  it("digests identically whatever line endings the checkout carried", () => {
    const lf = captureFindingEvidence({ workspace, file: "src/a.mjs", line: 1 });
    const crlf = captureFindingEvidence({ workspace, file: "src/crlf.mjs", line: 1 });
    expect(crlf.subject).toBe("one");
    expect(crlf.digest).toBe(contentDigest("one"));
    expect(lf.digest).toBe(contentDigest("first line"));
  });

  it("caps the excerpt at the declared retention bound and sanitises it", () => {
    const evidence = captureFindingEvidence({ workspace, file: "src/hostile.mjs", line: 1 });
    expect(evidence.excerpt.length).toBeLessThanOrEqual(EVIDENCE_EXCERPT_CHARS);
    expect(evidence.excerpt).toContain("@\u200Cmaintainer");
    expect(evidence.excerpt).toContain("&lt;script>");
    expect(evidence.excerpt).not.toContain("<script>");
  });

  it("refuses an anchor on a path the checkout does not carry", () => {
    expect(refusalOf("src/absent.mjs", 1)).toBe(
      "capture refused for src/absent.mjs:1 — the reviewed file could not be read from the checkout: " +
        "'src/absent.mjs' does not exist in the workspace",
    );
  });

  it("refuses an anchor outside the workspace confinement", () => {
    const message = refusalOf("../outside.mjs", 1);
    expect(message).toMatch(/^capture refused for \.\.\/outside\.mjs:1 — /);
  });

  it("refuses an anchor on a directory", () => {
    expect(refusalOf("src", 1)).toMatch(/^capture refused for src:1 — /);
  });

  it("refuses an empty file — there is no line to anchor", () => {
    expect(refusalOf("src/empty.mjs", 1)).toBe(
      "capture refused for src/empty.mjs:1 — the reviewed file is empty",
    );
  });

  it("refuses a binary file — it carries no capturable line", () => {
    expect(refusalOf("src/bin.mjs", 1)).toMatch(/^capture refused for src\/bin\.mjs:1 — /);
  });

  it("refuses a line past the end of the file, naming the file's length", () => {
    expect(refusalOf("src/a.mjs", 4)).toBe(
      "capture refused for src/a.mjs:4 — the reviewed file carries 3 line(s)",
    );
  });

  it("refuses a zero, negative or fractional anchor line", () => {
    expect(refusalOf("src/a.mjs", 0)).toBe(
      "capture refused for src/a.mjs:0 — the anchor line must be a 1-based integer",
    );
    expect(refusalOf("src/a.mjs", -2)).toMatch(/the anchor line must be a 1-based integer/);
    expect(refusalOf("src/a.mjs", 1.5)).toMatch(/the anchor line must be a 1-based integer/);
  });

  it("names the file and the line in every refusal message", () => {
    for (const [file, line] of /** @type {Array<[string, number]>} */ ([
      ["src/absent.mjs", 7],
      ["../outside.mjs", 2],
      ["src", 3],
      ["src/empty.mjs", 1],
      ["src/bin.mjs", 1],
      ["src/a.mjs", 99],
      ["src/a.mjs", 0],
    ])) {
      expect(refusalOf(file, line)).toMatch(
        new RegExp(
          `^capture refused for ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:${String(line)} — `,
        ),
      );
    }
  });
});
