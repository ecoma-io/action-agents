// Tests for check-readme-langs.mjs.
//
// `inspectDocument`, `selectorLinks` and `evaluate` take every fact they need
// as an argument, so these run with no filesystem. `readFacts` and `main` are
// deliberately not tested: they exist to read real paths, and a test that
// stubbed them would only pin the stub.
//
// The cases that matter are the drifts the harmonise run itself cannot see:
// a selector edited in one translation, a language configured without its
// document, a twin nobody configured, and a "translation" of the protected
// header — the corruption a later run would preserve rather than repair.

import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluate, inspectDocument, selectorLinks } from "./check-readme-langs.mjs";

const BADGES = [
  "<!-- harmonise:skip-start -->",
  '<p align="center">',
  '  <a href="https://github.com/ecoma-io/action-agents"><img src="badge.svg" alt="CI" /></a>',
  "</p>",
  "<!-- harmonise:skip-end -->",
].join("\n");

/** @param {string[]} links @returns {string} */
const selector = (links) =>
  [
    "<!-- harmonise:skip-start -->",
    links.map((l) => `<a href="${l}">${l}</a>`).join(" | "),
    "<!-- harmonise:skip-end -->",
  ].join("\n");

const EN_SELECTOR = selector(["README.md", "README.vi.md"]);
const VI_SELECTOR = selector(["README.md", "README.vi.md"]);

/** @param {string} header @returns {string} */
const readme = (header) => `${header}\n# Action Agents\n\nKeep repositories in step.\n`;

const LANGUAGES = { en: "{document}.md", vi: "{document}.vi.md" };

/** @returns {{ configPath: string, languages: Record<string, string>, sourceLanguage: string, documents: { path: string, text: string }[] }} */
function facts(documents, languages = LANGUAGES) {
  return { configPath: "harmonise.json5", languages, sourceLanguage: "en", documents };
}

test("a set that agrees passes", () => {
  const result = evaluate(
    facts([
      { path: "README.md", text: readme(`${BADGES}\n\n${EN_SELECTOR}`) },
      { path: "README.vi.md", text: readme(`${BADGES}\n\n${VI_SELECTOR}`) },
    ]),
  );

  assert.deepEqual(result.failures, []);
  assert.equal(result.checked, 2);
});

test("a selector edited in one translation is caught as region drift", () => {
  const result = evaluate(
    facts([
      { path: "README.md", text: readme(`${BADGES}\n\n${EN_SELECTOR}`) },
      {
        path: "README.vi.md",
        text: readme(`${BADGES}\n\n${selector(["README.md", "README.ja.md"])}`),
      },
    ]),
  );

  assert.match(result.failures[0], /^README\.vi\.md: protected region 2 differs/);
});

test("a configured language without its document is named", () => {
  const result = evaluate(
    facts([{ path: "README.md", text: readme(`${BADGES}\n\n${EN_SELECTOR}`) }]),
  );

  assert.deepEqual(result.failures, [
    "README.vi.md: language 'vi' is configured, but the document does not exist",
  ]);
});

test("a README twin no language claims is named", () => {
  const result = evaluate(
    facts([
      { path: "README.md", text: readme(`${BADGES}\n\n${EN_SELECTOR}`) },
      { path: "README.vi.md", text: readme(`${BADGES}\n\n${VI_SELECTOR}`) },
      { path: "README.ko.md", text: readme(`${BADGES}\n\n${VI_SELECTOR}`) },
    ]),
  );

  assert.deepEqual(result.failures, ["README.ko.md: a README twin no configured language claims"]);
});

test("a selector whose order disagrees with the configuration is caught", () => {
  const reordered = selector(["README.vi.md", "README.md"]);
  const result = evaluate(
    facts([
      { path: "README.md", text: readme(`${BADGES}\n\n${EN_SELECTOR}`) },
      { path: "README.vi.md", text: readme(`${BADGES}\n\n${reordered}`) },
    ]),
  );

  assert.ok(
    result.failures.some((f) =>
      f.includes("the selector's language order disagrees with harmonise.json5"),
    ),
  );
});

test("a selector that links a language twice is caught", () => {
  const duplicated = selector(["README.md", "README.vi.md", "README.vi.md"]);
  const result = evaluate(
    facts([
      { path: "README.md", text: readme(`${BADGES}\n\n${EN_SELECTOR}`) },
      { path: "README.vi.md", text: readme(`${BADGES}\n\n${duplicated}`) },
    ]),
  );

  assert.ok(result.failures.some((f) => f.includes("links README.vi.md twice")));
});

test("an unknown whole-line harmonise comment is an error, not a shrug", () => {
  const result = evaluate(
    facts([
      {
        path: "README.md",
        text: readme(`${BADGES}\n\n${EN_SELECTOR}\n\n<!-- harmonise:ignore:badges -->`),
      },
      { path: "README.vi.md", text: readme(`${BADGES}\n\n${VI_SELECTOR}`) },
    ]),
  );

  assert.ok(result.failures.some((f) => f.includes("not a directive this action accepts")));
});

test("an unclosed region is an error", () => {
  const result = evaluate(
    facts([
      { path: "README.md", text: readme("<!-- harmonise:skip-start -->\nbadges") },
      { path: "README.vi.md", text: readme(`${BADGES}\n\n${VI_SELECTOR}`) },
    ]),
  );

  assert.ok(result.failures.some((f) => f.includes("never closed")));
});

test("a set whose regions never link the source document has no selector", () => {
  const noSelector = selector(["README.vi.md"]);
  const result = evaluate(
    facts([
      { path: "README.md", text: readme(`${BADGES}\n\n${noSelector}`) },
      { path: "README.vi.md", text: readme(`${BADGES}\n\n${noSelector}`) },
    ]),
  );

  assert.ok(result.failures.some((f) => f.includes("no selector exists")));
});

test("a lone skip directive forms a region of itself and the next non-blank line", () => {
  const { regions, errors } = inspectDocument("<!-- harmonise:skip -->\nkept line\n", "README.md");

  assert.deepEqual(errors, []);
  assert.deepEqual(
    regions.map((r) => r.content),
    ["<!-- harmonise:skip -->\nkept line"],
  );
});

test("comment-like text inside a fence is content, not a directive", () => {
  const { regions, errors } = inspectDocument(
    "```markdown\n<!-- harmonise:skip-start -->\n```\n\n<!-- harmonise:skip-start -->\nkept\n<!-- harmonise:skip-end -->\n",
    "README.md",
  );

  assert.deepEqual(errors, []);
  assert.equal(regions.length, 1);
});

test("two consecutive lone skips yield two regions, the first not erased", () => {
  const { regions, errors } = inspectDocument(
    "<!-- harmonise:skip -->\nfirst\n<!-- harmonise:skip -->\nsecond\n",
    "README.md",
  );

  assert.deepEqual(errors, []);
  assert.equal(regions.length, 2);
});

test("selector links arrive in document order with external targets dropped", () => {
  const content = [
    "<!-- harmonise:skip-start -->",
    '<a href="https://ecoma.io">Site</a> | <a href="README.md">English</a> | [Tiếng Việt](README.vi.md "Vietnamese")',
    "<!-- harmonise:skip-end -->",
  ].join("\n");

  assert.deepEqual(selectorLinks(content), ["README.md", "README.vi.md"]);
});

test("the source language must resolve to README.md", () => {
  const result = evaluate(
    facts([{ path: "README.md", text: readme(`${BADGES}\n\n${EN_SELECTOR}`) }], {
      en: "docs/{document}.md",
    }),
  );

  assert.ok(
    result.failures.some((f) => f.includes("the source language must resolve to README.md")),
  );
});

test("two languages resolving to one path are named", () => {
  const result = evaluate(
    facts([{ path: "README.md", text: readme(`${BADGES}\n\n${EN_SELECTOR}`) }], {
      en: "{document}.md",
      vi: "{document}.md",
    }),
  );

  assert.ok(result.failures.some((f) => f.includes("both resolve to README.md")));
});

test("two lone skips settling on one line are one merged region", () => {
  const { regions, errors } = inspectDocument(
    "<!-- harmonise:skip -->\n<!-- harmonise:skip -->\ntarget\n",
    "README.md",
  );

  assert.deepEqual(errors, []);
  assert.equal(regions.length, 1);
  assert.equal(regions[0].content, "<!-- harmonise:skip -->\n<!-- harmonise:skip -->\ntarget");
});

test("a lone skip whose target is fenced is refused like the run refuses it", () => {
  const { errors } = inspectDocument("<!-- harmonise:skip -->\n\n```\nblock\n```\n", "README.md");

  assert.ok(errors.some((e) => e.includes("would target a fenced code block")));
});

test("an indented fence no longer hides a diverging badges region", () => {
  const indent = "    ```\nindented, not fenced\n";
  const edited = BADGES.replace("badge.svg", "renamed.svg");
  const result = evaluate(
    facts([
      { path: "README.md", text: readme(`${indent}\n${BADGES}\n\n${EN_SELECTOR}`) },
      { path: "README.vi.md", text: readme(`${indent}\n${edited}\n\n${VI_SELECTOR}`) },
    ]),
  );

  assert.ok(result.failures.some((f) => f.includes("protected region 1 differs")));
});

test("a third protected region cannot ride along byte-identical", () => {
  const extra =
    '<!-- harmonise:skip-start -->\n<a href="docs/README.ko.md">Fake</a>\n<!-- harmonise:skip-end -->';
  const result = evaluate(
    facts([
      { path: "README.md", text: readme(`${BADGES}\n\n${EN_SELECTOR}\n\n${extra}`) },
      { path: "README.vi.md", text: readme(`${BADGES}\n\n${VI_SELECTOR}\n\n${extra}`) },
    ]),
  );

  assert.ok(result.failures.some((f) => f.includes("exactly 2 regions")));
});

test("a lone-skip header leaves the badges outside the convention's shape", () => {
  const loneBadges = '<!-- harmonise:skip -->\n<p align="center">badges</p>';
  const result = evaluate(
    facts([
      { path: "README.md", text: readme(`${loneBadges}\n\n${EN_SELECTOR}`) },
      { path: "README.vi.md", text: readme(`${loneBadges}\n\n${VI_SELECTOR}`) },
    ]),
  );

  assert.ok(result.failures.some((f) => f.includes("carries no badge image")));
});

test("a dead document link cannot hide inside the badges region", () => {
  const carrying = BADGES.replace("</p>", '  <a href="docs/README.ko.md">Extra</a>\n</p>');
  const result = evaluate(
    facts([
      { path: "README.md", text: readme(`${carrying}\n\n${EN_SELECTOR}`) },
      { path: "README.vi.md", text: readme(`${carrying}\n\n${VI_SELECTOR}`) },
    ]),
  );

  assert.ok(result.failures.some((f) => f.includes("the badges region links 'docs/README.ko.md'")));
});
