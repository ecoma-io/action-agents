// E2E, merge-bypass: the theorem that a bad run cannot slip through the
// check-run surface. The gate's rendering is a pure function of the
// canonical record: required mode renders failure for every BLOCK and
// success only for PASS; observe mode renders neutral whatever the run
// decided — a neutral check satisfies a required ruleset but enforces
// nothing (#373), which is why enforcing deployments set gate-mode to
// required and let the real merge refusal carry the weight (#375); and a
// refused, failed or abandoned run renders no check run at all, so a
// required ruleset sees a pending check — fail-closed by absence.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createCanonicalResult } from "./canonical.mjs";
import {
  A_CONTENT,
  artifactOf,
  driveEntrypoint,
  drainEntryTemps,
  drainWorkspaces,
  forgeStub,
  HEAD,
  makeWorkspace,
  MOVED,
  readTurn,
  scriptedChat,
  snapshot,
} from "./e2e.fixtures.mjs";
import { renderGateCheckRun } from "./index.mjs";
import { decideReviewGate } from "./merge-gate.mjs";
import { parseRecordBlock } from "./record.mjs";

afterAll(() => {
  drainWorkspaces();
  drainEntryTemps();
});

/**
 * The gate verdict of a replay — or a loud failure, never a soft one.
 *
 * @param {import("./run.mjs").RunResult} result
 * @returns {import("./merge-gate.mjs").ReviewGateDecision}
 */
function gateOf(result) {
  if (result.gate === undefined) throw new Error("the replay returned no gate verdict");
  return result.gate;
}

/** The confirmed-concern script: the replay every BLOCK renders from. */
const CONFIRMED_SCRIPT = [
  readTurn("src/a.mjs"),
  {
    content:
      '{"findings":[{"severity":"concern","kind":"correctness","file":"src/a.mjs","line":2,' +
      '"message":"off-by-one"}],"summary":"one concern"}',
  },
  { content: '{"verdict":"confirmed","kind":"correctness","reason":"the guard is missing"}' },
];

/** The clean script: the replay every PASS renders from. */
const CLEAN_SCRIPT = [readTurn("src/a.mjs"), { content: '{"findings":[],"summary":"all clear"}' }];

describe("merge-bypass: required mode renders the verdict", () => {
  it("a BLOCK renders a failed check run and still exits green", async () => {
    const workspace = makeWorkspace({ "src/a.mjs": A_CONTENT });
    const forge = forgeStub();
    const chat = scriptedChat(CONFIRMED_SCRIPT);
    const settled = await driveEntrypoint({ workspace, forge, chat, gateMode: "required" });
    // A blocked review is not a broken action: the run resolves, and the
    // enforcement rides the check run's conclusion, not the exit code.
    expect(settled.ok).toBe(true);
    expect(settled.result?.outcome).toBe("published");
    expect(gateOf(/** @type {import("./run.mjs").RunResult} */ (settled.result))).toEqual({
      verdict: "BLOCK",
      reasons: ["confirmed correctness finding at src/a.mjs:2."],
    });
    expect(forge.calls.checkRuns).toHaveLength(1);
    expect(forge.calls.checkRuns[0]).toMatchObject({
      headSha: HEAD,
      name: "review gate",
      conclusion: "failure",
      output: {
        title: "review gate: BLOCK",
        summary: "confirmed correctness finding at src/a.mjs:2.",
      },
    });
    expect(readFileSync(settled.outFile, "utf8")).toContain("gate-verdict=BLOCK\n");
  });

  it("a PASS is the only success the surface renders", async () => {
    const workspace = makeWorkspace({ "src/a.mjs": A_CONTENT });
    const forge = forgeStub();
    const chat = scriptedChat(CLEAN_SCRIPT);
    const settled = await driveEntrypoint({ workspace, forge, chat, gateMode: "required" });
    expect(settled.ok).toBe(true);
    expect(settled.result?.outcome).toBe("published");
    expect(gateOf(/** @type {import("./run.mjs").RunResult} */ (settled.result))).toEqual({
      verdict: "PASS",
      reasons: [],
    });
    expect(forge.calls.checkRuns).toHaveLength(1);
    expect(forge.calls.checkRuns[0]).toMatchObject({
      name: "review gate",
      conclusion: "success",
      output: {
        title: "review gate: PASS",
        summary: "Every finding in the closed vocabulary is either absent or below the gate's bar.",
      },
    });
    expect(readFileSync(settled.outFile, "utf8")).toContain("gate-verdict=PASS\n");
  });

  it("a hollow verdict blocks and renders failure — the record's own defect is a block", () => {
    const hollow = createCanonicalResult({
      head: HEAD,
      run: { state: "published", verdict: "unknown" },
      findings: [],
    });
    const gate = decideReviewGate(hollow);
    expect(gate.verdict).toBe("BLOCK");
    expect(gate.reasons[0]).toContain("hollow");
    expect(renderGateCheckRun({ gate, gateMode: "required" }).conclusion).toBe("failure");
  });
});

describe("merge-bypass: observe mode renders neutral whatever the run decided", () => {
  it("a BLOCK under observe renders neutral — satisfying a ruleset, enforcing nothing", async () => {
    const workspace = makeWorkspace({ "src/a.mjs": A_CONTENT });
    const forge = forgeStub();
    const chat = scriptedChat(CONFIRMED_SCRIPT);
    const settled = await driveEntrypoint({ workspace, forge, chat, gateMode: "observe" });
    expect(settled.ok).toBe(true);
    expect(gateOf(/** @type {import("./run.mjs").RunResult} */ (settled.result))).toEqual({
      verdict: "BLOCK",
      reasons: ["confirmed correctness finding at src/a.mjs:2."],
    });
    expect(forge.calls.checkRuns).toHaveLength(1);
    expect(forge.calls.checkRuns[0]).toMatchObject({
      name: "review gate",
      conclusion: "neutral",
      output: { title: "review gate: BLOCK" },
    });
    // The output keeps the verdict visible under its observe prefix.
    expect(readFileSync(settled.outFile, "utf8")).toContain("gate-verdict=OBSERVE-BLOCK\n");
  });

  it("a PASS under observe renders neutral too — the surface never enforces", async () => {
    const workspace = makeWorkspace({ "src/a.mjs": A_CONTENT });
    const forge = forgeStub();
    const chat = scriptedChat(CLEAN_SCRIPT);
    const settled = await driveEntrypoint({ workspace, forge, chat, gateMode: "observe" });
    expect(settled.ok).toBe(true);
    expect(gateOf(/** @type {import("./run.mjs").RunResult} */ (settled.result))).toEqual({
      verdict: "PASS",
      reasons: [],
    });
    expect(forge.calls.checkRuns[0]).toMatchObject({
      name: "review gate",
      conclusion: "neutral",
      output: { title: "review gate: PASS" },
    });
    expect(readFileSync(settled.outFile, "utf8")).toContain("gate-verdict=OBSERVE-PASS\n");
  });
});

describe("merge-bypass: absence — the runs that render no check run at all", () => {
  it("a refused run renders no check run, no gate output and no SARIF", async () => {
    const workspace = makeWorkspace({ "src/a.mjs": A_CONTENT });
    const forge = forgeStub();
    let cursor = 0;
    /** @type {import("#core/chat.mjs").Chat} */
    const chat = {
      async complete() {
        cursor += 1;
        if (cursor === 1) {
          return {
            content: "",
            toolCalls: [{ id: "r1", name: "read_file", arguments: '{"path":"src/a.mjs"}' }],
            finishReason: "tool_calls",
          };
        }
        if (cursor === 2) {
          return {
            content:
              '{"findings":[{"severity":"concern","kind":"correctness","file":"src/a.mjs","line":2,' +
              '"message":"off-by-one"}],"summary":"one concern"}',
            toolCalls: [],
            finishReason: "stop",
          };
        }
        // The verdict turn shrinks the checkout: capture refuses.
        writeFileSync(join(workspace, "src", "a.mjs"), "line1\n");
        return {
          content: '{"verdict":"confirmed","kind":"correctness","reason":"the guard is real"}',
          toolCalls: [],
          finishReason: "stop",
        };
      },
    };
    const settled = await driveEntrypoint({ workspace, forge, chat });
    expect(settled.ok).toBe(false);
    // A required ruleset sees no completed check — the check stays pending,
    // which is the fail-closed posture: absence, not a green lie.
    expect(forge.calls.checkRuns).toEqual([]);
    expect(readFileSync(settled.outFile, "utf8")).not.toContain("gate-verdict");
    expect(readdirSync(settled.temp)).toEqual(["github-output.txt"]);
    expect(artifactOf(workspace, `review-artifact-refused-${HEAD}.json`)).toMatchObject({
      outcome: { classification: "refused" },
    });
  });

  it("a failed run renders no check run, no gate output and no SARIF", async () => {
    const workspace = makeWorkspace({ "src/a.mjs": "line1\n\nline3\n" });
    const forge = forgeStub();
    const chat = scriptedChat([
      readTurn("src/a.mjs"),
      {
        content:
          '{"findings":[{"severity":"concern","kind":"correctness","file":"src/a.mjs","line":2,' +
          '"message":"off-by-one"}],"summary":"blank anchor"}',
      },
    ]);
    const settled = await driveEntrypoint({ workspace, forge, chat });
    expect(settled.ok).toBe(false);
    expect(forge.calls.checkRuns).toEqual([]);
    expect(readFileSync(settled.outFile, "utf8")).not.toContain("gate-verdict");
    expect(readdirSync(settled.temp)).toEqual(["github-output.txt"]);
    expect(artifactOf(workspace, `review-artifact-failed-${HEAD}.json`)).toMatchObject({
      outcome: { classification: "failed" },
    });
  });

  it("an abandoned run renders no check run and leaves the comment standing", async () => {
    const workspace = makeWorkspace({ "src/a.mjs": A_CONTENT });
    const forge = forgeStub({
      snapshotQueue: [
        snapshot(),
        snapshot(),
        snapshot(),
        snapshot({ head: { ref: "feature", sha: MOVED } }),
      ],
    });
    const chat = scriptedChat(CONFIRMED_SCRIPT);
    const settled = await driveEntrypoint({ workspace, forge, chat });
    expect(settled.ok).toBe(true);
    expect(settled.result?.outcome).toBe("abandoned");
    expect(forge.calls.upserts).toHaveLength(1); // the comment stands
    expect(forge.calls.checkRuns).toEqual([]);
    expect(readFileSync(settled.outFile, "utf8")).not.toContain("gate-verdict");
    expect(readdirSync(settled.temp)).toEqual(["github-output.txt"]);
    expect(artifactOf(workspace, `review-artifact-abandoned-${HEAD}.json`)).toMatchObject({
      outcome: { classification: "abandoned" },
    });
  });
});

describe("merge-bypass: the enforcing check run is a function of the embedded record", () => {
  it("the check run equals the rendering of the record the comment embeds", async () => {
    const workspace = makeWorkspace({ "src/a.mjs": A_CONTENT });
    const forge = forgeStub();
    const chat = scriptedChat(CONFIRMED_SCRIPT);
    const settled = await driveEntrypoint({ workspace, forge, chat, gateMode: "required" });
    const result = /** @type {import("./run.mjs").RunResult} */ (settled.result);
    const embedded = parseRecordBlock(forge.calls.upserts[0]?.body ?? "");
    // The embedded record is the returned canonical minus the publication
    // fact — the block is written by the very upsert whose outcome that
    // fact names, so it cannot carry it.
    expect(embedded).toEqual({
      ...result.canonical,
      run: { state: result.canonical.run.state, verdict: result.canonical.run.verdict },
    });
    const gate = decideReviewGate(/** @type {*} */ (embedded));
    expect(gate).toEqual(result.gate);
    const rendered = renderGateCheckRun({ gate, gateMode: "required" });
    expect(forge.calls.checkRuns[0]).toEqual({
      headSha: HEAD,
      name: rendered.name,
      conclusion: rendered.conclusion,
      output: { title: rendered.title, summary: rendered.summary },
    });
  });
});
