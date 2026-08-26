/**
 * The translation prompt, assembled in one order — `docs/development/harmonise.md`'s:
 *
 * ```text
 * 1  system    built in: the task, the output contract, the repository's name
 *              and description, the source language and the pair's language,
 *              glossary handling instructions, skip directive instructions
 * 2  custom    the instruction document, if it exists
 * 3  language  this language's instruction, if one exists
 * 4  evidence  the source document with glossary placeholders and skip
 *              placeholders, wrapped as evidence (if a translation exists:
 *              both documents)
 * ```
 *
 * Layer 4 is framed by `core/untrusted.mjs`: the document is data to
 * translate, never instructions to follow. The model's only degrees of
 * freedom are prose and the three contract fields — filenames, links, images,
 * glossary terms and skip regions are already fixed in the text it receives.
 */

/** @typedef {import("#core/chat.mjs").ChatMessage} ChatMessage */
/** @typedef {import("#core/untrusted.mjs").Evidence} Evidence */

/**
 * @typedef {object} TranslationPromptInput
 * @property {{ name: string, description: string }} repository
 * @property {string} sourceLanguage
 * @property {string} language the pair's target language
 * @property {string} protectedSource the prepared source text (placeholders in place)
 * @property {string | undefined} existingTranslation the current translation, when one exists
 * @property {{ instruction?: string, languages: Record<string, string> }} documents
 * @property {Evidence} evidence
 */

/**
 * Assembles the messages for one pair's chat request.
 *
 * @param {TranslationPromptInput} input
 * @returns {{ messages: ChatMessage[] }}
 */
export function buildTranslationPrompt(input) {
  const system = [
    layerTask(input),
    input.documents.instruction,
    input.documents.languages[input.language],
  ]
    .filter((layer) => layer !== undefined && layer !== "")
    .join("\n\n");

  /** @type {ChatMessage[]} */
  const messages = [{ role: "system", content: system }];

  const evidence = [input.evidence.wrap("source-document", input.protectedSource)];
  if (input.existingTranslation !== undefined) {
    evidence.push(input.evidence.wrap("existing-translation", input.existingTranslation));
  }
  messages.push({ role: "user", content: evidence.join("\n\n") });

  return { messages };
}

/**
 * Layer 1, always present.
 *
 * @param {TranslationPromptInput} input
 * @returns {string}
 */
function layerTask(input) {
  const repo =
    input.repository.description === ""
      ? input.repository.name
      : `${input.repository.name} — ${input.repository.description}`;

  return [
    `You translate one documentation file from ${input.sourceLanguage} into ${input.language}, ` +
      `keeping the file's Markdown structure exactly.`,
    `Repository: '${repo}'.`,
    "Answer with JSON only, no prose around it:",
    '{"drift": <true|false>, "summary": "<one line saying what changed or why none did>", ' +
      '"content": "<the complete translated document>"}',
    "Rules you cannot change:",
    "- The complete document, never a patch or a diff.",
    `- Every token like [[harmonise:…]] is a placeholder for content that must survive ` +
      `byte-for-byte: keep each one exactly as written, same count, same spelling. Translate ` +
      `the prose around them; never translate, move across paragraphs, add or drop tokens. ` +
      `Glossary terms live inside some of these tokens — they stay in the source language by design.`,
    "- Links and image references are already final. Do not rewrite, reorder or reformat them.",
    "- Headings keep their levels; fenced code blocks keep their contents and their fences; " +
      `inline code stays inline code. Translate human-readable prose only.`,
    '- "drift" is true when your translation differs from the existing translation (or when ' +
      "there is no existing translation), false when it would come out byte-identical.",
  ].join("\n");
}
