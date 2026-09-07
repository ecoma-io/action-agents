// E2E, merge-bypass: the theorem that a bad run cannot slip through the
// check-run surface. The gate's rendering is a pure function of the
// canonical record: required mode renders failure for every BLOCK and
// success only for PASS; observe mode renders neutral whatever the run
// decided — a neutral check satisfies a required ruleset but enforces
// nothing (#373), which is why enforcing deployments set gate-mode to
// required and let the real merge refusal carry the weight (#375); and
// every non-published terminal lands the terminal check run its §8 row
// names (#377) — `failure` under `required` for `refused`, `failed` and
// `abandoned`, `neutral` for `skip`, `nothing-to-review` and `dry-run` in
// both modes — because absence is never the enforcement state.

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
  reviewMarker,
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

describe("merge-bypass: terminal rows — the red terminals land the check (T8, #377 inversion)", () => {
  it("a refused run renders the terminal check naming the refusal — absence was the defect", async () => {
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
    // The old pin asserted `checkRuns` [] and read that absence as the
    // fail-closed posture. #377 is exactly that absence: run 33995911404's
    // required ruleset pended forever because no check ever reported. The
    // red boundary now lands the terminal check itself — observe mode
    // renders the BLOCK row neutral, with the terminal named — and the
    // run's own error still fails the step.
    expect(forge.calls.checkRuns).toHaveLength(1);
    expect(forge.calls.checkRuns[0]).toMatchObject({
      headSha: HEAD,
      name: "review gate",
      output: {
        title: "review gate: OBSERVE-BLOCK (refused)",
        summary: "capture refused for src/a.mjs:2 — the reviewed file carries 1 line(s)",
      },
    });
    // The rest of the §8 row is unchanged: no gate-verdict output and no
    // SARIF — those stay published-run surfaces.
    expect(readFileSync(settled.outFile, "utf8")).not.toContain("gate-verdict");
    expect(readdirSync(settled.temp)).toEqual(["github-output.txt"]);
    expect(artifactOf(workspace, `review-artifact-refused-${HEAD}.json`)).toMatchObject({
      outcome: { classification: "refused" },
    });
  });

  it("a failed run renders the terminal check naming the failure — absence was the defect", async () => {
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
    // Inverted with #377: the check exists and names the terminal — it
    // never reports absence, and it never reports pass over a red run.
    expect(forge.calls.checkRuns).toHaveLength(1);
    expect(forge.calls.checkRuns[0]).toMatchObject({
      headSha: HEAD,
      name: "review gate",
      conclusion: "neutral",
      output: {
        title: "review gate: OBSERVE-BLOCK (failed)",
        summary: "findings[0].subject must be a non-empty string",
      },
    });
    expect(readFileSync(settled.outFile, "utf8")).not.toContain("gate-verdict");
    expect(readdirSync(settled.temp)).toEqual(["github-output.txt"]);
    expect(artifactOf(workspace, `review-artifact-failed-${HEAD}.json`)).toMatchObject({
      outcome: { classification: "failed" },
    });
  });

  it("an abandoned run renders the terminal check and leaves the comment standing", async () => {
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
    // Inverted with #377: a run that published its review and then lost
    // the freshness race lands the terminal check on the head it reviewed
    // — the BLOCK row, neutral under observe — so a ruleset watching the
    // branch sees the ending instead of a check that never reports.
    expect(forge.calls.checkRuns).toHaveLength(1);
    expect(forge.calls.checkRuns[0]).toMatchObject({
      headSha: HEAD,
      name: "review gate",
      conclusion: "neutral",
      output: {
        title: "review gate: OBSERVE-BLOCK (abandoned)",
        summary: expect.stringContaining("moved while its review was being published"),
      },
    });
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
    const returned = result.canonical;
    if (returned === undefined) throw new Error("the replay published no canonical record");
    expect(embedded).toEqual({
      ...returned,
      run: { state: returned.run.state, verdict: returned.run.verdict },
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

/**
 * One replay per §8 non-published row, with the facts its assertion pins.
 * @type {Array<{ name: string, terminal: string, blocking: boolean, ok: boolean, summary: RegExp,
 *   setup: () => { workspace: string, forge: ReturnType<typeof forgeStub>, chat: import("#core/chat.mjs").Chat, extra?: Record<string, string> },
 * }>}
 */
const TERMINAL_SCENARIOS = [
  {
    name: "refused run",
    terminal: "refused",
    blocking: true,
    ok: false,
    summary: /failed the output contract/,
    setup: () => ({
      workspace: makeWorkspace({ "src/a.mjs": A_CONTENT }),
      forge: forgeStub(),
      chat: scriptedChat([
        readTurn("src/a.mjs"),
        { content: "this is not the JSON object the contract specifies" },
        { content: "still not the JSON object the contract specifies" },
      ]),
    }),
  },
  {
    name: "failed run",
    terminal: "failed",
    blocking: true,
    ok: false,
    summary: /subject must be a non-empty string/,
    setup: () => ({
      workspace: makeWorkspace({ "src/a.mjs": "line1\n\nline3\n" }),
      forge: forgeStub(),
      chat: scriptedChat([
        readTurn("src/a.mjs"),
        {
          content:
            '{"findings":[{"severity":"concern","kind":"correctness","file":"src/a.mjs","line":2,' +
            '"message":"off-by-one"}],"summary":"blank anchor"}',
        },
      ]),
    }),
  },
  {
    name: "abandoned run (lost before publication)",
    terminal: "abandoned",
    blocking: true,
    ok: true,
    summary: /moved while it was being reviewed/,
    setup: () => ({
      workspace: makeWorkspace({ "src/a.mjs": A_CONTENT }),
      forge: forgeStub({
        snapshotQueue: [snapshot(), snapshot({ head: { ref: "feature", sha: MOVED } })],
      }),
      chat: scriptedChat(CONFIRMED_SCRIPT),
    }),
  },
  {
    name: "abandoned run (lost after publication)",
    terminal: "abandoned",
    blocking: true,
    ok: true,
    summary: /moved while its review was being published/,
    setup: () => ({
      workspace: makeWorkspace({ "src/a.mjs": A_CONTENT }),
      forge: forgeStub({
        snapshotQueue: [
          snapshot(),
          snapshot(),
          snapshot(),
          snapshot({ head: { ref: "feature", sha: MOVED } }),
        ],
      }),
      chat: scriptedChat(CONFIRMED_SCRIPT),
    }),
  },
  {
    name: "skip run (draft state)",
    terminal: "skip",
    blocking: false,
    ok: true,
    summary: /draft/,
    setup: () => ({
      workspace: makeWorkspace({ "src/a.mjs": A_CONTENT }),
      forge: forgeStub({ snapshotQueue: [snapshot({ draft: true })] }),
      chat: scriptedChat(CONFIRMED_SCRIPT),
    }),
  },
  {
    name: "nothing-to-review run (marker cleared)",
    terminal: "nothing-to-review",
    blocking: false,
    ok: true,
    summary: /universe empty/,
    setup: () => ({
      workspace: makeWorkspace({ "src/a.mjs": A_CONTENT }),
      forge: forgeStub({
        files: [],
        comments: [
          {
            id: 40,
            body: `${reviewMarker("beef42", HEAD)}\nstale prose`,
            user: { login: "github-actions[bot]" },
            created_at: "",
            updated_at: "",
          },
        ],
      }),
      chat: scriptedChat(CONFIRMED_SCRIPT),
    }),
  },
  {
    name: "dry-run run",
    terminal: "dry-run",
    blocking: false,
    ok: true,
    summary: /dry run/,
    setup: () => ({
      workspace: makeWorkspace({ "src/a.mjs": A_CONTENT }),
      forge: forgeStub(),
      chat: scriptedChat(CLEAN_SCRIPT),
      extra: { "INPUT_DRY-RUN": "true" },
    }),
  },
];

describe("merge-bypass: the terminal §8 matrix — every non-published terminal renders its row (T9)", () => {
  for (const scenario of TERMINAL_SCENARIOS) {
    for (const gateMode of /** @type {const} */ (["observe", "required"])) {
      it(`a ${scenario.name} renders its row under ${gateMode}`, async () => {
        const { workspace, forge, chat, extra } = scenario.setup();
        const settled = await driveEntrypoint({
          workspace,
          forge,
          chat,
          gateMode,
          ...(extra === undefined ? {} : { extra }),
        });
        // The exit follows the run's own ending — enforcement is the check
        // run's job, never the exit code — so the red rows stay red and a
        // BLOCK row that returns stays green.
        expect(settled.ok).toBe(scenario.ok);
        if (scenario.ok) expect(settled.result?.outcome).toBe(scenario.terminal);
        // The row: BLOCK terminals render failure under required and
        // neutral-with-the-block-named under observe; the non-block
        // terminals render neutral in both modes. Never absence (#377),
        // never pass over a red run.
        expect(forge.calls.checkRuns).toHaveLength(1);
        const [conclusion, title] = !scenario.blocking
          ? ["neutral", `review gate: NEUTRAL (${scenario.terminal})`]
          : gateMode === "required"
            ? ["failure", `review gate: BLOCK (${scenario.terminal})`]
            : ["neutral", `review gate: OBSERVE-BLOCK (${scenario.terminal})`];
        expect(forge.calls.checkRuns[0]).toMatchObject({
          headSha: HEAD,
          name: "review gate",
          conclusion,
          output: { title, summary: expect.stringMatching(scenario.summary) },
        });
      });
    }
  }
});

describe("merge-bypass: published-without-artifact still lands the gate surfaces (T10)", () => {
  it("a forced artifact-write failure renders the gate surfaces from the canonical", async () => {
    const workspace = makeWorkspace({ "src/a.mjs": A_CONTENT });
    // The artifact path exists as a file: the archive cannot land, and the
    // published run downgrades to published-without-artifact (the logged-
    // loss tier). The gate surfaces fire from the canonical fact — the
    // archive's loss never mutes the enforcement.
    writeFileSync(join(workspace, ".review-artifact"), "not a directory");
    const forge = forgeStub();
    const chat = scriptedChat(CLEAN_SCRIPT);
    const settled = await driveEntrypoint({ workspace, forge, chat, gateMode: "required" });
    expect(settled.ok).toBe(true);
    expect(settled.result?.outcome).toBe("published-without-artifact");
    // The check run renders from the canonical: PASS under required.
    expect(forge.calls.checkRuns).toHaveLength(1);
    expect(forge.calls.checkRuns[0]).toMatchObject({
      headSha: HEAD,
      name: "review gate",
      conclusion: "success",
      output: { title: "review gate: PASS" },
    });
    // The output and the SARIF stand too — the surfaces are the canonical's.
    expect(readFileSync(settled.outFile, "utf8")).toContain("gate-verdict=PASS\n");
    expect(readdirSync(settled.temp).some((name) => name.startsWith("review-sarif-"))).toBe(true);
  });
});
