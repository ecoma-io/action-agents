/**
 * The prompt, assembled in one order, every layer after the first optional
 * — `docs/development/triage.md`'s five layers:
 *
 * ```text
 * 1  system    the task, the output contract, the thread type, the
 *              repository's name and description, the title
 * 2  custom    the instruction document, if it exists
 * 3  type      issue-instruction or pr-instruction, if it exists
 * 4  sheet     the effective labels, each with its gloss
 * 5  evidence  the body — and for a PR, the diff stats — wrapped as evidence
 * ```
 *
 * Layer 5 is framed by `core/untrusted.mjs`: content an answer may be drawn
 * from, never instruction to act on. No ceiling rests on that framing —
 * whatever the prompt says, the answer is matched exactly against the sheet
 * downstream — but one code path fixes how untrusted content may appear, and
 * this is it: the action never frames evidence its own way.
 */

/** @typedef {import("#core/chat.mjs").ChatMessage} ChatMessage */
/** @typedef {import("#core/untrusted.mjs").Evidence} Evidence */

/**
 * @typedef {object} Thread
 * @property {"issue" | "pr"} type
 * @property {string} title
 * @property {string} body
 */

/**
 * @typedef {object} PromptInput
 * @property {Thread} thread
 * @property {{ name: string, description: string }} repository
 * @property {Map<string, string> | null} sheet null when there is no sheet — the classification is the comment
 * @property {{ instruction?: string, typeInstruction?: string }} documents
 * @property {{ filename: string, additions: number, deletions: number }[]} files the PR's files, for the diff-stats evidence
 * @property {Evidence} evidence the untrusted-content wrapper
 * @property {import("./evidence.mjs").QualityFacts | null} quality the deterministic issue-form facts, null for a PR run
 * @property {import("./evidence.mjs").ForgeSearchFacts | null} forgeSearch the bounded search facts, null when no search ran
 * @property {import("./config.mjs").TriageConfig | null} policy the validated config — its severity/routing vocabulary only
 */

/**
 * Assembles the messages for one chat request.
 *
 * @param {PromptInput} input
 * @returns {{ messages: ChatMessage[] }}
 */
export function buildPrompt(input) {
  const system = [
    layerTask(input),
    input.documents.instruction,
    input.documents.typeInstruction,
    layerDimensions(input),
    layerSheet(input),
  ]
    .filter((layer) => layer !== undefined && layer !== "")
    .join("\n\n");

  /** @type {ChatMessage[]} */
  const messages = [{ role: "system", content: system }];

  const evidence = [
    input.evidence.wrap("title", input.thread.title),
    input.evidence.wrap("thread-body", input.thread.body),
  ];
  if (input.thread.type === "pr" && input.files.length > 0) {
    evidence.push(input.evidence.wrap("diff-stats", diffStats(input.files)));
  } else if (input.sheet !== null && input.thread.type === "issue") {
    evidence.push(...userEvidence(input));
  }
  messages.push({ role: "user", content: evidence.join("\n\n") });

  return { messages };
}

/**
 * Layer 4.5, present on a sheet-mode issue run only: the stable facts the
 * model assesses against — the issue form the body came through (trusted),
 * and the candidates the bounded search found (untrusted titles, wrapped).
 * The model's answers to these are the evaluator dimensions; the numbers
 * below are the ceiling — a candidate beyond the search cap is never seen.
 *
 * @param {PromptInput} input
 * @returns {string | undefined}
 */
function layerDimensions(input) {
  if (input.sheet === null || input.thread.type !== "issue") return undefined;
  const lines = [
    "Answer the issue-side dimensions too, as part of the same JSON:",
    '- quality: { "completeness": "complete" | "missing-evidence", "missing": ["<field>", …], "weak": ["<field>", …], "confidence": <0..1 or null> } — completeness is missing-evidence when a required field is empty or the reproduction cannot be followed',
  ];
  const severityKeys = [...(input.policy?.labels.priority.keys() ?? [])];
  if (severityKeys.length > 0) {
    lines.push(
      `- priority: { "severity": "${severityKeys.join('" | "')}" | null, "confidence": <0..1 or null> }`,
    );
  }
  const types = ["duplicate", "related", "likely-resolves", "supersedes", "similar"];
  lines.push(
    `- relationships: { "candidates": [{ "index": <n>, "type": "${types.join(
      '" | "',
    )}", "confidence": <0..1 or null>, "evidence": "<one line>" }], … } — index is the position in the candidate list below; judge each candidate you can; empty list when nothing relates`,
  );
  return lines.join("\n");
}

/**
 * The trusted form facts and the untrusted candidate list a sheet-mode issue
 * user message carries. Form facts are code facts (rendered directly, no
 * wrapping — they could not carry author prose); candidates are author prose
 * (wrapped) that the model may judge, never act on.
 *
 * @param {PromptInput} input
 * @returns {string[]}
 */
function userEvidence(input) {
  /** @type {string[]} */
  const blocks = [];
  if (input.quality !== null && input.quality !== undefined) {
    const lines = [
      "The issue form facts (code-measured):",
      input.quality.template === null
        ? "- no matching issue form"
        : `- matched form: ${input.quality.template.name}`,
      input.quality.missingRequired.length === 0
        ? "- all required fields present"
        : `- missing required: ${input.quality.missingRequired.join(", ")}`,
      `- body ${String(input.quality.bodyLength)} chars, ${String(input.quality.urlCount)} urls`,
    ];
    blocks.push(lines.join("\n"));
  }
  if (
    input.forgeSearch !== null &&
    input.forgeSearch !== undefined &&
    input.forgeSearch.candidates.length > 0
  ) {
    const lines = ["Open issues in this repository (candidates):"];
    input.forgeSearch.candidates.forEach((candidate, index) => {
      lines.push(
        input.evidence.wrap(
          `candidate-${String(index)}`,
          `#${String(candidate.number)} — ${candidate.title}`,
        ),
      );
    });
    if (input.forgeSearch.totalCount > input.forgeSearch.cappedAt) {
      lines.push(
        `(${String(input.forgeSearch.totalCount)} candidates total — only these ${String(
          input.forgeSearch.cappedAt,
        )} are offered)`,
      );
    }
    blocks.push(lines.join("\n"));
  }
  return blocks;
}
/**
 * Layer 1, always present: the task, the output contract, the thread type,
 * the repository, the title.
 *
 * @param {PromptInput} input
 * @returns {string}
 */
function layerTask(input) {
  const kind = input.thread.type === "issue" ? "issue" : "pull request";
  const lines = [
    `You triage a ${kind} in the repository '${repositoryLine(input.repository)}'.`,
    input.sheet === null
      ? 'Answer with JSON only, no prose: {"classification": "<one line naming what this is>", "rationale": "<one line saying why"}.'
      : 'Answer with JSON only, no prose: {"labels": ["<name>", …], "rationale": "<one line>"}. Choose labels only from the sheet below; choose none if none fit.',
  ];
  if (input.thread.type === "pr") {
    // The bounded semantic judgement only a reader can give: whether the
    // title/body obviously mismatch the diff's scope, and how well the
    // description carries the change. Everything else about a PR is computed
    // deterministically in code and never asked of the model.
    lines.push(
      'Also answer, for this pull request only: {"pr": {"scope": {"obviousMismatch": <true|false>}, "readiness": {"descriptionQuality": <"poor"|"good"|null>}, "notes": ["<one caution, or none>"]}}. obviousMismatch: true only when the title or body plainly contradicts what the diff does. descriptionQuality: "poor" when the description is missing, a stub, or does not say what changed and why; "good" otherwise; null when you cannot tell. Keep notes to at most two short sentences.',
    );
  }
  return lines.join("\n");
}

/**
 * Layer 4, present whenever there is a sheet: each label with its gloss.
 *
 * @param {PromptInput} input
 * @returns {string | undefined}
 */
function layerSheet(input) {
  if (input.sheet === null || input.sheet.size === 0) return undefined;
  const lines = ["The labels you may choose from:"];
  for (const [name, gloss] of input.sheet) {
    lines.push(gloss === "" ? `- ${name}` : `- ${name} — ${gloss}`);
  }
  return lines.join("\n");
}

/**
 * @param {{ name: string, description: string }} repository
 * @returns {string}
 */
function repositoryLine(repository) {
  return repository.description === ""
    ? repository.name
    : `${repository.name} — ${repository.description}`;
}

/**
 * The diff stats a PR's evidence carries: one line per file, the counts as
 * GitHub accounts them.
 *
 * @param {{ filename: string, additions: number, deletions: number }[]} files
 * @returns {string}
 */
function diffStats(files) {
  return files
    .map((file) => `${file.filename}: +${String(file.additions)} -${String(file.deletions)}`)
    .join("\n");
}
