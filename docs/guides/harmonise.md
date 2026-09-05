# Guide: `harmonise`

Keep the multilingual versions of a repository's documentation semantically in
step with one another. It discovers translatable pairs, translates source
changes into each target language, and opens a pull request with the results —
never touching the source, and never editing a target that drifted outside the
action's own history.

- [Install and pin](#install-and-pin)
- [Inputs](#inputs)
- [Config file](#config-file)
- [Permissions](#permissions)
- [Outputs and artifacts](#outputs-and-artifacts)
- [Manual-edit protection](#manual-edit-protection)
- [Skip directives](#skip-directives)
- [Cost and budget controls](#cost-and-budget-controls)
- [Failure modes](#failure-modes)
- [Recipes](#recipes)

## Install and pin

Add a workflow file under `.github/workflows/`. The minimal form:

```yaml
- uses: ecoma-io/action-agents/harmonise@v0.5
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    api-url: ${{ vars.LLM_API_URL }}
    api-key: ${{ secrets.LLM_API_KEY }}
    model: ${{ vars.LLM_MODEL }}
    source-language: en
```

Pin to a floating minor (`@v0.5`), an exact version (`@v0.5.0`) or a commit SHA.
See [Getting started](getting-started.md#pinning) for the tradeoffs.

The action is referenced as the directory `harmonise` in the repository.

`harmonise` runs on `schedule` and `workflow_dispatch` — it is not a
per-pull-request action. A pull request opened by `GITHUB_TOKEN` gets no
workflow runs (GitHub suppresses events its own token caused), so consumers who
want the harmonise PR to run CI mint a
[GitHub App token](https://docs.github.com/en/apps/creating-github-apps)
and pass it as `github-token`.

### Requirements

- A config file is **required**. No file is a red refusal — a run with no
  language map has nothing to do.
- `source-language` must be declared in the `languages` map in the config file.
- Each target language must have a file-name pattern declared in the `languages`
  map.

## Inputs

All inputs listed below. Shared inputs are documented in the
[development configuration page](../development/configuration.md).

| Input                | Required | Default             | What it does                                                            |
| -------------------- | -------- | ------------------- | ----------------------------------------------------------------------- |
| `github-token`       | yes      | —                   | Token for GitHub API calls.                                             |
| `api-url`            | yes      | —                   | Base URL of an OpenAI-compatible endpoint.                              |
| `api-key`            | no       | —                   | Key for that endpoint. Leave unset for keyless endpoints.               |
| `model`              | yes      | —                   | Model id to ask.                                                        |
| `request-timeout-ms` | no       | `120000`            | Per-attempt timeout in milliseconds.                                    |
| `config-path`        | no       | `""`                | Override the config file location.                                      |
| `source-language`    | yes      | —                   | BCP-47 tag of the source-of-truth language.                             |
| `documents`          | no       | `""`                | Comma-separated globs narrowing which source documents to keep in step. |
| `dry-run`            | no       | `true`              | Report drift, propose nothing.                                          |
| `record-path`        | no       | `.harmonise-record` | Directory for the machine-readable run record.                          |

**`source-language`**: the key of the `languages` map every other version is
judged against. Must be declared in the config file.

**`documents`**: comma-separated globs narrowing which source documents this run
keeps in step. Empty means all of them — the config's language map defines the
space, this only filters it.

**`dry-run`**: defaults to `true`, because the output of a real run is a pull
request against your documentation rather than a comment. Flip to `false` after
verifying the language map produces correct results.

## Config file

A config file is mandatory — `harmonise` refuses to run without one.

### Discovery

`harmonise` looks for its config file in order:

1. If `config-path` is set in the workflow, only that path is read.
2. Otherwise, the default locations, tried in order:
   - `.github/action-agents/harmonise/harmonise.json5`
   - `.github/action-agents/harmonise/harmonise.json`

The first found wins; if none exist the action refuses at startup.

### Resolved policy source

Same as the other actions: the file is read from the default branch at an
immutable commit SHA. The full mechanism is in the
[configuration page](../development/configuration.md).

### Keys

The file is JSON5.

| Key              | Required | Default | What it does                                                                     |
| ---------------- | -------- | ------- | -------------------------------------------------------------------------------- |
| `schemaVersion`  | no       | —       | Must be `1` if present. A higher major is refused.                               |
| `sourceLanguage` | yes      | —       | The key of `languages` every other version is judged against.                    |
| `languages`      | yes      | —       | Map of BCP-47 tag to file-name pattern (glob).                                   |
| `ignore`         | no       | `[]`    | Glob patterns excluding generated or untranslated documents from the source set. |
| `glossary`       | no       | `[]`    | Terms protected verbatim in every translation. Exact-match.                      |
| `instructions`   | no       | —       | Paths to instruction documents.                                                  |
| `concurrency`    | no       | `2`     | How many translatable pairs may be in flight at once. Max `4`.                   |
| `pullRequest`    | no       | —       | Custom pull-request title template.                                              |
| `assets`         | no       | —       | Templates for language-specific image variants.                                  |

#### `languages`

The map of BCP-47 tag to file-name pattern. The source language's pattern is how
source documents are discovered; each target language's pattern tells the action
where to write the translation.

```json5
languages: {
  en: "**/{document}.md",
  vi: "**/{document}.vi.md",
  de: "**/{document}.de.md",
}
```

A pattern must contain exactly one `{document}` placeholder — the
`{document}` is replaced with the document's slug. For example,
`**/{document}.vi.md` matches `README.vi.md` from `README.md` and
`guides/triage.vi.md` from `guides/triage.md`.

#### `sourceLanguage`

Must be a key of `languages`. Every other language in the map is a target.

```json5
sourceLanguage: "en",
```

#### `ignore`

Glob patterns excluding files from the source set. A source file matched by any
pattern is never translated.

```json5
ignore: [
  "node_modules/**",
  "generated/**",
],
```

#### `glossary`

An array of terms the model must preserve verbatim in every translation.
Exact-match, case-sensitive.

```json5
glossary: [
  "ecoma-io",
  "action-agents",
  "SECURITY.md",
],
```

Control characters (`\0`, newlines, tabs) are refused at startup — they are never
an intentional glossary entry.

#### `instructions`

Paths to instruction documents on the resolved policy source.

```json5
instructions: {
  instruction: ".github/action-agents/harmonise/instruction.md",
  "language-instructions": {
    vi: ".github/action-agents/harmonise/vi-instruction.md",
    de: ".github/action-agents/harmonise/de-instruction.md",
  },
}
```

| Sub-key                       | Default path                                     |
| ----------------------------- | ------------------------------------------------ |
| `instruction`                 | `.github/action-agents/harmonise/instruction.md` |
| `language-instructions.<tag>` | Not set — optional per-language instructions.    |

The `instruction` document applies to every pair. A `language-instructions`
entry applies to one language's pairs, and every tag it names must be a key of
`languages`. Both are optional. The prompt carries the general instruction as
its custom layer and this language's instruction, if one exists, as the layer
after it. Only these two sub-keys exist — any other key is refused at startup.

#### `concurrency`

How many translatable pairs one run may translate concurrently. Defaults to `2`,
capped at `4`. Each pair has its own model call; concurrent pairs share the
context budget but each reads its own source document.

```json5
concurrency: 3,
```

#### `pullRequest`

Override the pull-request title template. Two placeholders are available:
`{n}` (the number of changed documents) and `{sourceLanguage}` (the source
language tag).

```json5
pullRequest: {
  title: "i18n: sync {n} documents from {sourceLanguage}",
}
```

The default is `"harmonise: {n} documents from {sourceLanguage}"`. A rendered
title longer than 200 characters is refused.

#### `assets`

Templates naming where a language's image variants live, relative to the
document's directory. Each layout is a string with a `{lang}` placeholder.

```json5
assets: {
  layouts: ["assets/{lang}/"],
}
```

The default is `["assets/{lang}/"]`.

### Complete example

```json5
{
  schemaVersion: 1,
  sourceLanguage: "en",
  languages: {
    en: "**/{document}.md",
    vi: "**/{document}.vi.md",
    de: "**/{document}.de.md",
  },
  ignore: ["node_modules/**", "generated/**"],
  glossary: ["ecoma-io", "action-agents"],
  concurrency: 2,
  pullRequest: {
    title: "i18n: sync {n} documents from {sourceLanguage}",
  },
}
```

### Byte ceilings

| Boundary             | Value  |
| -------------------- | ------ |
| Config file          | 64 KiB |
| Instruction document | 8 KiB  |

## Permissions

```yaml
permissions:
  contents: write
  pull-requests: write
```

- `contents: write` — reading source and target documents, writing the proposal
  branch (`harmonise/<source-language>`).
- `pull-requests: write` — opening the harmonise pull request.

`contents: write` is wider than the other actions' permissions because harmonise
writes a commit. The write is bounded in code: exactly one branch of its own
naming (`harmonise/<source-language>`), force-upserted with optimistic locking,
and exactly one pull request. The model never names the branch, and no other
branch or ref is touched.

When using `GITHUB_TOKEN` (rather than an App token), the pull request opened by
the action does not trigger workflow runs. To run CI on the harmonise PR, mint a
GitHub App token and pass it as `github-token` — see the
[dogfood workflow](https://github.com/ecoma-io/action-agents/blob/main/.github/workflows/harmonise.yml)
for the pattern.

## Outputs and artifacts

**Pull request**: one pull request per run, titled with the configured or
default template. The branch is `harmonise/<source-language>`, force-upserted
with optimistic locking. A dry run proposes nothing.

**Report in the PR body**: the pull request body documents every pair — source
document, target document, change type (new, updated, unchanged, noop), and any
recovery action taken.

**Run record**: one JSON file per run under `record-path` (default
`.harmonise-record`), named after the base commit the run pinned to — the
outcome, the pair accounting and the pull request it wrote, never document or
model text. This repository's own workflow uploads it as the
`harmonise-run-record` artifact; the contract is on the
[development page](../development/harmonise.md#the-run-record).

### Pull request lifecycle

1. The action discovers all translatable pairs from the source documents on the
   default branch.
2. For each pair where the source changed since the last run, it translates the
   new content using the model.
3. It writes one commit to `harmonise/<source-language>`.
4. It opens (or updates) a pull request from that branch to the default branch.
5. The pull request runs CI like any contributor's, if `github-token` is an App
   token.

### When a pair is re-translated

A pair is re-translated when its source bytes changed, when the translation
policy moved — the glossary, any instruction document, the transformation
version — or when the **model identity** changed: the model id and the
endpoint the ask went to are part of the policy digest every state record
carries, so switching model or provider re-runs every affected pair instead
of silently carrying over wording the old model produced. The same force
applies once on upgrade, when the digest gains the identity fields.

## Manual-edit protection

A target document that was edited by hand outside the action's own history is
protected from being overwritten. The action detects drift by comparing the
target against the base the translation memory proves: if the target's current
content differs from what the action last wrote, the merge cannot be proven and
the pair fails closed — the action reports the conflict and moves on.

This means a human can edit a translated document and the action will not
silently overwrite those edits. Resolve the conflict manually, then the next run
sees the new base and proceeds.

The three-way merge is deterministic and code-owned: the action reads the
original source, the last-translated target, and the current target, and
produces a merged result or a refusal. The development page has the full
algorithm.

## Skip directives

A source document can protect its own lines from translation with HTML-comment
directives in the body. A protected region survives the translate step
byte-for-byte: it is replaced by a placeholder before the model call and
restored afterwards, by the same mechanism the glossary uses. There are three
forms, each a whole line whose only content is the comment:

```markdown
<!-- harmonise:skip -->
<!-- harmonise:skip-start -->
<!-- harmonise:skip-end -->
```

`<!-- harmonise:skip -->` protects the next non-blank line. The `skip-start`
and `skip-end` directives bracket a region — markers included — that is
preserved whole.

Directives are honored from the source document only; the model cannot
introduce one. A malformed directive fails the run — an unclosed or nested
region, a `skip-end` with no open `skip-start`, or any other whole-line
`<!-- harmonise:… -->` comment is refused, never silently ignored. Comment-like
text inside a fenced code block or mid-line is content, not a directive, and is
never validated as one. The full validation rules are on the
[development page](../development/harmonise.md#skip-directives).

## Cost and budget controls

| Control              | Default  | Effect                                                  |
| -------------------- | -------- | ------------------------------------------------------- |
| `concurrency`        | `2`      | How many pairs translate at once. Max `4`.              |
| `dry-run`            | `true`   | Report drift, propose nothing. Model calls still count. |
| `request-timeout-ms` | `120000` | Per-attempt timeout for one provider call.              |

Each translatable pair that actually changed makes one model call (translation)
plus potentially a recovery call. Pairs that are unchanged or noop make no model
calls — the action detects staleness from the diff before asking the model.

## Failure modes

| Symptom                                                  | Cause                                                 | Resolution                                                                         |
| -------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| "No config file found"                                   | No file at the configured or default locations.       | Create `.github/action-agents/harmonise/harmonise.json5`.                          |
| "sourceLanguage not found in languages"                  | `sourceLanguage` is not a key of the `languages` map. | Add the source language to the map, or change `sourceLanguage`.                    |
| "Language pattern must contain exactly one `{document}`" | A language's pattern is malformed.                    | Fix the pattern — `**/{document}.vi.md` is correct.                                |
| "Glossary entry contains control characters"             | A glossary term has `\0`, newlines or tabs.           | Remove the control characters.                                                     |
| "Config file exceeds 64 KiB"                             | Config file too large.                                | Reduce it.                                                                         |
| "Instruction document exceeds 8 KiB"                     | An instruction document is too large.                 | Shorten it.                                                                        |
| "PR title exceeds 200 characters"                        | The rendered title is too long.                       | Shorten the template or the number of changed documents.                           |
| "Manual-edit conflict"                                   | A target document was edited outside the action.      | Resolve the conflict manually. The action reports the pair as failed and moves on. |
| "Provider unreachable"                                   | The `api-url` endpoint did not respond.               | Check the endpoint and the timeout.                                                |

## Recipes

### Basic bilingual setup

English source, Vietnamese target.

```json5
{
  sourceLanguage: "en",
  languages: {
    en: "**/{document}.md",
    vi: "**/{document}.vi.md",
  },
  glossary: ["action-agents", "ecoma-io"],
}
```

### Multilingual with custom instructions

English source, three targets, per-language instructions.

```json5
{
  sourceLanguage: "en",
  languages: {
    en: "**/{document}.md",
    vi: "**/{document}.vi.md",
    de: "**/{document}.de.md",
    ja: "**/{document}.ja.md",
  },
  ignore: ["node_modules/**"],
  glossary: ["action-agents", "ecoma-io", "SECURITY.md"],
  instructions: {
    instruction: ".github/action-agents/harmonise/instruction.md",
    "language-instructions": {
      vi: ".github/action-agents/harmonise/vi-instruction.md",
    },
  },
}
```

### App token for CI on the harmonise PR

```yaml
jobs:
  harmonise:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          persist-credentials: false
          fetch-depth: 1

      - name: Mint a GitHub App token
        id: app-token
        uses: actions/create-github-app-token@v3
        with:
          app-id: ${{ secrets.APP_ID }}
          private-key: ${{ secrets.APP_KEY }}

      - uses: ecoma-io/action-agents/harmonise@v0.5
        with:
          github-token: ${{ steps.app-token.outputs.token }}
          api-url: ${{ vars.LLM_API_URL }}
          api-key: ${{ secrets.LLM_API_KEY }}
          model: ${{ vars.LLM_MODEL }}
          source-language: en
```

### Dry-run first

Verify what a run would change without touching anything.

```yaml
- uses: ecoma-io/action-agents/harmonise@v0.5
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    api-url: ${{ vars.LLM_API_URL }}
    api-key: ${{ secrets.LLM_API_KEY }}
    model: ${{ vars.LLM_MODEL }}
    source-language: en
    # dry-run defaults to true — no proposal, no PR
```

---

For the architecture this action is built to — the document model, the prompt,
the pull request lifecycle — read the [development page](../development/harmonise.md).
