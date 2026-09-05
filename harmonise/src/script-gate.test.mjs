import { describe, expect, it } from "vitest";

import { judgeScript } from "./script-gate.mjs";
import { protectDocument } from "./protect.mjs";

describe("judgeScript", () => {
  it("passes a Latin candidate for each Latin-script target", () => {
    expect(judgeScript("# Hướng dẫn\n\nXem [api](api.md).\n", "vi")).toBeNull();
    expect(judgeScript("Hello world.", "en")).toBeNull();
    expect(judgeScript("Bonjour le monde.", "fr")).toBeNull();
    expect(judgeScript("Hallo Welt.", "de")).toBeNull();
    expect(judgeScript("Hola mundo.", "es")).toBeNull();
    expect(judgeScript("Xin chào, đây là câu tiếng Việt.", "vi")).toBeNull();
    expect(judgeScript("Cześć, to jest zdanie.", "pl")).toBeNull();
    expect(judgeScript("Türkçe bir cümle.", "tr")).toBeNull();
    expect(judgeScript("Det här är en mening.", "sv")).toBeNull();
    expect(judgeScript("Tämä on lause.", "fi")).toBeNull();
    expect(judgeScript("Aceasta este o propoziție.", "ro")).toBeNull();
    expect(judgeScript("Ez egy mondat.", "hu")).toBeNull();
  });

  it("passes each non-Latin single-script target", () => {
    expect(judgeScript("Привет мир.", "ru")).toBeNull();
    expect(judgeScript("Привіт світ.", "uk")).toBeNull();
    expect(judgeScript("Здравей свят.", "bg")).toBeNull();
    expect(judgeScript("你好世界。", "zh")).toBeNull();
    expect(judgeScript("สวัสดีชาวโลก", "th")).toBeNull();
    expect(judgeScript("مرحبا بالعالم", "ar")).toBeNull();
    expect(judgeScript("سلام دنیا", "fa")).toBeNull();
    expect(judgeScript("دنیا کی طرف سے سلام", "ur")).toBeNull();
    expect(judgeScript("שלום עולם", "he")).toBeNull();
    expect(judgeScript("Καλημέρα κόσμε", "el")).toBeNull();
    expect(judgeScript("नमस्ते दुनिया", "hi")).toBeNull();
    expect(judgeScript("नमस्कार जग", "mr")).toBeNull();
    expect(judgeScript("नमस्ते संसार", "ne")).toBeNull();
    expect(judgeScript("নমস্কার পৃথিবী", "bn")).toBeNull();
    expect(judgeScript("வணக்கம் உலகம்", "ta")).toBeNull();
    expect(judgeScript("გამარჯობა მსოფლიო", "ka")).toBeNull();
    expect(judgeScript("Բարև աշխարհ", "hy")).toBeNull();
    expect(judgeScript("ሰላም አለም", "am")).toBeNull();
  });

  it("judges the expected scripts as a union for multi-script targets", () => {
    // Japanese: Hiragana, Katakana and Han together satisfy the set; each
    // script alone satisfies it too, because the majority is the union's.
    expect(judgeScript("こんにちは世界。", "ja")).toBeNull();
    expect(judgeScript("カタカナのみの文。", "ja")).toBeNull();
    expect(judgeScript("漢字のみの文章。", "ja")).toBeNull();
    // Korean: Hangul alone passes, as does Hangul with Han mixed in.
    expect(judgeScript("한국어 문장입니다.", "ko")).toBeNull();
    expect(judgeScript("한국어 漢字 혼용 문장.", "ko")).toBeNull();
  });

  it("refuses when the expected scripts fall to exactly half", () => {
    // One Latin letter against one Cyrillic letter: half is not a majority.
    expect(judgeScript("aб", "en")).toBe(
      'script gate: target language "en" requires Latin ' +
        "to hold the majority of the counted letters, but Cyrillic holds 1/2",
    );
  });

  it("passes when the expected scripts hold just over half", () => {
    expect(judgeScript("aaб", "en")).toBeNull();
  });

  it("refuses a majority in a foreign script and names the winner and fraction", () => {
    expect(judgeScript("Hello world", "ja")).toBe(
      'script gate: target language "ja" requires Han, Hiragana or Katakana ' +
        "to hold the majority of the counted letters, but Latin holds 10/10",
    );
  });

  it("refuses the largest foreign script when several are present", () => {
    // Latin 3, Cyrillic 4, against an Arabic target: Cyrillic wins on count.
    expect(judgeScript("абвгabc", "ar")).toBe(
      'script gate: target language "ar" requires Arabic ' +
        "to hold the majority of the counted letters, but Cyrillic holds 4/7",
    );
  });

  it("names an unlisted script when every counted letter is outside the order", () => {
    expect(judgeScript("ᏣᎳᎩᏅ", "hi")).toBe(
      'script gate: target language "hi" requires Devanagari ' +
        "to hold the majority of the counted letters, but an unlisted script holds 4/4",
    );
  });
  it("breaks count ties in the fixed script order", () => {
    // Latin 1, Cyrillic 1, against a Greek target: both are foreign and tie;
    // Cyrillic precedes Latin in the evaluation order, so it is named.
    expect(judgeScript("aб", "el")).toBe(
      'script gate: target language "el" requires Greek ' +
        "to hold the majority of the counted letters, but Cyrillic holds 1/2",
    );
  });

  it("is case-insensitive on the language tag and refuses the primary subtag", () => {
    expect(judgeScript("Hello world", "JA")).toBe(
      'script gate: target language "ja" requires Han, Hiragana or Katakana ' +
        "to hold the majority of the counted letters, but Latin holds 10/10",
    );
  });

  it("does not apply to a subtag absent from the table", () => {
    expect(judgeScript("Hello world", "xx")).toBeNull();
    expect(judgeScript("Привет мир", "zz")).toBeNull();
    expect(judgeScript("Hello world", "")).toBeNull();
    expect(judgeScript("Hello world", "42")).toBeNull();
  });

  it("passes a candidate with zero counted letters", () => {
    expect(judgeScript("# ----\n\n```\n123 456\n```\n\n| a | b |\n", "en")).toBeNull();
    expect(judgeScript("", "ja")).toBeNull();
  });

  it("does not let a real minted token vote", () => {
    // The prose majority is a single letter, so the minted token's own
    // spellings — up to seven Latin letters of hex id and kind — would break
    // the majority with one vote. The pass pins the exclusion against the
    // real minting machinery, not a hand-spelled token.
    const { text } = protectDocument("EcomA の", {
      glossary: ["EcomA"],
    });
    expect(text).toMatch(/\[\[harmonise:[0-9a-f]{16}:g1\]\]/);
    expect(judgeScript(text, "ja")).toBeNull();
  });

  it("passes a token-heavy candidate whose prose carries the target script", () => {
    expect(
      judgeScript(
        "[[harmonise:0123456789abcdef:g1]] 本当 [[harmonise:0123456789abcdef:s1]] " +
          "[[harmonise:0123456789abcdef:f1]] 説明 [[harmonise:0123456789abcdef:g2]]",
        "ja",
      ),
    ).toBeNull();
  });

  it("is byte-deterministic: the same inputs build the same sentence", () => {
    const first = judgeScript("Hello world", "ko");
    const second = judgeScript("Hello world", "ko");
    expect(first).toBe(second);
    expect(first).toBe(
      'script gate: target language "ko" requires Hangul or Han ' +
        "to hold the majority of the counted letters, but Latin holds 10/10",
    );
  });
});
