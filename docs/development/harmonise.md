# Development — `harmonise`

Shipped behaviour, not intent: `harmonise` is released and pinnable (`v0.1` through `v0.3`), and this page is the specification the running code implements, kept as the implementation contract — every behavior below is stated precisely enough to test, and is tested. The shared mechanism it rests on — file discovery, the default branch, precedence — is in [the configuration page](configuration.md); this page is the document model, the prompt and the pull request.

## What `harmonise` decides

For every translated document in a repository: does it still convey what the source-language version says? Where it does not, the model returns a rewritten version, and the action proposes it. Where a translation does not exist, the model generates it, and the action proposes it. The pull request is opened unconditionally — one drift or thirty — so what bounds that operation is the workflow's `permissions:` block, never the model's answer. That is the branch of the doctrine's diagram where **the model chose the text and nothing about the call**: there is no sheet here, no operation for a model to pick, and the rewritten text never names a path — the action already knows which file each answer belongs to, because it enumerated the pair itself.

## Trigger and surface

`harmonise` is not a per-pull-request action. Its subject is the default branch's documentation, so it runs on `schedule` and `workflow_dispatch`, and reads and writes everything through the API: **no checkout, no working tree, no files on the runner**. The working tree is not merely the wrong trust level here — under `pull_request` it would be the wrong subject, a merge ref rather than the branch being kept in step.

A real run needs `contents: write` and `pull-requests: write`, and the workflow's `permissions:` block is the bound on both.

**Token choice and CI:** a pull request opened by `GITHUB_TOKEN` gets no workflow runs — GitHub suppresses events its own token caused, so the action's PR would sit there un-checked forever. Consumers who want the harmonise pull request to run CI mint an identity outside the workflow token (a GitHub App token, as this repository's own dogfood workflow does) and pass it as `github-token`. That identity is stronger than the `permissions:` block — the block binds only `GITHUB_TOKEN` — which is acceptable precisely because what a harmonise run may write is pinned in code: files inside the configured language patterns, one branch of its own naming, nothing else.

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

## The document set

```text
sources    =  the source-language pattern, minus `ignore`, minus the `documents` filter
pairs      =  each source × each other language in the map
inventory  =  discovered sources, existing translations, missing translations, orphans, planned translations
```

### Document discovery

Sources and translations are discovered by enumerating the Git tree of the default branch using the configured patterns:

1. List every blob on the default branch through the Git Trees API
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

- The tree listing follows `Link: rel="next"` pagination when the endpoint offers it;
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

A placeholder has the shape `[[harmonise:<run-id>:<kind><n>]]` — one shared random hex `run-id` per action run, a kind (`g` for glossary terms, `s` for protected spans), and an index. One glossary term maps to one placeholder repeated at each of its occurrences; each protected span gets its own.

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

A pair that skips does not fail the run; it is recorded in the report. A run where every pair skipped — none in step, none proposed — is red, not a green no-op.

### Translation-specific failures

- Placeholder corruption (glossary or skip) → run fails, pair recorded as failed;
- LLM returns malformed JSON → run fails after retries;
- LLM returns empty content → run fails after retries;
- Generation failure for missing translation → run fails;
- Structural validation failure → run fails;
- Link validation failure (a re-targeted, added or removed link) → run fails, pair recorded as failed after the one retry;

**Answer parsing:** The action accepts plain JSON or JSON wrapped in markdown code blocks (`json...`). Provider drift in formatting is tolerated as long as the JSON is parseable. Malformed JSON that cannot be parsed causes failure after retries.

## Capabilities

What a run does is decided by `src/index.mjs` and what it imports; a module nothing on that path reaches changes no run, however complete its tests. On `main` today the production path runs through `config`, `inventory`, `patterns`, `markdown`, `links`, `link-graph`, `fingerprint`, `drift`, `stale`, `state`, `plan`, `protect`, `prompt`, `answer` and `pull-request` — and, wired on `main` since `v0.3.0` through `plan` and `src/index.mjs`, `frontmatter`, `blocks`, `tm`, `pool`, `protection` and `threeway`: the translation memory (#64) is read once per run, consulted per pair as advisory reference, and recorded on publication; pairs translate under the bounded-concurrent pool (#85), outcomes returned in input order so completion order never reaches the record; and a target that drifted outside harmonise is merged three-way against the base the memory proves (#91), a merge that cannot be proven failing the pair closed. Plus — from `core/` — `http`, `chat`, `forge`, `glob`, `inputs`, `json5-parse`, `runtime`, `untrusted` and `sanitise`. The skip-unchanged classification (#75) is part of the run itself: a pair whose recorded publication still matches is skipped without a model call.

Two pure modules are **landed, wiring tracked** — merged and tested, not yet imported by the production path, therefore not behaviour a run exhibits:

| Module       | Landed as                              |
| ------------ | -------------------------------------- |
| `terms.mjs`  | deterministic terminology system (#71) |
| `report.mjs` | incremental report model (#86)         |

Do not read them as active behaviour: no run consults the terminology system, and a run's report today is the action log and the pull-request body, not `report.mjs`'s model.

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
- Dry-run report — the report is the action log and nothing is written; a pair that failed still turns a dry run red.

**Link rewriting complexity:** Relative link recomputation across directories is specified; complex paths (deep nesting, encoded segments) resolve through the same deterministic algorithm, but exotic destinations — angle-bracket destinations, backslash separators — pass through untouched in v1.

These simplifications are visible in the code today and remain the intended shape for v1; refinement beyond them is future work, not undocumented drift.

## Amendments

The specification is living text, and changes to it are recorded here rather than silently rewritten into the acceptance list above:

- **PR2:** Localized internal image references are specified and supported (the earlier "image rewriting removed" v1 limitation is superseded). Inventory completeness is a refusal contract: a truncated tree listing fails the run instead of being processed. Skip-directive syntax, protected-span boundaries, and pattern-overlap refusal are made exact.
- **Correctness hardening:** Glossary detection is specified as whole-word — a term flanked by a letter, digit or underscore never matches — and its scope excludes link machinery: inline link and image destinations, reference-definition destinations, angle autolinks, and bare scheme URLs. Newline handling is pinned by test: protected content round-trips byte-for-byte under LF, CRLF, mixed newlines, and a missing final newline. Document resolution is answered from the inventory's own index rather than a per-link scan of `pairs`.
- **Title customization (#30):** The commit subject and pull-request title — one line, always — may be renamed by the repository through the optional `pullRequest.title` config key. `{n}` and `{sourceLanguage}` are its only placeholders, substituted deterministically at publish time; absent, the built-in convention stands byte-for-byte unchanged. The pull-request body stays action-authored.

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
