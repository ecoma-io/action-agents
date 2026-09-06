// E2E, cross-surface consistency: the three published surfaces of one
// review — the marker comment, the SARIF projection and the gate's check
// run — are three renderings of one canonical record. The replays here pin
// that identity end to end: the embedded record parses back to what SARIF
// and the gate consumed, fingerprints agree across surfaces, gate reasons
// cite only findings the record carries, and two identical replays are
// byte-stable everywhere but the run-scoped marker id.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { parseMarker } from "#core/comment.mjs";

import {
  confirmedConcern,
  context,
  drainWorkspaces,
  EVENT,
  forgeStub,
  INPUTS,
  makeWorkspace,
  readTurn,
  replayIo,
  scriptedChat,
} from "./e2e.fixtures.mjs";
import { renderGateCheckRun, writeSarifFile } from "./index.mjs";
import { decideReviewGate } from "./merge-gate.mjs";
import { parseRecordBlock, previousRecord } from "./record.mjs";
import { reviewPullRequest } from "./run.mjs";
import { toSarif } from "./sarif.mjs";

/** @type {string[]} */
const sarifDirs = [];

afterAll(() => {
  drainWorkspaces();
  for (const dir of sarifDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * The published record of a replay — or a loud failure, never a soft one.
 *
 * @param {import("./run.mjs").RunResult} result
 * @returns {import("./canonical.mjs").CanonicalResult}
 */
function canonicalOf(result) {
  if (result.canonical === undefined) throw new Error("the replay published no canonical record");
  // The publication fact belongs to the returned canonical alone: the
  // embedded block is written by the very upsert whose outcome the fact
  // names, so the record it carries cannot know it. Every surface compared
  // through this helper reads the canonical minus that one run-level fact.
  return {
    ...result.canonical,
    run: { state: result.canonical.run.state, verdict: result.canonical.run.verdict },
  };
}

/**
 * The gate verdict of a replay — same posture.
 *
 * @param {import("./run.mjs").RunResult} result
 * @returns {import("./merge-gate.mjs").ReviewGateDecision}
 */
function gateOf(result) {
  if (result.gate === undefined) throw new Error("the replay returned no gate verdict");
  return result.gate;
}

/**
 * The one comment body the replay's forge recorded.
 *
 * @param {{ forge: ReturnType<typeof forgeStub> }} world
 * @returns {string}
 */
function bodyOf(world) {
  return world.forge.calls.upserts[0]?.body ?? "";
}

/** The finding-shaped gate reason grammar, parsed back to its tuple. */
const FINDING_REASON = /^(confirmed|unresolved) ([a-z-]+) finding at (.+):(\d+)\.$/;

/**
 * The mixed-verdicts scenario: under the adversarial strategy both findings
 * reach a verdict call — the concern confirmed, the nit refuted.
 *
 * @returns {Promise<{ workspace: string, forge: ReturnType<typeof forgeStub>, chat: ReturnType<typeof scriptedChat>, log: string[], result: import("./run.mjs").RunResult }>}
 */
async function mixedVerdicts() {
  const workspace = makeWorkspace({ "src/a.mjs": "line1\nline2\nline3\n" });
  const forge = forgeStub({ config: '{"strategy":"adversarial"}' });
  const chat = scriptedChat([
    readTurn("src/a.mjs"),
    {
      content:
        '{"findings":[{"severity":"concern","kind":"correctness","file":"src/a.mjs","line":2,' +
        '"message":"off-by-one"},{"severity":"nit","kind":"style","file":"src/a.mjs","line":3,' +
        '"message":"naming"}],"summary":"one concern, one nit"}',
    },
    { content: '{"verdict":"confirmed","kind":"correctness","reason":"the guard is missing"}' },
    { content: '{"verdict":"refuted","kind":"style","reason":"the naming is house style"}' },
  ]);
  const { io, log } = replayIo(forge, chat);
  const result = await reviewPullRequest({
    inputs: INPUTS,
    context: context(workspace),
    pullRequestNumber: 7,
    eventName: "pull_request",
    event: EVENT,
    io,
  });
  return { workspace, forge, chat, log, result };
}

describe("cross-surface consistency: one canonical record, three surfaces", () => {
  it("the comment, SARIF and the gate read one canonical record", async () => {
    const world = await confirmedConcern();
    const canonical = canonicalOf(world.result);
    expect(world.result.outcome).toBe("published");
    // The block the comment carries parses back to the very record the run
    // returned — the same object SARIF and the gate consume.
    expect(parseRecordBlock(bodyOf(world))).toEqual(canonical);
    expect(gateOf(world.result)).toEqual(decideReviewGate(canonical));
  });

  it("the confirmed finding is rendered once and fingerprinted identically in SARIF", async () => {
    const world = await confirmedConcern();
    const canonical = canonicalOf(world.result);
    expect(canonical.findings).toHaveLength(1);
    const body = bodyOf(world);
    expect(body).toContain("### Concerns (1)");
    expect(body).toContain("- `src/a.mjs:2` — off-by-one");
    const sarif = toSarif(canonical);
    const results = sarif.runs[0]?.results ?? [];
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      ruleId: "correctness",
      level: "warning",
      message: { text: "off-by-one" },
    });
    expect(results[0]?.locations?.[0]?.physicalLocation?.artifactLocation).toEqual({
      uri: "src/a.mjs",
      uriBaseId: "%SRCROOT%",
    });
    expect(results[0]?.locations?.[0]?.physicalLocation?.region).toEqual({ startLine: 2 });
    // The fingerprint slot is the same identity the record carries — the
    // string a ruleset or a human uses to join comment and SARIF.
    expect(results[0]?.partialFingerprints?.["reviewFindingFingerprint/v2"]).toBe(
      canonical.findings[0]?.fingerprint,
    );
  });

  it("the entrypoint's SARIF file is byte-identical to the projection over the same record", async () => {
    const world = await confirmedConcern();
    const canonical = canonicalOf(world.result);
    const dir = mkdtempSync(join(tmpdir(), "e2e-sarif-"));
    sarifDirs.push(dir);
    const file = writeSarifFile({ tempDir: dir, canonical });
    expect(readFileSync(file, "utf8")).toBe(JSON.stringify(toSarif(canonical)));
  });

  it("gate reasons cite only findings the canonical record carries", async () => {
    const world = await confirmedConcern();
    const canonical = canonicalOf(world.result);
    const gate = gateOf(world.result);
    expect(gate.verdict).toBe("BLOCK");
    expect(gate.reasons).toHaveLength(1);
    for (const reason of gate.reasons) {
      const match = FINDING_REASON.exec(reason);
      expect(match).not.toBeNull();
      const [, lifecycle, kind, file, line] = /** @type {RegExpExecArray} */ (match);
      expect(canonical.findings).toContainEqual(
        expect.objectContaining({ lifecycle, kind, file, line: Number(line) }),
      );
    }
  });

  it("the embedded record is the one the next run reconciles from", async () => {
    const world = await confirmedConcern();
    const recovered = previousRecord(
      [
        {
          id: 101,
          body: bodyOf(world),
          user: { login: "github-actions[bot]" },
          created_at: "",
          updated_at: "",
        },
      ],
      "review",
      ["github-actions[bot]"],
    );
    expect(recovered).toEqual(canonicalOf(world.result));
  });

  it("two identical replays differ only in the run-scoped marker id", async () => {
    const [one, two] = await Promise.all([confirmedConcern(), confirmedConcern()]);
    /** @param {string} body */
    const cut = (body) => {
      const at = body.indexOf("\n");
      return [body.slice(0, at), body.slice(at + 1)];
    };
    const [markerOne, restOne] = cut(bodyOf(one));
    const [markerTwo, restTwo] = cut(bodyOf(two));
    // The marker line is exactly the run's marker: structure fixed, only the
    // run-scoped 12-hex id minted fresh per run (the approved determinism
    // cut — everything after the marker line must be byte-stable).
    expect(markerOne).toMatch(/^<!-- action-agents:review:[0-9a-f]{12}:head=a{40} -->$/);
    expect(markerTwo).toMatch(/^<!-- action-agents:review:[0-9a-f]{12}:head=a{40} -->$/);
    expect(restOne).toBe(restTwo);
  });

  it("the SARIF bytes and the check-run rendering are byte-stable across replays", async () => {
    const [one, two] = await Promise.all([confirmedConcern(), confirmedConcern()]);
    expect(JSON.stringify(toSarif(canonicalOf(one.result)))).toBe(
      JSON.stringify(toSarif(canonicalOf(two.result))),
    );
    for (const gateMode of /** @type {const} */ (["required", "observe"])) {
      expect(renderGateCheckRun({ gate: gateOf(one.result), gateMode })).toEqual(
        renderGateCheckRun({ gate: gateOf(two.result), gateMode }),
      );
    }
  });

  it("the record block rides the comment inert", async () => {
    const world = await confirmedConcern();
    const canonical = canonicalOf(world.result);
    const body = bodyOf(world);
    const blocks = body.match(/<!--\s*action-agents-record:review:[A-Za-z0-9+/=]+\s*-->/gu) ?? [];
    expect(blocks).toHaveLength(1);
    const encoded = /** @type {RegExpMatchArray} */ (
      body.match(/<!--\s*action-agents-record:review:([A-Za-z0-9+/=]+)\s*-->/u)
    )?.[1];
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/);
    // The payload's alphabet carries no HTML and no marker grammar.
    expect(encoded).not.toContain("<");
    expect(encoded).not.toContain("action-agents");
    const marker = parseMarker(body);
    expect(marker?.action).toBe("review");
    expect(marker?.head).toBe(canonical.head);
  });

  it("coverage reads the same on every surface", async () => {
    const world = await confirmedConcern();
    const canonical = canonicalOf(world.result);
    expect(canonical.coverage).toEqual({ covered: ["src/a.mjs"], uncovered: [], total: 1 });
    expect(bodyOf(world)).toContain("Changed files examined: 1/1.");
    expect(gateOf(world.result).reasons).toEqual(["confirmed correctness finding at src/a.mjs:2."]);
  });
});

describe("cross-surface consistency: mixed verdicts under the adversarial strategy", () => {
  it("SARIF publishes only the confirmed finding — the refuted one never enters", async () => {
    const world = await mixedVerdicts();
    const canonical = canonicalOf(world.result);
    expect(canonical.findings.map((finding) => [finding.kind, finding.lifecycle])).toEqual([
      ["correctness", "confirmed"],
      ["style", "refuted"],
    ]);
    const sarif = toSarif(canonical);
    const results = sarif.runs[0]?.results ?? [];
    expect(results).toHaveLength(1);
    expect(results[0]?.ruleId).toBe("correctness");
    expect(sarif.runs[0]?.tool?.driver?.rules?.map((rule) => rule.id)).toEqual(["correctness"]);
  });

  it("the comment renders both verdicts and the record carries both", async () => {
    const world = await mixedVerdicts();
    const canonical = canonicalOf(world.result);
    const body = bodyOf(world);
    expect(body).toContain("### Concerns (1)");
    expect(body).toContain("- `src/a.mjs:2` — off-by-one");
    expect(body).toContain("### Refuted during verification (1)");
    expect(body).toContain("- `src/a.mjs:3` — naming");
    expect(body).toContain("  refuted: the naming is house style");
    expect(body).not.toContain("### Nits");
    expect(parseRecordBlock(body)).toEqual(canonical);
  });

  it("the gate blocks on the confirmed finding alone and the check run says so", async () => {
    const world = await mixedVerdicts();
    const gate = gateOf(world.result);
    expect(gate.verdict).toBe("BLOCK");
    expect(gate.reasons).toEqual(["confirmed correctness finding at src/a.mjs:2."]);
    const required = renderGateCheckRun({ gate, gateMode: "required" });
    expect(required.conclusion).toBe("failure");
    expect(required.summary).toBe("confirmed correctness finding at src/a.mjs:2.");
    const observe = renderGateCheckRun({ gate, gateMode: "observe" });
    expect(observe.conclusion).toBe("neutral");
    expect(observe.title).toBe("review gate: BLOCK");
  });
});
