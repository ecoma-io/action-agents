# Guide: `triage`

Classify issues and pull requests against a label sheet you declare, with any
OpenAI-compatible model. Labels are drawn from the sheet and nowhere else, and
an off-sheet label the model names is refused at the point of application —
the model picks from the printed sheet, it does not invent. An answer entirely
off-sheet refuses the run rather than applying nothing; an answer partly
off-sheet applies its on-sheet half and logs the rest.

- [Install and pin](#install-and-pin)
- [Inputs](#inputs)
- [Config file](#config-file)
- [Permissions](#permissions)
- [Outputs and artifacts](#outputs-and-artifacts)
- [Cost and budget controls](#cost-and-budget-controls)
- [Failure modes](#failure-modes)
- [Recipes](#recipes)

## Install and pin

Add a workflow file under `.github/workflows/`. The minimal form:

```yaml
- uses: ecoma-io/action-agents/triage@v0.5
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    api-url: ${{ vars.LLM_API_URL }}
    api-key: ${{ secrets.LLM_API_KEY }}
    model: ${{ vars.LLM_MODEL }}
```

Pin to a floating minor (`@v0.5`), an exact version (`@v0.5.0`) or a commit SHA.
See [Getting started](getting-started.md#pinning) for the tradeoffs.

The action is referenced as the directory `triage` in the repository. The
repository root is a stub — never use `ecoma-io/action-agents@…` bare.

## Inputs

All inputs listed below. Shared inputs (`github-token`, `api-url`, `api-key`,
`model`, `request-timeout-ms`, `config-path`) are documented in the
[development configuration page](../development/configuration.md).

| Input                | Required | Default | What it does                                              |
| -------------------- | -------- | ------- | --------------------------------------------------------- |
| `github-token`       | yes      | —       | Token for GitHub API calls.                               |
| `api-url`            | yes      | —       | Base URL of an OpenAI-compatible endpoint.                |
| `api-key`            | no       | —       | Key for that endpoint. Leave unset for keyless endpoints. |
| `model`              | yes      | —       | Model id to ask.                                          |
| `request-timeout-ms` | no       | `30000` | Per-attempt timeout in milliseconds.                      |
| `config-path`        | no       | `""`    | Override the config file location.                        |
| `labels`             | no       | `""`    | Narrow the label sheet to a comma-separated subset.       |
| `dry-run`            | no       | `true`  | Decide and log, write nothing.                            |

**`labels`**: a comma-separated subset of the label sheet declared in the config
file. A name the file does not declare is a startup error. Setting this with no
file at all is also a startup error, because there is nothing to narrow. Empty
means no narrowing — with no file the classification is written as a comment.

**`dry-run`**: defaults to `true`, so a first run cannot surprise anyone. When
true, the action decides and logs the classification but writes no labels and no
comment. Flip to `false` after verifying the sheet produces the right results.

## Config file

The label sheet and behaviour belong to the repository, not to a workflow.
Declare them in a config file.

### Discovery

`triage` looks for its config file in order:

1. If `config-path` is set in the workflow, only that path is read. A path that
   does not exist on the resolved policy source is a startup error.
2. Otherwise, the default locations, tried in order:
   - `.github/action-agents/triage/triage.json5`
   - `.github/action-agents/triage/triage.json`

The first found wins; if none exist the action runs policy-empty (no sheet, no
instructions) — classification is written as a comment rather than as labels.

### Resolved policy source

The file is read at an immutable commit SHA from the **resolved policy source**:

- For `issues` events and `workflow_dispatch`: the repository's default branch.
- For `pull_request` events: the pull request's base branch.

This means a pull request cannot edit the policy that governs its own triage.
The full mechanism is in the [configuration page](../development/configuration.md).

### Keys

The file is JSON5 (comments, trailing commas, single quotes).

| Key             | Required | What it does                                                                                                                                                            |
| --------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion` | no       | Must be `1` if present. A higher major is refused at startup.                                                                                                           |
| `labels`        | no       | The label sheet: `universal` (both issues and PRs), `issues` (issues only), `pr` (pull requests only). Each is a map of label name to a one-line gloss the model reads. |
| `size`          | no       | Size measurement from the diff: `exclude` (globs), `ladder` (rungs with `upTo` and `label`). The catch-all rung has no `upTo`.                                          |
| `triageMarker`  | no       | A queue label name the action clears once a universal category is classified.                                                                                           |
| `instructions`  | no       | Paths to instruction documents: `instruction` (both), `issue-instruction` (issues only), `pr-instruction` (pull requests only).                                         |

The three sub-keys are each a map of label name to gloss string. The effective
sheet for a thread is `universal ∪ issues` for an issue, `universal ∪ pr` for a
pull request — with every label held once, so a name declared on more than one
map is refused at startup (a label that is "universal" on an issue and "PR-only"
on a pull request would be ambiguous, and the config rejects rather than
resolves it).

```json5
labels: {
  universal: {
    "bug": "A defect in shipped behaviour — unexpected crashes, incorrect results, data loss",
    "enhancement": "A change that adds new capabilities or extends existing ones",
    "documentation": "A change that only touches documentation — README, docstrings, guides",
    "refactor": "A change that restructures code without changing its observable behaviour",
  },
  issues: {
    "question": "A request for information rather than a code change — "how do I?" or "what does this mean?",
    "needs-repro": "An issue that lacks steps or a reproduction case",
  },
  pr: {
    "dependencies": "A change that only touches dependency files — lockfiles, version bumps",
  },
}
```

The gloss is the only text the model sees for each label. It is the place to
distinguish "bug" from "refactor" — the model reads the gloss, not the name.

#### `size`

Measured from the diff, never asked of the model: additions plus deletions over
files `exclude` has not dropped (renamed, binary and submodule entries contribute
zero). The ladder declares rungs from smallest to largest. The catch-all (no
`upTo`) must be the final rung.

```json5
size: {
  exclude: [
    "*.lock",
    "pnpm-lock.yaml",
  ],
  ladder: [
    { upTo: 50, label: "size/small" },
    { upTo: 200, label: "size/medium" },
    { upTo: 1000, label: "size/large" },
    { label: "size/xl" },
  ],
}
```

Every size label must also be declared in the PR sheet (`universal ∪ pr`). A
label declared on two rungs is a startup error.

#### `triageMarker`

A label name that marks a thread as untriaged. Once a universal category is
classified, the action removes this label.

```json5
triageMarker: "needs-triage",
```

#### `instructions`

Paths to instruction documents on the resolved policy source. Each is an
optional Markdown document (max 8 KiB) that the action appends to the prompt.

```json5
instructions: {
  instruction: ".github/action-agents/triage/instruction.md",
  "issue-instruction": ".github/action-agents/triage/issue-instruction.md",
  "pr-instruction": ".github/action-agents/triage/pr-instruction.md",
}
```

The defaults, when a key is absent:

| Key                 | Default path                                        |
| ------------------- | --------------------------------------------------- |
| `instruction`       | `.github/action-agents/triage/instruction.md`       |
| `issue-instruction` | `.github/action-agents/triage/issue-instruction.md` |
| `pr-instruction`    | `.github/action-agents/triage/pr-instruction.md`    |

### Complete example

```json5
{
  schemaVersion: 1,
  labels: {
    universal: {
      bug: "A defect in shipped behaviour",
      enhancement: "A change that adds new capabilities",
      documentation: "A change that only touches documentation",
    },
    issues: {
      question: "A request for information rather than a code change",
    },
    pr: {
      dependencies: "A change that only touches dependency files",
    },
  },
  size: {
    exclude: ["*.lock"],
    ladder: [{ upTo: 50, label: "size/small" }, { label: "size/xl" }],
  },
  triageMarker: "needs-triage",
}
```

### Byte ceilings

| Boundary             | Value  |
| -------------------- | ------ |
| Config file          | 64 KiB |
| Instruction document | 8 KiB  |

An oversized config file or instruction document is a red refusal, not a
truncated read.

## Permissions

```yaml
permissions:
  contents: read
  issues: write
  pull-requests: write
```

- `contents: read` — reading the config file and instruction documents.
- `issues: write` — applying labels on issues.
- `pull-requests: write` — applying labels on pull request threads. This scope
  is load-bearing: GitHub's API refuses the labels endpoint on a pull request
  number without it, even though labels are conceptually an issue operation.

A fork's pull request carries a read-only token — the action fails loudly rather
than silently skipping, because without write access it cannot do its job.

## Outputs and artifacts

**Labels** are **add-only for the classification (sheet) labels** — the action
never removes a category a human or another action applied, and only ever adds
its own. The two deliberate exceptions are code-driven, never model choices:
the **size** label is a replacement (the measured rung supersedes whichever
hand last applied a size on the thread), and the `triageMarker` queue label is
removed once the run classifies a universal category.

**Marker comment**: when the config file has no label sheet (policy-empty), the
action writes a single comment with the classification text. This is the same
route a real sheet uses to explain its labels, but with no sheet the comment
_is_ the output rather than a side-channel.

**Size label**: when the `size` key is configured and the event is a pull
request, the action measures the diff against the ladder and applies the
matching size label.

## Cost and budget controls

| Control              | Default | Effect                                                               |
| -------------------- | ------- | -------------------------------------------------------------------- |
| `dry-run`            | `true`  | No API calls to GitHub for writing. Model calls still count.         |
| `request-timeout-ms` | `30000` | Per-attempt timeout. Raise for endpoints that are legitimately slow. |

The action makes exactly one model call per thread per run. There is no agent
loop — the model reads the thread body, the config sheet, and the instructions,
and answers in one round.

## Failure modes

| Symptom                                      | Cause                                                                 | Resolution                                                           |
| -------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| "Label X is not in the sheet"                | The model chose a label the config does not declare.                  | Declare it in the config, or remove it from the `labels:` input.     |
| "No config file at PATH"                     | `config-path` set to a path that does not exist.                      | Fix the path, or remove `config-path` and use the default locations. |
| "schemaVersion Y is not supported"           | Config file declares a schema version this build does not understand. | Downgrade `schemaVersion` or update the action tag.                  |
| "Size label X is declared on multiple rungs" | A label appears on two ladder entries.                                | Deduplicate.                                                         |
| "Instruction document exceeds 8 KiB"         | An instruction document is too large.                                 | Shorten it.                                                          |
| "Config file exceeds 64 KiB"                 | The config file is too large.                                         | Reduce it — a 64 KiB policy is already very long prose.              |
| Provider unreachable                         | The `api-url` endpoint did not respond within `request-timeout-ms`.   | Check the endpoint, the network, and the timeout value.              |
| HTTP 403 on labels                           | `pull-requests: write` scope missing.                                 | Add the scope to the workflow's `permissions:` block.                |

## Recipes

### Basic label sheet

Classify every thread with four universal categories and no size measurement.

```json5
{
  labels: {
    universal: {
      bug: "A defect in shipped behaviour",
      enhancement: "A change that adds new capabilities",
      documentation: "A change that only touches documentation",
      refactor: "A change that restructures code without changing observable behaviour",
    },
  },
}
```

### Size from the diff

Add size labels to pull requests using a three-rung ladder.

```json5
{
  labels: {
    universal: {
      bug: "A defect",
      enhancement: "New capabilities",
    },
    pr: {
      "size/small": "At most 50 changed lines",
      "size/large": "More than 50 changed lines",
    },
  },
  size: {
    exclude: ["*.lock"],
    ladder: [{ upTo: 50, label: "size/small" }, { label: "size/large" }],
  },
}
```

### Narrowing per call site

Use the `labels:` workflow input to limit one workflow to bugs and enhancements
only, while another workflow covers the full sheet.

```yaml
- uses: ecoma-io/action-agents/triage@v0.5
  with:
    labels: "bug,enhancement"
```

A name not in the config file is a startup error, so the narrow list is verified
at the same point the sheet is — before the first model call.

### Queue marker

Mark every unclassified issue with `needs-triage` and let the action remove it
once a universal category is assigned.

```json5
{
  triageMarker: "needs-triage",
  labels: {
    universal: {
      bug: "A defect",
      enhancement: "New capabilities",
    },
  },
}
```

---

For the architecture this action is built to — the prompt pipeline, the
classification flow — read the [development page](../development/triage.md).
