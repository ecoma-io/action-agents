// Tests for the answer's parse and match.
//
// Parsing tolerates provider drift; matching tolerates none of it. Those
// two halves are pinned separately on purpose: a test that only proved
// `{"labels":["bug"]}` round-trips would pin neither the fences a model
// wraps its JSON in nor the exactness that is the whole ceiling.

import { describe, expect, it } from "vitest";

import { matchLabels, parseCommentAnswer, parseLabelsAnswer } from "./answer.mjs";

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
