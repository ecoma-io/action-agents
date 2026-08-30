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
- [Events](#events)
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

| Key             | Required | What it does                                                                                                                                                         |
| --------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion` | no       | Must be `2` if present. A higher major is refused at startup. A schema-1 file (`labels.{universal,issues,pr}` + `triageMarker`) is migrated on read, with a warning. |
| `labels`        | no       | The policy block: `use` (the usable set), `roles` (what each label is for), `exclusive`, `workflowMarkers`, `triageOwned`, `priority`. See below.                    |
| `size`          | no       | Size measurement from the diff: `exclude` (globs), `ladder` (rungs with `upTo` and `label`). The catch-all rung has no `upTo`.                                       |
| `instructions`  | no       | Paths to instruction documents: `instruction` (both), `issue-instruction` (issues only), `pr-instruction` (pull requests only).                                      |

#### `labels` — a policy, not a registry

Schema 2 makes GitHub the source of truth for a label's words (its description
and colour) and the config a **policy** that decides what each label is _for_.
The config names labels; it never re-describes them, so the sheet does not drift
from the repository.

- **`use`** — the whole usable set, as an array of label names. Every label the
  action may apply must be here; a duplicate name is a startup error. The model
  chooses from this set (minus the labels it is never offered — see below).
- **`roles`** — a map of label name to role:
  - `semantic-classification` — a category. Once one is classified, a workflow
    marker is cleared (see `workflowMarkers`).
  - `routing-area` — a routing label (e.g. `good first issue`), not a category.
  - `priority` — a priority signal; never offered to the model as a choice.
  - `workflow-marker` — a queue marker (see `workflowMarkers`); never offered.
  - `triage-owned` — a label the action owns and may clear or replace.
- **`exclusive`** — an array of role names that form mutually exclusive groups.
  Each group must be carried by at least one `roles` entry.
- **`workflowMarkers`** — an array of queue-marker label names. Once a
  `semantic-classification` label is classified, the action clears the marker.
  The model is never told the marker's name.
- **`triageOwned`** — an array of label names the action owns and may clear or
  replace (for example the size rungs it measures and supersedes).
- **`priority`** — a map of name to ordering metadata.

The labels the model is offered are `use` minus the size-ladder labels and the
`priority`/`workflow-marker` role labels: the rungs are measured, not chosen,
and the queue marker is cleared, not picked.

```json5
labels: {
  use: [
    "bug",
    "enhancement",
    "documentation",
    "refactor",
    "question",
    "dependencies",
    "priority/high",
    "priority/low",
  ],
  roles: {
    bug: "semantic-classification",
    enhancement: "semantic-classification",
    documentation: "semantic-classification",
    refactor: "semantic-classification",
    question: "routing-area",
    dependencies: "routing-area",
    "priority/high": "priority",
    "priority/low": "priority",
  },
  exclusive: ["semantic-classification"],
  workflowMarkers: ["needs-triage"],
  triageOwned: ["needs-triage"],
}
```

For every label the policy names, the action reads GitHub's own description at
startup and prints it as the gloss the model reads. A label the repository does
not have is a startup error — a policy naming a label GitHub does not hold can
never classify it. Where GitHub has no description, the label's name is used.

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

Every size label must also be declared in `labels.use`, because a size label is
applied like any other. A label declared on two rungs is a startup error.

#### `workflowMarkers`

A queue marker is a label that marks a thread as untriaged. Once a
`semantic-classification` label is classified, the action removes the marker. The
model is never told the marker's name — it is on no offered sheet.

```json5
labels: {
  workflowMarkers: ["needs-triage"],
}
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
  schemaVersion: 2,
  labels: {
    use: ["bug", "enhancement", "documentation", "question", "size/small", "size/xl"],
    roles: {
      bug: "semantic-classification",
      enhancement: "semantic-classification",
      documentation: "semantic-classification",
      question: "routing-area",
    },
    exclusive: ["semantic-classification"],
    workflowMarkers: ["needs-triage"],
    triageOwned: ["size/small", "size/xl"],
  },
  size: {
    exclude: ["*.lock"],
    ladder: [{ upTo: 50, label: "size/small" }, { label: "size/xl" }],
  },
  instructions: {
    instruction: ".github/action-agents/triage/instruction.md",
  },
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
hand last applied a size on the thread), and a **workflow marker** queue label is
removed once the run classifies a classification category.

**Marker comment**: when the config file has no label sheet (policy-empty), the
action writes a single comment with the classification text. This is the same
route a real sheet uses to explain its labels, but with no sheet the comment
_is_ the output rather than a side-channel.

**Size label**: when the `size` key is configured and the event is a pull
request, the action measures the diff against the ladder and applies the
matching size label.

## Events

`triage` decides exactly which events re-run its pipeline. Its expensive work
is one model call plus the evidence reads that feed it, so it only pays for
them when the event could have changed triage-relevant evidence: the thread's
content, its diff, its draft state, or the queue state the
`labels.workflowMarkers` lifecycle keys on. Everything else logs one audit
line — `triage: event issues.labeled → skip — …` — and writes nothing. The
event matrix is decided from the payload and your config alone, before any
read past the config; a rerun of an unchanged thread re-derives the same
decision.

Which actions re-triage, per event:

| Event          | Action re-triaged                                                                         |
| -------------- | ----------------------------------------------------------------------------------------- |
| `issues`       | `opened`, `edited`, `reopened`, `labeled` (see below)                                     |
| `pull_request` | `opened`, `edited`, `synchronized`, `ready_for_review`, `reopened`, `labeled` (see below) |
| either         | a missing or unlisted action (re-triaged conservatively, never skipped)                   |

Which actions skip, writing nothing:

| Event          | Action skipped                                                  |
| -------------- | --------------------------------------------------------------- |
| `issues`       | `closed`, `transferred`, `milestoned`, `unlabeled`              |
| `pull_request` | `closed`, `review_requested`, `converted_to_draft`, `unlabeled` |

`labeled` re-triages only when the change could move the queue lifecycle:
applying the queue marker (`labels.workflowMarkers`), or applying a
`semantic-classification` label to a thread still carrying the marker — the
stuck-queue case where a category exists but the marker remains. Applying any
other label skips: a label the policy does not own or read cannot change what
the model would classify. `unlabeled` always skips: removing a label changes
no content evidence, and removing the queue marker is a human dequeue triage
respects rather than rewrites.

An event that is not on the matrix is re-triaged, never silently skipped — a
payload this action was not built for is not classified as a no-op. To run
only on the events that matter, list them in your workflow's `on:` block; the
matrix is the action's belt-and-braces guard for whatever your trigger sends
it.

## Cost and budget controls

| Control              | Default | Effect                                                               |
| -------------------- | ------- | -------------------------------------------------------------------- |
| `dry-run`            | `true`  | No API calls to GitHub for writing. Model calls still count.         |
| `request-timeout-ms` | `30000` | Per-attempt timeout. Raise for endpoints that are legitimately slow. |

The action makes exactly one model call per thread per run. There is no agent
loop — the model reads the thread body, the config sheet, and the instructions,
and answers in one round.

## Failure modes

| Symptom                                                      | Cause                                                                 | Resolution                                                           |
| ------------------------------------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| "Label X is not in the sheet"                                | The model chose a label the config does not declare.                  | Declare it in the config, or remove it from the `labels:` input.     |
| "No config file at PATH"                                     | `config-path` set to a path that does not exist.                      | Fix the path, or remove `config-path` and use the default locations. |
| "schemaVersion Y is not supported"                           | Config file declares a schema version this build does not understand. | Downgrade `schemaVersion` or update the action tag.                  |
| "Size label X is declared on multiple rungs"                 | A label appears on two ladder entries.                                | Deduplicate.                                                         |
| "declares the label 'X', which the repository does not have" | A policy names a label GitHub does not hold.                          | Create the label in GitHub, or remove it from `labels.use`.          |
| "Instruction document exceeds 8 KiB"                         | An instruction document is too large.                                 | Shorten it.                                                          |
| "Config file exceeds 64 KiB"                                 | The config file is too large.                                         | Reduce it — a 64 KiB policy is already very long prose.              |
| Provider unreachable                                         | The `api-url` endpoint did not respond within `request-timeout-ms`.   | Check the endpoint, the network, and the timeout value.              |
| HTTP 403 on labels                                           | `pull-requests: write` scope missing.                                 | Add the scope to the workflow's `permissions:` block.                |

## Recipes

### Basic label sheet

Classify every thread with four classification categories and no size
measurement.

```json5
{
  schemaVersion: 2,
  labels: {
    use: ["bug", "enhancement", "documentation", "refactor"],
    roles: {
      bug: "semantic-classification",
      enhancement: "semantic-classification",
      documentation: "semantic-classification",
      refactor: "semantic-classification",
    },
    exclusive: ["semantic-classification"],
  },
}
```

### Size from the diff

Add size labels to pull requests using a three-rung ladder.

```json5
{
  schemaVersion: 2,
  labels: {
    use: ["bug", "enhancement", "size/small", "size/large"],
    roles: {
      bug: "semantic-classification",
      enhancement: "semantic-classification",
    },
    triageOwned: ["size/small", "size/large"],
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
once a classification category is assigned.

```json5
{
  schemaVersion: 2,
  labels: {
    use: ["bug", "enhancement"],
    roles: {
      bug: "semantic-classification",
      enhancement: "semantic-classification",
    },
    workflowMarkers: ["needs-triage"],
  },
}
```

---

For the architecture this action is built to — the prompt pipeline, the
classification flow — read the [development page](../development/triage.md).
