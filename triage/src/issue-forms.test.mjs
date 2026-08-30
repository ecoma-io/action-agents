// Tests for the issue-form reader. The fixtures are the repository's own
// `.github/ISSUE_TEMPLATE` files — a parser tested against forms that are not
// the ones it ships with would pin the parser, not the surface it parses.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  MAX_ISSUE_FORMS,
  assessIssueForm,
  countUrls,
  loadIssueForms,
  parseIssueForm,
  splitSections,
} from "./issue-forms.mjs";

/** @param {string} name */
function template(name) {
  return readFileSync(new URL(`../../.github/ISSUE_TEMPLATE/${name}`, import.meta.url), "utf8");
}

describe("parseIssueForm", () => {
  it("parses the repository's real bug report form", () => {
    const form = parseIssueForm(template("bug_report.yml"));
    expect(form).not.toBeNull();
    expect(form?.name).toBe("Bug report");
    const labels = form?.fields.map((field) => field.label);
    expect(labels).toEqual([
      "Before filing",
      "Which action",
      "What happens",
      "What should happen instead",
      "Your workflow file",
      "Run log",
      "Where does it go wrong?",
      "Provider",
      "Environment",
      "Anything else",
    ]);
    const required = form?.fields.filter((field) => field.required).map((field) => field.label);
    expect(required).toEqual([
      "Before filing",
      "Which action",
      "What happens",
      "What should happen instead",
      "Your workflow file",
      "Where does it go wrong?",
      "Provider",
      "Environment",
    ]);
    // A checkbox's requirement lives on its options; the two optional
    // checkbox items stay optional.
    expect(form?.fields.find((field) => field.label === "Anything else")?.required).toBe(false);
    expect(form?.fields.find((field) => field.label === "Run log")?.required).toBe(false);
  });

  it("parses the repository's real feature request form", () => {
    const form = parseIssueForm(template("feature_request.yml"));
    expect(form?.name).toBe("Feature request");
    const required = form?.fields.filter((field) => field.required).map((field) => field.label);
    expect(required).toEqual([
      "Before filing",
      "Which action",
      "What problem does this solve?",
      "What you are proposing",
      "Does this hold for languages neither of us has thought about?",
      "Does this still help someone on a weak or keyless model?",
    ]);
  });

  it("parses the repository's real question form", () => {
    const form = parseIssueForm(template("question.yml"));
    expect(form?.name).toBe("Question");
    const required = form?.fields.filter((field) => field.required).map((field) => field.label);
    expect(required).toEqual(["Before asking", "Which action", "What are you trying to do?"]);
  });

  it("refuses the chooser config, which is not a form", () => {
    expect(parseIssueForm(template("config.yml"))).toBeNull();
  });

  it("refuses text that is not a form at all", () => {
    expect(parseIssueForm("labels: {}\n")).toBeNull();
    expect(parseIssueForm("")).toBeNull();
  });

  it("ignores a form field that never gained an id or label", () => {
    const form = parseIssueForm(
      "name: Odd\nbody:\n" +
        "  - type: textarea\n    attributes:\n      label: No id\n" +
        "  - type: textarea\n    id: has-id\n    attributes:\n      label: Complete\n",
    );
    expect(form?.fields.map((field) => field.id)).toEqual(["has-id"]);
  });
});

describe("splitSections and countUrls", () => {
  it("splits a body into its ### sections", () => {
    expect(splitSections("### One\ntext\n\n### Two\ntext 2")).toEqual([
      { heading: "One", content: "text\n" },
      { heading: "Two", content: "text 2" },
    ]);
  });

  it("keeps a body with no headings as one sectionless stream", () => {
    expect(splitSections("plain text")).toEqual([]);
  });

  it("counts urls, excluding none of the common delimiters", () => {
    expect(countUrls("See https://github.com/o/r/issues/1 (and https://e.com/a?b=c).")).toBe(2);
    expect(countUrls("no links here")).toBe(0);
  });
});

describe("assessIssueForm", () => {
  /** @type {import("./issue-forms.mjs").IssueForm[]} */
  const forms = [
    {
      id: "bug_report",
      .../** @type {Omit<import("./issue-forms.mjs").IssueForm, "id">} */ (
        /** @type {unknown} */ (parseIssueForm(template("bug_report.yml")))
      ),
    },
    {
      id: "feature_request",
      .../** @type {Omit<import("./issue-forms.mjs").IssueForm, "id">} */ (
        /** @type {unknown} */ (parseIssueForm(template("feature_request.yml")))
      ),
    },
  ];
  const BUG = /** @type {import("./issue-forms.mjs").IssueForm} */ (forms[0]);

  it("names the form a bug-report body came through, and its missing required fields", () => {
    const fact = assessIssueForm(
      [
        "### What happens",
        "The action crashes on import.",
        "",
        "### Which action",
        "triage",
        "",
        "### Environment",
        "- Action version (the ref in `uses:`): v0.1",
      ].join("\n"),
      forms,
    );
    expect(fact.template).toEqual({ id: "bug_report", name: "Bug report" });
    expect(fact.missingRequired).toEqual([
      "Before filing",
      "What should happen instead",
      "Your workflow file",
      "Where does it go wrong?",
      "Provider",
    ]);
    expect(fact.fieldsPresent.find((entry) => entry.label === "What happens")).toEqual({
      label: "What happens",
      present: true,
      required: true,
    });
    expect(fact.fieldsPresent.find((entry) => entry.label === "Run log")).toEqual({
      label: "Run log",
      present: false,
      required: false,
    });
  });

  it("calls nothing missing when every required field is answered", () => {
    const answered = BUG.fields
      .filter((field) => field.required)
      .map((field) => `### ${field.label}\nanswer\n`)
      .join("\n");
    const fact = assessIssueForm(answered, forms);
    expect(fact.template?.name).toBe("Bug report");
    expect(fact.missingRequired).toEqual([]);
  });

  it("chooses the form with the most matched headings on ties by file order", () => {
    const shared = ["### Which action", "triage", "### What happens", "boom"].join("\n");
    const fact = assessIssueForm(shared, forms);
    // feature_request also has "Which action" but not "What happens" — the
    // bug form wins on score.
    expect(fact.template).toEqual({ id: "bug_report", name: "Bug report" });
  });

  it("reports no template when no heading matches any form", () => {
    const fact = assessIssueForm("### Something out of the forms\nno idea.", forms);
    expect(fact.template).toBeNull();
    expect(fact.missingRequired).toEqual([]);
    expect(fact.fieldsPresent).toEqual([]);
  });

  it("reports the body shape facts and passes overflow through", () => {
    const fact = assessIssueForm(
      "### One\nSee https://example.com/a https://example.com/b\n",
      forms,
      { templatesOverflow: true },
    );
    expect(fact.bodyLength).toBe(56);
    expect(fact.urlCount).toBe(2);
    expect(fact.templatesOverflow).toBe(true);
  });

  it("is deterministic on identical input", () => {
    const body = "### What happens\ncrash\n";
    expect(assessIssueForm(body, forms)).toEqual(assessIssueForm(body, forms));
  });
});

describe("loadIssueForms", () => {
  it("reads, parses and ids the template files at the pinned sha, capped", async () => {
    const paths = [
      ".github/ISSUE_TEMPLATE/feature_request.yml",
      ".github/ISSUE_TEMPLATE/bug_report.yml",
      ".github/ISSUE_TEMPLATE/config.yml",
      ".github/ISSUE_TEMPLATE/question.yml",
    ];
    const forge = {
      async listTree() {
        return paths.map((path) => ({ path, type: "blob" }));
      },
    };
    const policy = {
      /** @param {string} path */
      async getContents(path) {
        return { content: template(path.split("/").pop() ?? "") };
      },
    };

    const { forms, templatesOverflow } = await loadIssueForms({
      forge,
      policy,
      source: { sha: "0123456789abcdef" },
    });

    expect(templatesOverflow).toBe(false);
    expect(forms.map((form) => form.id)).toEqual(["bug_report", "feature_request", "question"]);
    expect(forms.find((form) => form.id === "bug_report")?.name).toBe("Bug report");
  });

  it("records overflow when the cap cuts the template list", async () => {
    const many = Array.from({ length: MAX_ISSUE_FORMS + 3 }, (_, index) => ({
      path: `.github/ISSUE_TEMPLATE/form-${String(index).padStart(2, "0")}.yml`,
    }));
    const forge = {
      async listTree() {
        return many;
      },
    };
    const policy = {
      async getContents() {
        return null;
      },
    };

    const { forms, templatesOverflow } = await loadIssueForms({
      forge,
      policy,
      source: { sha: "sha" },
    });
    // Every form read is unreadable here; the overflow fact is about the
    // read, not the parse, so it still records the cap.
    expect(templatesOverflow).toBe(true);
    expect(forms).toEqual([]);
  });
});
