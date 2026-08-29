# Development — `triage`

The architecture `triage` is built to, written before its implementation
started and kept current with it. The shared mechanism it rests on — file
discovery, the default branch, precedence — is in
[the configuration page](configuration.md); this page is the schema, the
prompt and the pipeline.

## What `triage` decides

An issue or pull request arrives; `triage` classifies it and applies labels
drawn from a sheet the repository declared. Size is not asked of the model —
it is measured from the diff. When no sheet exists at all, the classification
is written as one marker comment instead. That is the whole of what the action
may do: labels, and that comment, and nothing else.

## Trigger and permissions

`triage` runs on `issues` and `pull_request`; a real run needs `issues:
write`, `pull-requests: write` and `contents: read` (the config file); the
workflow's `permissions:` block is the bound. A write the token cannot make is
a red run, not a skip — a fork's pull request under `pull_request` carries a
read-only token, and a real run there fails loudly; `continue-on-error` is the
workflow's choice, and `dry-run` needs no write at all.

## Inputs

| Input                | Meaning                                                                                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github-token`       | the token the action writes with — the workflow's `permissions:` block is the real bound                                                                                                                         |
| `api-url`            | base URL of an OpenAI-compatible endpoint                                                                                                                                                                        |
| `api-key`            | key for that endpoint; empty is a supported keyless configuration                                                                                                                                                |
| `model`              | model id to ask                                                                                                                                                                                                  |
| `request-timeout-ms` | per-attempt timeout in milliseconds for one provider call — the attempt must complete the whole completion; raise it for endpoints that legitimately take longer than 30 seconds; default 30000, floored at 1000 |
| `config-path`        | overrides `.github/action-agents/triage/triage.json5` / `.json` — see the configuration page                                                                                                                     |
| `labels`             | narrows the sheet the config file declares, for this call site only; a name the file does not declare is a startup error, and so is a `labels:` input with no file at all, because there is nothing to narrow    |
| `dry-run`            | decide and log, write nothing — the default, so a first run cannot surprise anyone                                                                                                                               |

Timeouts come in two layers. `request-timeout-ms` bounds one provider attempt; retries,
backoff, `Retry-After` and the attempt limit are `core/src/http.mjs` policy, not inputs.
The workflow's `timeout-minutes` (5 in this repository's own `triage.yml`) remains the
outer safety boundary — the per-request value bounds one call, the job timeout bounds the
run. A value below 1000 is a startup error, so the HTTP client's disabled-timeout path is
unreachable from a workflow.

The numbers — attempts, backoff, the `Retry-After` cap, the retryable
statuses — are stated in [the core ceilings](ceilings.md#the-retry-ceiling).

## The config file

`.github/action-agents/triage/triage.json5`, in full:

```json5
{
  // The sheet, split three ways. `universal` applies to every thread; `pr`
  // and `issues` are added to it according to what is being classified.
  labels: {
    universal: {
      bug: "Reproducible incorrect behaviour — it worked before, or should have.",
      docs: "Documentation or examples only; no runtime code is affected.",
    },
    issues: {
      "good first issue": "Small, self-contained, needs no prior context.",
    },
    pr: {
      breaking: "Changes the public contract in a way consumers must act on.",
    },
  },

  // Size is measured from the diff — additions plus deletions — never asked
  // of the model. `upTo` is inclusive; rungs ascend; the final rung has no
  // `upTo` and catches everything above, so every diff lands somewhere.
  // `exclude` drops files from the measurement itself: a lockfile-only pull
  // request is small to review, so it is small here. Matching nothing is fine.
  size: {
    exclude: ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "**/*.min.js"],
    ladder: [
      { upTo: 10, label: "size/xs" },
      { upTo: 50, label: "size/s" },
      { upTo: 200, label: "size/m" },
      { upTo: 500, label: "size/l" },
      { label: "size/xl" },
    ],
  },

  // Prose, pointed at rather than embedded. Every entry is optional; these
  // paths are the defaults, and a missing document is fine.
  instructions: {
    instruction: ".github/action-agents/triage/instruction.md",
    "issue-instruction": ".github/action-agents/triage/issue-instruction.md",
    "pr-instruction": ".github/action-agents/triage/pr-instruction.md",
  },
}
```

### The effective sheet

```text
issue  →  universal ∪ issues
PR     →  universal ∪ pr
```

The `labels:` input narrows that set for one call site; it never widens it.

### Validation, all of it at startup

- a label name declared twice — in `universal` and a type map, or on two
  rungs — is refused, not reconciled;
- every `size` label must be on the PR sheet (`universal` ∪ `pr`), because a
  size label is applied like any other;
- `upTo` values must ascend, and the final rung must be the catch-all;
- a label the repository no longer has is refused before the model is called.

## The prompt

Assembled in one order, every layer after the first optional:

```text
1  system    built in: the task, the output contract, the thread type (issue
             or PR), the repository's name and description, the title
2  custom    the instruction document, if it exists
3  type      issue-instruction or pr-instruction, if it exists
4  sheet     the effective labels, each with its gloss
5  evidence  the body — and for a PR, the diff stats — wrapped as evidence:
             content an answer may be drawn from, never instruction to act on
```

Layer 1's facts come from the event payload. Layer 5 is framed as untrusted by
construction — [the doctrine](../doctrine.md) carries the reasoning — and the
ceiling does not rest on the framing anyway: whatever the prompt says, the
model's answer is matched exactly against the sheet, and an answer that is not
on it is refused and logged, never retried.

The output contract is JSON — chosen labels and a one-line rationale:

```json
{ "labels": ["bug", "docs"], "rationale": "Fails on import; tests untouched." }
```

Parsing tolerates provider drift — the same JSON5 parser the config file uses;
matching tolerates none of it: `bug `, `Bug` and `BUG` are not `bug`.

## Size, and its edge cases

Measured, not asked: additions plus deletions of the pull request's diff,
summed over the files `exclude` has not dropped. The counts are read per file
from the pull request's files listing — the event payload does not carry
them, which is why `exclude` is matched per file — and a pull request past
that listing's 3,000-file ceiling cannot be measured and is refused rather
than guessed at. The basis is review effort, not raw magnitude — a size label
signals how much there is to read, which is why a file nobody would review
does not count toward it.

- `upTo` is inclusive — 50 counted lines matches `{ upTo: 50 }`.
- the final rung has no `upTo`, and a ladder without one is a validation
  error: a required catch-all means no diff can fall off the end;
- a diff whose every file is excluded counts zero lines and lands on the
  first rung — a lockfile-only pull request is small to read, so it is small;
- renamed, binary and submodule entries contribute nothing, by GitHub's own
  accounting of them;
- an issue has no size at all; there is no diff to measure.

## The run

```text
read inputs, mask the api-key, read the runner context
  ▼
fetch the config file from the default branch          (absent = empty policy)
  ▼
build the effective sheet; validate everything above   (a failure ends the run)
  ▼
read the thread from the event: type, title, body      (PR: + per-file diff counts)
  ▼
assemble the prompt, make one chat request
  ▼
parse the answer; match each label exactly             (off-sheet → refused
log the rationale                                       and logged, no retry)
  ▼
measure size against the ladder                        (PRs only)
  ▼
dry-run → log only ─┬─ real → apply labels through the GitHub API
                    └─ no sheet → upsert the marker comment
```

Labels are applied add-only in this first version: re-classifying an edited
issue never removes a label a human chose, because the action does not yet
track which labels it applied itself. Size is the exception, and the cost is
stated — one size label is meaningful at a time and size is measured rather
than judged, so a new size replaces the old one, including one a human applied
by hand; an out-of-date size label is wrong whoever set it.

## Failure posture

A run fails loudly. The provider unreachable after retries, a config that does
not validate, an answer entirely off-sheet — the step goes red rather than
green-on-nothing, and a workflow that wants triage soft uses
`continue-on-error`. Refused labels are logged before the run ends, so the
annotation says what was refused and why.

## What `triage` never does

Close, assign, request a reviewer, mention anyone, file a verdict — each fails
the operation test (it notifies somebody, or is not one-click reversible), so
no input and no config key offers it. The action's whole write surface is
labels and one comment.

## What `triage` will need from `core/`

| Module          | Kind     | What `triage` needs of it                                                                                         |
| --------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `http.mjs`      | protocol | timeouts, retries, the failure shapes a provider really returns                                                   |
| `chat.mjs`      | protocol | one chat-completions request, and that is all                                                                     |
| `forge.mjs`     | protocol | read an issue or PR, read a default-branch file, add and remove a label, list, create and update a marked comment |
| `untrusted.mjs` | ceiling  | the evidence wrapper that layer 5 is framed by                                                                    |
| `sanitise.mjs`  | ceiling  | what model text survives into a comment                                                                           |
| `comment.mjs`   | ceiling  | the marker upsert — find by author, then by marker                                                                |

The config reader is none of these. A schema is an action's own domain, so
`triage` reads its file with the protocol primitives and keeps the knowledge
of what its keys mean; no other action imports that reader, and `core/` never
learns a key's name.
