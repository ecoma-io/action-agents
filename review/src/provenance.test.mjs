// Tests for evidence provenance — the pure module. Anchoring is proven
// deterministic (first covering read wins), quarantine is proven loud and
// identity-carrying, anchored content is proven byte-identical, and every
// malformed shape is proven refused, not coerced.

import { describe, expect, it } from "vitest";

import { attachProvenance, evidenceRef, readsFromRecordedReads } from "./provenance.mjs";

/**
 * @param {Partial<import("./answer.mjs").Finding>} [over]
 * @returns {import("./answer.mjs").Finding}
 */
function finding(over = {}) {
  return { severity: "concern", file: "src/a.mjs", line: 2, message: "off-by-one", ...over };
}

/**
 * @param {Partial<import("./provenance.mjs").LedgerRead>} [over]
 * @returns {import("./provenance.mjs").LedgerRead}
 */
function read(over = {}) {
  return { path: "src/a.mjs", startLine: 1, endLine: 4, ...over };
}

describe("attachProvenance", () => {
  it("anchors a finding to the read that covers its path and line", () => {
    const result = attachProvenance([finding({ line: 3 })], [read()]);
    expect(result.quarantined).toHaveLength(0);
    expect(result.published).toHaveLength(1);
    expect(result.published[0]?.provenance).toEqual({
      path: "src/a.mjs",
      startLine: 1,
      endLine: 4,
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
    });
  });

  it("skips a read that ends before the anchor and takes the later covering one", () => {
    const ledger = [read({ endLine: 3 }), read({ startLine: 1, endLine: 20 })];
    const result = attachProvenance([finding({ line: 7 })], ledger);
    expect(result.published[0]?.provenance).toEqual({
      path: "src/a.mjs",
      startLine: 1,
      endLine: 20,
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
    expect(provenance).toEqual({ path: "src/a.mjs", startLine: 1, endLine: 4 });
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
    ]) {
      expect(() => attachProvenance([finding()], [/** @type {any} */ (malformed)])).toThrow(
        TypeError,
      );
    }
    expect(() => attachProvenance([], /** @type {any} */ ("ledger"))).toThrow(TypeError);
  });

  it("refuses a malformed ledger entry even when no finding consults it", () => {
    expect(() => attachProvenance([], [read(), /** @type {any} */ ({ path: "x.mjs" })])).toThrow(
      TypeError,
    );
  });
});

describe("readsFromRecordedReads", () => {
  it("maps one capture to its full line range, verify's counting", () => {
    const reads = readsFromRecordedReads(new Map([["src/a.mjs", "line1\nline2\nline3\n"]]));
    expect(reads).toEqual([{ path: "src/a.mjs", startLine: 1, endLine: 4 }]);
  });

  it("keeps recording order and one entry per path", () => {
    const recorded = new Map([
      ["src/b.mjs", "b"],
      ["src/a.mjs", "a\nb"],
    ]);
    const reads = readsFromRecordedReads(recorded);
    expect(reads.map((entry) => entry.path)).toEqual(["src/b.mjs", "src/a.mjs"]);
    expect(reads[1]?.endLine).toBe(2);
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

describe("evidenceRef", () => {
  it("renders a range collapsed to one number for a single-line read", () => {
    expect(evidenceRef({ path: "src/a.mjs", startLine: 3, endLine: 3 })).toBe("src/a.mjs:3");
    expect(evidenceRef({ path: "src/a.mjs", startLine: 1, endLine: 4 })).toBe("src/a.mjs:1-4");
  });

  it("refuses malformed provenance fail-closed", () => {
    expect(() => evidenceRef(/** @type {any} */ ({}))).toThrow(TypeError);
    expect(() => evidenceRef(/** @type {any} */ (null))).toThrow(TypeError);
  });
});
