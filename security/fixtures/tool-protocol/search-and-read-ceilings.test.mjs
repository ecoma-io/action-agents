// Search and read ceilings — the tool-protocol surface.
//
// Attacks:
//   - a search whose candidate set dwarfs MAX_SEARCH_MATCHES → the answer is
//     exactly MAX_SEARCH_MATCHES entries long and ends with the
//     `(search stopped at N matches)` termination marker — never a raw
//     unbounded listing
//   - a read_file of a file past MAX_READ_BYTES → the model-visible answer is
//     capped at the read ceiling while the header carries the real byte
//     counts and the tool ledger keeps every byte actually captured
//   - a file whose size is exactly the ceiling → read in full, no cut marker
//   - a BOM + CRLF file past the ceiling → the header byte counts still match
//     the on-disk bytes (BOM and carriage returns included)
//
// Security property asserted: what the model sees is always bounded and
// explicitly marked at the enforced ceiling, and the ledger is never smaller
// than the captured bytes.
//
// Deterministic and offline: the tree is scripted in a throwaway temp dir and
// the evidence delimiter is injected; no network, no model, no timers.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as p from "node:path";
import { after, before, describe, it } from "node:test";

import { createEvidence } from "#core/untrusted.mjs";
import { createWorkspace } from "#core/workspace.mjs";

import { createTools, MAX_READ_BYTES, MAX_SEARCH_MATCHES } from "../../../review/src/tools.mjs";

/** @type {string} */
let root;
/** @type {ReturnType<typeof createWorkspace>} */
let workspace;
/** @type {ReturnType<typeof createTools>} */
let tools;
/** @type {Map<string, string>} */
let recordedReads;

const evidence = createEvidence(() => "aaaabbbbccccdddd");

before(() => {
  root = mkdtempSync(p.join(tmpdir(), "tool-protocol-ceilings-"));
  workspace = createWorkspace({ root });
  recordedReads = new Map();
  tools = createTools({ workspace, evidence, ignore: [], recordedReads });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("search ceiling — bounded and marked", () => {
  it("a search with more candidates than MAX_SEARCH_MATCHES stops at exactly the ceiling and marks it", () => {
    const dir = p.join(root, "search");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 10; i++) {
      writeFileSync(p.join(dir, `f${String(i)}.txt`), "needle\n".repeat(30));
    }

    const result = tools.execute("search", JSON.stringify({ query: "needle", path: "search" }));

    assert.equal(MAX_SEARCH_MATCHES, 200, "the search ceiling is frozen at 200");
    assert.equal(result.ok, true);
    assert.ok(
      result.output.includes(`(search stopped at ${String(MAX_SEARCH_MATCHES)} matches)`),
      "the termination marker rides in the answer",
    );
    const listed = result.output.split("\n").filter((line) => line.endsWith(":needle"));
    assert.equal(listed.length, MAX_SEARCH_MATCHES, "the answer lists exactly the ceiling");
    assert.ok(
      !result.output.includes("search/f6.txt:21:needle"),
      "a match beyond the ceiling never appears",
    );
  });
});

describe("read_file ceiling — capped answer, byte-true header, full ledger", () => {
  it("a file past MAX_READ_BYTES caps the answer, names the real bytes and keeps the captured read in the ledger", () => {
    const tail = "TAIL-BEYOND-CAP";
    writeFileSync(p.join(root, "big.txt"), "x".repeat(MAX_READ_BYTES) + `${tail}\n`);
    const size = statSync(p.join(root, "big.txt")).size;

    const result = tools.execute("read_file", JSON.stringify({ path: "big.txt" }));

    assert.equal(MAX_READ_BYTES, 2 ** 20, "the read ceiling is frozen at 1 MiB");
    assert.equal(result.ok, true);
    assert.ok(
      result.output.includes(
        `(showing the first ${String(MAX_READ_BYTES)} of ${String(size)} bytes)`,
      ),
      "the header names the real byte counts",
    );
    assert.ok(
      !result.output.includes(tail),
      "the model-visible answer never carries bytes past the ceiling",
    );
    const recorded = recordedReads.get("big.txt");
    assert.equal(recorded, "x".repeat(MAX_READ_BYTES), "the ledger keeps the full captured read");
    assert.equal(
      Buffer.byteLength(recorded, "utf8"),
      MAX_READ_BYTES,
      "the ledger is the full read ceiling",
    );
  });

  it("a file exactly at the ceiling reads in full and carries no cut marker", () => {
    writeFileSync(p.join(root, "cap.txt"), "z".repeat(MAX_READ_BYTES));

    const result = tools.execute("read_file", JSON.stringify({ path: "cap.txt" }));

    assert.equal(result.ok, true);
    assert.ok(
      !result.output.includes("(showing the first"),
      "no truncation header at the exact cap",
    );
    assert.equal(recordedReads.get("cap.txt"), "z".repeat(MAX_READ_BYTES), "every byte read");
    assert.equal(Buffer.byteLength(recordedReads.get("cap.txt"), "utf8"), MAX_READ_BYTES);
  });

  it("a BOM + CRLF file past the ceiling still reports byte-accurate counts", () => {
    const line = "line\r\n";
    const text = line.repeat(Math.ceil(MAX_READ_BYTES / line.length) + 1);
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
    writeFileSync(p.join(root, "bom-crlf.txt"), bytes);
    const size = statSync(p.join(root, "bom-crlf.txt")).size;

    const result = tools.execute("read_file", JSON.stringify({ path: "bom-crlf.txt" }));

    assert.equal(result.ok, true);
    assert.equal(size, 3 + Buffer.byteLength(text, "utf8"), "BOM + CRLF bytes on disk");
    assert.ok(
      result.output.includes(
        `(showing the first ${String(MAX_READ_BYTES)} of ${String(size)} bytes)`,
      ),
      "the header counts the BOM and carriage-return bytes",
    );
    const recorded = recordedReads.get("bom-crlf.txt");
    assert.ok(
      recorded.startsWith("\uFEFFline\r\n"),
      "the BOM and CRLF survive the byte-accurate read",
    );
    assert.equal(Buffer.byteLength(recorded, "utf8"), MAX_READ_BYTES);
  });
});
