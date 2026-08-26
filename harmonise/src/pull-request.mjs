/**
 * The pull request body — action-authored from this run's own records, with
 * exactly one kind of model text inside: the sanitised one-line summaries.
 * Everything else is counts, paths and reasons the deterministic stages
 * produced. Nobody is mentioned; nothing merges itself; the sections are the
 * report a reviewer reads before deciding.
 */

import { sanitiseCommentText } from "#core/sanitise.mjs";

/** @typedef {import("./inventory.mjs").Inventory} Inventory */

/**
 * @typedef {object} PullRequestReport
 * @property {string} sourceLanguage
 * @property {{ lang: string, destinationPath: string, created: boolean, summary: string }[]} proposals
 * @property {{ path: string, lang: string }[]} orphans
 * @property {string[]} skipped reasons per skipped pair, prefixed by language
 * @property {string[]} failures reasons per failed pair
 */

/** How much of any one summary line survives into the body. */
const MAX_SUMMARY_CHARS = 300;

/**
 * @param {PullRequestReport} report
 * @returns {string}
 */
export function buildPullRequestBody(report) {
  /** @type {string[]} */
  const sections = [];

  const drifted = report.proposals.filter((proposal) => !proposal.created);
  const generated = report.proposals.filter((proposal) => proposal.created);

  /** @type {string[]} */
  const summaryLines = [];
  for (const proposal of [...generated, ...drifted]) {
    for (const line of sanitisedLines(proposal.summary)) {
      summaryLines.push(`- \`${proposal.destinationPath}\` [${proposal.lang}] ${line}`);
    }
  }
  sections.push(
    section("What changed", [
      plural(generated.length, "new translation", "new translations") + " generated",
      plural(drifted.length, "existing translation updated", "existing translations updated"),
      "",
      ...(summaryLines.length > 0 ? ["Summaries:", ...summaryLines] : []),
    ]),
  );

  sections.push(
    section(
      "Orphan translations",
      report.orphans.length === 0
        ? ["None."]
        : [
            "These files have no source document under the configured map. They are reported, " +
              "never deleted, renamed or recreated:",
            ...report.orphans.map(
              (orphan) => `- \`${safeLine(orphan.path)}\` [${safeLine(orphan.lang)}]`,
            ),
          ],
    ),
  );

  sections.push(
    section(
      "Skipped pairs",
      report.skipped.length === 0
        ? ["None."]
        : report.skipped.map((reason) => `- ${safeLine(reason)}`),
    ),
  );

  if (report.failures.length > 0) {
    sections.push(
      section("Failed pairs", [
        "The run exits red; these pairs produced no proposal:",
        ...report.failures.map((reason) => `- ${safeLine(reason)}`),
      ]),
    );
  }

  sections.push(
    section("About this pull request", [
      `Authored by the harmonise action: every file is a translation of its ` +
        `${report.sourceLanguage}-language source, kept in step with it. One run builds one ` +
        `branch and one commit; this request is updated in place on every later run.`,
      "Merging is a human decision — the action never merges.",
    ]),
  );

  return sections.join("\n\n");
}

/**
 * One report line — model summary, repository path, or failure reason alike —
 * flattened to safe list text. Paths are attacker-influenced (a filename can
 * carry newlines, backticks and @handles), provider excerpts are outright
 * untrusted, so nothing reaches the body raw.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
function safeLine(text, maxChars = MAX_SUMMARY_CHARS) {
  // Backticks would break out of the code spans these lines live in.
  const tamed = text.replace(/`/g, "'");
  const flat = sanitiseCommentText(tamed.replace(/\s+/g, " ").trim(), { maxChars });
  return flat.text;
}

/**
 * A model summary becomes heading-free, mention-free, single-line list text.
 *
 * @param {string} summary
 * @returns {string[]}
 */
function sanitisedLines(summary) {
  const flat = safeLine(summary);
  if (flat === "") return ["(no summary given)"];
  return [flat];
}

/** @param {string} title @param {string[]} lines @returns {string} */
function section(title, lines) {
  return [`## ${title}`, ...lines].join("\n");
}

/** @param {number} count @param {string} one @param {string} many @returns {string} */
function plural(count, one, many) {
  return `${String(count)} ${count === 1 ? one : many}`;
}
