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
 * @property {Evidence} evidence
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
    layerSheet(input),
  ]
    .filter((layer) => layer !== undefined && layer !== "")
    .join("\n\n");

  /** @type {ChatMessage[]} */
  const messages = [{ role: "system", content: system }];

  const evidence = [input.evidence.wrap("thread-body", input.thread.body)];
  if (input.thread.type === "pr" && input.files.length > 0) {
    evidence.push(input.evidence.wrap("diff-stats", diffStats(input.files)));
  }
  messages.push({ role: "user", content: evidence.join("\n\n") });

  return { messages };
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
    `Title: ${input.thread.title}`,
  ];
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
