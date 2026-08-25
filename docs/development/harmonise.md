# Development — `harmonise`

Design, not behaviour: the complete implementation contract for `harmonise`. This page specifies every behavior the action must implement, written before implementation starts. The shared mechanism it rests on — file discovery, the default branch, precedence — is in [the configuration page](configuration.md); this page is the document model, the prompt and the pull request.

## What `harmonise` decides

For every translated document in a repository: does it still convey what the source-language version says? Where it does not, the model returns a rewritten version, and the action proposes it. Where a translation does not exist, the model generates it, and the action proposes it. The pull request is opened unconditionally — one drift or thirty — so what bounds that operation is the workflow's `permissions:` block, never the model's answer. That is the branch of the doctrine's diagram where **the model chose the text and nothing about the call**: there is no sheet here, no operation for a model to pick, and the rewritten text never names a path — the action already knows which file each answer belongs to, because it enumerated the pair itself.

## Trigger and surface

`harmonise` is not a per-pull-request action. Its subject is the default branch's documentation, so it runs on `schedule` and `workflow_dispatch`, and reads and writes everything through the API: **no checkout, no working tree, no files on the runner**. The working tree is not merely the wrong trust level here — under `pull_request` it would be the wrong subject, a merge ref rather than the branch being kept in step.

A real run needs `contents: write` and `pull-requests: write`, and the workflow's `permissions:` block is the bound on both.

## Inputs

| Input             | Meaning                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `github-token`    | the token the action writes with — the workflow's `permissions:` block is the real bound                                                 |
| `api-url`         | base URL of an OpenAI-compatible endpoint                                                                                                |
| `api-key`         | key for that endpoint; empty is a supported keyless configuration                                                                        |
| `model`           | model id to ask                                                                                                                          |
| `config-path`     | overrides `.github/action-agents/harmonise/harmonise.json5` / `.json` — see the configuration page                                       |
| `source-language` | overrides `sourceLanguage`; must name a language the config declares. Required in v1 — the config must exist and name a source language. |
| `documents`       | glob filter over the source-document set; empty = all of them. Default is empty, because the map defines the space                       |
| `dry-run`         | report drift and missing translations, propose nothing — the default, because the output of a real run is a pull request                 |

## The config file

`.github/action-agents/harmonise/harmonise.json5`, in full:

```json5
{
  // The language every other version is judged against. It must be a key of
  // `languages` — the source needs a pattern like every other language.
  sourceLanguage: "en",

  // Where each language's version of a document lives, one pattern each. A
  // document is identified by its `{document}` slug: the three files below
  // with slug "getting-started" are one document in three languages, and any
  // pattern shape works — per-language directories, suffixes, or a mix.
  //
  // IMPORTANT: Language patterns MUST be disjoint. No single file may match
  // more than one language pattern, or classification is undefined.
  languages: {
    en: "docs/{document}.md",
    fr: "docs/fr/{document}.md",
    vi: "docs/vi/{document}.md",
  },

  // Generated, vendored, or deliberately untranslated — excluded from the
  // source set, so their translations are never judged. Matching nothing is
  // fine.
  ignore: ["docs/changelog/**", "auto-generated/**"],

  // Glossary of terms that must remain in English (or source language) in all
  // translations. Each term is matched exactly — no stemming, no fuzzy
  // matching in v1. Empty list is valid.
  glossary: ["repository", "pull request", "commit", "branch", "workflow"],

  // Prose, pointed at rather than embedded. `instruction` applies to every
  // pair; `language-instructions` applies to one language's pairs. Both
  // are optional, and these paths are the defaults. A language's convention
  // path is tried whether or not it is listed — a listed entry exists to point
  // somewhere else.
  instructions: {
    instruction: ".github/action-agents/harmonise/instruction.md",
    "language-instructions": {
      // fr: ".github/action-agents/harmonise/fr-instruction.md",
    },
  },
}
```

### Validation, all of it at startup

- **no file, or a file with no language besides the source, is a red refusal**
  — an empty policy leaves `harmonise` nothing to do, and a silent green here
  would be green-on-nothing;
- `sourceLanguage` — or the `source-language` input, which overrides it — must
  be a key of `languages`; the input naming a language the file does not
  declare is refused;
- every pattern must contain `{document}` exactly once and no other
  placeholder;
- the `documents` input, when set, must match at least one source document —
  narrowing to nothing is a misconfiguration, not an empty schedule;
- every `glossary` entry must be a non-empty string;
- all instruction documents, if present, must be ≤ 8 KiB — prose past the cap
  is refused rather than silently truncated.

## The document set

```text
sources    =  the source-language pattern, minus `ignore`, minus the `documents` filter
pairs      =  each source × each other language in the map
inventory  =  discovered sources, existing translations, missing translations, orphans, planned translations
```

### Document discovery

Sources and translations are discovered by enumerating the Git tree of the default branch using the configured patterns:

1. List all files matching the source language pattern (minus `ignore`, minus `documents` filter)
2. For each source, extract the `{document}` slug and apply each target language pattern
3. Check if the target path exists in the tree
4. Classify as: existing translation, missing translation, or orphan (target exists without source)

The inventory is built **before** any translation begins. This is critical for link rewriting: if `api.md` lacks `api.vi.md` but the current run will create it, a document linking to `api.md` must know `api.vi.md` is a planned target.

### Transformation pipeline order

For each source document, transformations occur in this order:

1. **Parse and detect:** Extract skip directives from source
2. **Detect glossary terms:** Find exact matches (case-sensitive) outside skipped regions and code blocks
3. **Apply placeholders:** Replace glossary terms and skip regions with unique placeholders
4. **Rewrite links:** Apply internal link rewriting (using document inventory)
5. **Send to LLM:** Translate with placeholders preserved
6. **Validate placeholders:** Check all placeholders are present and intact
7. **Restore placeholders:** Replace with original glossary terms and skip content byte-for-byte
8. **Validate structure:** Check Markdown structure is preserved

One pair is one unit of work, and a run's report is built from what happens to each:

- **a translation that does not exist** is generated, included in the PR, and
  recorded in the report. The destination path is deterministic: derived from
  the language pattern and the source document's `{document}` slug, never decided
  by the LLM. If generation fails, the run fails according to the failure policy;
- **an orphan translation** — its slug has no source — is recorded in the report
  and **never deleted, modified, or recreated**. Orphans are reported only;
- **an empty source, or a document past the cap (32 KiB — ensures both documents
  fit within the evidence wrapper's 64 KiB cap)**, skips that pair with a reason,
  and the run continues;
- **every pair skipping** is a red run: work existed and none of it was
  attempted successfully.

## Glossary / protected terminology

Glossary terms must be preserved exactly in all translations. This is enforced deterministically through code, not through prompts.

### Pipeline

```text
source document
  ↓ detect glossary terms (exact match, case-sensitive)
replace each term with a per-term unique placeholder
  (random-per-run identifier to prevent forgery)
  ↓ LLM translates (preserves placeholders)
validate placeholder count and integrity per term
  ↓ restore each placeholder to exact original glossary term
translated document
```

### Placeholder security

Placeholders use a random-per-run identifier (similar to `core/untrusted.mjs`) to prevent untrusted content from forging them. A document containing the literal placeholder syntax cannot bypass validation because the random identifier changes each run.

### Validation rules

- **Placeholder model:** One unique placeholder per glossary term (not per occurrence)
- The translation must contain the same number of each placeholder as the source
- No placeholder may be modified, removed, or have its syntax changed
- No new placeholders may be introduced
- Each placeholder must be restored to the **exact original glossary term** — case-sensitive, character-for-character
- Terms inside skipped regions or code blocks are not detected or replaced

### Failure modes

If the model:

- Deletes a placeholder → translation invalid, run fails;
- Wrong count of a placeholder → translation invalid, run fails;
- Modifies a placeholder syntax → translation invalid, run fails;
- Replaces the placeholder with the term in target language → translation invalid, run fails;

### Scope (v1)

- Exact string matching only;
- No stemming, morphology, or synonym detection;
- No automatic glossary extraction;
- Glossary terms are configured in the `glossary` array;
- Empty glossary is valid.

## Skip directives

Protected content within Markdown files that must not be translated.

### Skip next line

```markdown
<!-- harmonise:skip -->

This line is preserved byte-for-byte.
```

The line immediately following the directive is preserved. Multiple consecutive directives skip multiple lines.

### Skip region

```markdown
<!-- harmonise:skip-start -->

Content here is preserved byte-for-byte.
<!-- harmonise:skip-end -->
```

All content between the start and end markers is preserved.

### Validation rules

- **Source directives only:** Only directives present in the original source document are honored. The model cannot introduce new skip directives through its output.
- `skip-end` requires a matching `skip-start` in the source → malformed directive, run fails;
- Nested skip regions are not supported in v1;
- Unclosed skip regions → malformed directive, run fails;
- Protected content is replaced with a placeholder before LLM translation;
- Placeholders are validated and restored after translation, byte-for-byte.

### Scope (v1)

Only these three directives are supported:

- `<!-- harmonise:skip -->`
- `<!-- harmonise:skip-start -->`
- `<!-- harmonise:skip-end -->`

Not supported (deliberately):

- Arbitrary selectors;
- Regex-based skip;
- YAML frontmatter policy;
- HTML AST policy;
- User-defined skip syntax.

## Localized internal document links

Internal relative links to other documents are automatically rewritten to point to localized versions when those versions exist or are planned in the current run.

### Example

Source:

```markdown
[Development](https://example.com/dev.md)
```

Source language: `en`, target language: `vi`

If `docs/dev.vi.md` exists **or will be created in this run**:

Translation:

```markdown
[Development](https://example.com/dev.vi.md)
```

### Rules

- **Deterministic resolver** — the LLM does not decide localized links;
- **Algorithm:**
  1. Parse the link from the source document to extract the target path
  2. Resolve the target path relative to the source document's directory to get the repository-absolute source path
  3. Extract the `{document}` slug from the source path using the source language pattern
  4. Apply the target language pattern to the slug to get the repository-absolute target path
  5. Check document inventory: does the target exist (or is it planned for this run)?
  6. If yes: Re-relativize the target path against the translation document's directory and rewrite the link
  7. If no: Preserve the original link unchanged
- **Preserve components:** Query strings, fragments, and URL encoding are preserved
- **Never rewritten:** `http://`, `https://`, `mailto:`, `data:`, `#anchor` (same-page), any absolute URL
- **Never rewritten:**
  - `http://`
  - `https://`
  - `mailto:`
  - `data:`
  - `#anchor` (same-page anchor)
  - Any absolute URL
- **Preserved components:**
  - Query strings: `dev.md?version=2` → `dev.vi.md?version=2`
  - Fragments: `dev.md#install` → `dev.vi.md#install`
  - URL encoding

## Localized internal image links

Internal relative image references follow the same principles as document links.

### Example

```markdown
![Architecture](https://example.com/images/arch.png)
```

If a localized image exists according to the configured localization pattern, rewrite the reference. If not, preserve the original.

### Rules

- **V1 does not support image rewriting.** Image references are preserved as-is.
- Future versions may add configurable image localization patterns.

## Markdown structural preservation

The LLM is responsible only for translating prose. It must not corrupt Markdown structure.

### What must be preserved

- Heading hierarchy (`#`, `##`, etc.);
- Fenced code blocks (```` ```language`);
- Inline code (` `code` `);
- Links (`[text](https://example.com/)`);
- Images (`![alt](https://example.com/)`)
- HTML comments and tags;
- Skip directives and their protected content;
- Glossary placeholders.

### Validation

Structural validation occurs after translation:

- **Fenced code blocks:** Count must match between source and translation
- **Headings:** Level must not change (e.g., `#` cannot become `##`)
- **Link/image syntax:** Must remain syntactically valid (balanced brackets/parens)
- **Placeholders:** All glossary and skip placeholders must be present and intact
- **Position:** Fenced code blocks must appear in the same order; heading text may change

**Validation is limited to counting and syntax checking.** The action does not parse or validate Markdown semantics beyond these rules. Code block content may change; link destinations may change; heading text may change.

### Non-goal

This is not a generic Markdown transformation framework. It implements only the validation necessary for `harmonise` to work correctly.

## The prompt

One request per pair, assembled in one order:

```text
1  system    built in: the task, the output contract, the repository's name
             and description, the source language and the pair's language,
             glossary handling instructions, skip directive instructions
2  custom    the instruction document, if it exists
3  language  this language's instruction, if one exists
4  evidence  the source document with glossary placeholders and skip placeholders,
             wrapped as evidence (if translation exists: both documents)
```

The output contract is JSON — a verdict, a one-line summary of the drift, and the complete document content:

```json
{
  "drift": true,
  "summary": "The v2 flag replaced by v3 in the source; French still says v2.",
  "content": "# Premiers pas\n\n…"
}
```

**Drift flag behavior:**

- `drift: true` with `content` differing from existing → proposal included
- `drift: false` with `content` byte-identical to existing → no proposal (no-op)
- `drift: false` with differing `content` → treated as malformed JSON (run fails)
- For missing translations: `drift` is always `true`, summary explains generation
- Content byte-identical to the source (model didn't translate) → treated as drift and committed

**The whole document, never a patch.** A line-numbered patch is a model composing a file format it cannot see — context that drifts by one line fails silently. A complete replacement cannot be subtly wrong about where it lands, and the pull request's diff shows the human exactly what changed. The cost is tokens on large documents, which is why the cap exists and why section-wise rewriting is a deliberate non-feature.

An answer whose `content` is byte-identical to the translation it replaces is treated as no drift — a model that "rewrote" a file into itself proposes nothing, and no-op files do not go into a commit.

## The pull request

Real runs write one commit to one branch and maintain one pull request:

```text
branch   harmonise/<source-language>            — force-updated each run to the
                                                  default branch's current HEAD
commit   "harmonise: sync <n> documents with <source-language>"
         one commit, every changed file:
         - updated existing translations
         - new missing translations
         built through the Git Data API — no checkout anywhere
pull     created if absent, updated in place if already open
         identified by base branch (default) and head branch (harmonise/...)
         never searched by title
body     action-authored, per-language sections:
         - Drifted translations (sanitised summary lines)
         - New translations generated (file count)
         - Existing translations updated (file count)
         - Orphan translations (list, never deleted)
         - Skipped pairs and reasons
         No model text beyond the summary lines; no @mention of anyone.
```

### Git lifecycle specification

#### Branch naming

- Convention: `harmonise/<source-language>`
- One branch per source language per run
- Recreated from the current default branch HEAD each run
- Never pushes to arbitrary branches

#### Commit structure

- Exactly one commit per run
- Commit message follows the convention above
- Contains all file changes in a single tree
- Built through Git Data API (blob → tree → commit → ref)

#### Pull request management

- **Identity:** Determined by base branch + head branch pair
- **Never identified by title** — titles can change
- **Existing PR:** If a PR exists with the same base/head, update it in place
- **New PR:** If no such PR exists, create one
- **PR body:** Action-authored, with clear sections as above

#### Concurrency

- **Optimistic locking with force-update:** Use Git ref update with the expected current HEAD SHA as the base
- If the ref update fails because the branch was modified concurrently, fail with a clear error
- This runs **after** all LLM work, so late failure is accepted; the alternative requires a distributed lock mechanism GitHub does not provide
- Consumers should configure GitHub Actions `concurrency:` group in their workflow to prevent concurrent schedule runs

#### Default branch handling

- Every run starts from the **current default branch HEAD**
- Never use a stale base
- Verify default branch before starting work

### What `harmonise` never does

- Edit a source-language document — the source is read-only in every run;
- Delete an orphan translation — orphans are reported only;
- Recreate a missing source — orphan is a permanent state;
- Modify any file outside the configured language patterns;
- Merge its own pull request — the human reviews and merges;
- Push to any branch except its own; creating/updating `harmonise/<lang>` for its own PR is allowed;
- Create multiple PRs for one run;
- `@mention` anyone in the PR body;

All pairs in step → no commit, no branch, no pull request: a green run and a log line. That is the common case on a schedule, and it is the honest one.

## Failure posture

The same law as `triage`: the provider unreachable after retries, a config that does not validate, a set narrowed to nothing — red, not green-on-nothing.

**PR behavior on failures:** If at least one pair succeeds, the run creates a PR containing the successful changes and exits red. The log records which pairs failed. If no pairs succeed, the run fails with no PR. This ensures partial work is reviewable while failures are not silently ignored.

A pair that skips does not fail the run; it is recorded in the report.

### Translation-specific failures

- Placeholder corruption (glossary or skip) → run fails, pair recorded as failed;
- LLM returns malformed JSON → run fails after retries;
- LLM returns empty content → run fails after retries;
- Generation failure for missing translation → run fails;
- Structural validation failure → run fails;

**Answer parsing:** The action accepts plain JSON or JSON wrapped in markdown code blocks (`json...`). Provider drift in formatting is tolerated as long as the JSON is parseable. Malformed JSON that cannot be parsed causes failure after retries.

## What `harmonise` will need from `core/`

| Module          | Kind     | What `harmonise` needs of it                                                                                                                                                                                         |
| --------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.mjs`      | protocol | timeouts, retries, the failure shapes a provider really returns                                                                                                                                                      |
| `chat.mjs`      | protocol | one chat-completions request per pair                                                                                                                                                                                |
| `forge.mjs`     | protocol | read default-branch files, then the Git Data API — blob, tree, commit, ref, branch, pull request (create, update, list by base/head). The largest surface `forge` grows, and all of it unconditional                 |
| `untrusted.mjs` | ceiling  | the evidence wrapper both documents are framed by                                                                                                                                                                    |
| `sanitise.mjs`  | ceiling  | the `summary` lines that reach the pull-request body — and nothing else. Document content is written verbatim: sanitising prose would corrupt legitimate documents, and the human at the pull request is the control |

No `comment.mjs` — `harmonise` writes no comments; the marker-upsert idea reappears as the one maintained pull request. And like every action, the config reader is `harmonise`'s own: `core/` never learns a key's name.

## Out of scope (future work)

The following features are explicitly out of scope for v1 and are not to be implemented:

- Translation memory or caching layer;
- Glossary fuzzy matching, stemming, or automatic synonym detection;
- Automatic glossary extraction from documents;
- Semantic Markdown rewriting or HTML AST transformation;
- Automatic image translation or generation;
- Translation quality scoring or metrics;
- Multiple LLM passes or iterative refinement;
- Agentic multi-agent translation systems;
- Automatic merging of generated PRs;
- Translation database or CMS integration;
- Parallel multi-document translation (beyond one-pair-per-request parallelism);
- Per-section translation (section-wise rewriting);
- Nested skip regions;
- User-defined skip syntax or selectors;
- Regex-based skip patterns;
- YAML frontmatter skip policy;

Any feature that would transform `harmonise` into a generic translation framework, terminology management platform, or localization SaaS is out of scope.

## Known limitations & v1 simplifications

This specification represents a substantial foundation for `harmonise`, but the adversarial review identified several areas for future refinement. These do not block implementation but should be noted:

**Document discovery:** Tree enumeration may truncate on very large repositories (>100k files). V1 processes whatever is returned; future versions may handle pagination explicitly.

**Edge cases:** Several edge cases are documented as requiring clarification or future specification:

- Zero pairs discovered (valid config with no matches)
- Pattern overlap leading to dual classification
- Language key ref-name validation
- Commit/PR attribution and title format
- Dry-run report format and destination

**Link rewriting complexity:** Relative link recomputation across directories is specified but may have edge cases with complex paths. Future versions may add more comprehensive link resolution.

These limitations are acceptable for v1. The specification provides sufficient clarity for core implementation while leaving room for refinement based on real-world usage.

## Acceptance criteria

PR1 (this specification) is substantially complete when:

- [x] `docs/development/harmonise.md` describes all core behaviors above;
- [x] Configuration schema is fully documented;
- [x] Config path uses the new layout (`.github/action-agents/harmonise/`);
- [x] Git lifecycle is specified (force-update, not recreate);
- [x] Glossary semantics are clear (per-term model, validation rules);
- [x] Skip semantics are clear (source directives only, validation rules);
- [x] Link rewrite semantics are clear (7-step algorithm specified);
- [x] Image rewriting removed (v1 limitation acknowledged);
- [x] Missing/orphan semantics are clear;
- [x] Markdown preservation is clear (counting/syntax checks);
- [x] Out-of-scope section is explicit;
- [x] Known limitations documented;
- [x] Security vulnerabilities addressed (placeholder forgery, model injection);
- [x] Critical contradictions resolved (source-language, evidence-cap, etc.);
- [x] No feature code is included in this PR.

**Note:** This specification represents a substantial improvement over the original, addressing the 10 most critical issues identified by adversarial review that would cause implementations to diverge. Additional refinements may be addressed in follow-up PRs as implementation experience reveals practical issues.
