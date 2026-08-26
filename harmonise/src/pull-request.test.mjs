// Tests for the pull request body builder.
//
// The body is the report a human reads before merging. Two properties are
// pinned: the sections match the specification's list, and NOTHING reaches
// the text raw — model summaries, repository paths and provider excerpts are
// all flattened, mention-broken and comment-stripped, because a filename is
// attacker-influenced input the same way an answer is.

import { describe, expect, it } from "vitest";

import { buildPullRequestBody, renderPullRequestTitle } from "./pull-request.mjs";

/** @param {{ pullRequest?: { title: string } }} [overrides] @returns {any} */
function configWith(overrides = {}) {
  return { sourceLanguage: "en", ...overrides };
}

/** @returns {Parameters<typeof buildPullRequestBody>[0]} */
function baseReport() {
  return {
    sourceLanguage: "en",
    proposals: [],
    orphans: [],
    skipped: [],
    failures: [],
  };
}

describe("buildPullRequestBody", () => {
  it("renders the specification's sections for an empty run", () => {
    const body = buildPullRequestBody(baseReport());

    expect(body).toMatch(/## What changed/);
    expect(body).toMatch(/0 new translations generated/);
    expect(body).toMatch(/## Orphan translations/);
    expect(body).toMatch(/None\./);
    expect(body).toMatch(/## Skipped pairs/);
    expect(body).toMatch(/Merging is a human decision/);
  });

  it("lists new and updated translations with their sanitised summaries", () => {
    const body = buildPullRequestBody({
      ...baseReport(),
      proposals: [
        {
          lang: "vi",
          destinationPath: "manual/vi/dev.md",
          created: true,
          summary: 'first pass <!-- forged --> @team "quoted"',
        },
        {
          lang: "fr",
          destinationPath: "manual/fr/api.md",
          created: false,
          summary: "flag v2 renamed to v3",
        },
      ],
    });

    expect(body).toMatch(/1 new translation generated/);
    expect(body).toMatch(/1 existing translation updated/);
    expect(body).toMatch(
      /- `manual\/vi\/dev\.md` \[vi\] first pass +forged +@\u200Cteam "quoted"/u,
    );
    expect(body).not.toMatch(/<!--/);
    // The zero-width break means nothing in the body notifies anyone.
    expect(body).not.toMatch(/@team/u);
  });

  it("neutralises hostile paths, reasons and provider excerpts", () => {
    const body = buildPullRequestBody({
      ...baseReport(),
      orphans: [{ path: "evil/fr/`x`.md\n## Fake section\n@everyone", lang: "fr" }],
      failures: ["HTTP 500 at https://api.example/x\ninjected\nlog line"],
      skipped: ["vi manual/a.md: past the cap\n## another lie"],
    });

    expect(body).toMatch(/never deleted, renamed or recreated/);
    expect(body).not.toMatch(/\n## Fake section/);
    expect(body).not.toMatch(/@everyone/);
    expect(body).not.toMatch(/`\.`|``x``/); // no raw backtick pair survives into spans
    expect(body).not.toMatch(/injected\nlog line/);
    expect(body).toMatch(/## Skipped pairs/); // the real structure stands alone
  });
});

describe("renderPullRequestTitle", () => {
  it("keeps the built-in convention, pluralized, when no template is configured", () => {
    expect(renderPullRequestTitle(configWith(), 1)).toBe(
      "chore(harmonise): sync 1 document with en",
    );
    expect(renderPullRequestTitle(configWith(), 3)).toBe(
      "chore(harmonise): sync 3 documents with en",
    );
  });

  it("substitutes a custom template's {n} and {sourceLanguage} deterministically", () => {
    const cfg = configWith({
      pullRequest: { title: "docs(i18n): đồng bộ {n} tài liệu từ {sourceLanguage}" },
    });

    expect(renderPullRequestTitle(cfg, 2)).toBe("docs(i18n): đồng bộ 2 tài liệu từ en");
  });

  it("substitutes repeated placeholders and leaves the wording to the template", () => {
    const cfg = configWith({
      pullRequest: { title: "{sourceLanguage}: one document? many! n={n} ({n})" },
    });

    expect(renderPullRequestTitle(cfg, 1)).toBe("en: one document? many! n=1 (1)");
  });

  it("refuses a rendered title past the cap", () => {
    const longWord = "x".repeat(150);
    const cfg = configWith({ pullRequest: { title: `${longWord} ${longWord} {n}` } });

    expect(() => renderPullRequestTitle(cfg, 5)).toThrow(/-character cap/);
  });
});
