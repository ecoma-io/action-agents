# harmonise-adversarial

Adversarial fixtures for the harmonise action — the multilingual documentation
sync that translates a source-language document into target languages and opens
exactly one pull request on its own `harmonise/<source-language>` branch. The
model's entire power over that proposal is its text, and the fixtures attack
that text directly: HTML/script smuggled through a translation, a markdown link
retargeted to an attacker host, a summary engineered to break out of the PR
body, and an answer that tries to blow a byte/resource cap.

Each fixture drives a real `run()` (`harmonise/src/index.mjs`) with a scripted
chat and a recording forge, then asserts the capability stays bounded:

- **Translation text is inert, never instruction.** A hostile translation's
  `<script>`, `on*` event handlers and `javascript:` hrefs are blanked in place
  by `sanitizeTranslationHtml` (`harmonise/src/plan.mjs`) before the proposal
  becomes a blob; link destinations are judged by `validateLinkGraph`
  (`harmonise/src/link-graph.mjs`), so a destination the model changed — an
  internal link swapped for a foreign host, an external URL rewritten byte for
  byte — refuses the pair instead of reaching the branch.
- **Summaries are sanitised on the way to the PR body.** `buildPullRequestBody`
  (`harmonise/src/pull-request.mjs`) runs every model summary through
  `sanitiseCommentText` (`core/src/sanitise.mjs`): tag-shaped `<` is escaped,
  `@handles` are broken, and each line is capped — hostile summary text cannot
  render as script or mention.
- **Answers are capped, never hung.** A translated document past
  `MAX_SOURCE_BYTES` (32 KiB, `harmonise/src/plan.mjs`) is refused
  fail-closed; the transport's 1 MiB body cap (`core/transport/http.mjs`,
  `DEFAULT_MAX_BODY_BYTES`) refuses a multi-MB chat body before it is buffered.
  Refusals are never retried (`harmonise/src/recovery.mjs`), so a hostile
  answer does not multiply model calls or forge writes.

Cross-checked against the per-module unit tests so the corpus adds to them —
see `security/README.md` for the corpus contract.
