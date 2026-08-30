// Tests for the Decision contract — the auditable mutation plan — and its
// two pure renderers: `commentBody` (the marker comment's construction) and
// `renderDryRun` (the preview that must be exactly what a live run says).

import { afterEach, describe, expect, it, vi } from "vitest";

import { commentBody, renderDryRun, signalBody } from "./decision.mjs";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("commentBody", () => {
  it("builds the marker comment with classification, rationale and footnote", () => {
    const body = commentBody(
      { classification: "a bug", rationale: "fails on import." },
      "<!-- action-agents:triage -->",
    );
    expect(body).toContain("<!-- action-agents:triage -->");
    expect(body).toContain("**a bug**");
    expect(body).toContain("> fails on import.");
    expect(body).toContain(
      "_Classified by the `triage` action. No label sheet is configured in this repository, so the classification is posted as a comment — configure `.github/action-agents/triage/triage.json5` to apply labels instead._",
    );
  });

  it("collapses multi-line model text to one line", () => {
    const body = commentBody(
      { classification: "a bug\non import", rationale: "line one\nline two" },
      "<!-- action-agents:triage -->",
    );
    expect(body).toContain("**a bug on import**");
    expect(body).toContain("> line one line two");
  });

  it("renders (no classification) when the classification is empty, and no rationale line when the rationale is empty", () => {
    const body = commentBody({ classification: "", rationale: "" }, "<!-- m -->");
    expect(body).toContain("**(no classification)**");
    expect(body).not.toContain("> ");
  });

  it("never lets the marker appear inside model text, even if the model echoes it", () => {
    const marker = "<!-- action-agents:triage -->";
    const body = commentBody({ classification: marker, rationale: marker }, marker);
    expect(body).not.toContain(`> ${marker}`);
    expect(body).not.toContain(`**${marker}**`);
  });

  it("logs a warning when the sanitiser has to alter model text", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    commentBody(
      { classification: "<!-- action-agents:triage -->", rationale: "r" },
      "<!-- action-agents:triage -->",
    );
    expect(log.mock.calls.some((call) => String(call[0]).startsWith("::warning::sanitiser:"))).toBe(
      true,
    );
  });
});

describe("renderDryRun", () => {
  it("renders a pure add as one line", () => {
    const [line] = renderDryRun({
      kind: "labels",
      add: ["bug", "docs"],
      remove: [],
      refusals: [],
      logs: [],
      rationale: "r",
      comment: undefined,
    });
    expect(line).toBe("dry run — would add [bug, docs]");
  });

  it("explains a size replacement with its own wording", () => {
    const [line] = renderDryRun({
      kind: "labels",
      add: ["size/xs"],
      remove: [{ name: "size/xl", reason: "size" }],
      refusals: [],
      logs: [],
      rationale: "r",
      comment: undefined,
    });
    expect(line).toBe(
      "dry run — would add [size/xs] and remove [size/xl] (size is replaced, not added to)",
    );
  });

  it("explains a marker clear with its own wording", () => {
    const [line] = renderDryRun({
      kind: "labels",
      add: ["bug"],
      remove: [{ name: "needs triage", reason: "marker" }],
      refusals: [],
      logs: [],
      rationale: "r",
      comment: undefined,
    });
    expect(line).toBe(
      "dry run — would add [bug] and remove [needs triage] (triage marker cleared on classification)",
    );
  });

  it("names size replacements before marker clears, in removal order", () => {
    const [line] = renderDryRun({
      kind: "labels",
      add: ["bug", "size/xs"],
      remove: [
        { name: "size/xl", reason: "size" },
        { name: "needs triage", reason: "marker" },
      ],
      refusals: [],
      logs: [],
      rationale: "r",
      comment: undefined,
    });
    expect(line).toBe(
      "dry run — would add [bug, size/xs] and remove [size/xl] (size is replaced, not added to) and remove [needs triage] (triage marker cleared on classification)",
    );
  });

  it("renders an empty add faithfully as an empty list", () => {
    const [line] = renderDryRun({
      kind: "labels",
      add: [],
      remove: [],
      refusals: [],
      logs: [],
      rationale: "r",
      comment: undefined,
    });
    expect(line).toBe("dry run — would add []");
  });

  it("previews a comment decision as the dry-run-marked body", () => {
    const lines = renderDryRun({
      kind: "comment",
      add: [],
      remove: [],
      refusals: [],
      logs: [],
      rationale: "Because.",
      comment: { classification: "a bug", rationale: "Because." },
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("dry run — the classification would be written as this comment:");
    expect(lines[1]).toContain("<!-- action-agents:triage:dry-run -->");
    expect(lines[1]).toContain("**a bug**");
  });
});

describe("signalBody", () => {
  it("builds the incomplete-note when required fields are missing", () => {
    const body = signalBody(
      { needsMoreInfo: ["Steps to reproduce"], modelJudgedQuality: false, related: null },
      "<!-- action-agents:triage -->",
    );
    expect(body).toContain("<!-- action-agents:triage -->");
    expect(body).toContain(
      "This issue looks incomplete. This is a note, not a closing: the thread stays open and nothing is closed.",
    );
    expect(body).toContain("The following required field is empty: Steps to reproduce.");
    expect(body).toContain("_Posted by the `triage` action._");
    expect(body).not.toMatch(/@\w+/);
  });

  it("uses the fixed sentence when only the model judged the issue incomplete", () => {
    const body = signalBody(
      { needsMoreInfo: [], modelJudgedQuality: true, related: null },
      "<!-- action-agents:triage -->",
    );
    expect(body).toContain(
      "The report cannot be followed as written; adding steps to reproduce, expected-versus-actual, environment details or the run log would help.",
    );
  });

  it("pluralises the required-fields sentence for more than one field", () => {
    const body = signalBody(
      { needsMoreInfo: ["Steps", "Logs"], modelJudgedQuality: false, related: null },
      "<!-- action-agents:triage -->",
    );
    expect(body).toContain("The following required fields are empty: Steps, Logs.");
  });

  it("neutralises a mention-shaped template field label in the fixed sentence", () => {
    const body = signalBody(
      {
        needsMoreInfo: ["Reporter @alice", "Steps", "Logs"],
        modelJudgedQuality: false,
        related: null,
      },
      "<!-- action-agents:triage -->",
    );
    // Field names are untrusted repository data (a template's
    // attributes.label): an @handle must never survive as a live mention,
    // and the sentence the composer owns stays intact around the broken one.
    expect(body).not.toContain("@alice");
    expect(body).toContain(
      "The following required fields are empty: Reporter @\u200calice, Steps, Logs.",
    );
    expect(body).not.toMatch(/@\w+/);
  });

  it("marks the cap when a template pads the field list past the byte limit", () => {
    const body = signalBody(
      {
        needsMoreInfo: ["Field ".repeat(30).trim()],
        modelJudgedQuality: false,
        related: null,
      },
      "<!-- action-agents:triage -->",
    );
    expect(body).toContain("…[truncated]");
  });

  it("collapses blank lines so the marker, copy and footnote stay tight", () => {
    const body = signalBody(
      { needsMoreInfo: [], modelJudgedQuality: false, related: null },
      "<!-- action-agents:triage -->",
    );
    expect(body).not.toContain("\n\n\n");
  });

  it("names a best relationship with a sanitised title and no unfiltered markup", () => {
    const body = signalBody(
      {
        needsMoreInfo: [],
        modelJudgedQuality: false,
        related: {
          number: 12,
          title: "the same crash<br>@admin <!-- forge -->",
          type: "duplicate",
        },
      },
      "<!-- action-agents:triage -->",
    );
    expect(body).toContain("Possibly duplicate of #12 — the same crash");
    // Tags are escaped, @mentions broken, and the action's own marker cannot
    // appear inside the reference — the sanitiser neutralises the untrusted
    // title before the composer places it.
    expect(body).not.toContain("<br>");
    expect(body).not.toMatch(/@admin/);
    expect(body).not.toContain("<!-- forge -->");
  });
});

describe("renderDryRun — signal", () => {
  it("previews the owned replacement and the signal comment", () => {
    const [line] = renderDryRun({
      kind: "labels",
      add: ["bug", "p1"],
      remove: [{ name: "p2", reason: "owned" }],
      refusals: [],
      logs: [],
      rationale: "r",
      comment: undefined,
      signal: {
        needsMoreInfo: [],
        modelJudgedQuality: false,
        related: { number: 12, title: "the same crash", type: "duplicate" },
      },
    });
    expect(line).toContain("dry run — would add [bug, p1]");
    expect(line).toContain("and remove [p2] (triage-owned label replaced by the derived priority)");
    expect(line).toContain("and post a signal comment:");
    expect(line).toContain("Possibly duplicate of #12");
  });

  it("previews no signal when the decision carries none", () => {
    const [line] = renderDryRun({
      kind: "labels",
      add: ["bug"],
      remove: [],
      refusals: [],
      logs: [],
      rationale: "r",
      comment: undefined,
    });
    expect(line).toBe("dry run — would add [bug]");
    expect(line).not.toContain("signal");
  });
});
