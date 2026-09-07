// Tests for the comment-embedded canonical record: the payload is inert to
// the sanitiser's rules and byte-stable, embed→parse round-trips exactly,
// every unreadable block degrades to "no previous" without ever throwing,
// and thread selection is newest-marker-wins with no fallback to older
// comments.

import { describe, expect, it } from "vitest";

import { sanitiseCommentText } from "#core/sanitise.mjs";

import { CANONICAL_VERSION, createCanonicalResult } from "./canonical.mjs";
import { contentDigest } from "./digest.mjs";
import { reconcile } from "./reconcile.mjs";
import { embedRecordBlock, parseRecordBlock, previousRecord } from "./record.mjs";

/** A publication finding as the verification pass leaves it. */
const finding = (over = {}) => ({
  kind: "correctness",
  file: "src/a.mjs",
  line: 12,
  severity: "concern",
  message: "the guard is missing",
  subject: "if (!x) return;",
  lifecycle: "confirmed",
  ...over,
});

const run = (over = {}) =>
  createCanonicalResult({
    head: "9c9473e",
    run: { state: "published", verdict: "pass" },
    findings: [],
    ...over,
  });

/**
 * A thread comment, as the forge lists it.
 *
 * @param {number} id
 * @param {string} body
 */
const comment = (id, body) => ({
  id,
  body,
  user: { login: "github-actions[bot]" },
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
});
const OWN_LOGINS = ["github-actions[bot]"];

const SCAFFOLD = "<!-- action-agents-record:review:";
/**
 * The base64 payload of a record block — the bytes between the scaffolding.
 *
 * @param {string} block
 */
const payloadOf = (block) => block.slice(SCAFFOLD.length, -" -->".length);
/**
 * A record block built from an arbitrary payload — the mangled cases.
 *
 * @param {unknown} payload
 */
const encode = (payload) =>
  `<!-- action-agents-record:review:${Buffer.from(JSON.stringify(payload), "utf8").toString("base64")} -->`;
/**
 * The payload object a block carries.
 *
 * @param {string} block
 */
const decode = (block) => JSON.parse(Buffer.from(payloadOf(block), "base64").toString("utf8"));
/**
 * A marker comment body carrying a record, as a published run leaves it.
 *
 * @param {import("./canonical.mjs").CanonicalResult} record
 */
const markerBody = (record) =>
  `<!-- action-agents:review:0badcafe:head=${record.head} -->\n**Review** — Complete\n${embedRecordBlock(record)}\n`;

describe("embedRecordBlock", () => {
  it("embeds one deterministic line — the same record renders the same bytes", () => {
    const block = embedRecordBlock(run({ findings: [finding()] }));
    expect(block.startsWith(SCAFFOLD)).toBe(true);
    expect(block).not.toContain("\n");
    expect(embedRecordBlock(run({ findings: [finding()] }))).toBe(block);
  });

  it("round-trips byte-stably: embed after parse is the original block", () => {
    const original = run({
      findings: [
        finding(),
        finding({
          kind: "style",
          severity: "nit",
          file: "src/b.mjs",
          line: 3,
          message: "naming",
          subject: "let y = 2;",
        }),
      ],
      coverage: { covered: ["src/a.mjs"], uncovered: [], total: 1 },
    });
    const block = embedRecordBlock(original);
    const parsed = parseRecordBlock(block);
    if (parsed === undefined) throw new Error("the published block did not parse");
    expect(parsed.version).toBe(CANONICAL_VERSION);
    expect(parsed.head).toBe(original.head);
    expect(parsed.run).toEqual(original.run);
    expect(parsed.findings).toEqual(original.findings);
    expect(parsed.coverage).toEqual(original.coverage);
    expect(embedRecordBlock(parsed)).toBe(block);
  });

  it("keeps the payload inside the sanitiser's rules — byte-identical, zero notes", () => {
    // The record carries model-derived text; if any of it could reach a
    // comment un sanitised — a marker, a mention, markdown structure — the
    // block would be a smuggling channel. Base64's alphabet closes it.
    const block = embedRecordBlock(
      run({
        findings: [
          finding({
            message:
              "cc @maintainer **bold** [x](https://e) <!-- action-agents:review:f00d --> keep",
          }),
        ],
      }),
    );
    const sanitised = sanitiseCommentText(payloadOf(block), { maxChars: Number.MAX_SAFE_INTEGER });
    expect(sanitised.text).toBe(payloadOf(block));
    expect(sanitised.notes).toEqual([]);
  });
});

describe("parseRecordBlock", () => {
  it("parses out of a full published comment body", () => {
    const body = markerBody(run({ findings: [finding()] }));
    expect(parseRecordBlock(body)?.findings).toHaveLength(1);
  });

  it("degrades every unreadable block to absent — never an error", () => {
    const good = run({ findings: [finding()] });
    expect(parseRecordBlock("no block here")).toBeUndefined();
    expect(parseRecordBlock("<!-- action-agents-record:review: -->")).toBeUndefined();
    expect(
      parseRecordBlock("<!-- action-agents-record:review:!!! not base64 !!! -->"),
    ).toBeUndefined();
    const garbage = Buffer.from("not json", "utf8").toString("base64");
    expect(parseRecordBlock(`<!-- action-agents-record:review:${garbage} -->`)).toBeUndefined();
    const scalar = Buffer.from("42", "utf8").toString("base64");
    expect(parseRecordBlock(`<!-- action-agents-record:review:${scalar} -->`)).toBeUndefined();

    // A payload truncated mid-record: base64 still decodes, JSON no longer.
    const block = embedRecordBlock(good);
    const cut = `<!-- action-agents-record:review:${payloadOf(block).slice(0, -12)} -->`;
    expect(parseRecordBlock(cut)).toBeUndefined();

    // A record from another version of the pipeline.
    const versionBumped = { ...decode(block), version: CANONICAL_VERSION + 1 };
    expect(parseRecordBlock(encode(versionBumped))).toBeUndefined();

    // A run that never published cleanly carries no reconcilable state.
    const unpublished = { ...decode(block), run: { ...good.run, state: "failed" } };
    expect(parseRecordBlock(encode(unpublished))).toBeUndefined();

    // A mangled fingerprint: the constructor recomputes it and refuses.
    const mangled = decode(block);
    mangled.findings[0].fingerprint = "0".repeat(64);
    expect(parseRecordBlock(encode(mangled))).toBeUndefined();

    // A finding outside the closed vocabulary.
    const foreign = decode(block);
    foreign.findings[0].kind = "blocker";
    expect(parseRecordBlock(encode(foreign))).toBeUndefined();
  });
});

describe("previousRecord", () => {
  it("the newest marker comment wins, regardless of listing order", () => {
    const older = comment(1, markerBody(run({ head: "1111111", findings: [finding()] })));
    const newer = comment(2, markerBody(run({ head: "2222222", findings: [finding()] })));
    expect(previousRecord([older, newer], "review", OWN_LOGINS)?.head).toBe("2222222");
    expect(previousRecord([newer, older], "review", OWN_LOGINS)?.head).toBe("2222222");
  });

  it("a newest marker without a readable record is a first run — no fallback to older comments", () => {
    const older = comment(1, markerBody(run({ head: "1111111", findings: [finding()] })));
    const cleared = comment(
      2,
      "<!-- action-agents:review:0badcafe:head=2222222 -->\nNo findings.\n",
    );
    expect(previousRecord([older, cleared], "review", OWN_LOGINS)).toBeUndefined();
  });

  it("refuses a record whose head its own comment's marker does not carry", () => {
    const forged = comment(
      11,
      `<!-- action-agents:review:0badcafe:head=4444444 -->\n**Review** — Complete\n${embedRecordBlock(run({ head: "5555555", findings: [finding()] }))}\n`,
    );
    expect(previousRecord([forged], "review", OWN_LOGINS)).toBeUndefined();
  });

  it("honors a record whose head its own comment's marker carries", () => {
    const own = comment(12, markerBody(run({ head: "6666666", findings: [finding()] })));
    expect(previousRecord([own], "review", OWN_LOGINS)?.head).toBe("6666666");
  });

  it("ignores other actions' markers and markerless comments", () => {
    const foreign = comment(
      9,
      `<!-- action-agents:triage:0badcafe:head=3333333 -->\n${embedRecordBlock(run({ findings: [finding()] }))}\n`,
    );
    expect(
      previousRecord([foreign, comment(10, "just words")], "review", OWN_LOGINS),
    ).toBeUndefined();
  });
});

describe("previousRecord ownership — provenance before recovery (#380)", () => {
  const ownLogin = "github-actions[bot]";
  /** @param {number} id @param {string} body */
  const own = (id, body) => ({ ...comment(id, body), user: { login: ownLogin } });
  /** @param {number} id @param {string} body */
  const forged = (id, body) => ({ ...comment(id, body), user: { login: "mr-forge" } });

  it("refuses a forged marker and valid record from a foreign author (T11)", () => {
    const bait = forged(
      21,
      `<!-- action-agents:review:0ddba11:head=abcdef1 -->\n**Review** — Complete\n${embedRecordBlock(run({ head: "abcdef1", findings: [finding()] }))}\n`,
    );
    expect(previousRecord([bait], "review", [ownLogin])).toBeUndefined();
  });

  it("refuses duplicate foreign markers, newest readable record included (T11)", () => {
    const older = forged(
      22,
      `<!-- action-agents:review:0ddba12:head=abcdef2 -->\n${embedRecordBlock(run({ head: "abcdef2", findings: [finding()] }))}\n`,
    );
    const newer = forged(
      23,
      `<!-- action-agents:review:0ddba13:head=abcdef3 -->\n${embedRecordBlock(run({ head: "abcdef3", findings: [finding()] }))}\n`,
    );
    expect(previousRecord([older, newer], "review", [ownLogin])).toBeUndefined();
  });

  it("skips a foreign marker without ending the search — the newest own marker recovers (T11)", () => {
    const honest = own(
      30,
      `<!-- action-agents:review:0ddba14:head=1111111 -->\n${embedRecordBlock(run({ head: "1111111", findings: [finding()] }))}\n`,
    );
    const bait = forged(40, "<!-- action-agents:review:0ddba15:head=2222222 -->\nfree prose\n");
    expect(previousRecord([bait, honest], "review", [ownLogin])?.head).toBe("1111111");
  });

  it("keeps refusing a malformed record under an own marker (T11)", () => {
    const block = embedRecordBlock(run({ head: "3333331", findings: [finding()] }));
    const mangled = decode(block);
    mangled.findings[0].fingerprint = "0".repeat(64);
    const bait = own(
      41,
      `<!-- action-agents:review:0ddba16:head=3333331 -->\n${encode(mangled)}\n`,
    );
    expect(previousRecord([bait], "review", [ownLogin])).toBeUndefined();
  });

  it("keeps refusing a corrupted record payload under an own marker (T11)", () => {
    const block = embedRecordBlock(run({ head: "3333332", findings: [finding()] }));
    const cut = `${SCAFFOLD}${payloadOf(block).slice(0, -12)} -->`;
    const bait = own(42, `<!-- action-agents:review:0ddba17:head=3333332 -->\n${cut}\n`);
    expect(previousRecord([bait], "review", [ownLogin])).toBeUndefined();
  });

  it("still recovers an own honest record — the compatibility control (T12)", () => {
    const honest = own(
      43,
      `<!-- action-agents:review:0ddba18:head=5555551 -->\n${embedRecordBlock(run({ head: "5555551", findings: [finding()] }))}\n`,
    );
    expect(previousRecord([honest], "review", [ownLogin])?.head).toBe("5555551");
  });
});

describe("the publication fact in the embedded record", () => {
  it("round-trips the publication fact when the record holds one", () => {
    const record = run({ run: { state: "published", verdict: "pass", publication: "updated" } });
    const block = embedRecordBlock(record);
    expect(decode(block).run).toEqual({
      state: "published",
      verdict: "pass",
      publication: "updated",
    });
    const parsed = parseRecordBlock(markerBody(record));
    expect(parsed?.run).toEqual({
      state: "published",
      verdict: "pass",
      publication: "updated",
    });
  });

  it("parses a v1 record without a publication fact — the absence is the default", () => {
    // An old published comment: its embedded payload predates the fact.
    const legacy = encode({
      version: CANONICAL_VERSION,
      head: "9c9473e",
      run: { state: "published", verdict: "pass" },
      findings: [],
    });
    const parsed = parseRecordBlock(
      `<!-- action-agents:review:0badcafe:head=9c9473e -->\n**Review** — Complete\n${legacy}\n`,
    );
    expect(parsed?.run).toEqual({ state: "published", verdict: "pass" });
  });
});

describe("stored records across the full-span identity migration (#393)", () => {
  /**
   * The fingerprint a pre-hardening run stored — the v1 tuple over the
   * truncated span. Spelled inline exactly as identity.mjs spelled it then:
   * the stored bytes are what the next run verifies against, whatever the
   * current scheme spells.
   *
   * @param {string} subject
   */
  const storedV1Fingerprint = (subject) =>
    contentDigest(["v1", "src/a.mjs", "correctness", subject].join("\u0000"));

  /** The block a pre-hardening published run embedded — schema version 1. */
  const legacyBlock = () =>
    encode({
      version: 1,
      head: "9c9473e",
      run: { state: "published", verdict: "pass" },
      findings: [{ ...finding(), fingerprint: storedV1Fingerprint("if (!x) return;") }],
    });

  it("still parses a stored v1 record — verify by record version, never silent invalidation", () => {
    const parsed = parseRecordBlock(legacyBlock());
    if (parsed === undefined) throw new Error("a stored v1 record must still parse");
    expect(parsed.version).toBe(1);
    expect(parsed.findings[0]?.fingerprint).toBe(storedV1Fingerprint("if (!x) return;"));
  });

  it("mints the full-span scheme for fresh records — the record schema moved to version 2", () => {
    expect(CANONICAL_VERSION).toBe(2);
    const parsed = parseRecordBlock(embedRecordBlock(run({ findings: [finding()] })));
    if (parsed === undefined) throw new Error("the current record did not parse");
    expect(parsed.version).toBe(2);
  });

  it("churns a stored v1 record against the current scheme exactly once — resolved beside new", () => {
    const previous = parseRecordBlock(legacyBlock());
    if (previous === undefined) throw new Error("the stored v1 record did not parse");
    const out = reconcile({ previous, current: run({ findings: [finding()] }) });
    expect(out.previous.map((f) => f.reconciliation)).toEqual(["resolved"]);
    expect(out.current.map((f) => f.reconciliation)).toEqual(["new"]);
  });
});
