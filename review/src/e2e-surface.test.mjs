// E2E, cross-surface consistency: the published surfaces of one review —
// the marker comment and the SARIF projection — are renderings of one
// canonical record. The replays here pin that identity end to end: the
// embedded record parses back to what SARIF consumed, fingerprints agree
// across surfaces, and two identical replays are byte-stable everywhere
// but the run-scoped marker id.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { parseMarker } from "#core/comment.mjs";

import {
  A_CONTENT,
  changedFile,
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
import { writeSarifFile } from "./index.mjs";
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
 * The one comment body the replay's forge recorded.
 *
 * @param {{ forge: ReturnType<typeof forgeStub> }} world
 * @returns {string}
 */
function bodyOf(world) {
  return world.forge.calls.upserts[0]?.body ?? "";
}

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

/**
 * The incomplete-coverage scenario: two changed files, one read — the
 * default (medium) strictness lets the run conclude and publish anyway.
 *
 * @returns {Promise<{ workspace: string, forge: ReturnType<typeof forgeStub>, chat: ReturnType<typeof scriptedChat>, log: string[], result: import("./run.mjs").RunResult }>}
 */
async function partiallyCoveredRun() {
  const workspace = makeWorkspace({ "src/a.mjs": A_CONTENT, "src/b.mjs": "b1\nb2\nb3\n" });
  const forge = forgeStub({ files: [changedFile("src/a.mjs"), changedFile("src/b.mjs")] });
  const chat = scriptedChat([
    readTurn("src/a.mjs"),
    // The stop is heard once — the notice names src/b.mjs — and the second
    // stop ends the run with the same coverage the first would have ended it.
    { content: '{"findings":[],"summary":"nothing to report"}' },
    { content: '{"findings":[],"summary":"nothing to report"}' },
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

describe("cross-surface consistency: one canonical record, every surface", () => {
  it("the comment and SARIF read one canonical record", async () => {
    const world = await confirmedConcern();
    const canonical = canonicalOf(world.result);
    expect(world.result.outcome).toBe("published");
    // The block the comment carries parses back to the very record the run
    // returned — the same object the SARIF projection consumes.
    expect(parseRecordBlock(bodyOf(world))).toEqual(canonical);
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

  it("SARIF results cite only findings the canonical record carries", async () => {
    const world = await confirmedConcern();
    const canonical = canonicalOf(world.result);
    const results = toSarif(canonical).runs[0]?.results ?? [];
    expect(results).toHaveLength(1);
    for (const result of results) {
      const kind = result.ruleId;
      const uri = result.locations?.[0]?.physicalLocation?.artifactLocation?.uri;
      const line = result.locations?.[0]?.physicalLocation?.region?.startLine;
      expect(canonical.findings).toContainEqual(expect.objectContaining({ kind, file: uri, line }));
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

  it("the SARIF bytes are byte-stable across replays", async () => {
    const [one, two] = await Promise.all([confirmedConcern(), confirmedConcern()]);
    expect(JSON.stringify(toSarif(canonicalOf(one.result)))).toBe(
      JSON.stringify(toSarif(canonicalOf(two.result))),
    );
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
    expect(canonical.run.verdict).toBe("pass");
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

  it("the confirmed finding alone reaches SARIF — the enforcement input (ADR 006)", async () => {
    const world = await mixedVerdicts();
    const canonical = canonicalOf(world.result);
    const results = toSarif(canonical).runs[0]?.results ?? [];
    expect(results).toHaveLength(1);
    expect(results[0]?.ruleId).toBe("correctness");
  });
});

describe("cross-surface consistency: incomplete coverage rides the verdict, never the state", () => {
  it("a published run that left changed files unread carries verdict fail — and every surface reads it", async () => {
    const world = await partiallyCoveredRun();
    const canonical = canonicalOf(world.result);
    expect(world.result.outcome).toBe("published");
    // The default (medium) strictness lets the run conclude — the state
    // stays published, the run published what it concluded — but the
    // review was not COMPLETE: the verdict alone must carry the
    // incompleteness (it rides the verdict, never the state), and the
    // verdict is the code law's fail, never a pass.
    expect(canonical.run).toEqual({ state: "published", verdict: "fail" });
    expect(canonical.coverage).toEqual({
      covered: ["src/a.mjs"],
      uncovered: ["src/b.mjs"],
      total: 2,
    });
    // The comment embeds exactly this record — the fail rides the thread.
    expect(parseRecordBlock(bodyOf(world))).toEqual(canonical);
    // The SARIF projection of the same record: nothing confirmed, nothing reported.
    expect(toSarif(canonical).runs[0]?.results ?? []).toEqual([]);
    // The artifact — the run's machine-readable record — carries the same
    // published classification and the same coverage facts.
    expect(world.result.artifact).toMatchObject({
      outcome: { classification: "published" },
      coverage: canonical.coverage,
    });
  });
});
