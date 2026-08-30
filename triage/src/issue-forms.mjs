// The issue-form reader: what the repository's `.github/ISSUE_TEMPLATE` forms
// declare, and how a body measures against them.
//
// Everything here is deterministic — no model, and no network once the
// template files have been read — so the quality facts produced are code
// facts, the same class as the measured size. The model judges quality too
// (the QUALITY dimension), but what this module decides is never overridden
// by a model choice: a required field that is empty is a missing-evidence
// fact whether or not the model noticed it.
//
// The YAML reader is a deliberate subset, not a YAML parser: the forms this
// action reads are GitHub issue forms, whose surface is `name:` at the top and
// a `body:` list of typed items with `id:`, `attributes.label:` and
// `validations.required:`. A template that does not parse as that subset is
// skipped, never guessed at — a malformed template must not corrupt the
// quality facts of every issue filed through the chooser.

/**
 * @typedef {object} IssueFormField
 * @property {string} id the form item's id
 * @property {string} label the heading GitHub renders the field under
 * @property {boolean} required whether the field is mandatory
 */

/**
 * @typedef {object} IssueForm
 * @property {string} id the template file's basename without extension
 * @property {string} name the form's `name:`
 * @property {IssueFormField[]} fields the interactive fields, in file order
 */

/**
 * The most template files one issue may be assessed against. The policy's
 * form-id routing keys and the missing-required evidence are read from these,
 * so the read is capped like every other resource surface; `templatesOverflow`
 * tells the caller a template was not read.
 */
export const MAX_ISSUE_FORMS = 8;

/**
 * Whether a body section matches a field label. GitHub renders each form
 * answer under a `### <label>` heading, so an exact heading match with
 * non-empty content is the one definition of "present" — close is not
 * present, matching the action's exactness doctrine.
 *
 * @param {string} label
 * @param {string} content
 */
function isPresent(label, content) {
  return content.trim() !== "";
}

/**
 * The body's `### ` sections: heading and the text under it, in order.
 *
 * @param {string} body
 * @returns {Array<{ heading: string, content: string }>}
 */
export function splitSections(body) {
  /** @type {Array<{ heading: string, content: string[] }>} */
  const sections = [];
  /** @type {{ heading: string, content: string[] } | null} */
  let current = null;
  for (const line of String(body).split(/\r?\n/)) {
    const heading = line.match(/^###\s+(.+?)\s*$/);
    if (heading !== null) {
      current = { heading: /** @type {string} */ (heading[1]).trim(), content: [] };
      sections.push(current);
    } else if (current !== null) {
      current.content.push(line);
    }
  }
  return sections.map((section) => ({
    heading: section.heading,
    content: section.content.join("\n"),
  }));
}

/**
 * How many urls the body carries — one of the two body-shape facts (body
 * length is the other). A report that mentions nothing linkable and one that
 * is a list of links are different shapes to assess.
 *
 * @param {string} body
 */
export function countUrls(body) {
  const matches = String(body).match(/https?:\/\/[^\s"'<>)\]]+/g);
  return matches === null ? 0 : matches.length;
}

/** @param {string} value */
function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse one template file into the subset an issue can be assessed against.
 * Returns `null` when the file is not a form this subset understands — a
 * missing `name:`, a missing `body:` list, or no interactive items — so the
 * caller can skip it deterministically.
 *
 * @param {string} yaml
 * @returns {Omit<IssueForm, "id"> | null}
 */
export function parseIssueForm(yaml) {
  if (typeof yaml !== "string") return null;
  const lines = yaml.split(/\r?\n/);

  let name = null;
  for (let i = 0; i < lines.length; i += 1) {
    const match = String(lines[i] ?? "").match(/^name:\s*(\S.*?)\s*$/);
    if (match !== null) {
      name = unquote(/** @type {string} */ (match[1]));
      break;
    }
  }
  if (name === null) return null;
  const bodyAt = lines.findIndex((line) => /^body:\s*$/.test(line));
  if (bodyAt === -1) return null;

  /**
   * @typedef {object} ParsedItem
   * @property {string | null} id
   * @property {string | null} label
   * @property {string} type
   * @property {boolean} required
   * @property {boolean} optionRequired
   */
  /** @type {ParsedItem[]} */
  const items = [];
  /** @type {ParsedItem | null} */
  let current = null;
  for (let i = bodyAt + 1; i < lines.length; i += 1) {
    const line = /** @type {string} */ (lines[i] ?? "");
    const item = line.match(/^ {2}- type: (\S+)\s*$/);
    if (item !== null) {
      if (current !== null) items.push(current);
      current = {
        id: null,
        label: null,
        type: /** @type {string} */ (item[1]),
        required: false,
        optionRequired: false,
      };
      continue;
    }
    if (current === null) continue;

    const id = line.match(/^ {4}id: (\S+)\s*$/);
    if (id !== null) {
      current.id = /** @type {string} */ (id[1]);
      continue;
    }
    // The label directly under `attributes:` — six spaces. An option's
    // `- label:` sits eight spaces deep and must not be mistaken for it.
    const label = line.match(/^ {6}label: (.+?)\s*$/);
    if (label !== null) {
      current.label = unquote(/** @type {string} */ (label[1]));
      continue;
    }
    // The item's own required flag, under `validations:` — six spaces.
    const required = line.match(/^ {6}required: (true|false)\s*$/);
    if (required !== null) {
      current.required = required[1] === "true";
      continue;
    }
    // A checkboxes item is required when any of its options is. Options sit
    // ten spaces deep.
    if (/^ {10}required: true\s*$/.test(line)) {
      current.optionRequired = true;
    }
  }
  if (current !== null) items.push(current);

  const fields = items
    .filter((item) => item.id !== null && item.label !== null)
    .map((item) => ({
      id: /** @type {string} */ (item.id),
      label: /** @type {string} */ (item.label),
      required: item.type === "checkboxes" ? item.optionRequired : item.required,
    }));

  if (fields.length === 0) return null;
  return { name, fields };
}

/**
 * Read the repository's issue-form templates at the pinned policy SHA: the
 * `.github/ISSUE_TEMPLATE` `*.yml`/`*.yaml` files, in path order, capped at
 * `MAX_ISSUE_FORMS`, each read through the pinned policy reader and parsed.
 * A template that cannot be read or parsed is skipped — the forms that do
 * parse are the evidence; `templatesOverflow` records when the cap cut the
 * list off.
 *
 * @param {object} input
 * @param {{ listTree: (sha: string) => Promise<Array<{ path: string }>> }} input.forge
 * @param {{ getContents: (path: string) => Promise<{ content: string } | null> }} input.policy
 * @param {{ sha: string }} input.source
 */
export async function loadIssueForms({ forge, policy, source }) {
  const entries = await forge.listTree(source.sha);
  const paths = entries
    .map((entry) => entry.path)
    .filter((path) => path.startsWith(".github/ISSUE_TEMPLATE/"))
    .filter((path) => /\.ya?ml$/.test(path))
    .filter((path) => !/config\.ya?ml$/.test(path))
    .sort();

  const templatesOverflow = paths.length > MAX_ISSUE_FORMS;
  /** @type {IssueForm[]} */
  const forms = [];
  for (const path of paths.slice(0, MAX_ISSUE_FORMS)) {
    const file = await policy.getContents(path);
    if (file === null) continue;
    const parsed = parseIssueForm(file.content);
    if (parsed === null) continue;
    const base = path.split("/").pop() ?? "";
    const id = base.replace(/\.ya?ml$/, "");
    forms.push({ id, ...parsed });
  }
  return { forms, templatesOverflow };
}

/**
 * Assess one issue body against the repository's parsed forms.
 *
 * The best template is the one whose field headings the body matches most —
 * a body filed through the form renders a `### <label>` heading per answer,
 * so the body's own section headings name the form it came from. No form
 * matched (zero headings in common) means `template: null`: the form cannot
 * be known, so no required field can be called missing.
 *
 * @param {string} body
 * @param {IssueForm[]} forms
 * @param {{ templatesOverflow?: boolean }} [options]
 */
export function assessIssueForm(body, forms, options = {}) {
  const sections = splitSections(body);

  /** @type {Array<{ id: string, name: string, matched: Array<{ label: string, present: boolean, required: boolean }>, score: number }>} */
  const candidates = [];
  for (const form of forms) {
    const matched = form.fields.map((field) => ({
      label: field.label,
      present: sections.some(
        (section) => section.heading === field.label && isPresent(field.label, section.content),
      ),
      required: field.required,
    }));
    const score = matched.filter((entry) => entry.present).length;
    if (score > 0) candidates.push({ id: form.id, name: form.name, matched, score });
  }

  let best = null;
  for (const candidate of candidates) {
    if (best === null || candidate.score > best.score) best = candidate;
  }

  const template = best === null ? null : { id: best.id, name: best.name };
  const missingRequired =
    best === null
      ? []
      : best.matched
          .filter((entry) => entry.required && !entry.present)
          .map((entry) => entry.label);

  return {
    template,
    fieldsPresent: best === null ? [] : best.matched,
    missingRequired,
    bodyLength: String(body).length,
    urlCount: countUrls(body),
    templatesOverflow: options.templatesOverflow ?? false,
  };
}
