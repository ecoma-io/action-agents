// Tests for the comment renderer: deterministic bodies, defanged anchors,
// sanitised prose, collapsing by strictness, and the boundary bodies
// (No findings / Nothing to review / Partial).

import { describe, expect, it } from "vitest";

import { renderComment, renderNothingToReview } from "./render.mjs";

const HEAD = "a".repeat(40);

describe("renderComment", () => {
  it("renders complete reviews with anchored, ordered sections", () => {
    const body = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: "Two things worth a look.",
      findings: [
        { severity: "concern", file: "src/a.mjs", line: 12, message: "unchecked cast." },
        { severity: "nit", file: "src/a.mjs", line: 3, message: "typo" },
        { severity: "nit", file: "src/b.mjs", line: 8, message: "naming" },
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

  it("collapses nits at medium strictness — one click away, still anchored", () => {
    const body = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: "s",
      findings: [{ severity: "nit", file: "x.mjs", line: 1, message: "m" }],
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
      findings: [{ severity: "nit", file: "x.mjs", line: 1, message: "m" }],
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
        { severity: "concern", file: "src/a.mjs", line: 2, message: "real" },
        { severity: "nit", file: "src/a.mjs", line: 1, message: "m" },
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

  it("defangs inventory-derived paths before they enter backticks", () => {
    const body = renderComment({
      status: "Complete",
      headSha: HEAD,
      summary: "hostile filenames",
      findings: [
        {
          severity: "nit",
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
      findings: [{ severity: "nit", file: "x.mjs", line: 1, message: `${"y".repeat(1200)}` }],
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
          file: "src/a.mjs",
          line: 2,
          message: "off-by-one",
          id: "1",
          lifecycle: "refuted",
          verdict: "refuted",
          reason: "the line is correct",
        },
        { severity: "nit", file: "src/b.mjs", line: 8, message: "naming" },
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
