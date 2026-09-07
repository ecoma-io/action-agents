// E2E, cross-surface cases + replay (PR9, T17–T18): one harness, three laws.
//
// T17 — the eleven cases A–K of the task brief, each replayed through the
// real entrypoint: the SAME run outcome must produce the SAME view on every
// surface — the comment's embedded record, the SARIF projection, the
// workspace artifact and the runner outputs. No surface may contradict
// another: a comment contradicting the SARIF, or a published comment with
// no artifact where one was declared, is a defect this suite pins. There is
// no gate column any more: merge enforcement is the consumer's ruleset over
// Code Scanning (ADR 006), outside every surface a run touches.
//
// §8 — the audit's terminal × projection matrix as one executable table:
// every row walked, the projection read off the run and compared against
// the row's contract facts. No terminal maps to absence except the named
// carve-out.
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
const failedScenario = () => {
  const world = scenario({
    script: [readTurn("src/a.mjs"), { content: CONFIRMED_ANSWER }],
  });
  // An undeclared transport break after the run's facts are in — the
  // failed terminal the red boundary records. The blank-anchor producer
  // moved to the withheld row below (#411): a span that certifies nothing
  // is withheld, never run-fatal.
  let reads = 0;
  const inner = world.forge.getPullRequest.bind(world.forge);
  world.forge.getPullRequest = async (/** @type {number} */ number) => {
    reads += 1;
    if (reads > 1) throw new Error("the forge transport broke mid-run");
    return inner(number);
  };
  return world;
};

/** The withheld run: one claim, but its anchor line certifies no span (#411). */
const withheldScenario = () =>
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
 * Drives one published scenario and asserts the whole published projection
 * agrees: the comment's embedded record IS the canonical the run returned;
 * the SARIF file IS the projection over the same record; the artifact names
 * the comment; the outputs name the file. Returns the projection so the
 * case pins its own prose on top.
 *
 * @param {() => ReturnType<typeof scenario>} make
 */
async function projectPublished(make) {
  const p = await driveCase(make());
  const canonical = canonicalOf(p);
  expect(p.settled.ok).toBe(true);
  expect(p.outcome).toBe("published");
  expect(p.upserts).toHaveLength(1);
  expect(parseRecordBlock(p.upserts[0]?.body ?? "")).toEqual(canonical);
  // The publication fact rides the run's own record (the embedded block
  // predates the write), and names exactly the write the forge recorded.
  expect(p.canonical?.run.publication).toBe(p.upserts[0]?.op);
  expect(p.sarif).toEqual(toSarif(canonical));
  expect(p.artifacts).toHaveLength(1);
  expect(p.artifacts[0]?.json.outcome).toMatchObject({ classification: "published" });
  expect(p.artifacts[0]?.json.provenance).toMatchObject({ commentId: p.upserts[0]?.id });
  expect(p.outputs).toContain("artifact-file=");
  expect(p.outputs).not.toContain("gate-verdict=");
  return { p, canonical };
}

/**
 * The shared facts of a terminal row that never published: no canonical
 * record, no SARIF, no verdict-shaped output.
 *
 * @param {Awaited<ReturnType<typeof driveCase>>} p
 */
function expectNoPublishedSurfaces(p) {
  expect(p.canonical).toBeUndefined();
  expect(p.sarif).toBeUndefined();
  expect(p.outputs).not.toContain("gate-verdict=");
}

// ── T17: the eleven cases A–K on one harness ──

describe("cross-surface cases A–K: one run outcome, one view on every surface (T17)", () => {
  it("A: the clean pass projects pass everywhere", async () => {
    const { p, canonical } = await projectPublished(cleanScenario);
    expect(canonical.run.verdict).toBe("pass");
    expect(p.upserts[0]).toMatchObject({ op: "created", id: 101 });
    expect(p.upserts[0]?.body).toContain("No findings.");
    expect(p.sarif?.runs[0]?.results).toEqual([]);
  });

  it("B: the confirmed finding rides every surface, fingerprinted once", async () => {
    const { p, canonical } = await projectPublished(confirmedScenario);
    // The verdict is coverage-owned, not finding-owned — the merge
    // consequence rides the SARIF alert the ruleset acts on (ADR 006).
    expect(canonical.run.verdict).toBe("pass");
    expect(p.upserts[0]?.body).toContain("### Concerns (1)");
    expect(p.upserts[0]?.body).toContain("- `src/a.mjs:2` — off-by-one");
    const results = p.sarif?.runs[0]?.results ?? [];
    expect(results).toHaveLength(1);
    expect(results[0]?.partialFingerprints?.["reviewFindingFingerprint/v2"]).toBe(
      canonical.findings[0]?.fingerprint,
    );
  });

  it("C: the unresolved finding stands recorded and never reaches SARIF", async () => {
    const { p, canonical } = await projectPublished(unresolvedScenario);
    // The review answered, so the verdict is a pass — the undecided
    // finding rides the record and the comment's `unverified` label, and
    // SARIF's confirmed-only projection keeps it out of the alerts.
    expect(canonical.run.verdict).toBe("pass");
    expect(canonical.findings[0]).toMatchObject({ lifecycle: "unresolved" });
    expect(p.upserts[0]?.body).toContain("- `src/a.mjs:2` — off-by-one");
    expect(p.upserts[0]?.body).toContain("  unverified: ");
    expect(p.sarif?.runs[0]?.results).toEqual([]);
  });

  it("D: the verification failure publishes partial with verdict fail", async () => {
    const { p, canonical } = await projectPublished(demotedScenario);
    // A demoted finding is an unresolved finding: the review is not
    // complete, so the code law records fail — an incomplete review is
    // no pass, whatever the run managed to publish.
    expect(canonical.run).toMatchObject({ state: "published", verdict: "fail" });
    expect(p.upserts[0]?.body).toContain("> ⚠️ This review is partial:");
    expect(p.upserts[0]?.body).toContain("  unverified: ");
    expect(p.sarif?.runs[0]?.results).toEqual([]);
  });

  it("E: the refusal lands a red artifact and nothing else", async () => {
    const p = await driveCase(refusedScenario());
    expect(p.settled.ok).toBe(false);
    expect(p.settled.cause).toMatchObject({
      message: expect.stringMatching(/failed the output contract/),
    });
    expectNoPublishedSurfaces(p);
    expect(p.upserts).toEqual([]);
    expect(p.deletes).toEqual([]);
    expect(p.artifacts).toHaveLength(1);
    expect(p.artifacts[0]?.name).toBe(`review-artifact-refused-${HEAD}.json`);
    expect(p.artifacts[0]?.json.outcome).toMatchObject({ classification: "refused" });
    expect(p.artifacts[0]?.json.outcome.reason).toMatch(/failed the output contract/);
    expect(p.outputs).toContain("artifact-file=");
  });

  it("F: the failure lands a red artifact naming no comment", async () => {
    const p = await driveCase(failedScenario());
    expect(p.settled.ok).toBe(false);
    expect(p.settled.cause).toMatchObject({
      message: expect.stringMatching(/forge transport broke/),
    });
    expectNoPublishedSurfaces(p);
    expect(p.upserts).toEqual([]);
    // Provenance names a comment only if one landed — none did here.
    expect(p.artifacts).toHaveLength(1);
    expect(p.artifacts[0]?.name).toBe(`review-artifact-failed-${HEAD}.json`);
    expect(p.artifacts[0]?.json.outcome).toMatchObject({ classification: "failed" });
    expect(p.artifacts[0]?.json.outcome.reason).toMatch(/forge transport broke/);
    expect(p.artifacts[0]?.json.provenance?.commentId).toBeUndefined();
    expect(p.outputs).toContain("artifact-file=");
  });

  it("G: the abandoned race leaves the comment standing, its record readable", async () => {
    const p = await driveCase(movedPostScenario());
    expect(p.settled.ok).toBe(true);
    expect(p.outcome).toBe("abandoned");
    expectNoPublishedSurfaces(p);
    // The comment stands — honest about being published — and the record
    // it carries is the finding's: the view a later reader gets from the
    // thread is the view the artifact records, minus the publication fact.
    expect(p.upserts).toHaveLength(1);
    const standing = parseRecordBlock(p.upserts[0]?.body ?? "");
    expect(standing).toBeDefined();
    expect(standing?.head).toBe(HEAD);
    expect(standing?.findings).toHaveLength(1);
    // The abandonment's reason names the move, and the artifact pins it.
    expect(p.reason).toContain("moved while its review was being published");
    // Provenance names the comment the abandonment left standing.
    expect(p.artifacts[0]?.json).toMatchObject({
      outcome: { classification: "abandoned" },
      provenance: { commentId: p.upserts[0]?.id },
    });
    expect(p.artifacts[0]?.json.outcome.reason).toContain(
      "moved while its review was being published",
    );
  });

  it("H: the forged comment adopts nothing — the run publishes its own honest view", async () => {
    const { p, canonical } = await projectPublished(forgedScenario);
    // The forged thread is nobody's history: a fresh comment is created,
    // the forgery is left untouched, and no surface echoes its bait.
    expect(p.upserts[0]).toMatchObject({ op: "created", id: 101 });
    expect(p.upserts[0]?.body).not.toContain("Compared with the previous review");
    expect(canonical.findings).toHaveLength(1);
    expect(p.sarif?.runs[0]?.results).toHaveLength(1);
  });

  it("I: the stale finding across HEAD persists on every surface at once", async () => {
    const { p, canonical } = await projectPublished(staleScenario);
    // The previous record is recovered and the finding labelled on the
    // comment — while the SARIF and the artifact both read the current
    // record, which carries the same finding.
    expect(p.upserts[0]?.body).toContain("Compared with the previous review");
    expect(p.upserts[0]?.body).toContain("[persisting]");
    expect(canonical.findings).toHaveLength(1);
    expect(p.sarif?.runs[0]?.results).toHaveLength(1);
  });

  it("J: the malformed embedded record is a first run — one honest view, everywhere", async () => {
    const { p, canonical } = await projectPublished(malformedScenario);
    expect(p.upserts[0]).toMatchObject({ op: "updated", id: 40 });
    expect(p.upserts[0]?.body).not.toContain("Compared with the previous review");
    expect(canonical.findings).toHaveLength(1);
    expect(p.sarif?.runs[0]?.results).toHaveLength(1);
  });

  it("K: the withheld span publishes a reduced view that names its withholding on every surface", async () => {
    const p = await driveCase(withheldScenario());
    expect(p.settled.ok).toBe(true);
    expect(p.outcome).toBe("published");
    // A span that certifies nothing anchors no identity: the claim never
    // enters the record, so every surface reads a clean zero — and the
    // comment names the withholding instead of a clean bill.
    expect(p.canonical?.findings).toHaveLength(0);
    expect(p.canonical?.run.verdict).toBe("pass");
    expect(p.upserts).toHaveLength(1);
    expect(p.upserts[0]?.body).toContain(
      "1 finding withheld: its anchor line carries no span to certify.",
    );
    expect(p.sarif?.runs[0]?.results).toHaveLength(0);
    expect(p.artifacts[0]?.name).toBe(`review-artifact-${HEAD}.json`);
    expect(p.artifacts[0]?.json.outcome).toMatchObject({ classification: "published" });
  });
});

// ── §8: the terminal × projection matrix as one executable table ──

/**
 * One entry per §8 row that a replay can reach. `comments` is the comment
 * column's write count; `artifact` the record classification the artifact
 * column names. There is no gate column: post-ADR 006 the terminal's merge
 * consequence is the consumer's ruleset, not a surface the run touches.
 * The two rows no replay can reach — `published` + `unknown` (no producer:
 * the verdict law only ever computes pass or fail) and death before event
 * facts — carry their own tests below.
 *
 * @type {Array<{
 *   row: string,
 *   make: () => ReturnType<typeof scenario>,
 *   published?: boolean,
 *   terminal?: string,
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
    comments: 1,
    artifact: "published",
  },
  {
    row: "published (partial review)",
    make: demotedScenario,
    published: true,
    comments: 1,
    artifact: "published",
  },
  {
    row: "published (all findings withheld)",
    make: withheldScenario,
    published: true,
    comments: 1,
    artifact: "published",
  },
  {
    row: "refused",
    make: refusedScenario,
    terminal: "refused",
    comments: 0,
    artifact: "refused",
    redSummary: /failed the output contract/,
  },
  {
    row: "failed",
    make: failedScenario,
    terminal: "failed",
    comments: 0,
    artifact: "failed",
    redSummary: /forge transport broke/,
  },
  {
    row: "abandoned (pre-write)",
    make: movedPreScenario,
    terminal: "abandoned",
    comments: 0,
    artifact: "abandoned",
  },
  {
    row: "abandoned (post-write)",
    make: movedPostScenario,
    terminal: "abandoned",
    comments: 1,
    artifact: "abandoned",
  },
  {
    row: "skip / nothing-to-review (clearing landed)",
    make: clearingScenario,
    terminal: "nothing-to-review",
    comments: 1,
    artifact: "skip",
  },
  {
    row: "dry-run",
    make: dryRunScenario,
    terminal: "dry-run",
    comments: 0,
    artifact: "dry-run",
  },
];

describe("the §8 projection matrix, executable", () => {
  for (const entry of MATRIX) {
    it(`row '${entry.row}' projects its contract facts`, async () => {
      const p = await driveCase(entry.make());
      // The row's ending: red rows throw; every other terminal exits green.
      const red = entry.terminal === "refused" || entry.terminal === "failed";
      expect(p.settled.ok).toBe(!red);
      // A red run returns no result — its one outcome surface is the
      // artifact's classification, and it must name the row's terminal.
      expect(p.outcome ?? p.artifacts[0]?.json.outcome?.classification).toBe(
        entry.terminal ?? "published",
      );
      // The comment column.
      expect(p.upserts).toHaveLength(entry.comments ?? 0);
      expect(p.deletes).toEqual([]);
      // The consequence column: a published run records its verdict —
      // pass or fail, never unknown — and nothing else reports a
      // consequence: no check run, no verdict output (ADR 006).
      if (entry.published === true) {
        expect(p.canonical?.run.state).toBe("published");
        expect(["pass", "fail"]).toContain(p.canonical?.run.verdict);
      }
      expect(p.outputs).not.toContain("gate-verdict=");
      // A red run's evidence sentence lives in its artifact's reason.
      if (entry.redSummary !== undefined) {
        expect(p.artifacts[0]?.json.outcome.reason).toMatch(entry.redSummary);
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

  it("row 'death before event facts' stays unsurfaced — the named carve-out", async () => {
    const p = await driveCase(eventFactsScenario());
    // Unsurfaced: the run died before it held the facts an artifact is
    // built from, so nothing is written, nothing reported — the one row
    // absence is the contract's answer.
    expect(p.settled.ok).toBe(false);
    expect(p.upserts).toEqual([]);
    expect(p.deletes).toEqual([]);
    expect(p.artifacts).toEqual([]);
    expect(p.sarif).toBeUndefined();
    expect(p.outputs).toBe("");
  });
});

// ── T18: the deterministic race replay harness ──

/**
 * Replays a schedule once and returns its terminal fingerprint: every
 * surface, normalised only in the run-scoped marker id and the runner's
 * temp paths.
 *
 * @param {() => ReturnType<typeof scenario>} make
 */
async function replayed(make) {
  const world = make();
  const projection = await driveCase(world);
  return { projection, fingerprint: replayFingerprint(world, projection) };
}

describe("the deterministic race replay harness (T18)", () => {
  /** @type {Array<{ name: string, make: () => ReturnType<typeof scenario>, pin: (p: Awaited<ReturnType<typeof driveCase>>) => void }>} */
  const SCHEDULES = [
    {
      name: "the stale run (the head moves before publication)",
      make: movedPreScenario,
      pin: (p) => {
        expect(p.outcome).toBe("abandoned");
        // Nothing written: no publish, no duplicate cleanup, no comment id.
        expect(p.upserts).toEqual([]);
        expect(p.artifacts[0]?.json).toMatchObject({
          outcome: { classification: "abandoned" },
        });
        expect(p.artifacts[0]?.json.provenance?.commentId).toBeUndefined();
        expect(p.reason).toContain("moved while it was being reviewed");
      },
    },
    {
      name: "concurrent publication (the head moves after the write)",
      make: movedPostScenario,
      pin: (p) => {
        expect(p.outcome).toBe("abandoned");
        expect(p.upserts).toHaveLength(1);
        expect(parseRecordBlock(p.upserts[0]?.body ?? "")).toBeDefined();
        // Provenance names the comment the abandonment left standing.
        expect(p.artifacts[0]?.json).toMatchObject({
          outcome: { classification: "abandoned" },
          provenance: { commentId: p.upserts[0]?.id },
        });
      },
    },
    {
      name: "the duplicate comment (two own markers)",
      make: duplicatesScenario,
      pin: (p) => {
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
      pin: (p) => {
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
      },
    },
    {
      name: "the malformed embedded record",
      make: malformedScenario,
      pin: (p) => {
        expect(p.outcome).toBe("published");
        expect(p.upserts).toEqual([{ op: "updated", id: 40, body: expect.any(String) }]);
        expect(p.upserts[0]?.body).not.toContain("Compared with the previous review");
        expect(parseRecordBlock(p.upserts[0]?.body ?? "")).toEqual(canonicalOf(p));
      },
    },
    {
      name: "the red boundary after a failed run",
      make: failedScenario,
      pin: (p) => {
        expect(p.settled.ok).toBe(false);
        expect(p.settled.cause).toMatchObject({
          message: expect.stringContaining("forge transport broke"),
        });
        expect(p.upserts).toEqual([]);
        expect(p.artifacts[0]?.json.outcome).toMatchObject({ classification: "failed" });
        expect(p.artifacts[0]?.json.outcome.reason).toContain("forge transport broke");
      },
    },
  ];

  for (const schedule of SCHEDULES) {
    it(`${schedule.name} — the same schedule replays to the same terminal result`, async () => {
      const first = await replayed(schedule.make);
      const second = await replayed(schedule.make);
      // No sleeps, no sampling: the replay is the schedule, and the
      // fingerprint is the whole terminal effect.
      expect(second.fingerprint).toBe(first.fingerprint);
    });

    it(`${schedule.name} — lands the terminal the audit names`, async () => {
      const { projection } = await replayed(schedule.make);
      schedule.pin(projection);
    });
  }
});
