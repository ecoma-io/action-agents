// E2E, the architecture-evidence input: one review run seen through the
// `architecture-report` knob's whole wiring — the blind default (byte-equal
// to a run that never heard of Archkeep, even when a report sits unnamed in
// the workspace), the aware run (evidence read through the real reader,
// held on the result, never rendered anywhere a reader or a projection
// could see), and the two red arms the input's own contract names (a
// failed read ends the run `failed`; bytes that disagree with the frozen
// protocol end it `refused`). The protocol itself is not under test here —
// the reader's unit suite and the runtime-evidence contract gate pin that;
// this suite pins the wiring: env → input → reader → evidence → the run's
// surfaces.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { DeterministicRefusalError } from "./refusal.mjs";
import {
  A_CONTENT,
  BASE,
  driveEntrypoint,
  drainEntryTemps,
  drainWorkspaces,
  forgeStub,
  HEAD,
  makeWorkspace,
  readTurn,
  replayIo,
  scriptedChat,
} from "./e2e.fixtures.mjs";
import { reviewPullRequest } from "./run.mjs";

afterAll(() => {
  drainWorkspaces();
  drainEntryTemps();
});

// ── Recipe-shaped fixtures: the files the consumer's step leaves ──

/**
 * The recipe's manifest beside the report — the sibling `run.json`
 * convention the integration recipe pins. The exit is the fact every
 * precedence judgement reads; the rest mirrors the recipe's shape so the
 * fixture documents what a real step writes, not a bare stub.
 *
 * @param {number} exitCode
 * @returns {string}
 */
function manifest(exitCode) {
  return JSON.stringify({
    exitCode,
    stderrDigest: `sha256:${"0".repeat(64)}`,
    base: { capturePath: ".archkeep/baseline.json", commit: BASE },
    head: { commit: HEAD },
  });
}

/**
 * A minimal coherent delta envelope, the same shape the reader's unit
 * suite and the contract goldens pin — enough structure to validate and
 * normalize, nothing the wiring under test needs to interpret.
 *
 * @param {{ head?: string, status?: "ok" | "findings" }} [over]
 * @returns {string}
 */
function envelope(over = {}) {
  const status = over.status ?? "ok";
  const introduced = status === "findings" ? [violation()] : [];
  const head = over.head ?? HEAD;
  return JSON.stringify({
    schemaVersion: 2,
    tool: { name: "@ecoma-io/archkeep", version: "0.29.0" },
    command: "delta",
    workspace: {
      root: "/repo",
      provider: "node-workspace",
      marker: "package.json",
      provenance: { commit: head, dirty: false },
    },
    status,
    exitCode: status === "ok" ? 0 : 1,
    coverage: { complete: true, analyzedFiles: 1, notAnalyzed: [], blindSpots: [], notes: [] },
    decision: { verdict: status === "ok" ? "pass" : "fail" },
    result: {
      policyChanged: false,
      baseline: {
        provenance: { commit: BASE, dirty: false },
        policyFingerprint: `sha256:${"1".repeat(64)}`,
        records: 0,
        projects: 2,
      },
      head: {
        provenance: { commit: head, dirty: false },
        policyFingerprint: `sha256:${"1".repeat(64)}`,
        records: 0,
        projects: 2,
      },
      summary: {
        introduced: introduced.length,
        introducedWaived: 0,
        resolved: 0,
        unchanged: 0,
        unknown: 0,
        unresolvable: { introduced: 0, resolved: 0, unchanged: 0, unknown: 0 },
      },
      violations: { introduced, resolved: [], unchanged: [], unknown: [] },
      unresolvable: { introduced: [], resolved: [], unchanged: [], unknown: [] },
    },
  });
}

/** One introduced boundary violation — the item shape a findings delta carries. */
function violation() {
  return {
    messageId: "module-boundary",
    sourceProject: "widgets-a",
    target: "widgets-b/src/index.mjs",
    targetIsSpecifier: false,
    constraint: "widgets-a must not import widgets-b",
    waived: false,
  };
}

/**
 * A workspace holding the reviewed file plus the architecture step's
 * leftovers — the recipe's `.archkeep/` pair.
 *
 * @param {{ report?: string, manifest?: string }} [files]
 * @returns {string}
 */
function workspaceWith(files = {}) {
  /** @type {Record<string, string>} */
  const writes = { "src/a.mjs": A_CONTENT };
  if (files.manifest !== undefined) writes[".archkeep/run.json"] = files.manifest;
  if (files.report !== undefined) writes[".archkeep/delta.json"] = files.report;
  return makeWorkspace(writes);
}

/**
 * The published comment body with the run-scoped marker line cut off — the
 * approved determinism cut, same as the cross-surface suite's.
 *
 * @param {ReturnType<typeof forgeStub>} forge
 * @returns {string}
 */
function commentPastMarker(forge) {
  const body = forge.calls.upserts[0]?.body ?? "";
  const at = body.indexOf("\n");
  return body.slice(at + 1);
}

/**
 * The run artifact's raw bytes — what a consumer's pipeline would upload.
 * A published run's record names no outcome prefix: `review-artifact-<head>`.
 *
 * @param {string} workspace
 * @returns {string}
 */
function artifactBytes(workspace) {
  return readFileSync(join(workspace, ".review-artifact", `review-artifact-${HEAD}.json`), "utf8");
}

/** The scripted happy-path chat: one read turn, one confirming verdict. */
const CONCERN_SCRIPT = () => [
  readTurn("src/a.mjs"),
  {
    content:
      '{"findings":[{"severity":"concern","kind":"correctness","file":"src/a.mjs","line":2,' +
      '"message":"off-by-one"}],"summary":"one concern"}',
  },
  { content: '{"verdict":"confirmed","kind":"correctness","reason":"the guard is missing"}' },
];

describe("the architecture-report input: blind default", () => {
  it("a report sitting unnamed in the workspace changes nothing — comment and artifact bytes identical", async () => {
    // Two entrypoint drives of the same scripted scenario: one over a plain
    // workspace, one over a workspace that also holds the recipe's
    // `.archkeep/` pair. The input is unset in both. If the mere presence
    // of the files moved a single byte of either surface, the input would
    // not be off when it claims to be off.
    const plainWorkspace = makeWorkspace({ "src/a.mjs": A_CONTENT });
    const plainForge = forgeStub();
    const plain = await driveEntrypoint({
      workspace: plainWorkspace,
      forge: plainForge,
      chat: scriptedChat(CONCERN_SCRIPT()),
    });
    const besideWorkspace = workspaceWith({ report: envelope(), manifest: manifest(0) });
    const besideForge = forgeStub();
    const besideFiles = await driveEntrypoint({
      workspace: besideWorkspace,
      forge: besideForge,
      chat: scriptedChat(CONCERN_SCRIPT()),
    });
    expect(plain.ok).toBe(true);
    expect(besideFiles.ok).toBe(true);
    expect(plain.result?.outcome).toBe("published");
    expect(besideFiles.result?.outcome).toBe("published");
    expect(commentPastMarker(plainForge)).toBe(commentPastMarker(besideForge));
    expect(artifactBytes(besideWorkspace)).toBe(artifactBytes(plainWorkspace));
    // And neither run holds evidence: a blind run reports nothing it did
    // not read.
    expect(plain.result?.architecture).toBeUndefined();
    expect(besideFiles.result?.architecture).toBeUndefined();
  });
});

describe("the architecture-report input: aware run", () => {
  it("reads the evidence before the first model call, holds it, and publishes identically", async () => {
    const workspace = workspaceWith({ report: envelope(), manifest: manifest(0) });
    const forge = forgeStub();
    const chat = scriptedChat(CONCERN_SCRIPT());
    const { io, log } = replayIo(forge, chat);
    const result = await reviewPullRequest({
      inputs: {
        model: "review",
        maxTurns: 5,
        contextWindow: 128_000,
        dryRun: false,
        configPath: "",
        architectureReport: ".archkeep/delta.json",
      },
      context: { owner: "acme", repo: "widgets", workspace },
      pullRequestNumber: 7,
      eventName: "pull_request",
      event: {
        action: "synchronize",
        pull_request: { number: 7, base: { ref: "main", sha: BASE } },
      },
      io,
    });
    expect(result.outcome).toBe("published");
    // The evidence the reader froze, held verbatim: verdict recorded from
    // the envelope, provenance pinned to the reviewed head, digest over the
    // raw bytes.
    expect(result.architecture?.verdict).toBe("pass");
    expect(result.architecture?.stale).toBe(false);
    expect(result.architecture?.provenance.head.commit).toBe(HEAD);
    expect(result.architecture?.introduced).toEqual([]);
    // The read happened before the loop logged anything — the evidence line
    // precedes every run log the model's turns produce.
    const at = log.findIndex((line) => line.includes("architecture evidence"));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(log.findIndex((line) => line.includes("expected file(s) read"))).toBeGreaterThan(at);
    // The evidence changes nothing a reader or a projection could see: the
    // published bytes equal the blind run's, and the artifact is not
    // stamped this phase. The artifact comparison is entrypoint against
    // entrypoint — the artifact is the entrypoint's write, so the aware
    // side drives the same scenario through `run` over a fresh workspace
    // holding the same recipe files.
    const blindWorkspace = makeWorkspace({ "src/a.mjs": A_CONTENT });
    const blindForge = forgeStub();
    const blind = await driveEntrypoint({
      workspace: blindWorkspace,
      forge: blindForge,
      chat: scriptedChat(CONCERN_SCRIPT()),
    });
    expect(blind.ok).toBe(true);
    expect(commentPastMarker(forge)).toBe(commentPastMarker(blindForge));
    const awareWorkspace = workspaceWith({ report: envelope(), manifest: manifest(0) });
    const aware = await driveEntrypoint({
      workspace: awareWorkspace,
      forge: forgeStub(),
      chat: scriptedChat(CONCERN_SCRIPT()),
      extra: { "INPUT_ARCHITECTURE-REPORT": ".archkeep/delta.json" },
    });
    expect(aware.ok).toBe(true);
    expect(aware.result?.architecture?.verdict).toBe("pass");
    expect(artifactBytes(awareWorkspace)).toBe(artifactBytes(blindWorkspace));
  });

  it("a stale report withholds its verdict as unknown and still publishes green", async () => {
    const workspace = workspaceWith({
      report: envelope({ head: "e".repeat(40) }),
      manifest: manifest(0),
    });
    const forge = forgeStub();
    const { io, log } = replayIo(forge, scriptedChat(CONCERN_SCRIPT()));
    const result = await reviewPullRequest({
      inputs: {
        model: "review",
        maxTurns: 5,
        contextWindow: 128_000,
        dryRun: false,
        configPath: "",
        architectureReport: ".archkeep/delta.json",
      },
      context: { owner: "acme", repo: "widgets", workspace },
      pullRequestNumber: 7,
      eventName: "pull_request",
      event: {
        action: "synchronize",
        pull_request: { number: 7, base: { ref: "main", sha: BASE } },
      },
      io,
    });
    expect(result.outcome).toBe("published");
    expect(result.architecture?.verdict).toBe("unknown");
    expect(result.architecture?.stale).toBe(true);
    expect(result.architecture?.incompleteness?.reason).toBe("stale");
    expect(log.some((line) => line.includes("stale, verdict withheld as unknown"))).toBe(true);
  });

  it("a findings verdict is recorded, never enforced — the run publishes as it would blind", async () => {
    const workspace = workspaceWith({
      report: envelope({ status: "findings" }),
      manifest: manifest(1),
    });
    const forge = forgeStub();
    const { io } = replayIo(forge, scriptedChat(CONCERN_SCRIPT()));
    const result = await reviewPullRequest({
      inputs: {
        model: "review",
        maxTurns: 5,
        contextWindow: 128_000,
        dryRun: false,
        configPath: "",
        architectureReport: ".archkeep/delta.json",
      },
      context: { owner: "acme", repo: "widgets", workspace },
      pullRequestNumber: 7,
      eventName: "pull_request",
      event: {
        action: "synchronize",
        pull_request: { number: 7, base: { ref: "main", sha: BASE } },
      },
      io,
    });
    expect(result.outcome).toBe("published");
    // The fail verdict is held as a fact and gates nothing this phase.
    expect(result.architecture?.verdict).toBe("fail");
    expect(result.architecture?.introduced).toHaveLength(1);
    const blindForge = forgeStub();
    const blind = await driveEntrypoint({
      workspace: makeWorkspace({ "src/a.mjs": A_CONTENT }),
      forge: blindForge,
      chat: scriptedChat(CONCERN_SCRIPT()),
    });
    expect(blind.ok).toBe(true);
    expect(commentPastMarker(forge)).toBe(commentPastMarker(blindForge));
  });
});

describe("the architecture-report input: red arms", () => {
  it("a report absent beside a zero exit fails the run red, before any model call", async () => {
    // The named lane: the manifest records success and the report is not
    // there. A chat that would throw on any call proves the read fired
    // first; the cause is a plain error (never a refusal — nothing was
    // judged), and the boundary's red artifact records `failed`.
    const workspace = workspaceWith({ manifest: manifest(0) });
    /** @type {unknown[][]} */
    const calls = [];
    /** @type {import("#core/chat.mjs").Chat} */
    const chat = {
      async complete(request) {
        calls.push([request]);
        throw new Error("the model was called on a run that should never have reached it");
      },
    };
    const settled = await driveEntrypoint({
      workspace,
      forge: forgeStub(),
      chat,
      extra: { "INPUT_ARCHITECTURE-REPORT": ".archkeep/delta.json" },
    });
    expect(settled.ok).toBe(false);
    expect(settled.cause).not.toBeInstanceOf(DeterministicRefusalError);
    expect(settled.cause instanceof Error ? settled.cause.message : "").toMatch(
      /absent-though-configured/,
    );
    expect(calls).toHaveLength(0);
    const artifact = JSON.parse(
      readFileSync(
        join(workspace, ".review-artifact", `review-artifact-failed-${HEAD}.json`),
        "utf8",
      ),
    );
    expect(artifact.outcome).toMatchObject({ classification: "failed" });
    expect(artifact.outcome.reason).toMatch(/absent-though-configured/);
  });

  it("bytes that disagree with the protocol refuse the run red", async () => {
    // A report from another archkeep family parses fine and is still not
    // admissible evidence: the typed refusal class, so the boundary's red
    // artifact records `refused`, the arm a maintainer fixes by re-running
    // the consumer's own step — never by trusting the bytes.
    const foreign = JSON.stringify({
      ...JSON.parse(envelope()),
      command: "check",
    });
    const workspace = workspaceWith({ report: foreign, manifest: manifest(0) });
    const settled = await driveEntrypoint({
      workspace,
      forge: forgeStub(),
      chat: {
        async complete() {
          throw new Error("the model was called on a run that should never have reached it");
        },
      },
      extra: { "INPUT_ARCHITECTURE-REPORT": ".archkeep/delta.json" },
    });
    expect(settled.ok).toBe(false);
    expect(settled.cause).toBeInstanceOf(DeterministicRefusalError);
    const artifact = JSON.parse(
      readFileSync(
        join(workspace, ".review-artifact", `review-artifact-refused-${HEAD}.json`),
        "utf8",
      ),
    );
    expect(artifact.outcome).toMatchObject({ classification: "refused" });
  });
});
