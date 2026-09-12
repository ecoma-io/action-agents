// Tests for the comment renderer: deterministic bodies, defanged anchors,
// sanitised prose, collapsing by strictness, and the boundary bodies
// (No findings / Nothing to review / Partial).

import { describe, expect, it } from "vitest";

import { createCanonicalResult } from "./canonical.mjs";
import {
  ARCHITECTURE_LISTED_ITEMS,
  renderArchitectureCommentSection,
  renderComment,
  renderNothingToReview,
} from "./render.mjs";

const HEAD = "a".repeat(40);

describe("renderComment", () => {
  it("renders complete reviews with anchored, ordered sections", () => {
    const body = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: "Two things worth a look.",
      findings: [
        {
          severity: "concern",
          kind: "security",
          file: "src/a.mjs",
          line: 12,
          message: "unchecked cast.",
        },
        { severity: "nit", kind: "style", file: "src/a.mjs", line: 3, message: "typo" },
        { severity: "nit", kind: "style", file: "src/b.mjs", line: 8, message: "naming" },
      ],
      strictness: "high",
    });

    expect(body).toContain(`**Review** — Complete`);
    expect(body).toContain(`Reviewed head \`${HEAD}\``);
    expect(body).toContain("### Concerns (1)");
    expect(body).toContain("- `src/a.mjs:12` — unchecked cast.");
    expect(body).toContain("### Nits (2)");
    expect(body.indexOf("Concerns")).toBeLessThan(body.indexOf("Nits"));
  });

  it("defangs an attacker-chosen policy branch before it enters the provenance line", () => {
    const body = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: "n/a",
      findings: [],
      strictness: "high",
      policySource: { basis: "pushed", branch: "feature`x<!--`", sha: HEAD },
    });

    // Backticks cannot open a code span from inside the branch name, and the
    // HTML-comment opener cannot survive to start a comment.
    expect(body).toContain("Policy source `feature'x&lt;-'`");
    expect(body).not.toContain("feature`");
    expect(body).not.toContain("<!--");
  });

  it("collapses nits at medium strictness — one click away, still anchored", () => {
    const body = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: "s",
      findings: [{ severity: "nit", kind: "style", file: "x.mjs", line: 1, message: "m" }],
      strictness: "medium",
    });
    expect(body).toContain("<details>");
    expect(body).toContain("<summary>Nits (1)</summary>");
    expect(body).toContain("- `x.mjs:1` — m");
    expect(body).toContain("</details>");
  });

  it("drops the nits section entirely at low strictness — filtering happened upstream", () => {
    const body = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: "s",
      findings: [{ severity: "nit", kind: "style", file: "x.mjs", line: 1, message: "m" }],
      strictness: "low",
    });
    expect(body).not.toContain("Nits");
  });

  it("at low, a mixed concern+nit list renders the concern only", () => {
    const body = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: "s",
      findings: [
        { severity: "concern", kind: "style", file: "src/a.mjs", line: 2, message: "real" },
        { severity: "nit", kind: "style", file: "src/a.mjs", line: 1, message: "m" },
      ],
      strictness: "low",
    });
    expect(body).toContain("### Concerns (1)");
    expect(body).toContain("- `src/a.mjs:2` — real");
    expect(body).not.toContain("Nits");
  });

  it("leads partials with a prominent banner naming the bound", () => {
    const body = renderComment({
      status: "Partial",
      headSha: HEAD,
      summary: "partial work",
      findings: [],
      strictness: "medium",
      partialReason: "the reading-turn budget was reached.",
    });
    expect(body.startsWith("> ⚠️ This review is partial:")).toBe(true);
    expect(body).toContain("**Review** — Partial");
  });

  it("shows an explicit No findings line on clean completes", () => {
    const body = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: "nothing wrong",
      findings: [],
      strictness: "high",
    });
    expect(body).toContain("No findings.");
  });
  it("a quarantine-only complete names the withheld count instead of a clean bill", () => {
    const body = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: "s",
      findings: [],
      strictness: "high",
      quarantinedCount: 2,
    });
    expect(body).toContain(
      "No published findings — 2 findings withheld: no recorded read reaches their anchor lines.",
    );
    expect(body).not.toContain("No findings.");
  });

  it("the withheld line is singular for one withheld finding", () => {
    const body = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: "s",
      findings: [],
      strictness: "high",
      quarantinedCount: 1,
    });
    expect(body).toContain("1 finding withheld: no recorded read reaches its anchor line.");
  });

  it("a span-withheld-only complete names the span law instead of a clean bill", () => {
    const body = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: "s",
      findings: [],
      strictness: "high",
      withheldUnspannedCount: 1,
    });
    expect(body).toContain(
      "No published findings — 1 finding withheld: its anchor line carries no span to certify.",
    );
    expect(body).not.toContain("No findings.");
  });

  it("both withheld kinds render one combined sentence, unanchored first", () => {
    const two = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: "s",
      findings: [],
      strictness: "high",
      quarantinedCount: 2,
      withheldUnspannedCount: 1,
    });
    expect(two).toContain(
      "No published findings — 2 findings withheld: no recorded read reaches their anchor lines; " +
        "1 more withheld: its anchor line carries no span to certify.",
    );
  });

  it("a quoted-evidence-withheld-only complete names the span gate instead of a clean bill", () => {
    const one = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: "s",
      findings: [],
      strictness: "high",
      withheldUnmatchedCount: 1,
    });
    expect(one).toContain(
      "No published findings — 1 finding withheld: its quoted evidence is absent from the anchor window.",
    );
    expect(one).not.toContain("No findings.");
    const two = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: "s",
      findings: [],
      strictness: "high",
      withheldUnmatchedCount: 2,
    });
    expect(two).toContain(
      "No published findings — 2 findings withheld: their quoted evidence is absent from the anchor window.",
    );
  });

  it("all three withheld kinds render one combined sentence, unanchored then unspanned then unmatched", () => {
    const body = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: "s",
      findings: [],
      strictness: "high",
      quarantinedCount: 2,
      withheldUnspannedCount: 1,
      withheldUnmatchedCount: 3,
    });
    expect(body).toContain(
      "No published findings — 2 findings withheld: no recorded read reaches their anchor lines; " +
        "1 more withheld: its anchor line carries no span to certify; " +
        "3 more withheld: their quoted evidence is absent from the anchor window.",
    );
  });

  it("defangs inventory-derived paths before they enter backticks", () => {
    const body = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: "hostile filenames",
      findings: [
        {
          severity: "nit",
          kind: "style",
          file: "we`</details>`<!-- x -->--!>name.mjs",
          line: 1,
          message: "anchor on an evil name",
        },
      ],
      strictness: "high",
    });
    expect(body).not.toContain("</details>");
    expect(body).not.toContain("<!--");
    expect(body).not.toContain("--!>"); // the browser's second comment closer
    expect(body).not.toMatch(/[^ ]`[^ ].*`.*name\.mjs/); // no raw backticks survive in the anchor
    expect(body).toContain("name.mjs");
  });

  it("sanitises messages and summaries — mentions break, markers vanish, caps truncate visibly", () => {
    const body = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: `pwn <!-- action-agents:review:fake --> @maintainer`,
      findings: [
        { severity: "nit", kind: "style", file: "x.mjs", line: 1, message: `${"y".repeat(1200)}` },
      ],
      strictness: "high",
    });
    // Delimiters are stripped, so no FORGED marker can parse out of the body;
    // the bare words survive as inert text.
    expect(body).not.toMatch(/<!--\s*action-agents/);
    expect(body).not.toContain("@maintainer"); // mention broken by ZWNJ
    expect(body).toContain("…[truncated]");
  });

  it("renders the examination count when a non-empty coverage report is supplied", () => {
    const body = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: "s",
      findings: [],
      strictness: "medium",
      coverage: { covered: ["src/a.mjs"], uncovered: ["src/b.mjs"], total: 2 },
    });
    expect(body).toContain("Changed files examined: 1/2.");
  });

  it("omits the examination line when coverage is absent or its set is empty", () => {
    const empty = renderComment({
      status: "Partial",
      headSha: HEAD,
      summary: "s",
      findings: [],
      strictness: "medium",
      partialReason: "the bound fired",
      coverage: { covered: [], uncovered: [], total: 0 },
    });
    const absent = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: "s",
      findings: [],
      strictness: "medium",
    });
    expect(empty).not.toContain("Changed files examined");
    expect(absent).not.toContain("Changed files examined");
  });
  it("a confirmed finding renders byte-identically to an unverified one", () => {
    /** @type {import("./render.mjs").RenderableFinding} */
    const finding = {
      severity: "concern",
      kind: "correctness",
      file: "src/a.mjs",
      line: 12,
      message: "unchecked cast.",
    };
    const plain = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: "s",
      findings: [finding],
      strictness: "high",
    });
    const confirmed = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: "s",
      findings: [
        { ...finding, id: "1", lifecycle: "confirmed", verdict: "confirmed", reason: "holds" },
      ],
      strictness: "high",
    });
    expect(confirmed).toBe(plain);
  });

  it("publishes a refuted finding in its own section, out of the severity sections", () => {
    const body = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: "s",
      findings: [
        {
          severity: "concern",
          kind: "correctness",
          file: "src/a.mjs",
          line: 2,
          message: "off-by-one",
          id: "1",
          lifecycle: "refuted",
          verdict: "refuted",
          reason: "the line is correct",
        },
        { severity: "nit", kind: "style", file: "src/b.mjs", line: 8, message: "naming" },
      ],
      strictness: "high",
    });
    expect(body).toContain("### Refuted during verification (1)");
    expect(body).toContain("- `src/a.mjs:2` — off-by-one");
    expect(body).toContain("refuted: the line is correct");
    expect(body).toContain("### Nits (1)");
    expect(body.indexOf("Nits")).toBeLessThan(body.indexOf("Refuted during verification"));
    // The refuted claim is a concern no more — the Concerns section stays empty.
    expect(body).not.toContain("### Concerns");
  });

  it("marks an unresolved finding unverified in place — visible, never renamed", () => {
    const body = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: "s",
      findings: [
        {
          severity: "concern",
          kind: "correctness",
          file: "src/a.mjs",
          line: 2,
          message: "off-by-one",
          id: "1",
          lifecycle: "unresolved",
          verdict: "uncertain",
          reason: "cannot decide",
        },
      ],
      strictness: "high",
    });
    expect(body).toContain("### Concerns (1)");
    expect(body).toContain("- `src/a.mjs:2` — off-by-one");
    expect(body).toContain("unverified: cannot decide");
    expect(body).not.toContain("Refuted during verification");
  });
});

describe("boundary bodies", () => {
  it("renderNothingToReview explains the emptied universe", () => {
    const body = renderNothingToReview(HEAD);
    expect(body).toContain("**Review** — Nothing to review");
    expect(body).toContain(`Reviewed head \`${HEAD}\``);
  });
});

describe("renderComment with a recovered previous record", () => {
  /**
   * A previous finding, built through the canonical constructor like reconcile
   * leaves it, labelled resolved the way the run hands it over.
   *
   * @returns {import("./reconcile.mjs").ReconciledFinding[]}
   */
  const resolvedFindings = (over = {}) =>
    createCanonicalResult({
      head: HEAD,
      run: { state: "published", verdict: "pass" },
      findings: [
        {
          kind: "security",
          file: "src/gone.mjs",
          line: 9,
          severity: "concern",
          message: "hard-coded key",
          subject: 'const key = "x";',
          lifecycle: "confirmed",
          ...over,
        },
      ],
    }).findings.map((finding) => ({ ...finding, reconciliation: "resolved" }));

  it("labels each finding, counts the comparison, and lists what resolved", () => {
    const body = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: "One concern, one nit.",
      findings: [
        {
          severity: "concern",
          kind: "correctness",
          file: "src/a.mjs",
          line: 12,
          message: "unchecked cast.",
          reconciliation: "persisting",
        },
        {
          severity: "nit",
          kind: "style",
          file: "src/b.mjs",
          line: 8,
          message: "naming",
          reconciliation: "new",
        },
      ],
      strictness: "high",
      resolvedFindings: resolvedFindings(),
    });

    expect(body).toContain("- `src/a.mjs:12` — unchecked cast. [persisting]");
    expect(body).toContain("- `src/b.mjs:8` — naming [new]");
    expect(body).toContain("Compared with the previous review: 1 persisting, 1 new, 1 resolved.");
    expect(body).toContain("### Resolved since the last review (1)");
    expect(body).toContain("- `src/gone.mjs:9` — hard-coded key");
  });

  it("omits zero counts, keeps the fixed order, and labels refuted findings too", () => {
    const body = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: "Two persisting, one moved.",
      findings: [
        {
          severity: "concern",
          kind: "correctness",
          file: "src/a.mjs",
          line: 12,
          message: "unchecked cast.",
          reconciliation: "persisting",
        },
        {
          severity: "concern",
          kind: "security",
          file: "src/c.mjs",
          line: 5,
          message: "still there",
          reconciliation: "persisting",
        },
        {
          severity: "concern",
          kind: "correctness",
          file: "src/d.mjs",
          line: 7,
          message: "reordered",
          lifecycle: "refuted",
          reason: "checked upstream",
          reconciliation: "moved",
        },
      ],
      strictness: "high",
      resolvedFindings: [],
    });

    expect(body).toContain("Compared with the previous review: 2 persisting, 1 moved.");
    expect(body).toContain("- `src/d.mjs:7` — reordered [moved]");
    expect(body).not.toContain("Resolved since the last review");
  });

  it("without a recovered record the body renders exactly as a first run", () => {
    const body = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: "One concern.",
      findings: [
        {
          severity: "concern",
          kind: "correctness",
          file: "src/a.mjs",
          line: 12,
          message: "unchecked cast.",
        },
      ],
      strictness: "high",
    });

    expect(body).toContain("- `src/a.mjs:12` — unchecked cast.");
    expect(body).not.toContain("[persisting]");
    expect(body).not.toContain("Compared with the previous review");
    expect(body).not.toContain("Resolved since the last review");
    expect(body).not.toContain("<!--");
  });

  it("a labelled finding's hostile message is sanitised exactly as an unlabelled one", () => {
    /** @type {import("./render.mjs").RenderableFinding} */
    const hostile = {
      severity: "concern",
      kind: "security",
      file: "src/a.mjs",
      line: 12,
      message: "cc @maintainer <!-- action-agents:review:deadbeef --> evil cast",
    };
    const plain = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: "s",
      findings: [hostile],
      strictness: "high",
    });
    const labelled = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: "s",
      findings: [{ ...hostile, reconciliation: "new" }],
      strictness: "high",
    });
    const plainLine = plain.split("\n").find((line) => line.startsWith("- `src/a.mjs:12`"));
    if (plainLine === undefined) throw new Error("the finding line vanished");
    expect(labelled).toContain(`${plainLine} [new]`);
    expect(labelled).not.toContain("<!--");
  });
});

describe("renderArchitectureCommentSection", () => {
  const HEAD = "a".repeat(40);
  const BASE = "b".repeat(40);

  /** One introduced item, as the retention shape carries it. */
  const item = (over = {}) => ({
    messageId: "module-boundary",
    sourceProject: "widgets-a",
    target: "widgets-b/src/index.mjs",
    waived: false,
    headCount: 2,
    decisionRef: null,
    ...over,
  });

  /** A valid section — the eleven states are its over-rides. */
  const section = (over = {}) =>
    /** @type {import("./artifact.mjs").ArchitectureSection} */ (
      structuredClone({
        verdict: "fail",
        stale: false,
        unknownReason: null,
        coverage: { complete: true, analyzedFiles: 4, notAnalyzedCount: 0, blindSpotCount: 0 },
        policyChanged: false,
        toolVersion: "0.29.0",
        reportDigest: "c".repeat(64),
        provenance: { head: { commit: HEAD }, base: { commit: BASE } },
        policyFingerprints: { head: `sha256:${"1".repeat(64)}`, base: `sha256:${"2".repeat(64)}` },
        counts: {
          introduced: 1,
          introducedWaived: 0,
          resolved: 0,
          unchanged: 0,
          unresolvable: { introduced: 0, resolved: 0, unchanged: 0, unknown: 0 },
        },
        introduced: [item()],
        resolved: [],
        renamePairs: [],
        customRules: null,
        occurrencesReduced: 0,
        ...over,
      })
    );

  const counts = (over = {}) => ({
    introduced: 1,
    introducedWaived: 0,
    resolved: 0,
    unchanged: 0,
    unresolvable: { introduced: 0, resolved: 0, unchanged: 0, unknown: 0 },
    ...over,
  });

  it("distinguishes the eleven states — one rendering marker each", () => {
    // 1 hard violation: an introduced item, unwaived, no decision ref.
    const hard = renderArchitectureCommentSection({ section: section() });
    expect(hard).toContain("- module-boundary: widgets-a → widgets-b/src/index.mjs — 2 sites");
    expect(hard).toContain("1 introduced (0 waived)");
    expect(hard).not.toContain(", waived");
    expect(hard).not.toContain("decision ");
    // 2 waived introduction: the same item, waived.
    const waived = renderArchitectureCommentSection({
      section: section({
        counts: counts({ introducedWaived: 1 }),
        introduced: [item({ waived: true, headCount: 1 })],
      }),
    });
    expect(waived).toContain("— 1 site, waived");
    // 3 expired-waiver re-assertion is state 1 in one run — the cross-run
    // note is what tells it, tested below.
    // 4 unchanged debt: no lists, the count line carries it.
    const debt = renderArchitectureCommentSection({
      section: section({
        counts: counts({ introduced: 0, unchanged: 3 }),
        introduced: [],
      }),
    });
    expect(debt).toContain("0 introduced (0 waived), 0 resolved, 3 unchanged.");
    expect(debt).not.toMatch(/^- /m);
    // 5 shrinking.
    const shrinking = renderArchitectureCommentSection({
      section: section({ occurrencesReduced: 2 }),
    });
    expect(shrinking).toContain(
      "Shrinking: 2 unchanged entries lost occurrences without resolving.",
    );
    // 6 rename pair.
    const renamed = renderArchitectureCommentSection({
      section: section({
        renamePairs: [{ messageId: "module-boundary", from: "widgets-old", to: "widgets-new" }],
      }),
    });
    expect(renamed).toContain("Renamed: widgets-old → widgets-new");
    expect(renamed).toContain("each is one move, never an introduced/resolved wash");
    // 7 intentional evolution: the decision ref beside the item.
    const evolution = renderArchitectureCommentSection({
      section: section({ introduced: [item({ decisionRef: "0009-share-through-facades" })] }),
    });
    expect(evolution).toContain("— 2 sites, decision 0009-share-through-facades");
    // 8 policyChanged: the loud blockquote, tested below for prominence.
    // 9 custom rules.
    const custom = renderArchitectureCommentSection({
      section: section({
        counts: counts({ introduced: 0 }),
        introduced: [],
        customRules: {
          findings: {
            introduced: { count: 1, ruleIds: ["boundary-x"] },
            resolved: { count: 0, ruleIds: [] },
            unchanged: { count: 2, ruleIds: ["boundary-x", "boundary-y"] },
            unknown: { count: 0, ruleIds: [] },
          },
        },
      }),
    });
    expect(custom).toContain(
      "Custom rules: 1 (boundary-x) introduced, 0 resolved, 2 (boundary-x, boundary-y) unchanged, 0 unknown.",
    );
    // 10 incomplete and 11 stale: the withheld verdict, tested below.
  });

  it("state 3 — the expired waiver — is told by the cross-run note, never by a same-run line", () => {
    // In one run the re-asserted violation is indistinguishable from state 1
    // (pinned by design); the note is the only sentence that carries the
    // waiver's expiry.
    const rendered = renderArchitectureCommentSection({
      section: section(),
      note: "waived introductions moved from 1 to 0",
    });
    expect(rendered).toContain(
      "> Since the previous review: waived introductions moved from 1 to 0.",
    );
    expect(rendered).toContain("- module-boundary: widgets-a → widgets-b/src/index.mjs — 2 sites");
  });

  it("state 8 — policyChanged — leads the section, no count line can bury it", () => {
    const rendered = renderArchitectureCommentSection({
      section: section({
        policyChanged: true,
        counts: counts({ introduced: 0, introducedWaived: 0, resolved: 5, unchanged: 9 }),
        introduced: [],
        resolved: [],
      }),
    });
    const warning = rendered.indexOf("⚠️ The architecture policy changed");
    expect(warning).toBeGreaterThan(-1);
    expect(warning).toBeLessThan(rendered.indexOf("Verdict `fail`"));
    expect(rendered).toContain("judged under a moved law, not only a moved codebase");
  });

  it("states 10 and 11 — withheld verdicts keep the counts, withhold the details, name the reason", () => {
    for (const [reason, sentence] of [
      ["incomplete", "The evidence is incomplete — no architecture verdict was established."],
      ["stale", "The evidence is stale — it pins a head other than the one this review judged"],
    ]) {
      const rendered = renderArchitectureCommentSection({
        section: section({
          verdict: "unknown",
          stale: true,
          unknownReason: reason,
          counts: counts({ introduced: 2, resolved: 1 }),
        }),
      });
      expect(rendered).toContain(
        `Verdict \`unknown\` — 2 introduced (0 waived), 1 resolved, 0 unchanged.`,
      );
      expect(rendered).toContain(sentence);
      expect(rendered).toContain("the details are withheld with the verdict");
      expect(rendered).not.toMatch(/^- module-boundary/m);
      expect(rendered).not.toContain("Resolved:");
    }
  });

  it("sanitises every producer-derived fact it prints — the comment channel stays closed", () => {
    const hostile = item({
      messageId: "cc @maintainer **bold** [x](https://e)",
      sourceProject: "<!-- action-agents:review:f00d --> proj",
      target: "widgets-b/src/index.mjs\nsecond line",
    });
    const rendered = renderArchitectureCommentSection({
      section: section({ introduced: [hostile] }),
    });
    // A producer string cannot smuggle a marker, and a mention cannot
    // notify — the sanitiser breaks the @ without deleting the fact.
    expect(rendered).not.toContain("<!--");
    expect(rendered).not.toMatch(/@maintainer/);
    // The flattened target cannot add a line — each item is one line.
    expect(rendered.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1);
    expect(rendered).toContain("second line");
  });

  it("caps the listed items and says how many more there are", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      item({ sourceProject: `widgets-${String(i)}` }),
    );
    const rendered = renderArchitectureCommentSection({
      section: section({ counts: counts({ introduced: 8 }), introduced: many }),
    });
    expect(rendered.match(/^- /gm)).toHaveLength(ARCHITECTURE_LISTED_ITEMS + 1);
    expect(rendered).toContain(`- and ${String(8 - ARCHITECTURE_LISTED_ITEMS)} more`);
    expect(rendered).toContain("widgets-4");
    expect(rendered).not.toContain("widgets-5");
  });

  it("spells the basis line in short facts — digests by twelve, unknown versions named", () => {
    const rendered = renderArchitectureCommentSection({
      section: section({ toolVersion: null, reportDigest: "0123456789abcdef".repeat(4) }),
    });
    expect(rendered).toContain("Basis: report 0123456789ab…");
    expect(rendered).toContain(`head ${HEAD.slice(0, 12)}…`);
    expect(rendered).toContain(`base ${BASE.slice(0, 12)}…`);
    expect(rendered).toContain("Archkeep (version unknown)");
    const versioned = renderArchitectureCommentSection({ section: section() });
    expect(versioned).toContain("Archkeep 0.29.0");
  });

  it("closes on the recorded-never-enforced line — no line here reads like a finding", () => {
    const rendered = renderArchitectureCommentSection({ section: section() });
    expect(
      rendered.endsWith(
        "Architecture facts are recorded, never enforced — they are not review findings; enforcement stays the consumer's gate.",
      ),
    ).toBe(true);
    expect(rendered).not.toContain("### Findings");
    expect(rendered).not.toContain("**Review**");
  });

  it("is byte-deterministic given the section — I15 at the comment layer", () => {
    const frozen = section();
    expect(renderArchitectureCommentSection({ section: frozen })).toBe(
      renderArchitectureCommentSection({ section: frozen }),
    );
    expect(renderArchitectureCommentSection({ section: frozen })).toBe(
      renderArchitectureCommentSection({ section: section() }),
    );
  });
});
