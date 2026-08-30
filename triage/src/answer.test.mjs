// Tests for the answer's parse and match.
//
// Parsing tolerates provider drift; matching tolerates none of it. Those
// two halves are pinned separately on purpose: a test that only proved
// `{"labels":["bug"]}` round-trips would pin neither the fences a model
// wraps its JSON in nor the exactness that is the whole ceiling.

import { describe, expect, it } from "vitest";

import {
  matchLabels,
  parseCommentAnswer,
  parseIssueDimensions,
  parseLabelsAnswer,
} from "./answer.mjs";

const SHEET = new Map([
  ["bug", "Reproducible incorrect behaviour"],
  ["docs", "Documentation only"],
  ["good first issue", "Small and self-contained"],
]);

describe("parseLabelsAnswer", () => {
  it("reads the labels and the rationale from plain JSON", () => {
    expect(parseLabelsAnswer('{"labels":["bug","docs"],"rationale":"Fails on import."}')).toEqual({
      labels: ["bug", "docs"],
      rationale: "Fails on import.",
    });
  });

  it("reads JSON5 — the same parser the config file uses", () => {
    const answer = parseLabelsAnswer(`{
      // provider drift, tolerated
      labels: ['bug',],  // trailing comma, single quotes
      rationale: "Quoted with a \\" inside.",
    }`);
    expect(answer.labels).toEqual(["bug"]);
  });

  it("unwraps a code fence around the whole answer", () => {
    expect(parseLabelsAnswer('```json\n{"labels":["bug"],"rationale":"r"}\n```')).toEqual({
      labels: ["bug"],
      rationale: "r",
    });
  });

  it("accepts extra fields without reading them", () => {
    const answer = parseLabelsAnswer('{"labels":["bug"],"rationale":"r","confidence":0.9}');
    expect(answer.labels).toEqual(["bug"]);
  });

  it("accepts an empty labels array — none fitting is a valid verdict", () => {
    expect(parseLabelsAnswer('{"labels":[],"rationale":"Nothing fits."}').labels).toEqual([]);
  });

  it("accepts a missing rationale, and refuses a non-string one", () => {
    expect(parseLabelsAnswer('{"labels":["bug"]}').rationale).toBe("");
    expect(() => parseLabelsAnswer('{"labels":["bug"],"rationale":7}')).toThrow(/rationale/);
  });

  it("refuses prose with no JSON object in it", () => {
    expect(() => parseLabelsAnswer("This issue looks like a bug to me.")).toThrow(/no JSON object/);
  });

  it("refuses JSON of the wrong shape rather than parsing optimistically", () => {
    expect(() => parseLabelsAnswer('{"rationale":"no labels key"}')).toThrow(/no labels array/);
    expect(() => parseLabelsAnswer('{"labels":"bug"}')).toThrow(/no labels array/);
    expect(() => parseLabelsAnswer('{"labels":[7]}')).toThrow(/not a string/);
    expect(() => parseLabelsAnswer('["bug"]')).toThrow(/no JSON object/);
  });

  it("takes the outermost object, so braces inside strings do not end it early", () => {
    const answer = parseLabelsAnswer('{"labels":["bug"],"rationale":"a } brace inside"}');
    expect(answer.rationale).toBe("a } brace inside");
  });
});

describe("parseCommentAnswer", () => {
  it("reads the no-sheet contract: classification and rationale", () => {
    expect(parseCommentAnswer('{"classification":"bug","rationale":"r"}')).toEqual({
      classification: "bug",
      rationale: "r",
    });
  });

  it("refuses an answer with no classification string", () => {
    expect(() => parseCommentAnswer('{"rationale":"r"}')).toThrow(/no classification/);
  });
});

describe("matchLabels", () => {
  it("accepts the on-sheet and refuses the off-sheet, exactly", () => {
    const { accepted, refused } = matchLabels(["bug", "nope", "good first issue"], SHEET);
    expect(accepted).toEqual(["bug", "good first issue"]);
    expect(refused).toEqual(["nope"]);
  });

  it("refuses wrong casing and trailing whitespace — `Bug` and `bug ` are not `bug`", () => {
    const { accepted, refused } = matchLabels(["Bug", "bug ", "BUG", "bug"], SHEET);
    expect(accepted).toEqual(["bug"]);
    expect(refused).toEqual(["Bug", "bug ", "BUG"]);
  });
});

describe("parseIssueDimensions", () => {
  it("returns {} when the answer carries no dimensions field", () => {
    expect(parseIssueDimensions('{"labels":["bug"],"rationale":"r"}')).toEqual({});
  });

  it("parses all three issue-side dimensions leniently", () => {
    const parsed = parseIssueDimensions(
      JSON.stringify({
        labels: ["bug"],
        rationale: "r",
        dimensions: {
          quality: {
            missing: ["logs"],
            weak: ["env"],
            completeness: "missing-evidence",
            confidence: 0.8,
          },
          relationships: {
            candidates: [
              { index: 0, type: "duplicate", confidence: 0.6, evidence: "same crash" },
              { index: 2, type: "related" },
            ],
          },
          priority: { severity: "high", confidence: 0.9 },
        },
      }),
    );
    expect(parsed).toEqual({
      quality: {
        missing: ["logs"],
        weak: ["env"],
        completeness: "missing-evidence",
        confidence: 0.8,
      },
      relationships: {
        candidates: [
          { index: 0, type: "duplicate", confidence: 0.6, evidence: "same crash" },
          { index: 2, type: "related" },
        ],
      },
      priority: { severity: "high", confidence: 0.9 },
    });
  });

  it("refuses a wrong-typed dimensions field", () => {
    expect(() => parseIssueDimensions('{"dimensions":"nope"}')).toThrow(
      "the model's dimensions are not a JSON object",
    );
  });

  it("refuses a non-object quality dimension", () => {
    expect(() => parseIssueDimensions('{"dimensions":{"quality":42}}')).toThrow(
      "the model's quality dimension is not a JSON object",
    );
  });

  it("refuses a relationship candidate with no numeric index", () => {
    expect(() =>
      parseIssueDimensions(
        '{"dimensions":{"relationships":{"candidates":[{"type":"duplicate"}]}}}',
      ),
    ).toThrow("a model relationship candidate has no numeric index");
  });

  it("refuses a non-string relationship candidate type", () => {
    expect(() =>
      parseIssueDimensions(
        '{"dimensions":{"relationships":{"candidates":[{"index":0,"type":7}]}}}',
      ),
    ).toThrow("a model relationship candidate type is not a string");
  });

  it("refuses a non-string severity", () => {
    expect(() => parseIssueDimensions('{"dimensions":{"priority":{"severity":5}}}')).toThrow(
      "the model's priority.severity is not a string",
    );
  });

  it("treats null members as absent and non-object answers as refused", () => {
    const parsed = parseIssueDimensions('{"dimensions":{"priority":{"severity":null}}}');
    expect(parsed.priority).toEqual({});
    expect(() => parseIssueDimensions("just prose, no object")).toThrow(
      "the model's answer holds no JSON object",
    );
  });

  it("ignores a routing answer the prompt no longer asks for", () => {
    // Routing is code-derived from the matched form; a model that still
    // answers it is never refused on it — the judgement is simply not part
    // of the output contract any more.
    expect(parseIssueDimensions('{"dimensions":{"routing":{"area":5}}}')).toEqual({});
    expect(parseIssueDimensions('{"dimensions":{"routing":"nope"}}')).toEqual({});
  });
});
