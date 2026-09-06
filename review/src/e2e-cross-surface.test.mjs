// E2E, cross-surface cases + replay (PR9, T17–T18): one harness, three laws.
//
// T17 — the ten cases A–J of the task brief, each replayed through the real
// entrypoint in both gate modes: the SAME run outcome must produce the SAME
// view on every surface — the comment's embedded record, the gate verdict,
// the check run, the SARIF projection, the workspace artifact and the
// runner outputs. No surface may contradict another: a comment saying pass
// over a failed check, or a published comment with no artifact where one
// was declared, is a defect this suite pins.
//
// §8 — the audit's terminal × projection matrix as one executable table:
// every row walked under both gate modes, the projection read off the run
// and compared against the row's contract facts. No terminal maps to
// absence except the named carve-out.
//
// T18 — the deterministic race replay harness: the races the E2E suite can
// only sample become replayable schedules — explicit event-ordered
// interleavings through the fixture seams (snapshot queues, comment
// threads, chat scripts), no sleeps anywhere, and the law that the same
// schedule replayed twice yields the same terminal result, fingerprint for
// fingerprint.

import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createCanonicalResult } from "./canonical.mjs";
import {
  A_CONTENT,
  drainEntryTemps,
  drainWorkspaces,
  FOREIGN,
  forgeStub,
  HEAD,
  makeWorkspace,
  MOVED,
  readTurn,
  reviewMarker,
  scriptedChat,
  snapshot,
} from "./e2e.fixtures.mjs";
import { driveCase, recordingDeletes, replayFingerprint } from "./e2e-cross-surface.fixtures.mjs";
import { renderGateCheckRun, renderTerminalCheckRun } from "./index.mjs";
import { decideReviewGate } from "./merge-gate.mjs";
import { embedRecordBlock, parseRecordBlock } from "./record.mjs";
import { toSarif } from "./sarif.mjs";

afterAll(() => {
  drainWorkspaces();
  drainEntryTemps();
});

// ── The scenarios: each factory returns a fresh replay world ──

const CONFIRMED_ANSWER =
  '{"findings":[{"severity":"concern","kind":"correctness","file":"src/a.mjs","line":2,' +
  '"message":"off-by-one"}],"summary":"one concern"}';
const CONFIRMED_VERDICT =
  '{"verdict":"confirmed","kind":"correctness","reason":"the guard is missing"}';
const UNCERTAIN_VERDICT =
  '{"verdict":"uncertain","kind":"correctness","reason":"cannot decide from the evidence"}';
const REFUSED_ANSWERS = /** @type {const} */ ([
  "this is not the JSON object the contract specifies",
  "still not the JSON object the contract specifies",
]);
const BLANK_ANCHOR_ANSWER =
  '{"findings":[{"severity":"concern","kind":"correctness","file":"src/a.mjs","line":2,' +
  '"message":"off-by-one"}],"summary":"blank anchor"}';

/**
 * A scenario world: a fresh workspace over the named files, a deleting-
 * recording forge, and the scripted chat the replay reads.
 *
 * @param {{
 *   files?: Record<string, string>,
 *   forge?: Parameters<typeof forgeStub>[0],
 *   script: Array<ReturnType<typeof readTurn> | { content: string }>,
 *   extra?: Record<string, string>,
 * }} input
 */
function scenario(input) {
  const workspace = makeWorkspace(input.files ?? { "src/a.mjs": A_CONTENT });
  return {
    workspace,
    forge: recordingDeletes(forgeStub(input.forge)),
    chat: scriptedChat(
      input.script.map((step) => (typeof step === "string" ? readTurn(step) : step)),
    ),
    ...(input.extra === undefined ? {} : { extra: input.extra }),
  };
}

/** A: the clean run — every file read, nothing found, the only honest PASS. */
const cleanScenario = () =>
  scenario({
    script: [readTurn("src/a.mjs"), { content: '{"findings":[],"summary":"all clear"}' }],
  });

/** B: the confirmed finding — the canonical blocking case. */
const confirmedScenario = () =>
  scenario({
    script: [readTurn("src/a.mjs"), { content: CONFIRMED_ANSWER }, { content: CONFIRMED_VERDICT }],
  });

/** C: the unresolved finding — the verifier could not decide; the gate still blocks. */
const unresolvedScenario = () =>
  scenario({
    script: [readTurn("src/a.mjs"), { content: CONFIRMED_ANSWER }, { content: UNCERTAIN_VERDICT }],
  });

/** D: the verification failure — a demoted finding fails the review's own gate. */
const demotedScenario = () =>
  scenario({
    forge: { config: '{"strategy":"adversarial"}' },
    script: [
      readTurn("src/a.mjs"),
      { content: CONFIRMED_ANSWER },
      { content: '{"verdict":"confirmed","kind":"style","reason":"looks fine to me"}' },
    ],
  });

/** E: the refused run — the output contract declines, twice, before any write. */
const refusedScenario = () =>
  scenario({
    script: [
      readTurn("src/a.mjs"),
      { content: REFUSED_ANSWERS[0] },
      { content: REFUSED_ANSWERS[1] },
    ],
  });

/** F: the failed run — an undeclared defect the red boundary records. */
const failedScenario = () =>
  scenario({
    files: { "src/a.mjs": "line1\n\nline3\n" },
    script: [readTurn("src/a.mjs"), { content: BLANK_ANCHOR_ANSWER }],
  });

/** An honest record of one confirmed finding at the reviewed head. */
const FINDING_RECORD = createCanonicalResult({
  head: HEAD,
  run: { state: "published", verdict: "pass" },
  findings: [
    {
      severity: "concern",
      kind: "correctness",
      file: "src/a.mjs",
      line: 2,
      message: "older guard",
      subject: "line2",
      lifecycle: "confirmed",
      verdict: "confirmed",
      reason: "was real once",
    },
  ],
});

/** An honest record of a clean pass at the reviewed head. */
const CLEAN_RECORD = createCanonicalResult({
  head: HEAD,
  run: { state: "published", verdict: "pass" },
  findings: [],
});

/**
 * An own-marker thread comment carrying a record block.
 *
 * @param {number} id the comment id the forge reports
 * @param {string} markerId the marker id baked into the marker line
 * @param {string} body the prose under the marker line
 */
function ownComment(
  /** @type {number} */ id,
  /** @type {string} */ markerId,
  /** @type {string} */ body,
) {
  return {
    id,
    body: `${reviewMarker(markerId, HEAD)}\n${body}`,
    user: { login: "github-actions[bot]" },
    created_at: "",
    updated_at: "",
  };
}

/** I: the stale finding across HEAD — the same finding the previous run left. */
const staleScenario = () =>
  scenario({
    forge: { comments: [ownComment(40, "feed12", embedRecordBlock(FINDING_RECORD))] },
    script: [readTurn("src/a.mjs"), { content: CONFIRMED_ANSWER }, { content: CONFIRMED_VERDICT }],
  });

/**
 * The record block of `record` with its fingerprint mangled past recovery.
 *
 * @param {import("./canonical.mjs").CanonicalResult} record the record to mangle
 */
function mangledBlock(record) {
  const payload = JSON.parse(
    Buffer.from(
      embedRecordBlock(record).slice("<!-- action-agents-record:review:".length, -" -->".length),
      "base64",
    ).toString("utf8"),
  );
  payload.findings[0].fingerprint = "0".repeat(64);
  return `<!-- action-agents-record:review:${Buffer.from(JSON.stringify(payload), "utf8").toString("base64")} -->`;
}

/** J: the malformed embedded record — unreadable payload, a first run again. */
const malformedScenario = () =>
  scenario({
    forge: { comments: [ownComment(40, "feed07", mangledBlock(FINDING_RECORD))] },
    script: [readTurn("src/a.mjs"), { content: CONFIRMED_ANSWER }, { content: CONFIRMED_VERDICT }],
  });

/** H: the forged comment — a foreign author's record claiming the current head. */
const forgedScenario = () =>
  scenario({
    forge: {
      comments: [
        {
          id: 40,
          body: `${reviewMarker("feed03", HEAD)}\n${embedRecordBlock(CLEAN_RECORD)}\n`,
          user: { login: "mr-forge" },
          created_at: "",
          updated_at: "",
        },
      ],
    },
    script: [readTurn("src/a.mjs"), { content: CONFIRMED_ANSWER }, { content: CONFIRMED_VERDICT }],
  });

/** G: the abandoned race — the head moves after the write; the comment stands. */
const movedPostScenario = () =>
  scenario({
    forge: {
      snapshotQueue: [
        snapshot(),
        snapshot(),
        snapshot(),
        snapshot({ head: { ref: "feature", sha: MOVED } }),
      ],
    },
    script: [readTurn("src/a.mjs"), { content: CONFIRMED_ANSWER }, { content: CONFIRMED_VERDICT }],
  });

/** The pre-write abandonment: the head moves before anything is written. */
const movedPreScenario = () =>
  scenario({
    forge: {
      snapshotQueue: [snapshot(), snapshot({ head: { ref: "feature", sha: MOVED } })],
      comments: [
        ownComment(30, "cafe30", embedRecordBlock(CLEAN_RECORD)),
        ownComment(40, "beef40", embedRecordBlock(CLEAN_RECORD)),
      ],
    },
    script: [readTurn("src/a.mjs"), { content: CONFIRMED_ANSWER }, { content: CONFIRMED_VERDICT }],
  });

/** The §8 clearing row: an own marker and an empty universe — the clearing write. */
const clearingScenario = () =>
  scenario({
    forge: { files: [], comments: [ownComment(40, "beef42", "stale prose")] },
    script: [readTurn("src/a.mjs"), { content: CONFIRMED_ANSWER }, { content: CONFIRMED_VERDICT }],
  });

/** The T5 clearing race: the newest own marker binds a foreign, undatable head. */
const foreignMarkerScenario = () =>
  scenario({
    forge: {
      files: [],
      comments: [
        {
          id: 40,
          body: `${reviewMarker("beef42", FOREIGN)}\n${embedRecordBlock(CLEAN_RECORD)}`,
          user: { login: "github-actions[bot]" },
          created_at: "",
          updated_at: "",
        },
      ],
    },
    script: [readTurn("src/a.mjs"), { content: CONFIRMED_ANSWER }, { content: CONFIRMED_VERDICT }],
  });

/** The duplicate-comment race: two own markers; the upsert keeps exactly one. */
const duplicatesScenario = () =>
  scenario({
    forge: {
      comments: [
        ownComment(30, "cafe30", embedRecordBlock(CLEAN_RECORD)),
        ownComment(40, "beef40", embedRecordBlock(CLEAN_RECORD)),
      ],
    },
    script: [readTurn("src/a.mjs"), { content: CONFIRMED_ANSWER }, { content: CONFIRMED_VERDICT }],
  });

/** The dry-run row: the full review replayed with the write suppressed. */
const dryRunScenario = () =>
  scenario({
    script: [readTurn("src/a.mjs"), { content: '{"findings":[],"summary":"all clear"}' }],
    extra: { "INPUT_DRY-RUN": "true" },
  });

/** The carve-out: a death before the run holds the event facts. */
const eventFactsScenario = () => {
  const base = scenario({ script: [readTurn("src/a.mjs")] });
  return { ...base, extra: { GITHUB_EVENT_PATH: join(base.workspace, "absent-event.json") } };
};

// ── The shared assertions: what "no surface contradicts another" means ──

/**
 * The canonical record of a projection — or a loud failure, never a soft
 * one. The publication fact lives on the returned canonical alone (the
 * embedded block is written by the very upsert whose outcome the fact
 * names), so every cross-surface comparison reads the record minus it.
 *
 * @param {Awaited<ReturnType<typeof driveCase>>} p
 * @returns {import("./canonical.mjs").CanonicalResult}
 */
function canonicalOf(p) {
  const canonical = p.canonical;
  if (canonical === undefined) throw new Error("the replay published no canonical record");
  return { ...canonical, run: { state: canonical.run.state, verdict: canonical.run.verdict } };
}

/**
 * The gate verdict of a projection — same posture.
 *
 * @param {Awaited<ReturnType<typeof driveCase>>} p
 * @returns {import("./merge-gate.mjs").ReviewGateDecision}
 */
function gateOf(p) {
  if (p.gate === undefined) throw new Error("the replay returned no gate verdict");
  return p.gate;
}

/**
 * A renderer's shape, as the forge records the check-run write.
 *
 * @param {string} head the 40-hex head the check run is reported against
 * @param {ReturnType<typeof renderGateCheckRun> | ReturnType<typeof renderTerminalCheckRun>} rendered
 */
function asCheckRun(head, rendered) {
  return {
    headSha: head,
    name: rendered.name,
    conclusion: rendered.conclusion,
    output: { title: rendered.title, summary: rendered.summary },
  };
}

/**
 * Drives one published scenario in one gate mode and asserts the whole
 * published projection agrees: the comment's embedded record IS the
 * canonical the run returned; the gate IS the pure decision over that
 * record; the check run IS that verdict rendered; the SARIF file IS the
 * projection over the same record; the artifact names the comment; the
 * outputs name the verdict and the file. Returns the projection so the
 * case pins its own prose on top.
 *
 * @param {() => ReturnType<typeof scenario>} make
 * @param {"observe" | "required"} gateMode
 */
async function projectPublished(make, gateMode) {
  const p = await driveCase(make(), gateMode);
  const canonical = canonicalOf(p);
  const gate = gateOf(p);
  expect(p.settled.ok).toBe(true);
  expect(p.outcome).toBe("published");
  expect(p.upserts).toHaveLength(1);
  expect(parseRecordBlock(p.upserts[0]?.body ?? "")).toEqual(canonical);
  // The publication fact rides the run's own record (the embedded block
  // predates the write), and names exactly the write the forge recorded.
  expect(p.canonical?.run.publication).toBe(p.upserts[0]?.op);
  expect(gate).toEqual(decideReviewGate(canonical));
  expect(p.checkRuns).toEqual([asCheckRun(canonical.head, renderGateCheckRun({ gate, gateMode }))]);
  expect(p.sarif).toEqual(toSarif(canonical));
  expect(p.artifacts).toHaveLength(1);
  expect(p.artifacts[0]?.json.outcome).toMatchObject({ classification: "published" });
  expect(p.artifacts[0]?.json.provenance).toMatchObject({ commentId: p.upserts[0]?.id });
  expect(p.outputs).toContain(
    `gate-verdict=${gateMode === "observe" ? "OBSERVE-" : ""}${gate.verdict}\n`,
  );
  expect(p.outputs).toContain("artifact-file=");
  return { p, canonical, gate };
}
/**
 * Pins a terminal row's one check run: the §8 row the audit names, read
 * back from what the entrypoint actually wrote — conclusion and title per
 * the mode, the summary carrying the run's own reason.
 *
 * @param {Awaited<ReturnType<typeof driveCase>>} p
 * @param {string} terminal
 * @param {boolean} blocking
 * @param {"observe" | "required"} gateMode
 * @param {string | undefined} reason the run's reason sentence, when the run returned one
 */
function expectTerminalCheck(p, terminal, blocking, gateMode, reason = p.reason) {
  expect(p.checkRuns).toEqual([
    asCheckRun(HEAD, renderTerminalCheckRun({ terminal, reason, gateMode })),
  ]);
}

/**
 * The shared facts of a terminal row that never published: no gate, no
 * SARIF, no gate-verdict output.
 *
 * @param {Awaited<ReturnType<typeof driveCase>>} p
 */
function expectNoPublishedSurfaces(p) {
  expect(p.gate).toBeUndefined();
  expect(p.canonical).toBeUndefined();
  expect(p.sarif).toBeUndefined();
  expect(p.outputs).not.toContain("gate-verdict=");
}

// ── T17: the ten cases A–J on one harness ──

describe("cross-surface cases A–J: one run outcome, one view on every surface (T17)", () => {
  it("A: the clean pass projects pass everywhere", async () => {
    for (const gateMode of /** @type {const} */ (["observe", "required"])) {
      const { p, canonical } = await projectPublished(cleanScenario, gateMode);
      expect(canonical.run.verdict).toBe("pass");
      expect(p.upserts[0]).toMatchObject({ op: "created", id: 101 });
      expect(p.upserts[0]?.body).toContain("No findings.");
      expect(p.sarif?.runs[0]?.results).toEqual([]);
    }
  });

  it("B: the confirmed finding blocks on every surface, fingerprinted once", async () => {
    for (const gateMode of /** @type {const} */ (["observe", "required"])) {
      const { p, canonical } = await projectPublished(confirmedScenario, gateMode);
      expect(canonical.run.verdict).toBe("pass");
      expect(gateOf(p)).toEqual({
        verdict: "BLOCK",
        reasons: ["confirmed correctness finding at src/a.mjs:2."],
      });
      expect(p.upserts[0]?.body).toContain("### Concerns (1)");
      expect(p.upserts[0]?.body).toContain("- `src/a.mjs:2` — off-by-one");
      const results = p.sarif?.runs[0]?.results ?? [];
      expect(results).toHaveLength(1);
      expect(results[0]?.partialFingerprints?.["reviewFindingFingerprint/v2"]).toBe(
        canonical.findings[0]?.fingerprint,
      );
    }
  });

  it("C: the unresolved finding blocks through blockUnresolved and never reaches SARIF", async () => {
    for (const gateMode of /** @type {const} */ (["observe", "required"])) {
      const { p, canonical } = await projectPublished(unresolvedScenario, gateMode);
      // The review answered — the run's own verdict passes — but the
      // undecided finding blocks the gate all the same.
      expect(canonical.run.verdict).toBe("pass");
      expect(canonical.findings[0]).toMatchObject({ lifecycle: "unresolved" });
      expect(gateOf(p)).toEqual({
        verdict: "BLOCK",
        reasons: ["unresolved correctness finding at src/a.mjs:2."],
      });
      expect(p.upserts[0]?.body).toContain("- `src/a.mjs:2` — off-by-one");
      expect(p.upserts[0]?.body).toContain("  unverified: ");
      expect(p.sarif?.runs[0]?.results).toEqual([]);
    }
  });

  it("D: the verification failure publishes partial and fails the gate first", async () => {
    for (const gateMode of /** @type {const} */ (["observe", "required"])) {
      const { p, canonical } = await projectPublished(demotedScenario, gateMode);
      expect(canonical.run).toMatchObject({ state: "published", verdict: "fail" });
      // The structural reason precedes the finding's own — the reason
      // order the gate contract pins.
      expect(gateOf(p)).toEqual({
        verdict: "BLOCK",
        reasons: [
          "run verdict 'fail' never passes — an incomplete review is no pass.",
          "unresolved style finding at src/a.mjs:2.",
        ],
      });
      expect(p.upserts[0]?.body).toContain("> ⚠️ This review is partial:");
      expect(p.upserts[0]?.body).toContain("  unverified: ");
      expect(p.sarif?.runs[0]?.results).toEqual([]);
    }
  });

  it("E: the refusal lands one terminal check, a red artifact, and nothing else", async () => {
    for (const gateMode of /** @type {const} */ (["observe", "required"])) {
      const p = await driveCase(refusedScenario(), gateMode);
      expect(p.settled.ok).toBe(false);
      expectNoPublishedSurfaces(p);
      expect(p.upserts).toEqual([]);
      expect(p.deletes).toEqual([]);
      expect(p.checkRuns).toHaveLength(1);
      expect(p.checkRuns[0]).toMatchObject({
        headSha: HEAD,
        name: "review gate",
        conclusion: gateMode === "required" ? "failure" : "neutral",
        output: {
          title: `review gate: ${gateMode === "required" ? "BLOCK" : "OBSERVE-BLOCK"} (refused)`,
          summary: expect.stringMatching(/failed the output contract/),
        },
      });
      expect(p.artifacts).toHaveLength(1);
      expect(p.artifacts[0]?.name).toBe(`review-artifact-refused-${HEAD}.json`);
      expect(p.artifacts[0]?.json.outcome).toMatchObject({ classification: "refused" });
      expect(p.outputs).toContain("artifact-file=");
    }
  });

  it("F: the failure lands one terminal check and a red artifact naming no comment", async () => {
    for (const gateMode of /** @type {const} */ (["observe", "required"])) {
      const p = await driveCase(failedScenario(), gateMode);
      expect(p.settled.ok).toBe(false);
      expectNoPublishedSurfaces(p);
      expect(p.upserts).toEqual([]);
      // Provenance names a comment only if one landed — none did here.
      expect(p.checkRuns).toHaveLength(1);
      expect(p.checkRuns[0]).toMatchObject({
        headSha: HEAD,
        name: "review gate",
        conclusion: gateMode === "required" ? "failure" : "neutral",
        output: {
          title: `review gate: ${gateMode === "required" ? "BLOCK" : "OBSERVE-BLOCK"} (failed)`,
          summary: expect.stringMatching(/subject must be a non-empty string/),
        },
      });
      expect(p.artifacts).toHaveLength(1);
      expect(p.artifacts[0]?.name).toBe(`review-artifact-failed-${HEAD}.json`);
      expect(p.artifacts[0]?.json.outcome).toMatchObject({ classification: "failed" });
      expect(p.artifacts[0]?.json.provenance?.commentId).toBeUndefined();
      expect(p.outputs).toContain("artifact-file=");
    }
  });

  it("G: the abandoned race leaves the comment standing and the record still blocking", async () => {
    for (const gateMode of /** @type {const} */ (["observe", "required"])) {
      const p = await driveCase(movedPostScenario(), gateMode);
      expect(p.settled.ok).toBe(true);
      expect(p.outcome).toBe("abandoned");
      expectNoPublishedSurfaces(p);
      // The comment stands — honest about being published — and the
      // record it carries still blocks: the view a later reader gets from
      // the thread agrees with the terminal the check run names.
      expect(p.upserts).toHaveLength(1);
      const standing = parseRecordBlock(p.upserts[0]?.body ?? "");
      expect(standing).toBeDefined();
      expect(standing?.head).toBe(HEAD);
      expect(decideReviewGate(/** @type {*} */ (standing))).toEqual({
        verdict: "BLOCK",
        reasons: ["confirmed correctness finding at src/a.mjs:2."],
      });
      expect(p.checkRuns).toHaveLength(1);
      expect(p.checkRuns[0]).toMatchObject({
        headSha: HEAD,
        conclusion: gateMode === "required" ? "failure" : "neutral",
        output: {
          title: `review gate: ${gateMode === "required" ? "BLOCK" : "OBSERVE-BLOCK"} (abandoned)`,
          summary: expect.stringContaining("moved while its review was being published"),
        },
      });
      // Provenance names the comment the abandonment left standing.
      expect(p.artifacts[0]?.json).toMatchObject({
        outcome: { classification: "abandoned" },
        provenance: { commentId: p.upserts[0]?.id },
      });
    }
  });

  it("H: the forged comment adopts nothing — the run publishes its own honest view", async () => {
    for (const gateMode of /** @type {const} */ (["observe", "required"])) {
      const { p, canonical } = await projectPublished(forgedScenario, gateMode);
      // The forged thread is nobody's history: a fresh comment is created,
      // the forgery is left untouched, and no surface echoes its bait.
      expect(p.upserts[0]).toMatchObject({ op: "created", id: 101 });
      expect(p.upserts[0]?.body).not.toContain("Compared with the previous review");
      expect(canonical.findings).toHaveLength(1);
      expect(gateOf(p)).toEqual({
        verdict: "BLOCK",
        reasons: ["confirmed correctness finding at src/a.mjs:2."],
      });
      expect(p.sarif?.runs[0]?.results).toHaveLength(1);
    }
  });

  it("I: the stale finding across HEAD persists on every surface at once", async () => {
    for (const gateMode of /** @type {const} */ (["observe", "required"])) {
      const { p, canonical } = await projectPublished(staleScenario, gateMode);
      // The previous record is recovered and the finding labelled on the
      // comment — while the gate, the SARIF and the artifact all read the
      // current record, which carries the same finding.
      expect(p.upserts[0]?.body).toContain("Compared with the previous review");
      expect(p.upserts[0]?.body).toContain("[persisting]");
      expect(canonical.findings).toHaveLength(1);
      expect(gateOf(p)).toEqual({
        verdict: "BLOCK",
        reasons: ["confirmed correctness finding at src/a.mjs:2."],
      });
      expect(p.sarif?.runs[0]?.results).toHaveLength(1);
    }
  });

  it("J: the malformed embedded record is a first run — one honest view, everywhere", async () => {
    for (const gateMode of /** @type {const} */ (["observe", "required"])) {
      const { p, canonical } = await projectPublished(malformedScenario, gateMode);
      expect(p.upserts[0]).toMatchObject({ op: "updated", id: 40 });
      expect(p.upserts[0]?.body).not.toContain("Compared with the previous review");
      expect(canonical.findings).toHaveLength(1);
      expect(gateOf(p)).toEqual({
        verdict: "BLOCK",
        reasons: ["confirmed correctness finding at src/a.mjs:2."],
      });
      expect(p.sarif?.runs[0]?.results).toHaveLength(1);
    }
  });
});

// ── §8: the terminal × projection matrix as one executable table ──

/**
 * One entry per §8 row that a replay can reach. `blocking` is the row's
 * gate column under `required`; `comments` the comment column's write
 * count; `artifact` the record classification the artifact column names.
 * The two rows no replay can reach — `published` + `unknown` (no
 * producer) and death before event facts — carry their own tests below.
 *
 * @type {Array<{
 *   row: string,
 *   make: () => ReturnType<typeof scenario>,
 *   published?: boolean,
 *   terminal?: string,
 *   blocking?: boolean,
 *   comments?: number,
 *   artifact?: string,
 *   redSummary?: RegExp,
 * }>}
 */
const MATRIX = [
  {
    row: "published (complete)",
    make: cleanScenario,
    published: true,
    blocking: false,
    comments: 1,
    artifact: "published",
  },
  {
    row: "published (partial review)",
    make: demotedScenario,
    published: true,
    blocking: true,
    comments: 1,
    artifact: "published",
  },
  {
    row: "refused",
    make: refusedScenario,
    terminal: "refused",
    blocking: true,
    comments: 0,
    artifact: "refused",
    redSummary: /failed the output contract/,
  },
  {
    row: "failed",
    make: failedScenario,
    terminal: "failed",
    blocking: true,
    comments: 0,
    artifact: "failed",
    redSummary: /subject must be a non-empty string/,
  },
  {
    row: "abandoned (pre-write)",
    make: movedPreScenario,
    terminal: "abandoned",
    blocking: true,
    comments: 0,
    artifact: "abandoned",
  },
  {
    row: "abandoned (post-write)",
    make: movedPostScenario,
    terminal: "abandoned",
    blocking: true,
    comments: 1,
    artifact: "abandoned",
  },
  {
    row: "skip / nothing-to-review (clearing landed)",
    make: clearingScenario,
    terminal: "nothing-to-review",
    blocking: false,
    comments: 1,
    artifact: "skip",
  },
  {
    row: "dry-run",
    make: dryRunScenario,
    terminal: "dry-run",
    blocking: false,
    comments: 0,
    artifact: "dry-run",
  },
];

describe("the §8 projection matrix, executable", () => {
  for (const entry of MATRIX) {
    for (const gateMode of /** @type {const} */ (["observe", "required"])) {
      it(`row '${entry.row}' projects its contract facts under ${gateMode}`, async () => {
        const p = await driveCase(entry.make(), gateMode);
        // The row's ending: BLOCK rows stay red-run only where the run
        // itself threw; a BLOCK abandonment still exits green — the check
        // run carries the enforcement, never the exit code.
        const red = entry.terminal === "refused" || entry.terminal === "failed";
        // The row's ending: a BLOCK abandonment still exits green — the
        // check run carries the enforcement, never the exit code — but a
        // red run exits red.
        expect(p.settled.ok).toBe(!red);
        // A red run returns no result — its one outcome surface is the
        // artifact's classification, and it must name the row's terminal.
        expect(p.outcome ?? p.artifacts[0]?.json.outcome?.classification).toBe(
          entry.terminal ?? "published",
        );
        // The comment column.
        expect(p.upserts).toHaveLength(entry.comments ?? 0);
        expect(p.deletes).toEqual([]);
        // The gate column: a published run renders its verdict — BLOCK
        // exactly on the row's blocking fact; a terminal renders its row.
        // Never absence, never pass over a red run.
        expect(p.checkRuns).toHaveLength(1);
        if (entry.published === true) {
          const gate = gateOf(p);
          expect(gate.verdict).toBe(entry.blocking ? "BLOCK" : "PASS");
          expect(p.checkRuns).toEqual([
            asCheckRun(canonicalOf(p).head, renderGateCheckRun({ gate, gateMode })),
          ]);
        } else if (entry.redSummary !== undefined) {
          // A red run returns no result, so the walker cannot replay the
          // renderer's summary from the run's own reason — it pins the
          // conclusion and the title exactly, and the summary by the row's
          // evidence sentence.
          expect(p.checkRuns[0]).toMatchObject({
            headSha: HEAD,
            name: "review gate",
            conclusion: gateMode === "required" ? "failure" : "neutral",
            output: {
              title: `review gate: ${gateMode === "required" ? "BLOCK" : "OBSERVE-BLOCK"} (${entry.terminal})`,
              summary: expect.stringMatching(entry.redSummary),
            },
          });
        } else {
          expectTerminalCheck(
            p,
            /** @type {string} */ (entry.terminal),
            entry.blocking ?? true,
            gateMode,
          );
        }
        // The SARIF column: published rows only.
        if (entry.published === true) {
          expect(p.sarif).toEqual(toSarif(canonicalOf(p)));
        } else {
          expect(p.sarif).toBeUndefined();
        }
        // The artifact column: every row but the carve-out declares one.
        expect(p.artifacts).toHaveLength(1);
        const artifact = p.artifacts[0]?.json;
        if (entry.artifact === "skip") {
          expect(artifact?.kind).toBe("nothing-to-review");
        } else {
          expect(artifact?.outcome).toMatchObject({ classification: entry.artifact });
        }
        expect(p.outputs).toContain("artifact-file=");
      });
    }
  }

  it("row 'published + unknown' has no producer and blocks on the record level", () => {
    // The one published row no run path can reach — a hollow verdict is a
    // defect the gate refuses, rendered `failure` under required and
    // neutral under observe. No comment, no SARIF, no artifact: there is
    // no producer to project them from.
    const hollow = createCanonicalResult({
      head: HEAD,
      run: { state: "published", verdict: "unknown" },
      findings: [],
    });
    const gate = decideReviewGate(hollow);
    expect(gate.verdict).toBe("BLOCK");
    expect(gate.reasons[0]).toContain("hollow");
    for (const gateMode of /** @type {const} */ (["observe", "required"])) {
      expect(renderGateCheckRun({ gate, gateMode }).conclusion).toBe(
        gateMode === "required" ? "failure" : "neutral",
      );
    }
  });

  for (const gateMode of /** @type {const} */ (["observe", "required"])) {
    it(`row 'death before event facts' stays unsurfaced under ${gateMode} — the named carve-out`, async () => {
      const p = await driveCase(eventFactsScenario(), gateMode);
      // BLOCK, and unsurfaced: the run died before it held the facts an
      // artifact is built from, so nothing is written, nothing reported —
      // the one row absence is the contract's answer.
      expect(p.settled.ok).toBe(false);
      expect(p.upserts).toEqual([]);
      expect(p.deletes).toEqual([]);
      expect(p.checkRuns).toEqual([]);
      expect(p.artifacts).toEqual([]);
      expect(p.sarif).toBeUndefined();
      expect(p.outputs).toBe("");
    });
  }
});

// ── T18: the deterministic race replay harness ──

/**
 * Replays a schedule once in one mode and returns its terminal
 * fingerprint: every surface, normalised only in the run-scoped marker id
 * and the runner's temp paths.
 *
 * @param {() => ReturnType<typeof scenario>} make
 * @param {"observe" | "required"} gateMode
 */
async function replayed(make, gateMode) {
  const world = make();
  const projection = await driveCase(world, gateMode);
  return { projection, fingerprint: replayFingerprint(world, projection) };
}

describe("the deterministic race replay harness (T18)", () => {
  /** @type {Array<{ name: string, make: () => ReturnType<typeof scenario>, pin: (p: Awaited<ReturnType<typeof driveCase>>, gateMode: "observe" | "required") => void }>} */
  const SCHEDULES = [
    {
      name: "the stale run (the head moves before publication)",
      make: movedPreScenario,
      pin: (p, gateMode) => {
        expect(p.outcome).toBe("abandoned");
        // Nothing written: no publish, no duplicate cleanup, no comment id.
        expect(p.upserts).toEqual([]);
        expect(p.artifacts[0]?.json).toMatchObject({
          outcome: { classification: "abandoned" },
        });
        expect(p.artifacts[0]?.json.provenance?.commentId).toBeUndefined();
        expectTerminalCheck(p, "abandoned", true, gateMode);
      },
    },
    {
      name: "concurrent publication (the head moves after the write)",
      make: movedPostScenario,
      pin: (p, gateMode) => {
        expect(p.outcome).toBe("abandoned");
        expect(p.upserts).toHaveLength(1);
        expect(parseRecordBlock(p.upserts[0]?.body ?? "")).toBeDefined();
        // Provenance names the comment the abandonment left standing.
        expect(p.artifacts[0]?.json).toMatchObject({
          outcome: { classification: "abandoned" },
          provenance: { commentId: p.upserts[0]?.id },
        });
        expectTerminalCheck(p, "abandoned", true, gateMode);
      },
    },
    {
      name: "the duplicate comment (two own markers)",
      make: duplicatesScenario,
      pin: (p, _gateMode) => {
        expect(p.outcome).toBe("published");
        // The upsert keeps exactly one: the newest updated, the loser
        // deleted exactly once.
        expect(p.upserts).toEqual([{ op: "updated", id: 40, body: expect.any(String) }]);
        expect(p.deletes).toEqual([30]);
        expect(p.artifacts[0]?.json.provenance).toMatchObject({ commentId: 40 });
        expect(parseRecordBlock(p.upserts[0]?.body ?? "")).toEqual(canonicalOf(p));
      },
    },
    {
      name: "the foreign marker (bound to a foreign head, undatable)",
      make: foreignMarkerScenario,
      pin: (p, gateMode) => {
        // The clearing race (#381 remainder): the run owns the
        // consequence — abandoned, the marker stands, and no skip record
        // is written that would describe a thread this run did not clear.
        expect(p.outcome).toBe("abandoned");
        expect(p.reason).toContain("owned by a concurrent run");
        expect(p.reason).toContain("the marker was not cleared");
        expect(p.upserts).toEqual([]);
        expect(p.deletes).toEqual([]);
        expect(p.artifacts).toHaveLength(1);
        expect(p.artifacts[0]?.json.outcome).toMatchObject({ classification: "abandoned" });
        expect(p.artifacts[0]?.json.kind).toBeUndefined();
        expectTerminalCheck(p, "abandoned", true, gateMode);
      },
    },
    {
      name: "the malformed embedded record",
      make: malformedScenario,
      pin: (p, _gateMode) => {
        expect(p.outcome).toBe("published");
        expect(p.upserts).toEqual([{ op: "updated", id: 40, body: expect.any(String) }]);
        expect(p.upserts[0]?.body).not.toContain("Compared with the previous review");
        expect(parseRecordBlock(p.upserts[0]?.body ?? "")).toEqual(canonicalOf(p));
      },
    },
    {
      name: "check terminalization after a failed run",
      make: failedScenario,
      pin: (p, gateMode) => {
        expect(p.settled.ok).toBe(false);
        expect(p.upserts).toEqual([]);
        expect(p.checkRuns).toHaveLength(1);
        expect(p.checkRuns[0]).toMatchObject({
          headSha: HEAD,
          name: "review gate",
          conclusion: gateMode === "required" ? "failure" : "neutral",
          output: {
            title: `review gate: ${gateMode === "required" ? "BLOCK" : "OBSERVE-BLOCK"} (failed)`,
            summary: expect.stringContaining("subject must be a non-empty string"),
          },
        });
        expect(p.artifacts[0]?.json.outcome).toMatchObject({ classification: "failed" });
      },
    },
  ];

  for (const schedule of SCHEDULES) {
    it(`${schedule.name} — the same schedule replays to the same terminal result`, async () => {
      for (const gateMode of /** @type {const} */ (["observe", "required"])) {
        const first = await replayed(schedule.make, gateMode);
        const second = await replayed(schedule.make, gateMode);
        // No sleeps, no sampling: the replay is the schedule, and the
        // fingerprint is the whole terminal effect.
        expect(second.fingerprint).toBe(first.fingerprint);
      }
    });

    it(`${schedule.name} — lands the terminal the audit names`, async () => {
      const { projection } = await replayed(schedule.make, "required");
      schedule.pin(projection, "required");
    });
  }
});
