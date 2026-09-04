// Tests for evidence provenance — the pure module. Anchoring is proven
// deterministic (first covering read wins), quarantine is proven loud and
// identity-carrying, anchored content is proven byte-identical, and every
// malformed shape is proven refused, not coerced.

import { describe, expect, it } from "vitest";

import { contentDigest, isDigest } from "./digest.mjs";
import {
  attachProvenance,
  evidenceRef,
  readsFromRecordedReads,
  validatedLedger,
} from "./provenance.mjs";

/**
 * @param {Partial<import("./answer.mjs").Finding>} [over]
 * @returns {import("./answer.mjs").Finding}
 */
function finding(over = {}) {
  return { severity: "concern", file: "src/a.mjs", line: 2, message: "off-by-one", ...over };
}

/** The captured content behind the default read fixture — four lines, hence endLine 4. */
const READ_CONTENT = "a\nb\nc\nd";

/**
 * @param {Partial<import("./provenance.mjs").LedgerRead>} [over]
 * @returns {import("./provenance.mjs").LedgerRead}
 */
function read(over = {}) {
  return {
    path: "src/a.mjs",
    startLine: 1,
    endLine: 4,
    digest: contentDigest(READ_CONTENT),
    ...over,
  };
}

describe("attachProvenance", () => {
  it("anchors a finding to the read that covers its path and line, digest and all", () => {
    const result = attachProvenance([finding({ line: 3 })], [read()]);
    expect(result.quarantined).toHaveLength(0);
    expect(result.published).toHaveLength(1);
    expect(result.published[0]?.provenance).toEqual({
      path: "src/a.mjs",
      startLine: 1,
      endLine: 4,
      digest: contentDigest(READ_CONTENT),
    });
  });

  it("resolves several covering reads to the first recorded — deterministically", () => {
    const ledger = [read({ startLine: 1, endLine: 10 }), read({ startLine: 5, endLine: 20 })];
    const first = attachProvenance([finding({ line: 7 })], ledger);
    const second = attachProvenance([finding({ line: 7 })], ledger);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.published[0]?.provenance).toEqual({
      path: "src/a.mjs",
      startLine: 1,
      endLine: 10,
      digest: contentDigest(READ_CONTENT),
    });
  });

  it("skips a read that ends before the anchor and takes the later covering one", () => {
    const ledger = [read({ endLine: 3 }), read({ startLine: 1, endLine: 20 })];
    const result = attachProvenance([finding({ line: 7 })], ledger);
    expect(result.published[0]?.provenance).toEqual({
      path: "src/a.mjs",
      startLine: 1,
      endLine: 20,
      digest: contentDigest(READ_CONTENT),
    });
  });

  it("quarantines a finding whose line the capture never reached", () => {
    const result = attachProvenance([finding({ line: 30 })], [read({ endLine: 4 })]);
    expect(result.published).toHaveLength(0);
    expect(result.quarantined).toEqual([{ finding: finding({ line: 30 }), reason: "unanchored" }]);
  });

  it("quarantines a finding on a file the ledger never recorded", () => {
    const result = attachProvenance([finding({ file: "src/other.mjs" })], [read()]);
    expect(result.published).toHaveLength(0);
    expect(result.quarantined[0]?.reason).toBe("unanchored");
  });

  it("matches the finding's ./-spelled path to the ledger's canonical spelling", () => {
    const result = attachProvenance(
      [finding({ file: "./src/a.mjs" })],
      [read({ path: "src/a.mjs" })],
    );
    expect(result.published).toHaveLength(1);
    expect(result.published[0]?.provenance?.path).toBe("src/a.mjs");
  });

  it("with an empty ledger, every finding is quarantined", () => {
    const findings = [finding(), finding({ severity: "nit", line: 1, message: "style nit" })];
    const result = attachProvenance(findings, []);
    expect(result.published).toHaveLength(0);
    expect(result.quarantined).toHaveLength(2);
  });

  it("keeps anchored content byte-identical and never mutates its inputs", () => {
    const original = finding();
    const ledger = [read()];
    const result = attachProvenance([original], ledger);
    const anchored = result.published[0];
    expect(anchored).toBeDefined();
    const { provenance, ...content } = /** @type {Record<string, unknown>} */ (anchored);
    expect(JSON.stringify(content)).toBe(JSON.stringify(original));
    expect(provenance).toEqual({
      path: "src/a.mjs",
      startLine: 1,
      endLine: 4,
      digest: contentDigest(READ_CONTENT),
    });
    expect(original).not.toHaveProperty("provenance");
    expect(ledger).toEqual([read()]);
  });

  it("preserves findings order in both result sets", () => {
    const findings = [
      finding({ line: 30, message: "lost" }),
      finding({ message: "kept" }),
      finding({ severity: "nit", file: "src/b.mjs", line: 1, message: "also lost" }),
    ];
    const ledger = [read(), read({ path: "src/absent.mjs" })];
    const result = attachProvenance(findings, ledger);
    expect(result.published.map((anchored) => anchored.message)).toEqual(["kept"]);
    expect(result.quarantined.map((entry) => entry.finding.message)).toEqual(["lost", "also lost"]);
  });

  it("refuses malformed findings fail-closed", () => {
    for (const malformed of [
      null,
      "concern",
      {},
      finding({ file: "" }),
      finding({ line: 0 }),
      finding({ line: 2.5 }),
      { severity: "concern", file: "src/a.mjs", message: "no line" },
    ]) {
      expect(() => attachProvenance([/** @type {any} */ (malformed)], [read()])).toThrow(TypeError);
    }
    expect(() => attachProvenance(/** @type {any} */ ("findings"), [])).toThrow(TypeError);
  });

  it("refuses malformed ledger entries fail-closed", () => {
    for (const malformed of [
      null,
      "read",
      {},
      read({ path: "" }),
      read({ startLine: 0 }),
      read({ endLine: 0.5 }),
      read({ startLine: 5, endLine: 4 }),
      read(/** @type {any} */ ({ digest: undefined })),
      read({ digest: "z".repeat(64) }),
    ]) {
      expect(() => attachProvenance([finding()], [/** @type {any} */ (malformed)])).toThrow(
        TypeError,
      );
    }
    expect(() => attachProvenance([], /** @type {any} */ ("ledger"))).toThrow(TypeError);
  });

  it("refuses a ledger entry with no digest, or a malformed one — even with no finding consulting it", () => {
    expect(() => validatedLedger([read(/** @type {any} */ ({ digest: undefined }))])).toThrow(
      /has no well-formed content digest/,
    );
    expect(() => validatedLedger([read({ digest: "not-a-digest" })])).toThrow(
      /has no well-formed content digest/,
    );
    expect(() => validatedLedger([read({ digest: "A".repeat(64) })])).toThrow(
      /has no well-formed content digest/,
    );
    expect(() => validatedLedger([read()])).not.toThrow();
  });

  it("refuses a malformed ledger entry even when no finding consults it", () => {
    expect(() => attachProvenance([], [read(), /** @type {any} */ ({ path: "x.mjs" })])).toThrow(
      TypeError,
    );
  });
});

describe("readsFromRecordedReads", () => {
  it("maps one capture to its full line range, verify's counting", () => {
    const content = "line1\nline2\nline3\n";
    const reads = readsFromRecordedReads(new Map([["src/a.mjs", content]]));
    expect(reads).toEqual([
      { path: "src/a.mjs", startLine: 1, endLine: 4, digest: contentDigest(content) },
    ]);
  });

  it("digests the captured bytes, not a re-render of them", () => {
    const content = "alpha\nbeta\ngamma";
    const reads = readsFromRecordedReads(new Map([["src/x.mjs", content]]));
    expect(reads[0]?.digest).toBe(contentDigest(content));
    expect(isDigest(reads[0]?.digest ?? "")).toBe(true);
    const again = readsFromRecordedReads(new Map([["src/x.mjs", content]]));
    expect(again).toEqual(reads);
  });

  it("refuses non-map ledgers and malformed entries fail-closed", () => {
    expect(() => readsFromRecordedReads(/** @type {any} */ ({}))).toThrow(TypeError);
    expect(() => readsFromRecordedReads(/** @type {any} */ (new Map([["src/a.mjs", 42]])))).toThrow(
      TypeError,
    );
    expect(() => readsFromRecordedReads(/** @type {any} */ (new Map([["", "content"]])))).toThrow(
      TypeError,
    );
  });
});

describe("evidence-ceiling contract", () => {
  it("an anchor past the 64 KiB transcript cut still resolves — the record, not the transcript, decides", () => {
    const content = ("z".repeat(96) + "\n").repeat(800); // ~76 KiB captured; one block shows at most 64 KiB
    const ledger = readsFromRecordedReads(new Map([["src/big.mjs", content]]));
    expect(ledger[0]?.endLine).toBe(801);
    const result = attachProvenance([finding({ file: "src/big.mjs", line: 800 })], ledger);
    expect(result.published).toHaveLength(1);
    expect(result.quarantined).toEqual([]);
  });
});

describe("evidenceRef", () => {
  it("renders a range collapsed to one number for a single-line read", () => {
    const digest = contentDigest("x\ny\nz");
    expect(evidenceRef({ path: "src/a.mjs", startLine: 3, endLine: 3, digest })).toBe(
      "src/a.mjs:3",
    );
    expect(evidenceRef({ path: "src/a.mjs", startLine: 1, endLine: 4, digest })).toBe(
      "src/a.mjs:1-4",
    );
  });

  it("refuses malformed provenance fail-closed", () => {
    expect(() => evidenceRef(/** @type {any} */ ({}))).toThrow(TypeError);
    expect(() => evidenceRef(/** @type {any} */ (null))).toThrow(TypeError);
    expect(() =>
      evidenceRef({ path: "src/a.mjs", startLine: 1, endLine: 4, digest: "short" }),
    ).toThrow(/has no well-formed content digest/);
    expect(() =>
      evidenceRef({
        path: "src/a.mjs",
        startLine: 1,
        endLine: 4,
        digest: contentDigest("x\ny\nz"),
      }),
    ).not.toThrow();
  });
});
