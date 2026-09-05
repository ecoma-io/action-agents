// Tests for the fixed tool registry, run against a real temporary tree with
// symlinks, a binary blob, ignored paths and .git present. The registry's
// promises — schema-exact validation, ceiling cuts with markers, policy
// refusals that name their ceiling, byte-wise determinism — are each pinned
// by the call that exercises them.

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as p from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEvidence } from "#core/untrusted.mjs";
import { createWorkspace } from "#core/workspace.mjs";

import { createTools, TOOL_SPECS } from "./tools.mjs";
import { readsFromRecordedReads, attachProvenance } from "./provenance.mjs";
import { planVerification } from "./verify.mjs";

/** @type {string} */
let root;
/** @type {ReturnType<typeof createTools>["execute"]} */
let execute;

beforeAll(() => {
  root = mkdtempSync(p.join(tmpdir(), "tools-test-"));
  mkdirSync(p.join(root, "src", "deep"), { recursive: true });
  mkdirSync(p.join(root, ".git"));
  mkdirSync(p.join(root, "dist"));
  writeFileSync(p.join(root, "src", "index.mjs"), "export const answer = 42;\n");
  writeFileSync(p.join(root, "src", "deep", "nested.mjs"), "needle here\nand again: needle\n");
  writeFileSync(p.join(root, "readme.md"), "# hi\n");
  writeFileSync(p.join(root, "logo.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]));
  writeFileSync(p.join(root, "dist", "bundle.js"), "ignored content\n");
  symlinkSync(p.join(root, "readme.md"), p.join(root, "src", "link.md"));
  symlinkSync("/etc/hostname", p.join(root, "outside.md"));

  const workspace = createWorkspace({ root });
  // One delimiter for the whole suite keeps assertions on the framing exact.
  const evidence = createEvidence(() => "deadbeefdeadbeef");
  const tools = createTools({ workspace, evidence, ignore: ["dist/**"] });
  execute = tools.execute;
});

afterAll(() => {
  // Left to the OS tmp cleaner.
});

/**
 * The wrapped payload between one known evidence block's markers.
 *
 * @param {string} output
 * @param {string} label
 * @returns {string}
 */
function bodyOf(output, label) {
  const start = output.indexOf(`[evidence:deadbeefdeadbeef ${label}]\n`);
  const end = output.indexOf("[end-evidence:deadbeefdeadbeef]");
  if (start < 0 || end < 0) throw new Error(`no ${label} block in output`);
  return output
    .slice(start + `[evidence:deadbeefdeadbeef ${label}]\n`.length, end)
    .replace(/\n$/, "");
}

describe("the registry surface", () => {
  it("is exactly the three fixed tools", () => {
    expect(TOOL_SPECS.map((tool) => tool.name)).toEqual(["read_file", "list_files", "search"]);
  });

  it("refuses unknown tools without guessing", () => {
    expect(execute("shell", '{"command":"ls"}')).toEqual({
      ok: false,
      output: expect.stringMatching(/unknown tool 'shell'/),
    });
    expect(execute("read_file\nmalicious", "{}").ok).toBe(false);
  });
});

describe("argument validation", () => {
  it("rejects malformed JSON and non-object arguments", () => {
    // Unparsable arguments break the conversation's own wire format —
    // fatal for the run, not a turn to hand back.
    expect(execute("read_file", "{nope")).toEqual({
      ok: false,
      output: "arguments are not valid JSON",
      fatal: true,
    });
    expect(execute("read_file", "[1]").output).toMatch(/must be a JSON object/);
    expect(execute("read_file", "null").output).toMatch(/must be a JSON object/);
    expect(execute("read_file", "[1]").fatal).toBeUndefined();
  });

  it("accepts a query of exactly the byte ceiling and refuses one past it", () => {
    const exact = execute("search", JSON.stringify({ query: "x".repeat(512) }));
    expect(exact.ok).toBe(true);
    const over = execute("search", JSON.stringify({ query: "x".repeat(513) }));
    expect(over.output).toMatch(/longer than 512 bytes/);
  });

  it("rejects missing, wrong-typed and extra arguments per schema", () => {
    expect(execute("read_file", "{}").output).toBe("missing argument 'path'");
    expect(execute("read_file", '{"path":42}').output).toMatch(/'path' must be a non-empty string/);
    expect(execute("search", '{"query":"x","extra":1}').output).toBe("unknown argument 'extra'");
    expect(execute("list_files", '{"path":""}').output).toMatch(/non-empty string/);
  });

  it("caps the query at its byte ceiling", () => {
    const result = execute("search", JSON.stringify({ query: "x".repeat(600) }));
    expect(result.output).toMatch(/longer than 512 bytes/);
  });
});

describe("read_file", () => {
  it("returns a file wrapped as evidence, header carrying the path", () => {
    const result = execute("read_file", '{"path":"src/index.mjs"}');
    expect(result.ok).toBe(true);
    expect(result.output).toContain("[evidence:deadbeefdeadbeef read-file]");
    expect(result.output).toContain("src/index.mjs\nexport const answer = 42;");
    expect(result.output).toContain("[end-evidence:deadbeefdeadbeef]");
  });

  it("refuses directories, missing files, symlinks and binary content by name", () => {
    expect(execute("read_file", '{"path":"src"}').output).toMatch(/names a directory/);
    expect(execute("read_file", '{"path":"src/nope.mjs"}').output).toMatch(/does not exist/);
    expect(execute("read_file", '{"path":"src/link.md"}').output).toMatch(/symlink/);
    expect(execute("read_file", '{"path":"outside.md"}').output).toMatch(/symlink/);
    expect(execute("read_file", '{"path":"logo.bin"}').output).toMatch(/binary content/);
  });

  it("refuses ignored paths on their canonical spelling — resolution decides, not the spelling", () => {
    // `dist/bundle.js` is ignored; every spelling that resolves to it — dot-
    // prefixed, or reached through a `..` that normalization collapses — is
    // refused on `entry.relative`, the same path the listing hides it under.
    expect(execute("read_file", '{"path":"dist/bundle.js"}').output).toMatch(
      /the config ignores this path/,
    );
    expect(execute("read_file", '{"path":"./dist/bundle.js"}').output).toMatch(
      /the config ignores this path/,
    );
    expect(execute("read_file", '{"path":"src/../dist/bundle.js"}').output).toMatch(
      /the config ignores this path/,
    );
  });

  it("refuses .git however it is reached", () => {
    expect(execute("read_file", '{"path":".git/config"}').output).toMatch(/inside \.git/);
    expect(execute("read_file", '{"path":"../.git/config"}').output).toMatch(
      /outside the workspace/,
    );
  });

  it("keeps the runner's filesystem out of error text", () => {
    // A self-referential symlink makes the OS fail with an ELOOP message
    // naming resolved absolute paths; what reaches the model names only the
    // path that was asked for, in whatever spelling it was asked.
    mkdirSync(p.join(root, "loopdir"));
    symlinkSync(p.join(root, "loopdir"), p.join(root, "loopdir", "self"));

    const throughLoop = execute("read_file", '{"path":"loopdir/self/x.txt"}');
    expect(throughLoop.ok).toBe(false);
    expect(throughLoop.output).not.toContain(root);
    expect(throughLoop.output).not.toMatch(/ELOOP|EACCES|\/home\//);
    expect(throughLoop.output).toContain("loopdir");

    const asFinal = execute("read_file", '{"path":"loopdir/self"}');
    expect(asFinal.output).toMatch(/symlink/);
  });

  it("cuts past the evidence cap visibly rather than silently", () => {
    // The wrapper caps at 64 KiB; a file larger than that must come back
    // marked, not clipped quietly.
    const big = "x".repeat(70 * 1024);
    writeFileSync(p.join(root, "big.txt"), big);
    const result = execute("read_file", '{"path":"big.txt"}');
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/\[evidence truncated: \d+ of \d+ bytes shown\]/);
  });
  it("records every captured byte past the 64 KiB wrap — the cut caps the transcript, not the record", () => {
    const line = "z".repeat(96) + "\n"; // 97 bytes a line
    const tree = mkdtempSync(p.join(tmpdir(), "tools-ceiling-"));
    writeFileSync(p.join(tree, "big-file.mjs"), line.repeat(800)); // ~76 KiB captured
    const recorded = new Map();
    const tools = createTools({
      workspace: createWorkspace({ root: tree }),
      evidence: createEvidence(() => "deadbeefdeadbeef"),
      ignore: [],
      recordedReads: recorded,
    });
    const result = tools.execute("read_file", '{"path":"big-file.mjs"}');
    expect(result.ok).toBe(true);
    expect(recorded.get("big-file.mjs")?.length).toBe(97 * 800);
    expect(result.output).toMatch(/\[evidence truncated: \d+ of \d+ bytes shown\]/);
    expect(result.output.length).toBeLessThan(66 * 1024);
  });

  describe("read ledger identity — resolved path", () => {
    it("records reads through an intermediate symlink under the resolved-relative path, and the seam — verification plan and provenance — agrees", () => {
      const tree = mkdtempSync(p.join(tmpdir(), "tools-ledger-"));
      mkdirSync(p.join(tree, "realdir"));
      writeFileSync(p.join(tree, "realdir", "file.mjs"), "line one\ntwo\n");
      symlinkSync(p.join(tree, "realdir"), p.join(tree, "link"), "dir");

      const recorded = new Map();
      const tools = createTools({
        workspace: createWorkspace({ root: tree }),
        evidence: createEvidence(() => "deadbeefdeadbeef"),
        ignore: [],
        recordedReads: recorded,
      });

      // Read through the alias — link/file.mjs -> realdir/file.mjs
      const result = tools.execute("read_file", '{"path":"link/file.mjs"}');
      expect(result.ok).toBe(true);

      // recordedReads is keyed by resolved path, not alias
      expect(recorded.has("realdir/file.mjs")).toBe(true);
      expect(recorded.has("link/file.mjs")).toBe(false);
      expect(recorded.get("realdir/file.mjs")).toBe("line one\ntwo\n");

      // result.path carries the resolved-relative path
      expect(result.path).toBe("realdir/file.mjs");

      // Direct read of the resolved path lands on the same key
      const direct = tools.execute("read_file", '{"path":"realdir/file.mjs"}');
      expect(direct.ok).toBe(true);
      expect(direct.path).toBe("realdir/file.mjs");
      expect(recorded.has("realdir/file.mjs")).toBe(true);

      // Final-component symlink still refused and never recorded
      symlinkSync(p.join(tree, "realdir", "file.mjs"), p.join(tree, "link-to-file.mjs"));
      const refused = tools.execute("read_file", '{"path":"link-to-file.mjs"}');
      expect(refused.ok).toBe(false);
      expect(refused.path).toBeUndefined();
      expect(recorded.has("link-to-file.mjs")).toBe(false);

      // Seam proof: planVerification plans a finding on the inventory path
      /** @type {import("./answer.mjs").Finding[]} */
      const findings = [
        {
          file: "realdir/file.mjs",
          line: 2,
          severity: "concern",
          kind: "correctness",
          message: "off-by-one",
        },
      ];
      const plan = planVerification(findings, {
        strategy: "adversarial",
        laneOf: () => undefined,
        recordedReads: recorded,
      });
      expect(plan.items).toHaveLength(1);
      expect(plan.skipped).toHaveLength(0);
      expect(plan.items[0]?.evidence.path).toBe("realdir/file.mjs");

      // Seam proof: attachProvenance publishes with provenance.path = resolved path
      const ledger = readsFromRecordedReads(recorded);
      const proven = attachProvenance(findings, ledger);
      expect(proven.published).toHaveLength(1);
      expect(proven.quarantined).toHaveLength(0);
      expect(proven.published[0]?.provenance.path).toBe("realdir/file.mjs");
    });
  });
});

describe("list_files", () => {
  it("lists regular files recursively, byte-sorted, symlinks invisible", () => {
    const result = execute("list_files", '{"path":"."}');
    expect(result.ok).toBe(true);
    const body = bodyOf(result.output, "listing");
    expect(body.split("\n")).toEqual([
      "big.txt",
      "logo.bin",
      "readme.md",
      "src/deep/nested.mjs",
      "src/index.mjs",
    ]);
  });

  it("omits ignored paths and .git entirely", () => {
    const result = execute("list_files", '{"path":"."}');
    expect(result.output).not.toContain("dist/");
    expect(result.output).not.toContain(".git");
    expect(result.output).toContain("big.txt");
    expect(result.output).toContain("logo.bin");
    expect(result.output).not.toContain("link.md");
    expect(result.output).not.toContain("outside.md");
  });

  it("refuses a file path and honours subtree roots", () => {
    expect(execute("list_files", '{"path":"readme.md"}').output).toMatch(/names a file/);
    const scoped = execute("list_files", '{"path":"src"}');
    expect(scoped.output).toContain("src/deep/nested.mjs");
    expect(scoped.output).toContain("src/index.mjs");
    expect(scoped.output).not.toContain("readme");
  });

  it("cuts at its entry cap with a marker", () => {
    const dir = p.join(root, "many");
    mkdirSync(dir, { recursive: true });
    for (let index = 0; index < 12; index++) {
      writeFileSync(p.join(dir, `f${String(index).padStart(2, "0")}.txt`), "x\n");
    }
    const workspace = createWorkspace({ root });
    const tools = createTools({
      workspace,
      evidence: createEvidence(() => "deadbeefdeadbeef"),
      ignore: ["dist/**"],
      limits: { listEntries: 5 },
    });
    const result = tools.execute("list_files", '{"path":"many"}');
    expect(result.output).toMatch(/\(listing cut at 5 entries\)/);
    expect(bodyOf(result.output, "listing").split("\n")).toHaveLength(6); // 5 + marker line
  });

  it("lists from an isolated tree without leaning on other tests' fixtures", () => {
    const isolated = mkdtempSync(p.join(tmpdir(), "tools-iso-"));
    writeFileSync(p.join(isolated, "a.md"), "a\n");
    writeFileSync(p.join(isolated, "b.md"), "b\n");
    const tools = createTools({
      workspace: createWorkspace({ root: isolated }),
      evidence: createEvidence(() => "deadbeefdeadbeef"),
      ignore: [],
    });
    const result = tools.execute("list_files", '{"path":"."}');
    expect(bodyOf(result.output, "listing").split("\n")).toEqual(["a.md", "b.md"]);
  });
});

describe("search", () => {
  it("reports matches grouped in byte order with 1-based lines", () => {
    const result = execute("search", '{"query":"needle"}');
    expect(result.ok).toBe(true);
    expect(result.output).toContain("src/deep/nested.mjs:1:needle here");
    expect(result.output).toContain("src/deep/nested.mjs:2:and again: needle");
  });

  it("is case-sensitive and substring-exact", () => {
    expect(execute("search", '{"query":"Needle"}').output).toContain("(no matches)");
    expect(execute("search", '{"query":"eedl"}').output).toContain("src/deep/nested.mjs:1:");
  });

  it("scans from the workspace root when no path is given, skips binaries and ignored trees", () => {
    const everywhere = execute("search", '{"query":"content"}');
    expect(everywhere.output).toContain("(no matches)");

    writeFileSync(p.join(root, "findable.txt"), "findable token\n");
    const result = execute("search", '{"query":"findable"}');
    expect(result.output).toContain("findable.txt:1:findable token");

    const scoped = execute("search", '{"query":"findable","path":"src"}');
    expect(scoped.output).toContain("(no matches)");
  });

  it("stops at its match cap with a marker — even when the cap lands in the last candidate", () => {
    // The regression shape: ONE file carrying more hits than the cap. The
    // cut happens inside the final candidate and must still be marked.
    const isolated = mkdtempSync(p.join(tmpdir(), "tools-solo-"));
    writeFileSync(p.join(isolated, "only.txt"), `${"hit\n".repeat(250)}`);
    const tools = createTools({
      workspace: createWorkspace({ root: isolated }),
      evidence: createEvidence(() => "deadbeefdeadbeef"),
      ignore: [],
      limits: { searchMatches: 200 },
    });
    const result = tools.execute("search", '{"query":"hit"}');
    expect(bodyOf(result.output, "search").split("\n")).toHaveLength(201); // 200 + marker
    expect(result.output).toMatch(/\(search stopped at 200 matches\)/);
  });

  it("stops at its scan cap with a marker instead of reading forever", () => {
    const dir = p.join(root, "wide");
    mkdirSync(dir, { recursive: true });
    for (const name of ["a.txt", "b.txt"]) {
      writeFileSync(p.join(dir, name), `${"z".repeat(100)}\n`);
    }
    const workspace = createWorkspace({ root });
    const tools = createTools({
      workspace,
      evidence: createEvidence(() => "deadbeefdeadbeef"),
      ignore: ["dist/**"],
      limits: { scanBytes: 150 },
    });
    const result = tools.execute("search", '{"query":"zzz"}');
    expect(result.output).toMatch(/\(scan limit reached at 150 bytes\)/);
  });

  it("marks the scan cut when the budget dies inside the only candidate", () => {
    const isolated = mkdtempSync(p.join(tmpdir(), "tools-scan-"));
    writeFileSync(p.join(isolated, "single.txt"), `${"z".repeat(100)}\n`);
    const tools = createTools({
      workspace: createWorkspace({ root: isolated }),
      evidence: createEvidence(() => "deadbeefdeadbeef"),
      ignore: [],
      limits: { scanBytes: 40 },
    });
    const result = tools.execute("search", '{"query":"z"}');
    expect(result.output).toMatch(/\(scan limit reached at 40 bytes\)/);
  });
});
