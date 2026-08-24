/**
 * The behavioural contract of {@linkcode json5Parse}: every grammar form the
 * parser accepts, the reviver's traversal semantics, and diagnostics that
 * name the offending character with its exact line and column.
 */

import { describe, expect, it, vi } from "vitest";

import { json5Parse } from "./json5-parse.mjs";

/**
 * Runs `json5Parse`, expecting a throw, and hands back that error.
 *
 * @param {string} text
 * @returns {SyntaxError & { lineNumber: number, columnNumber: number }}
 */
function parseError(text) {
  try {
    json5Parse(text);
  } catch (error) {
    return /** @type {SyntaxError & { lineNumber: number, columnNumber: number }} */ (error);
  }
  throw new Error(`expected ${JSON.stringify(text)} to be rejected`);
}

describe("json5Parse(text)", () => {
  describe("objects", () => {
    it("parses empty objects", () => {
      expect(json5Parse("{}")).toStrictEqual({});
    });

    it("parses double string property names", () => {
      expect(json5Parse('{"a":1}')).toStrictEqual({ a: 1 });
    });

    it("parses single string property names", () => {
      expect(json5Parse("{'a':1}")).toStrictEqual({ a: 1 });
    });

    it("parses unquoted property names", () => {
      expect(json5Parse("{a:1}")).toStrictEqual({ a: 1 });
    });

    it("parses special character property names", () => {
      expect(json5Parse("{$_:1,_$:2,a\u200C:3}")).toStrictEqual({
        $_: 1,
        _$: 2,
        "a\u200C": 3,
      });
    });

    it("parses unicode property names", () => {
      expect(json5Parse("{ùńîċõďë:9}")).toStrictEqual({ ùńîċõďë: 9 });
    });

    it("parses escaped property names", () => {
      expect(json5Parse("{\\u0061\\u0062:1,\\u0024\\u005F:2,\\u005F\\u0024:3}")).toStrictEqual({
        ab: 1,
        $_: 2,
        _$: 3,
      });
    });

    it("preserves __proto__ property names", () => {
      expect(json5Parse('{"__proto__":1}').__proto__).toBe(1);
    });

    it("parses multiple properties", () => {
      expect(json5Parse("{abc:1,def:2}")).toStrictEqual({ abc: 1, def: 2 });
    });

    it("parses nested objects", () => {
      expect(json5Parse("{a:{b:2}}")).toStrictEqual({ a: { b: 2 } });
    });
  });

  describe("arrays", () => {
    it("parses empty arrays", () => {
      expect(json5Parse("[]")).toStrictEqual([]);
    });

    it("parses array values", () => {
      expect(json5Parse("[1]")).toStrictEqual([1]);
    });

    it("parses multiple array values", () => {
      expect(json5Parse("[1,2]")).toStrictEqual([1, 2]);
    });

    it("parses nested arrays", () => {
      expect(json5Parse("[1,[2,3]]")).toStrictEqual([1, [2, 3]]);
    });
  });

  describe("nulls", () => {
    it("parses nulls", () => {
      expect(json5Parse("null")).toBe(null);
    });
  });

  describe("booleans", () => {
    it("parses true", () => {
      expect(json5Parse("true")).toBe(true);
    });

    it("parses false", () => {
      expect(json5Parse("false")).toBe(false);
    });
  });

  describe("numbers", () => {
    it("parses leading zeroes", () => {
      expect(json5Parse("[0,0.,0e0]")).toStrictEqual([0, 0, 0]);
    });

    it("parses integers", () => {
      expect(json5Parse("[1,23,456,7890]")).toStrictEqual([1, 23, 456, 7890]);
    });

    it("parses signed numbers", () => {
      expect(json5Parse("[-1,+2,-.1,-0]")).toStrictEqual([-1, 2, -0.1, -0]);
    });

    it("parses leading decimal points", () => {
      expect(json5Parse("[.1,.23]")).toStrictEqual([0.1, 0.23]);
    });

    it("parses fractional numbers", () => {
      expect(json5Parse("[1.0,1.23]")).toStrictEqual([1, 1.23]);
    });

    it("parses exponents", () => {
      expect(json5Parse("[1e0,1e1,1e01,1.e0,1.1e0,1e-1,1e+1]")).toStrictEqual([
        1, 10, 10, 1, 1.1, 0.1, 10,
      ]);
    });

    it("parses hexadecimal numbers", () => {
      expect(json5Parse("[0x1,0x10,0xff,0xFF]")).toStrictEqual([1, 16, 255, 255]);
    });

    it("parses signed and unsigned Infinity", () => {
      expect(json5Parse("[Infinity,-Infinity]")).toStrictEqual([Infinity, -Infinity]);
    });

    it("parses NaN", () => {
      expect(Number.isNaN(json5Parse("NaN"))).toBe(true);
    });

    it("parses signed NaN", () => {
      expect(Number.isNaN(json5Parse("-NaN"))).toBe(true);
    });

    it("parses bare numbers", () => {
      expect(json5Parse("1")).toBe(1);
      expect(json5Parse("+1.23e100")).toBe(1.23e100);
    });

    it("parses bare hexadecimal numbers", () => {
      expect(json5Parse("0x1")).toBe(1);
      // The point of the case is that both sides round-trip through the
      // same lossy literal.
      expect(json5Parse("-0x0123456789abcdefABCDEF")).toBe(
        // eslint-disable-next-line no-loss-of-precision
        -0x0123456789abcdefabcdef,
      );
    });
  });

  describe("strings", () => {
    it("parses double quoted strings", () => {
      expect(json5Parse('"abc"')).toBe("abc");
    });

    it("parses single quoted strings", () => {
      expect(json5Parse("'abc'")).toBe("abc");
    });

    it("parses quotes in strings", () => {
      expect(json5Parse(`['"',"'"]`)).toStrictEqual(['"', "'"]);
    });

    it("parses escaped characters", () => {
      expect(
        json5Parse(`'\\b\\f\\n\\r\\t\\v\\0\\x0f\\u01fF\\\n\\\r\n\\\r\\\u2028\\\u2029\\a\\'\\"'`),
      ).toBe("\b\f\n\r\t\v\0\x0f\u01FFa'\"");
    });

    it("reports line and paragraph separators in strings through the Actions log", () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(json5Parse("'\u2028\u2029'")).toBe("\u2028\u2029");
        expect(log).toHaveBeenCalledTimes(2);
        for (const call of log.mock.calls) {
          expect(String(call[0])).toContain("::warning::");
          expect(String(call[0])).toContain("not valid ECMAScript");
        }
      } finally {
        log.mockRestore();
      }
    });
  });

  describe("comments", () => {
    it("parses single-line comments", () => {
      expect(json5Parse("{//comment\n}")).toStrictEqual({});
    });

    it("parses single-line comments at end of input", () => {
      expect(json5Parse("{}//comment")).toStrictEqual({});
    });

    it("parses multi-line comments", () => {
      expect(json5Parse("{/*comment\n** */}")).toStrictEqual({});
    });
  });

  describe("whitespace", () => {
    it("parses whitespace", () => {
      expect(json5Parse("{\t\v\f \u00A0\uFEFF\n\r\u2028\u2029\u2003}")).toStrictEqual({});
    });
  });
});

describe("json5Parse(text, reviver)", () => {
  it("modifies property values", () => {
    expect(json5Parse("{a:1,b:2}", (k, v) => (k === "a" ? "revived" : v))).toStrictEqual({
      a: "revived",
      b: 2,
    });
  });

  it("modifies nested object property values", () => {
    expect(json5Parse("{a:{b:2}}", (k, v) => (k === "b" ? "revived" : v))).toStrictEqual({
      a: { b: "revived" },
    });
  });

  it("deletes property values", () => {
    expect(json5Parse("{a:1,b:2}", (k, v) => (k === "a" ? undefined : v))).toStrictEqual({ b: 2 });
  });

  it("modifies array values", () => {
    expect(json5Parse("[0,1,2]", (k, v) => (k === "1" ? "revived" : v))).toStrictEqual([
      0,
      "revived",
      2,
    ]);
  });

  it("modifies nested array values", () => {
    expect(json5Parse("[0,[1,2,3]]", (k, v) => (k === "2" ? "revived" : v))).toStrictEqual([
      0,
      [1, 2, "revived"],
    ]);
  });

  it("deletes array values", () => {
    expect(json5Parse("[0,1,2]", (k, v) => (k === "1" ? undefined : v))).toStrictEqual(
      // The parser produces a real hole, not an undefined entry.
      [0, , 2], // eslint-disable-line no-sparse-arrays
    );
  });

  it("modifies the root value", () => {
    expect(json5Parse("1", (k, v) => (k === "" ? "revived" : v))).toBe("revived");
  });

  it("sets `this` to the parent value", () => {
    expect(
      json5Parse("{a:{b:2}}", function (k, v) {
        return k === "b" && this.b ? "revived" : v;
      }),
    ).toStrictEqual({ a: { b: "revived" } });
  });
});

describe("diagnostics", () => {
  /** @type {Array<[string, RegExp, number, number, string]>} */
  const cases = [
    ["", /^JSON5: invalid end of input/, 1, 1, "empty documents"],
    ["//a", /^JSON5: invalid end of input/, 1, 4, "documents with only comments"],
    ["/a", /^JSON5: invalid character 'a'/, 1, 2, "incomplete single line comments"],
    ["/*", /^JSON5: invalid end of input/, 1, 3, "unterminated multiline comments"],
    ["/**", /^JSON5: invalid end of input/, 1, 4, "unterminated multiline comment closings"],
    ["a", /^JSON5: invalid character 'a'/, 1, 1, "invalid characters in values"],
    ["{\\a:1}", /^JSON5: invalid character 'a'/, 1, 3, "invalid identifier start escapes"],
    [
      "{\\u0021:1}",
      /^JSON5: invalid identifier character/,
      1,
      2,
      "invalid identifier start characters",
    ],
    ["{a\\a:1}", /^JSON5: invalid character 'a'/, 1, 4, "invalid identifier continue escapes"],
    [
      "{a\\u0021:1}",
      /^JSON5: invalid identifier character/,
      1,
      3,
      "invalid identifier continue characters",
    ],
    ["-a", /^JSON5: invalid character 'a'/, 1, 2, "invalid characters following a sign"],
    [
      ".a",
      /^JSON5: invalid character 'a'/,
      1,
      2,
      "invalid characters following a leading decimal point",
    ],
    [
      "1ea",
      /^JSON5: invalid character 'a'/,
      1,
      3,
      "invalid characters following an exponent indicator",
    ],
    [
      "1e-a",
      /^JSON5: invalid character 'a'/,
      1,
      4,
      "invalid characters following an exponent sign",
    ],
    [
      "0xg",
      /^JSON5: invalid character 'g'/,
      1,
      3,
      "invalid characters following a hexadecimal indicator",
    ],
    ['"\n"', /^JSON5: invalid character '\\n'/, 2, 0, "invalid new lines in strings"],
    ['"', /^JSON5: invalid end of input/, 1, 2, "unterminated strings"],
    [
      "{!:1}",
      /^JSON5: invalid character '!'/,
      1,
      2,
      "invalid identifier start characters in property names",
    ],
    [
      "{a!1}",
      /^JSON5: invalid character '!'/,
      1,
      3,
      "invalid characters following a property name",
    ],
    [
      "{a:1!}",
      /^JSON5: invalid character '!'/,
      1,
      5,
      "invalid characters following a property value",
    ],
    ["[1!]", /^JSON5: invalid character '!'/, 1, 3, "invalid characters following an array value"],
    ["tru!", /^JSON5: invalid character '!'/, 1, 4, "invalid characters in literals"],
    ['"\\', /^JSON5: invalid end of input/, 1, 3, "unterminated escapes"],
    [
      '"\\xg"',
      /^JSON5: invalid character 'g'/,
      1,
      4,
      "invalid first digits in hexadecimal escapes",
    ],
    [
      '"\\x0g"',
      /^JSON5: invalid character 'g'/,
      1,
      5,
      "invalid second digits in hexadecimal escapes",
    ],
    ['"\\u000g"', /^JSON5: invalid character 'g'/, 1, 7, "invalid unicode escapes"],
  ];

  for (let i = 1; i <= 9; i++) {
    cases.push([`'\\${i}'`, /^JSON5: invalid character '\d'/, 1, 3, `escaped digit ${i}`]);
  }

  cases.push(
    ["'\\01'", /^JSON5: invalid character '1'/, 1, 4, "octal escapes"],
    ["1 2", /^JSON5: invalid character '2'/, 1, 3, "multiple values"],
    [
      "\x01",
      /^JSON5: invalid character '\\x01'/,
      1,
      1,
      "control characters escaped in the message",
    ],
    ["{", /^JSON5: invalid end of input/, 1, 2, "unclosed objects before property names"],
    ["{a", /^JSON5: invalid end of input/, 1, 3, "unclosed objects after property names"],
    ["{a:", /^JSON5: invalid end of input/, 1, 4, "unclosed objects before property values"],
    ["{a:1", /^JSON5: invalid end of input/, 1, 5, "unclosed objects after property values"],
    ["[", /^JSON5: invalid end of input/, 1, 2, "unclosed arrays before values"],
    ["[1", /^JSON5: invalid end of input/, 1, 3, "unclosed arrays after values"],
  );

  for (const [text, message, lineNumber, columnNumber, name] of cases) {
    it(`throws on ${name}`, () => {
      const error = parseError(text);
      expect(error).toBeInstanceOf(SyntaxError);
      expect(error.message).toMatch(message);
      expect(error.lineNumber).toBe(lineNumber);
      expect(error.columnNumber).toBe(columnNumber);
    });
  }
});
