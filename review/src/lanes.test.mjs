// Tests for the attention lanes: the mapping table row by row, the
// refusals (unknown risk, unknown strictness — never coerced), the
// policy floor (config raises attention, never lowers it), the
// deterministic byte-wise ordering, and the budget split's documented
// rule — equal integer parts, remainder to the deepest occupied lanes
// first, nothing lost.

import { describe, expect, it } from "vitest";

import { assignLanes, laneBudget } from "./lanes.mjs";

/**
 * @param {string} path
 * @param {import("./risk.mjs").RiskLevel} risk
 * @returns {import("./lanes.mjs").LaneEntry}
 */
function entry(path, risk) {
  return { path, riskPlan: { risk, lanes: ["correctness"], signals: [] } };
}

describe("the mapping table, row by row", () => {
  it("maps low risk to skim", () => {
    expect(assignLanes([entry("src/util.ts", "low")], { strictness: "medium" })).toEqual([
      { path: "src/util.ts", risk: "low", lane: "skim" },
    ]);
  });

  it("maps medium risk to standard", () => {
    expect(assignLanes([entry("src/api/users.ts", "medium")], { strictness: "medium" })).toEqual([
      { path: "src/api/users.ts", risk: "medium", lane: "standard" },
    ]);
  });

  it("maps high risk to deep", () => {
    expect(assignLanes([entry("src/auth/login.ts", "high")], { strictness: "medium" })).toEqual([
      { path: "src/auth/login.ts", risk: "high", lane: "deep" },
    ]);
  });

  it("maps critical risk to deep", () => {
    expect(assignLanes([entry("src/auth/keys.ts", "critical")], { strictness: "low" })).toEqual([
      { path: "src/auth/keys.ts", risk: "critical", lane: "deep" },
    ]);
  });

  it("carries the classifier's risk through untouched", () => {
    for (const risk of /** @type {const} */ (["low", "medium", "high", "critical"])) {
      const [row] = assignLanes([entry("src/x.ts", risk)], { strictness: "medium" });
      expect(row?.risk).toBe(risk);
    }
  });
});

describe("the refusals", () => {
  it("refuses a risk the declared enum does not name, without a lane", () => {
    const hostile = entry("src/x.ts", /** @type {import("./risk.mjs").RiskLevel} */ ("moderate"));
    expect(() => assignLanes([hostile], { strictness: "medium" })).toThrow(/refuse a risk/);
  });

  it("refuses an entry whose plan carries no risk at all", () => {
    const hollow = /** @type {import("./lanes.mjs").LaneEntry} */ (
      /** @type {unknown} */ ({
        path: "src/x.ts",
        riskPlan: { lanes: ["correctness"], signals: [] },
      })
    );
    expect(() => assignLanes([hollow], { strictness: "medium" })).toThrow(/refuse a risk/);
  });

  it("refuses a strictness the config schema does not declare", () => {
    const hostile = /** @type {Pick<import("./config.mjs").ReviewConfig, "strictness">} */ (
      /** @type {unknown} */ ({ strictness: "paranoid" })
    );
    expect(() => assignLanes([entry("src/x.ts", "low")], hostile)).toThrow(/refuse a policy/);
  });
});

describe("the policy floor", () => {
  it("at high strictness every file reads deep, whatever the table says", () => {
    const lanes = assignLanes(
      [
        entry("src/util.ts", "low"),
        entry("src/api/users.ts", "medium"),
        entry("src/auth/login.ts", "high"),
      ],
      { strictness: "high" },
    );
    expect(lanes.map((row) => row.lane)).toEqual(["deep", "deep", "deep"]);
  });

  it("at low and medium strictness the table alone decides", () => {
    for (const strictness of /** @type {const} */ (["low", "medium"])) {
      const [row] = assignLanes([entry("src/auth/login.ts", "high")], { strictness });
      expect(row?.lane).toBe("deep");
      const [shallow] = assignLanes([entry("src/util.ts", "low")], { strictness });
      expect(shallow?.lane).toBe("skim");
    }
  });

  it("no strictness lowers a deep verdict — config raises, never lowers", () => {
    for (const strictness of /** @type {const} */ (["low", "medium", "high"])) {
      const [row] = assignLanes([entry("src/auth/keys.ts", "critical")], { strictness });
      expect(row?.lane).toBe("deep");
    }
  });
});

describe("deterministic ordering", () => {
  it("sorts byte-wise by path whatever the input order", () => {
    const lanes = assignLanes(
      [
        entry("src/z.ts", "low"),
        entry("B.ts", "high"),
        entry("a.ts", "low"),
        entry("src/a2.ts", "medium"),
        entry("src/a10.ts", "low"),
      ],
      { strictness: "medium" },
    );
    expect(lanes.map((row) => row.path)).toEqual([
      "B.ts", // 0x42 sorts before lowercase
      "a.ts",
      "src/a10.ts", // byte order, not numeric: "1" before "2"
      "src/a2.ts",
      "src/z.ts",
    ]);
  });

  it("the same entries and policy always yield the same rows", () => {
    const once = assignLanes([entry("src/b.ts", "high"), entry("src/a.ts", "low")], {
      strictness: "low",
    });
    const twice = assignLanes([entry("src/a.ts", "low"), entry("src/b.ts", "high")], {
      strictness: "low",
    });
    expect(twice).toEqual(once);
  });
});

describe("the budget split", () => {
  it("splits an exactly-divisible bound into equal parts", () => {
    const lanes = assignLanes([entry("src/auth/login.ts", "high"), entry("src/util.ts", "low")], {
      strictness: "medium",
    });
    expect(laneBudget(lanes, 10)).toEqual({ deep: 5, standard: 0, skim: 5 });
  });

  it("sends an indivisible remainder to the deepest occupied lane first", () => {
    const lanes = assignLanes([entry("src/auth/login.ts", "high"), entry("src/util.ts", "low")], {
      strictness: "medium",
    });
    expect(laneBudget(lanes, 11)).toEqual({ deep: 6, standard: 0, skim: 5 });
  });

  it("floors the equal part before the remainder lands", () => {
    const lanes = assignLanes([entry("src/auth/login.ts", "high"), entry("src/util.ts", "low")], {
      strictness: "medium",
    });
    expect(laneBudget(lanes, 7)).toEqual({ deep: 4, standard: 0, skim: 3 });
  });

  it("prioritises deep, then standard, then skim across three occupied lanes", () => {
    const lanes = assignLanes(
      [
        entry("src/auth/login.ts", "high"),
        entry("src/api/users.ts", "medium"),
        entry("src/util.ts", "low"),
      ],
      { strictness: "medium" },
    );
    expect(laneBudget(lanes, 10)).toEqual({ deep: 4, standard: 3, skim: 3 });
    expect(laneBudget(lanes, 12)).toEqual({ deep: 4, standard: 4, skim: 4 });
  });

  it("starves the shallow lanes first when the bound is smaller than the occupancy", () => {
    const lanes = assignLanes(
      [
        entry("src/auth/login.ts", "high"),
        entry("src/api/users.ts", "medium"),
        entry("src/util.ts", "low"),
      ],
      { strictness: "medium" },
    );
    expect(laneBudget(lanes, 2)).toEqual({ deep: 1, standard: 1, skim: 0 });
    expect(laneBudget(lanes, 1)).toEqual({ deep: 1, standard: 0, skim: 0 });
  });

  it("never loses a unit of the bound", () => {
    const lanes = assignLanes(
      [
        entry("src/auth/login.ts", "high"),
        entry("src/api/users.ts", "medium"),
        entry("src/util.ts", "low"),
      ],
      { strictness: "medium" },
    );
    for (let bound = 0; bound <= 50; bound++) {
      const split = laneBudget(lanes, bound);
      expect(split.deep + split.standard + split.skim).toBe(bound);
    }
  });

  it("budgets zero for every lane when nothing is occupied", () => {
    expect(laneBudget([], 10)).toEqual({ deep: 0, standard: 0, skim: 0 });
    expect(laneBudget([], 0)).toEqual({ deep: 0, standard: 0, skim: 0 });
  });

  it("budgets zero everywhere at a zero bound even with occupied lanes", () => {
    const lanes = assignLanes([entry("src/auth/login.ts", "high")], { strictness: "medium" });
    expect(laneBudget(lanes, 0)).toEqual({ deep: 0, standard: 0, skim: 0 });
  });

  it("refuses a bound that is not a non-negative integer", () => {
    const lanes = assignLanes([entry("src/auth/login.ts", "high")], { strictness: "medium" });
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => laneBudget(lanes, bad)).toThrow(/non-negative integer/);
    }
  });
});
