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
import {
  CaptureRefusal,
  anchorWindow,
  captureFindingEvidence,
  extractQuotedSpans,
  quotedEvidenceInWindow,
} from "./capture.mjs";

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
  writeFileSync(p.join(root, "src", "blank.mjs"), "line1\n\nline3\n");
  writeFileSync(p.join(root, "src", "ws.mjs"), "line1\n   \nline3\n");
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

  it("binds a blank anchor line as the empty span — withholding is downstream law, not the capture's", () => {
    // The raw-span law: the capture reports the bytes, however empty. A
    // span that certifies nothing is withheld by the run (#411) — refusing
    // here would fold the withheld law into the refusal law and destroy
    // the distinction the run boundary records through.
    const evidence = captureFindingEvidence({ workspace, file: "src/blank.mjs", line: 2 });
    expect(evidence.subject).toBe("");
    expect(evidence.digest).toBe(contentDigest(""));
    expect(evidence.excerpt).toBe("");
  });

  it("binds a whitespace-only span raw — normalisation is the identity's job, never the capture's", () => {
    const evidence = captureFindingEvidence({
      workspace,
      file: "src/ws.mjs",
      line: 2,
    });
    expect(evidence.subject).toBe("   ");
    expect(evidence.digest).toBe(contentDigest("   "));
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

describe("the quoted-span gate helpers", () => {
  it("extracts backtick-, single- and double-quoted spans in message order", () => {
    expect(extractQuotedSpans("duplicate `// CLI entry` header comments")).toEqual([
      "// CLI entry",
    ]);
    expect(extractQuotedSpans("the 'unused import' never fires")).toEqual(["unused import"]);
    expect(extractQuotedSpans('the "ledger fixtures" differ')).toEqual(["ledger fixtures"]);
    expect(extractQuotedSpans("'single' then `back` then \"double\"")).toEqual([
      "single",
      "back",
      "double",
    ]);
  });

  it("drops empty spans and carries nothing for plain or unclosed quotes", () => {
    expect(extractQuotedSpans("empty `` and '' and \"\" carry no evidence")).toEqual([]);
    expect(extractQuotedSpans("a plain off-by-one claim")).toEqual([]);
    expect(extractQuotedSpans("an `unclosed span never matches")).toEqual([]);
  });

  it("reads a single quote as a delimiter only at word boundaries", () => {
    // The apostrophe inside a contraction or a possessive is text, never
    // an evidence delimiter.
    expect(extractQuotedSpans("doesn't handle it and isn't")).toEqual([]);
    // Genuine single-quoted code in prose still extracts.
    expect(extractQuotedSpans("the 'guard' clause")).toEqual(["guard"]);
    // Both in one message: the possessive stays text, the quote carries.
    expect(extractQuotedSpans("file's 'quoted'")).toEqual(["quoted"]);
  });

  it("cuts the anchor's window at three lines on each side, clamped to the file", () => {
    const content = Array.from({ length: 20 }, (_, i) => `line${String(i + 1)}`).join("\n");
    expect(anchorWindow(content, 10)).toBe("line7\nline8\nline9\nline10\nline11\nline12\nline13");
    expect(anchorWindow(content, 1)).toBe("line1\nline2\nline3\nline4");
    expect(anchorWindow(content, 20)).toBe("line17\nline18\nline19\nline20");
  });

  it("windows nothing for an anchor past the file's end and folds checkout CRs", () => {
    const content = Array.from({ length: 20 }, (_, i) => `line${String(i + 1)}`).join("\n");
    expect(anchorWindow(content, 21)).toBeNull();
    expect(anchorWindow(content, 0)).toBeNull();
    expect(anchorWindow(content, 1.5)).toBeNull();
    expect(anchorWindow("one\r\ntwo\r\n", 2)).toBe("one\ntwo");
  });

  it("passes vacuously when the message quotes nothing, whatever the window", () => {
    expect(quotedEvidenceInWindow("a plain off-by-one claim", null)).toBe(true);
    expect(quotedEvidenceInWindow("a plain off-by-one claim", "any window")).toBe(true);
  });

  it("withholds a quoted span that appears nowhere in the anchor's window", () => {
    // The dogfood shape that cost a review its credibility: the anchor
    // points at a decoy line while the quoted evidence lives elsewhere.
    const lines = Array.from({ length: 20 }, (_, i) => `line${String(i + 1)}`);
    lines[2] = "record.jobs[jobName] = entry;";
    lines[16] = "// CLI entry";
    const content = lines.join("\n");
    const window = anchorWindow(content, 3);
    expect(window).not.toContain("// CLI entry");
    expect(quotedEvidenceInWindow("duplicate `// CLI entry` header comments", window)).toBe(false);
    // The mirror-image pass: anchoring the real header certifies it.
    expect(
      quotedEvidenceInWindow("duplicate `// CLI entry` header comments", anchorWindow(content, 17)),
    ).toBe(true);
  });

  it("passes on one hit among several quoted spans, and on a span at the window's edge", () => {
    const content = Array.from({ length: 20 }, (_, i) => `line${String(i + 1)}`).join("\n");
    const window = anchorWindow(content, 5);
    expect(quotedEvidenceInWindow("`nowhere` and `line4` and `nowhere either`", window)).toBe(true);
    // The edges: three lines out is the window's rim, four is outside it.
    expect(quotedEvidenceInWindow("`line2` is missing", window)).toBe(true);
    expect(quotedEvidenceInWindow("`line1` is missing", window)).toBe(false);
    expect(quotedEvidenceInWindow("`line8` is missing", window)).toBe(true);
    expect(quotedEvidenceInWindow("`line9` is missing", window)).toBe(false);
  });

  it("fails closed on demanded evidence with no window, and matches case-sensitively", () => {
    expect(quotedEvidenceInWindow("`line3` is missing", null)).toBe(false);
    const window = anchorWindow("line1\nline2\nline3\n", 2);
    expect(quotedEvidenceInWindow("`line2` is missing", window)).toBe(true);
    expect(quotedEvidenceInWindow("`LINE2` is missing", window)).toBe(false);
  });

  it("matches a span only where its flanking characters are non-word or the edge", () => {
    // A prefix-glued twin does not certify `run`, a suffix-glued one does
    // not certify `line1`.
    expect(quotedEvidenceInWindow("`run` is missing", "only runTime and runtime here")).toBe(false);
    expect(quotedEvidenceInWindow("`line1` is missing", "the line10 decoy")).toBe(false);
    // Punctuation-flanked and window-edge occurrences still certify.
    expect(quotedEvidenceInWindow("`run` is missing", "call (run) now")).toBe(true);
    expect(quotedEvidenceInWindow("`run` is missing", "run time")).toBe(true);
    expect(quotedEvidenceInWindow("`run` is missing", "time run")).toBe(true);
  });

  it("binds the window the capture reads — clamped and CR-folded like the helpers cut it", () => {
    expect(captureFindingEvidence({ workspace, file: "src/a.mjs", line: 2 }).window).toBe(
      "first line\nsecond line\nthird line",
    );
    expect(captureFindingEvidence({ workspace, file: "src/crlf.mjs", line: 1 }).window).toBe(
      "one\ntwo",
    );
  });
});
