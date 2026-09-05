# Development — `harmonise`

Shipped behaviour, not intent: `harmonise` is released and pinnable, and this page is the specification the running code implements, kept as the implementation contract — every behavior below is stated precisely enough to test, and is tested. The shared mechanism it rests on — file discovery, the resolved policy source, precedence — is in [the configuration page](configuration.md); this page is the document model, the prompt and the pull request.

## What `harmonise` decides

For every translated document in a repository: does it still convey what the source-language version says? Where it does not, the model returns a rewritten version, and the action proposes it — unless manual-edit protection preserves the existing bytes and routes the pair to a merge or a refusal (see "Manual-edit protection" below). Where a translation does not exist, the model generates it, and the action proposes it. The pull request is opened unconditionally — one drift or thirty — so what bounds that operation is the workflow's `permissions:` block, never the model's answer. That is the branch of the doctrine's diagram where **the model chose the text and nothing about the call**: there is no sheet here, no operation for a model to pick, and the rewritten text never names a path — the action already knows which file each answer belongs to, because it enumerated the pair itself.

## Trigger and surface

`harmonise` is not a per-pull-request action. Its subject is the default branch's documentation, so it runs on `schedule` and `workflow_dispatch`, and reads and writes everything through the API: **no checkout, no working tree, no files on the runner**. The working tree is not merely the wrong trust level here — under `pull_request` it would be the wrong subject, a merge ref rather than the branch being kept in step.

A real run needs `contents: write` and `pull-requests: write`, and the workflow's `permissions:` block is the bound on both.

**Token choice and CI:** a pull request opened by `GITHUB_TOKEN` gets no workflow runs — GitHub suppresses events its own token caused, so the action's PR would sit there un-checked forever. Consumers who want the harmonise pull request to run CI mint an identity outside the workflow token (a GitHub App token, as this repository's own dogfood workflow does) and pass it as `github-token`. That identity is stronger than the `permissions:` block — the block binds only `GITHUB_TOKEN` — which is acceptable precisely because what a harmonise run may write is pinned in code: files inside the configured language patterns, one branch of its own naming, nothing else.

## Inputs

| Input                | Meaning                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `github-token`       | the token the action writes with — the workflow's `permissions:` block is the real bound                                                                                                                           |
| `api-url`            | base URL of an OpenAI-compatible endpoint                                                                                                                                                                          |
| `api-key`            | key for that endpoint; empty is a supported keyless configuration                                                                                                                                                  |
| `model`              | model id to ask                                                                                                                                                                                                    |
| `request-timeout-ms` | per-attempt timeout in milliseconds for one provider call — the attempt must complete the whole completion; raise it for endpoints that legitimately take longer than two minutes; default 120000, floored at 1000 |
| `config-path`        | overrides `.github/action-agents/harmonise/harmonise.json5` / `.json` — see the configuration page                                                                                                                 |
| `source-language`    | overrides `sourceLanguage`; must name a language the config declares. Required in v1 — the config must exist and name a source language.                                                                           |
| `documents`          | glob filter over the source-document set; empty = all of them. Default is empty, because the map defines the space                                                                                                 |
| `dry-run`            | report drift and missing translations, propose nothing — the default, because the output of a real run is a pull request                                                                                           |
| `record-path`        | directory inside the workspace where the machine-readable run record lands at the run's terminal points; default `.harmonise-record` — see [the run record](#the-run-record)                                       |

Timeouts come in two layers. `request-timeout-ms` bounds one provider attempt; retries,
backoff, `Retry-After` and the attempt limit are `core/transport/http.mjs` policy, not inputs.
The workflow's `timeout-minutes` (15 in this repository's own `harmonise.yml`) remains the
outer safety boundary — the per-request value bounds one call, the job timeout bounds the
run. A value below 1000 is a startup error, so the HTTP client's disabled-timeout path is
unreachable from a workflow.

The numbers — attempts, backoff, the `Retry-After` cap, the retryable
statuses — are stated in [the core ceilings](ceilings.md#the-retry-ceiling).

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
  // When two patterns claim one file, the more specific — more literal
  // characters around `{document}` — wins; two equally specific claims are
  // refused at classification time. See "Document discovery" below.
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

  // How many translatable pairs one run may have in flight with the model at
  // once — a positive integer. Absent it defaults to 2, a conservative
  // starting point; the action hard-caps it at 4 whatever the file declares.
  concurrency: 2,

  // Optional. The commit subject and pull-request title a run publishes,
  // when this repository's own law differs from the built-in convention.
  // `{n}` is how many documents the run proposes; `{sourceLanguage}` is the
  // configured source language — those two placeholders are all there is,
  // substituted deterministically at publish time, never by the model.
  // Absent, the built-in shape stands unchanged.
  pullRequest: {
    title: "docs(i18n): sync {n} documents from {sourceLanguage}",
  },

  // Optional. Where a language's variant of an image lives, when this
  // repository's own convention differs from the built-in one. Each layout
  // is a template over `{dir}` (the image's directory relative to the
  // document's, empty when they share one), `{base}`, `{ext}` (without the
  // dot, empty when the name has none) and `{lang}`, producing a path
  // relative to the document's own directory. Configured layouts are tried
  // first, in this order, and the built-in convention
  // (`{dir}/{base}.{lang}.{ext}`) stays last — absent, today's behavior is
  // unchanged. `harmonise` never creates or uploads assets; a layout only
  // ever points a reference at a file the branch already holds.
  assets: {
    layouts: ["assets/{lang}/{dir}/{base}.{ext}"],
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
- a `pullRequest.title` template, when present, may carry only `{n}` and
  `{sourceLanguage}` — any other brace group, unpaired brace or empty
  placeholder is refused; the template is non-empty, non-whitespace, and
  within the title length cap. The pull-request **body** is not customisable:
  it stays action-authored.
- an `assets.layouts` entry, when present, must contain `{lang}` and `{base}`
  exactly once, only `{dir}`, `{ext}` and those two placeholders, and only
  literal parts that stay inside the document's directory — absolute paths,
  drive letters, `..` and empty segments are refused; duplicates are refused
  rather than deduplicated, and more than 8 layouts are refused. A layout is
  a naming convention, not a promise: whether a rendered candidate exists is
  decided against the branch's real tree, and a miss falls through to the
  next candidate;
- all instruction documents, if present, must be ≤ 8 KiB — prose past the cap
  is refused rather than silently truncated.
- `concurrency`, when present, must be a positive integer — anything else is
  refused. The action hard-caps the run at 4 concurrent pairs regardless of a
  larger declared value; absent, the default is 2.

## The policy source

The run begins by resolving its policy source from the execution context —
for `workflow_dispatch` on `refs/heads/main`, that is `main` at its live tip
([the full mapping](configuration.md#which-branch-governs--the-resolved-policy-source)).
Everything after that resolution is pinned to the resolved 40-hex SHA: every
document and state read, the translation-memory read, the instruction
documents, the tree enumeration, the commits' parent, the proposal pull
request's base branch, and the short SHA the report cites. The audit log line
— `policy source: event=… basis=… branch=… sha=… path=…` — is the run's
first output, before any model call.

`harmonise` has no policy-empty mode: no config file on the resolved source
is a red refusal naming the branch and SHA it looked on. A `schemaVersion`
major this build does not understand refuses the same way. The intent is
auditability: a proposal pull request names exactly which commit's policy
produced it, and a reader can diff that commit to see what changed.

## The document set

```text
sources    =  the source-language pattern, minus `ignore`, minus the `documents` filter
pairs      =  each source × each other language in the map
inventory  =  discovered sources, existing translations, missing translations, orphans, planned translations
```

### Document discovery

Sources and translations are discovered by enumerating the Git tree of the resolved policy source using the configured patterns:

1. List every blob on the resolved source through the Git Trees API
2. Match each blob against the language patterns (minus `ignore`)
3. For each source, extract the `{document}` slug and apply each target language pattern
4. Classify as: existing translation, missing translation, or orphan (target exists without source)

A file claimed by more than one language pattern is settled by **specificity**: the pattern carrying more literal characters around its `{document}` wins. Nested layouts are legitimate and common — `en: docs/{document}.md` beside `vi: docs/vi/{document}.md` — and a file inside a language's own directory belongs to that language, the deeper pattern being the more specific claim. Two patterns of equal specificity claiming one file leave classification genuinely arbitrary, and that is refused with both names in the error.

`{document}` may span path segments: under the pattern `docs/{document}.md`, a file `guides/setup.md` inside `docs/` carries the slug `guides/setup`. Slugs are matched case-sensitively.

**Ignore interacts with orphans deliberately:** a translation whose slug has no source because the source is ignored is _deliberately untranslated_, not an orphan, and is never reported as one. Only a translation whose slug matches no source and no ignored source is an orphan.

**The `documents` filter narrows work, not visibility:** it selects which pairs a run processes. Missing translations and orphans are still inventoried and reported outside the filter — a report that hid them would understate the repository's true translation state.

The inventory is built **before** any translation begins. This is critical for link rewriting: if `api.md` lacks `api.vi.md` but the current run will create it, a document linking to `api.md` must know `api.vi.md` is a planned target.

#### Inventory completeness

The inventory is only sound if it is complete. A partial enumeration silently treated as complete corrupts everything downstream — orphan detection, missing-translation detection, link resolution all answer wrongly while looking authoritative. Therefore:

- The Git Trees API answers in one response and signals overflow with its own `truncated` flag — **a truncated response is refused, not processed**. The run fails red naming the ceiling, and no pair is translated from an inventory known to be incomplete;
- There is no v1 fallback that processes part of a large repository. A repository past the API's ceiling needs its documentation split before `harmonise` can serve it, and the failure says exactly that.

### Transformation pipeline order

For each source document, transformations occur in this order:

1. **Parse and detect:** Extract skip directives from source
2. **Detect glossary terms:** Find exact matches (case-sensitive, whole-word) outside skipped regions, fenced code blocks, inline code spans, and link machinery
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
  ↓ detect glossary terms (exact match, case-sensitive, whole-word)
replace each term with a per-term unique placeholder
  (random-per-run identifier to prevent forgery)
  ↓ LLM translates (preserves placeholders)
validate placeholder count and integrity per term
  ↓ restore each placeholder to exact original glossary term
validate link identity against the source document
translated document
```

**Whole-word matching.** A match must stand alone: a term flanked by a letter, digit or underscore is a different word and never matches — `commit` does not fire inside `committed`, `commitment`, `recommit` or `commit_hash`. Punctuation adjacency is fine (`repository,`, `(repository)`, `"repository"` all match). This is the boundary the "no stemming" rule draws: substring-in-word matching would be morphology by another name.

**Machinery never matches.** Beyond skipped regions, fenced code blocks and inline code spans, glossary detection also excludes everything the link rewriter treats as machinery: an inline link or image's whole parenthesized interior — destination and quoted title alike, the extent the depth scan can prove — reference-definition destinations (`[id]: target`, whose titles stay matchable), angle autolinks (`<https://…>`), and bare scheme URLs in prose (`https://example.com/commit-guidelines`). Link text stays matchable — it is author prose — and so is every byte of a line that an inline construct leaves unproven by never closing. Excluding machinery keeps every destination byte-intact for the link rewriter that runs next; a placeholder inside a path would be a link the resolver can no longer prove.

### Placeholder security

Placeholders use a random-per-run identifier (similar to `core/untrusted.mjs`) to prevent untrusted content from forging them. A document containing the literal placeholder syntax cannot bypass validation because the random identifier changes each run.

A placeholder has the shape `[[harmonise:<run-id>:<kind><n>]]` — one shared random hex `run-id` per action run, a kind (`g` for glossary terms, `s` for protected spans), and an index: for `g`, the term's position in the glossary array (`g1` is the first entry); for `s`, the span's position in document order. The index is how a refusal that names a token maps back to the consumer's own config — a message naming `g3` points at the third entry of the configured glossary, one naming `s2` at the second protected span in document order. One glossary term maps to one placeholder repeated at each of its occurrences; each protected span gets its own.

- If a source document already contains text in the placeholder's own namespace, the id is regenerated before use; a source that collides with several consecutive ids is refused rather than risk ambiguity;
- Validation counts every placeholder occurrence: a translation must carry exactly the source's count of each — no loss, no duplication, no edited syntax, no invented placeholders;
- Restoration is byte-for-byte from what was protected, so the original term or span reappears exactly as it stood.

### Validation rules

- **Placeholder model:** One unique placeholder per glossary term (not per occurrence)
- The translation must contain the same number of each placeholder as the source
- No placeholder may be modified, removed, or have its syntax changed
- No new placeholders may be introduced
- Each placeholder must be restored to the **exact original glossary term** — case-sensitive, character-for-character
- Terms inside skipped regions, code blocks, link/image destinations, reference-definition destinations or URLs are not detected or replaced

### Failure modes

If the model:

- Deletes a placeholder → translation invalid, run fails;
- Wrong count of a placeholder → translation invalid, run fails;
- Modifies a placeholder syntax → translation invalid, run fails;
- Replaces the placeholder with the term in target language → translation invalid, run fails;
- Moves a later placeholder's first occurrence ahead of an earlier one's → typed refusal: the pair is skipped and recorded `refused`, never re-asked in-run (#358);

### Scope (v1)

- Exact string matching only, with whole-word boundaries (no flanking letter, digit or underscore);
- No stemming, morphology, or synonym detection;
- No automatic glossary extraction;
- Glossary terms are configured in the `glossary` array;
- Empty glossary is valid.

## Skip directives

Protected content within Markdown files that must not be translated.

### Syntax

A directive is a **whole line** whose only content is an HTML comment of one of
the three forms below. Optional whitespace is tolerated inside the comment —
`<!--harmonise:skip-->` and `<!-- harmonise:skip -->` are the same directive —
and nothing else about the line may vary. Directives are recognized only
outside fenced code blocks: inside a fence they are displayed text, not policy.

```markdown
<!-- harmonise:skip -->
<!-- harmonise:skip-start -->
<!-- harmonise:skip-end -->
```

### Skip next line

```markdown
<!-- harmonise:skip -->

This line is preserved byte-for-byte.
```

The next non-blank line after the directive is preserved. Blank lines between
the directive and its target carry no meaning and are left where they are.
Multiple consecutive directives preserve multiple lines.

A directive never targets a fenced code block. A `skip` whose next non-blank
line is fenced is malformed authoring and refuses the run — wrap the block in
a `skip-start` / `skip-end` region instead; a region carries fences through
verbatim happily.

### Skip region

```markdown
<!-- harmonise:skip-start -->

Content here is preserved byte-for-byte.
<!-- harmonise:skip-end -->
```

Everything from the start marker through the end marker — markers included —
is one protected span, preserved byte-for-byte.

### Protected spans

Each protected span (a skip-next-line's directive plus its preserved line; a
region's start marker through its end marker) is replaced by a single
placeholder before translation and restored byte-for-byte afterwards, by the
same mechanism glossary terms use. The restored document therefore still
carries its original directives, which keeps a translated document a valid
input to a later run.

### Validation rules

- **Source directives only:** Only directives present in the original source document are honored. The model cannot introduce new skip directives through its output.
- `skip-end` requires an open `skip-start` in the source → malformed directive, run fails;
- A `skip-start` while a region is already open → malformed (nested regions are not supported), run fails;
- Unclosed `skip-start` at end of document → malformed directive, run fails;
- A whole-line HTML comment addressing this action that is not exactly one of the three forms (`<!-- harmonise:skipx -->` and friends) → malformed, run fails — an unrecognized order to the action is refused, never silently ignored;
- Comment-like text inside fenced code blocks or mid-line is content, not a directive, and is never validated as one.

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

The map pairs `en: docs/{document}.md` with `vi: docs/{document}.vi.md`.
The source document with slug `dev` links to two neighbors:

```markdown
See also [the API](api.md) and [the guide](guides/setup.md#install).
```

If a localized `api` exists **or will be created in this run**, the
translation re-points that link at its `.vi` twin; the guide has no localized
version, so its link keeps every byte:

```markdown
See also [the API](api.vi.md) and [the guide](guides/setup.md#install).
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
- **Rewritten syntaxes:** inline links and images — bracketed text followed by a parenthesized destination — and reference definitions (`[id]: target`). Never rewritten inside fenced code blocks, inline code spans, or skip-protected spans. HTML attributes (`<a href>`, `<img src>`) are content for v1 and pass through untouched.
- **Preserve components:** Query strings, fragments, and URL encoding are preserved
- **Never rewritten:** `http://`, `https://`, `mailto:`, `data:`, `#anchor` (same-page), protocol-relative URLs (`//host/path`), any other absolute URL or scheme

## Localized internal image links

Internal relative image references follow the same principles as document links: the reference is rewritten to a localized image when one exists, and preserved when it does not. The action never generates, translates, or uploads an image — it only re-points a reference at a file the repository already holds.

### Example

Source document `docs/dev.md`, target language `vi`:

```markdown
![Architecture](images/dev.png)
```

If `docs/images/dev.vi.png` exists in the tree, the translation references it:

```markdown
![Architecture](images/dev.vi.png)
```

### Rules

- **Deterministic naming:** the localized candidates for language `<lang>`
  are tried in order — the configured `assets.layouts` first, in config
  order, each rendered relative to the referencing document's directory
  (`{dir}` is the image's directory relative to that; a reference outside
  the document's directory has no document-relative shape and skips the
  configured layouts), then the built-in convention last: the referenced
  path with `. <lang>` inserted before its final extension — `dev.png` →
  `dev.vi.png`, `logo.brand.svg` → `logo.brand.vi.svg`, an extensionless
  path gains the tag at its end (`diagram` → `diagram.vi`). Query strings
  and fragments keep their places: `img.png?v=2#fig` → `img.vi.png?v=2#fig`;
- **Existence-checked:** the rewrite happens only when the localized path exists in the default-branch tree. A missing localized image leaves the original reference untouched — never a broken link, never a generated file;
- **Same resolution machinery as documents:** relative to the referencing document, resolved against the inventory, re-relativized for the translation's directory, URL encoding preserved;
- **Never rewritten:** external images (`http://`, `https://`, protocol-relative), `data:` URIs, anchors;
- The LLM sees only the already-rewritten reference; image decisions are never its to make.

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

Structural validation occurs after translation. The action builds a profile
of each document — source and translation — and refuses the pair on a
mismatch:

- **Fenced code blocks:** count must match; blocks must keep their order and character
- **Headings:** level sequence must hold and the count must match; heading text may change
- **Link/image syntax:** must remain syntactically valid (balanced brackets/parens), and visibly broken constructs must not increase
- **Placeholders:** all glossary and skip placeholders must be present and intact
- **Position:** fenced code blocks must appear in the same order
- **Lists:** each top-level list block keeps its marker style, item count and nesting depth; renumbering (`3.` → `7.`) and reordering items of the same shape are accepted
- **Blockquotes:** block count and per-block nesting depth
- **Pipe tables:** table count, and per table the row count, column count and delimiter alignment
- **Reference definitions:** their count
- **Inline links, images and autolinks:** construct counts; destinations are the link machinery's business and are not compared here
- **Frontmatter:** presence and line extent of a leading `---` block (an unclosed leading block is not frontmatter)

**Conservative by default.** The profile refuses only unambiguous structural
change. Paragraph splitting or merging, re-wrapped lines, emphasis changes,
lazy continuations and horizontal rules never refuse. What a property cannot
parse confidently on its own line it leaves unchecked in both documents:
setext headings, lists inside blockquotes, tables inside list blocks,
blockquote interiors, reference-style link usages, bare scheme URLs.

Link identity is validated after translation, in the same pass as the structural checks. The source document — restored from its protected form, exactly what the model saw — and the sanitised translation are each collected into a list of links: inline links, images, reference definitions and autolinks, with each one's destination, title, line and visible text. The two lists must describe the same links: every destination, title and link text is matched one-to-one per kind, through the same inventory resolvers the link rewriter localized with (an internal destination counts as unchanged when it resolves to the same target document or image, so a rewritten spelling is never mistaken for drift).

A pair whose links do not match fails with one violation line per difference: a re-targeted destination, an added link with no source counterpart, or a removed one. Reordering prose is not a violation — links ride with their sentences, so matching is per kind and per identity, not by document position. Refused or malformed destinations compare verbatim: whatever the model produced must still resolve the way the source did.

**Validation is limited to counting, syntax checking, and link identity.** The action does not parse or validate Markdown semantics beyond these rules. Code block content may change; heading text may change; link destinations may not.

### Non-goal

This is not a generic Markdown transformation framework. It implements only the validation necessary for `harmonise` to work correctly.

## The script gate

Before anything is restored, the tokenised answer is judged by
`harmonise/src/script-gate.mjs`: `judgeScript(text, languageTag)` counts the
candidate's letters per Unicode script — `\p{L}` membership with
`\p{Script=…}` tests, the machinery's own `[[harmonise:…]]` token spellings
excluded — and refuses the pair unless the configured target language's
scripts hold strictly more than half of the counted letters; the refusal
sentence names the target subtag, the winning foreign script and the
fraction, byte-deterministically. The expected scripts come from a curated
table keyed by the language tag's primary subtag (`en` → Latin, `ja` →
Han + Hiragana + Katakana, `ko` → Hangul + Han), judged as a union. The table
is code, not configuration — a tag joins it when its script is
uncontroversial, by a reviewed decision in this repository, never a consumer
setting — and a primary subtag the table does not know leaves the pair
unjudged by this gate rather than guessed at: a fail-open strictly narrower
than a wrong default. A candidate with no counted letters passes, and a
violation is a refusal like every answer-contract failure: raised in
`judgeAnswer`, never retried.

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

An answer whose `content` is byte-identical to the translation it replaces is treated as no drift — a model that "rewrote" a file into itself proposes nothing, and no-op files do not go into a commit. For a recorded pair the endorsement is recorded: the state record re-pins onto the endorsed bytes with the run's currency, and the endorsed bytes enter the memory, so the next run proves the pair unchanged and skips it at zero model calls instead of re-asking forever.

### Manual-edit protection

Existing bytes on disk are authoritative whenever they cannot be proven to be
harmonise's own output. Drift detection names one of four facts (`canonical`,
`target-drift`, `unrecorded`, `unknown`); the protection policy maps each fact,
together with the target's presence, to exactly one action — and the wiring
honors every row:

| verdict        | target exists   | target missing |
| -------------- | --------------- | -------------- |
| `canonical`    | republish-safe  | refuse¹        |
| `target-drift` | merge or refuse | refuse¹        |
| `unrecorded`   | refuse          | create-allowed |
| `unknown`      | refuse          | refuse         |

¹ Unreachable by drift's own semantics — those verdicts require bytes on disk.
The wiring refuses them if ever reached.

Every `preserve-required` row updates only through a three-way merge against a
verified base — the doctrine in `harmonise/src/protection.mjs`: human edits win
ties, and generated text never silently displaces human work. A merge needs
both a verified base (a translation-memory entry whose bytes hash exactly to
the record's `translationFingerprint`) and existing bytes on disk. Without
either, the pair refuses before any model call: a loud failed-pair line, a red
run, the disk untouched. `(unrecorded, exists)` — the shape of every adoption
of a repository with pre-existing translations — refuses rather than
overwrites; `(unknown, missing)` — a record whose target was deleted — refuses
rather than recreating the deletion. Resolving a refusal is a human decision:
restore the translation memory or the recorded fingerprint, or adopt or delete
the file by hand.

**Accepted risk — consistent forgery of the advisory files.** "Verified" is
exact, and exactly this far: the base is a translation-memory entry keyed by
the record's source and policy fingerprints and the pair's language whose
bytes hash to the record's `translationFingerprint` — `recordedMergeBase` in
`harmonise/src/index.mjs`. That is hash equality joining the two advisory
files: it proves the state record and the memory entry agree with each other,
never that harmonise authored either. A hand-edited state record plus a
hand-edited memory entry that joins it is therefore accepted as a verified
base, and the merge runs against those bytes. The risk is accepted, not
overlooked. Both files live in the consumer's repository under one write
access, so a hand able to forge the pair consistently is a hand with commit
access — the adversary the protection table exists for is the model
displacing human edits, not a repository writer — and the same hand could
delete the pair instead, which fails closed: a `preserve-required` pair with
no memory entry to verify refuses, the same loud refusal as any unverifiable
base. And forgery buys only the merge base: the merged result is still
proposed on the action's own pull request, where a human reads it before it
lands.

## The pull request

Real runs write one commit to one branch and maintain one pull request:

```text
branch   harmonise/<source-language>            — force-updated each run to the
                                                   default branch's current HEAD
commit   the run's one title, as its subject —
         by default "chore(harmonise): sync <n> document(s) with <source-language>",
         or the repository's own `pullRequest.title` template rendered with
         <n> and <source-language>. Conventional-commits shape, because this
         repository's commitlint judges its pull-request title like any other
         — "harmonise" is a scope here, never a type. One commit,
         every changed file:
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

One run shape changes no translation file at all. When every pair came back in
step but a recorded state record was re-pinned — a noop endorsement, proved
against this run's source, policy and transformation version — the run still
publishes: the commit carries only the language-suffixed advisory files (paths in
[Snapshot authority](#snapshot-authority)), the re-pinned record made current
and the endorsed wording entered into the memory, so the next run skips the
pair at zero model calls. The pull request is created if absent, updated in
place if already open — exactly as with translation changes.

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

- **Optimistic locking with force-update:** the lock is the expected current
  HEAD SHA, checked when the run reads the branch and re-checked by a fresh
  read immediately before the ref update — a tip caught moving between the
  two fails with a clear error rather than being force-overwritten
- The re-read narrows, but cannot close, the interleaving window: GitHub's
  ref API has no compare-and-swap, so the window stays one round trip wide
- This runs **after** all LLM work, so late failure is accepted; the alternative requires a distributed lock mechanism GitHub does not provide
- Consumers should configure GitHub Actions `concurrency:` group in their workflow to prevent concurrent schedule runs

#### Default branch handling

- Every run starts from the **current default branch HEAD**
- Never use a stale base
- Verify default branch before starting work

#### Snapshot authority

The advisory files are language-suffixed: sync state at
`.github/action-agents/harmonise/state.<lang>.json`, translation memory at
`.github/action-agents/harmonise/tm.<lang>.json` — suffixed by the same
source language that names the publishing branch. Both resolve from the same
snapshot of repository history, literally: the `harmonise/<lang>` branch tip
is resolved **once** per run, and that one SHA feeds both advisory reads.
A push landing between the two reads can never pair a state from one commit
with a memory from another.

- **Branch-first, both files, one resolution:** A run publishes its
  language-suffixed state and memory files and every translation in one
  commit on the proposal branch. The next run resolves the branch tip a
  single time and reads both advisory files at that SHA, so a state record
  can always resolve the merge base it references — even while the pull
  request is still unmerged.
- **Default fallback, per file:** When the branch has no state file or no TM
  file, the default branch's copy is used — read at the audited default-branch
  SHA the run already pinned, never a second live lookup. The two files still
  fall back independently: state on the branch with the memory on the default
  is valid, and a record can still join against a default-branch memory entry
  it matches.
- **One-cycle legacy fallback:** Repositories created before #156 carry the
  un-suffixed `state.json` and `tm.json`. A run consults them once — only
  when no ref carries its suffixed file — reading the branch tip first, then
  the default snapshot, under the same finality rules as above. The first
  suffixed publication ends the fallback; nothing writes the legacy paths
  again.
- **The branch's file is final:** When the branch carries a file, the default
  branch is never read for it — a corrupt or foreign-schema branch file
  degrades to an empty memory (or absent state), the same fail-closed rule
  both files share, never a silent substitution of a stale default copy. The
  memory stays advisory: an absent or corrupt memory leaves the run without
  prior translations, and its only hard failure is a manual-edit protection
  refusal when a merge base cannot be verified.
- **Inventory and sources stay at the default tip:** The file tree, source
  documents, instruction prose and configuration are read from the audited
  default-branch HEAD — `ref.sha` — once at the start of the run. That
  snapshot never changes mid-run, and the commit built from it parents on it.
  The optimistic lock still guards the branch tip the run found.

### What `harmonise` never does

- Edit a source-language document — the source is read-only in every run;
- Delete an orphan translation — orphans are reported only;
- Recreate a missing source — orphan is a permanent state;
- Modify any file outside the configured language patterns;
- Merge its own pull request — the human reviews and merges;
- Push to any branch except its own; creating/updating `harmonise/<lang>` for its own PR is allowed;
- Create multiple PRs for one run;
- `@mention` anyone in the PR body;

All pairs in step with no recorded state to re-pin → no commit, no branch, no pull request: a green run and a log line. That is the common case on a schedule, and it is the honest one. A run that re-pinned even one record is not this case — its state write still publishes, as the bookkeeping-only commit [the pull request](#the-pull-request) describes.

## Design note — advisory-file shape for concurrent runs

> **Status: adopted — shipped behaviour (#156).** This section records the decision #156 called for; the language-suffixed names it recommends are what a run reads and publishes today.

### The collision

Before the suffix shipped, both advisory files published at fixed paths shared by every publishing branch — the same two names for every run — and each held records for **every** target language: state records are keyed by `destinationPath` across all languages, translation-memory entries by `{sourceHash, targetLang, policyContext}`. A run published one commit on `harmonise/<sourceLanguage>` carrying both files in full. Whenever two publishing branches existed — a repository keeping more than one source language, or any workflow topology landing harmonise work on separate branches — both rewrote the same two files, so merging them sequentially conflicted on the advisory files even when their translations touched disjoint paths. The merge queue serialized landings, so this was friction, not data loss: the second branch rebased, and a rebase resolved by dropping records left pairs unrecorded or without a verified merge base, which the [manual-edit protection](#manual-edit-protection) doctrine turned into refusals and re-work — fail-closed, surfaced as red runs and cost, never as silent data loss. The language-suffixed names above remove the collision by construction; the paragraphs below are kept as the record of why.

### The three shapes

| Axis                                               | (1) Language-suffixed names                                                                                                                                                                                                    | (2) One shared file, queue-serialized runs                                                                                                                                                            | (3) Accept and document the friction                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Merge-conflict surface                             | Removed across branches: each branch owns a disjoint file set, so sequential merges never touch the same bytes. Within one branch there is still one writer (the run), so no conflict.                                         | Present but avoided **iff** runs are serialized — the second starts only after the first lands, reads its advisory file, commits on top, a clean fast-forward. Two overlapping runs collide as today. | Present and accepted.                                |
| TM and state fan-in per language                   | The action reads only its own file (fan-in of one for the run). Reconstructing a cross-source view of the memory joins N files — but the action is the sole reader in v1, so that cost is latent, not paid.                    | One file; no fan-in, ever.                                                                                                                                                                            | One file; no fan-in.                                 |
| Consumer visibility                                | 2 × (publishing keys) files in `.github/action-agents/harmonise/`, each smaller and scoped; the directory grows with the source-language count.                                                                                | One file, the simplest surface, unchanged.                                                                                                                                                            | One file, unchanged.                                 |
| Migration for existing repos                       | Real cost: repos carry un-suffixed `state.json`/`tm.json`. A missed migration is loud — refusals, a red run — not silent, and recoverable. Mitigated by a one-cycle legacy-path fallback read the implementation must specify. | None — this is the current shape.                                                                                                                                                                     | None.                                                |
| Interaction with #165's one-resolved-SHA guarantee | Preserved: the run resolves its branch tip once and reads its own suffixed files at that SHA; the per-file default-branch fallback still applies per file. Cross-branch ownership only narrows what one SHA must cover.        | The natural fit — one shared file, one resolved SHA, exactly the read-side invariant #165 states (restating #112's contract).                                                                         | Unchanged; #165 already covers today's shared files. |

### Recommendation

**Shape 1 — language-suffixed advisory file names, keyed to the publishing branch dimension** (today, the source language, matching `harmonise/<sourceLanguage>`).

The collision is structural — shared advisory files rewritten from disjoint branches — and Shape 1 removes it by construction: a property of the action's own output, enforced in code, holding for every consumer regardless of workflow topology. Shape 2 delegates correctness to the consumer's `concurrency:` configuration, which the action cannot enforce — a group keyed by source language serializes same-source runs but not cross-source ones, and a global group that does is a throughput cost the consumer is free to omit. Where that precondition breaks, Shape 2 regresses to Shape 3's failure mode. Shape 3 codifies it.

Shape 1's only real cost is migration, and it is bounded: the action is the sole reader of these files in v1, so the fan-in cost is latent rather than paid, and a missed migration fails loud (refusals, red) rather than silent. It also fits the generality rule — the suffix is derived from the configured source language, not hard-coded to one, so no rule is special-cased by language.

Two caveats the implementation must settle before code:

- **Suffix follows the branch key.** The advisory files must carry the same key the publishing branch is named by; if the branch scheme later moves to per-target-language branching, the suffix moves with it or the guarantee breaks.
- **Same target from multiple sources still collides.** Two branches both translating `fr` write the same target's records — but that is genuine content overlap, not a spurious advisory collision, and is outside the common one-source-per-target case.

## The run record

Every run leaves one machine-readable record of itself at the terminal point it
reaches: the pull request a real run published, the partial exit that follows
failed pairs, the all-in-step skip, the dry run. `harmonise/src/run-record.mjs`
builds it, validates it fail-closed and serialises it byte-deterministically;
the write itself is `writeRunRecord` in `harmonise/src/index.mjs`, under the
same workspace ceiling every read honours — the path must resolve inside
`GITHUB_WORKSPACE`, and `.git` is refused outright, before and after the
directory is created. The family's shared contract — one record per run,
byte-determinism, the fail-closed validator, the closed outcome vocabulary, the
two-tier write posture — is [the run contract's](../run-contract.md#run-records);
its retention row is [ADR 003](../adr/003-evidence-retention.md).

Where it is written, per terminal path:

- a **published run** — after the pull request is opened or updated. A failed
  write here is a logged loss, not a red run: the publication was the run's
  outcome, and the record was the loss.
- a **partial exit** — the same point, same rule, with the failed pairs counted
  in the record and the run still exiting red after the record lands.
- an **all-in-step skip** and a **dry run** — the same logged-loss tier as
  the paths above (#347): a failed write is logged, the run keeps its
  verdict, and the built record is stashed — a red exit (failed pairs)
  re-attempts it at the boundary writer, exactly as it was built.

A throw the run did not declare — a config refusal, a transport break, a
mid-run defect — is recorded by the boundary writer: `refused`
for a typed deterministic refusal, `failed` for every other throw, and then
the original error still fails the step, so the record never masks the throw
it records (#344, #347). Only a run that dies before it holds the facts a
record is built from, and a run whose record write itself fails — at the
boundary, or at a declared point under the logged-loss tier — stay
unrecorded; the upload's `if-no-files-found: ignore` keeps the green ones
green.

The fields, in schema version 3: `schemaVersion`, `repository`, `eventName`,
`sourceLanguage`, `dryRun`, `outcome`, `reason` (the terminal path's own
sentence, sanitised and capped — the cap is measured the way the validator's
bound is read, in UTF-16 length, so a capped reason always fits it (#347)),
`pairs` (`selected` — the schedule's size in pair-targets, one
source document against one language — under `proposed`, `unchanged`,
`skipped`, `failed`, the four that partition it, and the validator refuses a
record where they do not; `null` when the run died before its accounting was
finalised), `pullRequest` (`number`, `created`; `null` when the run wrote
none) and `headSha` (the base commit every read pinned to; `null` before the
run resolved one). The log lines and
the pull-request body stay out of the record: the log lines are the run log's,
and the pull request itself is the durable form of that path.

`outcome` speaks the run contract's terminal-state vocabulary through
`HARMONISE_OUTCOMES`, the closed set `harmonise/src/run-record.mjs` exports and
validates against — a word outside it is refused, not coerced. The
publication, partial and skip paths record `published`, `partial` and
`skip`; the red terminals record `refused` — every line of the red set a
deterministic refusal — or `failed` when one defect line is present, the
worst line deciding (#347).

Delivery: the file lands under the `record-path` directory (default
`.harmonise-record`), named after the base commit — `harmonise-record-<base
sha>.json`, from `harmoniseRecordFilename` in the same module — so a record's
identity is the instant it judged. The name sits inside the upload glob
`.harmonise-record/harmonise-record-*.json`, which this repository's own
harmonise workflow uploads with `if: always()` as the `harmonise-run-record`
artifact.

Retention: every field is a fact the code already computed — no model text, no
document text, no translation text. The record carries the run's own pair
accounting and terminal state; the translation's durable form is the pull
request body, and the record is the run's, not the documents'.

## Failure posture

The same law as `triage`: the provider unreachable after retries, a config that does not validate, a set narrowed to nothing — red, not green-on-nothing. The record write's posture is F-14's two-tier rule, stated in [the run record](#the-run-record) and in [the run contract](../run-contract.md#run-records): where the run's own outcome has landed — publication, partial exit, and, since #347, the declared skip points — the loss is logged and the verdict stands; where the record write is the run's only outcome, the loss is the red run; a red exit re-attempts the stashed record at the boundary writer, and a failure's record never masks the original error it records.

**PR behavior on failures:** If at least one pair succeeds, the run creates a PR containing the successful changes and exits red. The log records which pairs failed. If no pairs succeed, the run fails with no PR. This ensures partial work is reviewable while failures are not silently ignored.

A pair that skips does not fail the run; it is recorded in the report. A run where every pair skipped — none in step, none proposed — is red, not a green no-op.

### The four recovery concepts

`recovery.mjs` is the retry-policy authority for the pair loop — pure, dependency-free, and millisecond-free. Four concepts, each a pure function over declared data:

1. **Classification** — what kind of failure happened. An answer that breaks the answer contract is tagged `RefusalError` in `plan` (the contract class); an HTTP status maps through `classFromStatus` — 401/403 are auth, the transport statuses (408, 425, 429, 500, 502, 503, 504) are transport, anything else is unknown; a core transport error is transport; anything else is unknown.
2. **Backoff** — how long to wait before the next attempt. `delayClass` names the wait per class and attempt; the entry point owns the clock — it maps names to milliseconds (`DELAY_MS`: immediate 0, short 1 000, long 5 000) and sleeps. The policy module never measures time, so it stays trivially testable.
3. **Retry-After** — server-advertised waits are honoured inside `core/transport/http.mjs`, below the action; they never reach the pair loop.
4. **Attempt limit** — how many retries a class is granted. `nextAction` answers `retry` or `give-up` from the policy: transport twice, unknown once, auth and refusal never.

The failure line records the verdict — `… (classified transport, exhausted)` — so the log says why a pair is red, not just that it is.

### Translation-specific failures

An answer that violates the answer contract is a **refusal**: raised where the answer is judged (`plan`'s `judgeAnswer`) and never retried — a second identical call would return an identical answer.

- Malformed JSON, or content that is empty or whitespace only → refusal, no retry;
- Placeholder corruption (glossary or skip), a lost protected token, forged or tampered frontmatter, an answer in the wrong script → refusal, no retry;
- Structural or link validation failure → refusal, no retry;
- A provider error object at HTTP 200 → unknown, one retry under the policy;

**Answer parsing:** The action accepts plain JSON or JSON wrapped in markdown code blocks (`json...`). Provider drift in formatting is tolerated as long as the JSON is parseable. JSON that cannot be parsed is a refusal: the pair fails on its first attempt, and the failure line names the class and the action taken.

## Capabilities

What a run does is decided by `src/index.mjs` and what it imports; a module nothing on that path reaches changes no run, however complete its tests. On `main` today the production path runs through `config`, `inventory`, `patterns`, `markdown`, `links`, `link-graph`, `fingerprint`, `drift`, `stale`, `state`, `plan`, `protect`, `prompt`, `answer` and `pull-request` — and, wired on `main` since `v0.3.0` through `plan` and `src/index.mjs`, `frontmatter`, `blocks`, `tm`, `pool`, `protection`, `threeway` and `recovery`: the translation memory (#64) is read once per run, consulted per pair as advisory reference, and recorded on publication — then pruned at that publication to exactly the entries the sync state's records reference, so the memory has no eviction cap of its own: a state record can always reach the merge base it references, whatever the repository's age or size (#150), and a no-op endorsement is recorded the same way so an endorsed pair converges instead of costing one model call per run forever (#95, #150); pairs translate under the bounded-concurrent pool (#85), outcomes returned in input order so completion order never reaches the record; a target that drifted outside harmonise is merged three-way against the base the memory proves (#91), a merge that cannot be proven failing the pair closed; and every pair's failure is classified and retried under the deterministic recovery policy (#107) — refusals and auth failures never, transport faults twice, unknown once, the policy's mapped backoff between attempts. Plus — from `core/` — `http`, `chat`, `forge`, `glob`, `inputs`, `json5-parse`, `runtime`, `untrusted` and `sanitise`. The skip-unchanged classification (#75) is part of the run itself: a pair whose recorded publication still matches is skipped without a model call.

What `harmonise` uses from `core/`, module by module: +

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

- A translation cache — the memory offers prior wording as reference and carries the merge base, but a hit never substitutes for a model call;
- Glossary fuzzy matching, stemming, or automatic synonym detection;
- Automatic glossary extraction from documents;
- Semantic Markdown rewriting or HTML AST transformation;
- Automatic image translation or generation;
- Translation quality scoring or metrics;
- Multiple LLM passes or iterative refinement;
- Agentic multi-agent translation systems;
- Automatic merging of generated PRs;
- Translation database or CMS integration;
- Parallel multi-document translation beyond the bounded pool's hard cap;
- Per-section translation (section-wise rewriting);
- Nested skip regions;
- User-defined skip syntax or selectors;
- Regex-based skip patterns;
- YAML frontmatter skip policy;

Any feature that would transform `harmonise` into a generic translation framework, terminology management platform, or localization SaaS is out of scope.

## Known limitations & v1 simplifications

This specification is the contract the shipped code implements; what follows are v1 simplifications that are real in the code today, not open questions.

**Document discovery:** The Git Trees API answers a recursive listing in one response and sets its `truncated` flag past its own ceiling (very large repositories). A truncated listing is refused, not processed — see [inventory completeness](#inventory-completeness). There is no v1 mode that works on a partial tree.

**Edge cases:** Every edge case the review flagged is answered in the shipped code:

- Zero pairs discovered — refused at startup: a config whose source language matches nothing fails the run ("no document matches the source language … nothing to keep in step"), never a green run on nothing;
- Pattern overlap — a file claimed by two patterns goes to the more specific one (more literal characters around the placeholder); two patterns of equal specificity are refused rather than guessed;
- Language key ref-name validation — language keys are validated as BCP 47 tags (`^[a-zA-Z]{2,8}(-[a-zA-Z0-9]+)*$`), which is also what keeps the branch name `harmonise/<sourceLanguage>` a safe ref name;
- ~~Commit/PR attribution and title format~~ — settled: the title is the repository's own via `pullRequest.title` (issue #30);
- Dry-run report — the report is the action log and nothing is written to the repository; a pair that failed still turns a dry run red. The one file a dry run leaves is its run record ([the run record](#the-run-record)), written in the workspace.

**Link rewriting complexity:** Relative link recomputation across directories is specified; complex paths (deep nesting, encoded segments) resolve through the same deterministic algorithm, but exotic destinations — angle-bracket destinations, backslash separators — pass through untouched in v1.

These simplifications are visible in the code today and remain the intended shape for v1; refinement beyond them is future work, not undocumented drift.

## Amendments

The specification is living text, and changes to it are recorded here rather than silently rewritten into the acceptance list above:

- **PR2:** Localized internal image references are specified and supported (the earlier "image rewriting removed" v1 limitation is superseded). Inventory completeness is a refusal contract: a truncated tree listing fails the run instead of being processed. Skip-directive syntax, protected-span boundaries, and pattern-overlap refusal are made exact.
- **Correctness hardening:** Glossary detection is specified as whole-word — a term flanked by a letter, digit or underscore never matches — and its scope excludes link machinery: inline link and image destinations, reference-definition destinations, angle autolinks, and bare scheme URLs. Newline handling is pinned by test: protected content round-trips byte-for-byte under LF, CRLF, mixed newlines, and a missing final newline. Document resolution is answered from the inventory's own index rather than a per-link scan of `pairs`.
- **Title customization (#30):** The commit subject and pull-request title — one line, always — may be renamed by the repository through the optional `pullRequest.title` config key. `{n}` and `{sourceLanguage}` are its only placeholders, substituted deterministically at publish time; absent, the built-in convention stands byte-for-byte unchanged. The pull-request body stays action-authored.
- **Recovery wiring (#107):** The pair loop's fixed two-attempt retry is replaced by the deterministic recovery policy. Every failure is classified — refusal, transport, auth, unknown — and the class decides the retry: transport faults retry twice (up to three model calls per pair), unknown failures once, and refusals and auth failures never. Answer-contract violations — malformed JSON, empty content, placeholder corruption, lost protected tokens, structural and link validation failures, frontmatter tampering — are refusals: the one-retry allowance link and structural failures had is withdrawn, and the second call an unfixable answer used to spend is no longer made.
- **Script gate (#354):** The tokenised answer is judged before restoration by a script floor — `plan`'s `judgeScript`, counting letters per Unicode script against a curated primary-subtag table — and the pair refuses unless the target language's scripts hold strictly more than half of the counted letters. The violation joins the answer-contract refusals: raised in `judgeAnswer`, never retried. A language the table does not know is not judged by the gate, and a same-script wrong-language answer still passes — a script floor, not language identification.

## Acceptance criteria

PR1 (this specification) is substantially complete when:

- [x] `docs/development/harmonise.md` describes all core behaviors above;
- [x] Configuration schema is fully documented;
- [x] Config path uses the new layout (`.github/action-agents/harmonise/`);
- [x] Git lifecycle is specified (force-update, not recreate);
- [x] Glossary semantics are clear (per-term model, validation rules);
- [x] Skip semantics are clear (source directives only, validation rules);
- [x] Link rewrite semantics are clear (7-step algorithm specified);
- [x] Image rewriting removed (v1 limitation acknowledged; superseded by the PR2 amendment above);
- [x] Missing/orphan semantics are clear;
- [x] Markdown preservation is clear (counting/syntax checks);
- [x] Out-of-scope section is explicit;
- [x] Known limitations documented;
- [x] Security vulnerabilities addressed (placeholder forgery, model injection);
- [x] Critical contradictions resolved (source-language, evidence-cap, etc.);
- [x] No feature code is included in this PR.

**Note:** This specification represents a substantial improvement over the original, addressing the 10 most critical issues identified by adversarial review that would cause implementations to diverge. Additional refinements may be addressed in follow-up PRs as implementation experience reveals practical issues.
