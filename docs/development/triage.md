# Development — `triage`

The architecture `triage` is built to, written before its implementation
started and kept current with it. The shared mechanism it rests on — file
discovery, the resolved policy source, precedence — is in
[the configuration page](configuration.md); this page is the schema, the
prompt and the pipeline.

## What `triage` decides

An issue or pull request arrives; `triage` classifies it and applies labels
drawn from a set the repository's policy declares. Size is not asked of the
model — it is measured from the diff. Where a policy exists, an issue is also
evaluated: its completeness against the repository's issue forms, its
relationship to the repository's other open issues, its routing from its
form, and its severity-derived priority — decided by code from code-measured
facts, surfaced as a code-composed signal comment, and never as close,
assign or mention. When no policy exists at all, the
classification is written as one marker comment instead. That is the whole of
what the action may do: labels, and that comment, and nothing else.

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
backoff, `Retry-After` and the attempt limit are `core/transport/http.mjs` policy, not inputs.
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
  schemaVersion: 2,

  // The policy, not a registry. `use` is the whole usable set; `roles` says
  // what each label is FOR. The labels' words (description, colour) come from
  // GitHub, the source of truth, and are never duplicated here — a description
  // the model reads is GitHub's own.
  labels: {
    use: [
      "bug",
      "documentation",
      "enhancement",
      "question",
      "good first issue",
      "size/xs",
      "size/s",
      "size/m",
      "size/l",
      "size/xl",
    ],
    roles: {
      bug: "semantic-classification",
      documentation: "semantic-classification",
      enhancement: "semantic-classification",
      question: "semantic-classification",
      "good first issue": "routing-area",
    },

    // The queue marker: the label every issue form applies (and nothing else),
    // cleared by code — never a model choice — once a classification category
    // is classified. An empty array applies no marker at all.
    workflowMarkers: ["needs triage"],

    // Labels the action owns and may clear or replace: here, the size rungs.
    triageOwned: ["size/xs", "size/s", "size/m", "size/l", "size/xl"],
  },

  // Size is measured from the diff — additions plus deletions — never asked
  // of the model. `upTo` is inclusive; rungs ascend; the final rung has no
  // `upTo` and catches everything above, so every diff lands somewhere.
  // `exclude` drops files from the measurement itself: a lockfile-only pull
  // request is small to review, so it is small here. Matching nothing is fine.
  size: {
    exclude: ["pnpm-lock.yaml", "coverage/**"],
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
  },
}
```

### The effective sheet

Schema 2 offers the model the whole `labels.use` set on every thread — there is
no per-thread-type split. From that set the model is never offered the labels
it must not choose: the size-ladder rungs (measured, never chosen), the
`priority` and `workflow-marker` role labels (applied by code or cleared, never
picked), and the `needsMoreInfo` label (a code decision when an issue is judged
incomplete, not a model choice). What remains is the sheet the model chooses
from:

```text
use − (size rungs ∪ priority roles ∪ workflow-marker roles ∪ needsMoreInfo)
```

The description GitHub holds for a label is its gloss; where GitHub has no
description, the label's name is the gloss. The `labels:` input narrows the
sheet for one call site; it never widens it.

### Validation, all of it at startup

- a label name declared twice — in `use`, on two rungs, or in two roles — is
  refused, not reconciled;
- every `use` label the policy names must exist in the repository — GitHub is
  the source of truth, so a policy naming a label the repository does not have
  is refused before the model is called;
- a role must be one the action understands, and a label's role must be a label
  the policy uses;
- every `size` label must be in `labels.use`, because a size label is applied
  like any other;
- a declared workflow marker must be a non-empty label name — it is the queue
  label the issue forms apply, and triage clears it once a classification
  category is classified;
- `upTo` values must ascend, and the final rung must be the catch-all.

## The prompt

Assembled in one order, every layer after the first optional:

```text
1  system    built in: the task, the output contract, the thread type (issue
             or PR), the repository's name and description, the title
2  custom    the instruction document, if it exists
3  type      issue-instruction or pr-instruction, if it exists
4  sheet     the effective labels, each with its gloss
5  evidence  the body — for a PR the diff stats, for a sheet-mode issue the
             form facts and the bounded open-issue candidates — wrapped as
             evidence: content an answer may be drawn from, never instruction
             to act on
```

Layer 1's facts come from the event payload. Layer 5 is framed as untrusted by
construction — [the doctrine](../doctrine.md) carries the reasoning — and the
ceiling does not rest on the framing anyway: whatever the prompt says, the
model's answer is matched exactly against the sheet, and an answer that is not
on it is refused and logged, never retried.

The output contract is JSON — chosen labels, a one-line rationale, and for a
sheet-mode issue an optional dimensions object the issue evaluators consume:

````json
{
  "labels": ["bug"],
  "rationale": "Fails on import; missing steps.",
  "dimensions": {
    "quality": { "completeness": "missing-evidence", "severity": "high" },
    "relationships": { "candidates": [{ "index": 0, "type": "duplicate", "confidence": 0.9, "evidence": "same stack trace" }] }
  }
}

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

## Issue-side evaluation

An issue has no diff to measure, so its evaluation is the counterweight to
size: quality, relationships, routing and priority, decided by code from
code-measured facts and one model judgement each. The whole layer runs only
when a sheet exists and the thread is an issue — `sheet !== null &&
thread.type === "issue"` — and no-sheet runs are byte-stable: the
classification comment is exactly what it was.

**Quality.** The repository's `.github/ISSUE_TEMPLATE/` forms are read at the
resolved policy SHA (bounded to 8 templates) and the body is measured against
them by code: which form it matches, which required fields are empty, how long
the body is, how many urls it carries. The model judges two further
dimensions — `quality.completeness` (`complete` | `missing-evidence`) and
`severity` — but the code facts are never overridden by a model choice. An
issue judged missing-evidence gets the `labels.needsMoreInfo` label when that
key is set; without it, the judgement becomes part of the signal comment.

**Relationships.** The issue's title, tokenised, searches the repository's own
open issues — a READ-only call, bounded to 5 candidates, scoped to
`repo:<owner>/<repo> state:open`, with the overflow counted and disclosed. The
model judges candidates by their index in that list, choosing a known type
(`duplicate` | `related` | `likely-resolves` | `supersedes` | `similar`); judgement types outside the
vocabulary and indexes outside the list are ignored with a warning, never
coerced. The strongest judgement wins, ties broken toward the lowest candidate
number. The best relationship becomes part of the signal comment, never an
action: triage does not close a duplicate or mention its owner.

**Routing and priority.** A `labels.routing` key maps a form id to an area
label, applied by code when the matched form declares one. A
`labels.priority` key maps a severity class (`low` | `medium` | `high`) to a
label the model must not pick directly — priority is derived from the model's
severity judgement, not chosen. Both values must be in `labels.use` (and for
`priority`, carry the `priority` role), and a derived severity with no label is
logged, never invented. Where the policy declares `triageOwned`, a derived
priority label replaces the previous one by code; where the `priority` role is
single-valued and a different rung is already applied, the run fails red — the
action does not clear a label it may not own.

**The signal comment.** An issue judged incomplete, or the best relationship,
or both, surfaces as a signal comment — one marked comment in the same
namespace as the no-sheet classification, so the marker upsert keeps exactly
one of the action's comments whichever mode the last run used. Its body is
composed by code: the run's own marker, fixed sentences
(`This issue looks incomplete.`, `Possibly <type> of #<number> — <title>.`),
and the candidate title and missing-field names passed through the comment
sanitiser — no `<script>`, no surviving `@mention`, no `<!--` beyond the
action's marker. The
note says what it is: `This is a note, not a closing: the thread stays open
and nothing is closed.` The model's wording never reaches it, so a hostile
issue statement cannot steer its own signal. A thread judged complete and
unrelated gets no comment at all.

The dimensions the model answers — quality, relationships, priority — are
one optional object in the output contract, asserted by the same exact
judgement rules as labels: a value outside the declared set is refused and
logged, and a malformed dimension fails the run red.


## The run

Five stages, each a module under `triage/src/`, always in this order — the
classification path and the no-sheet comment path run through the same stages:

```text
READ        event payload, resolved policy source, the config file at that
  ▼         SHA, the effective sheet — all validated before anything else
EVIDENCE    package the deterministic facts        gatherEvidence()
  ▼         thread (title and body stay on it, framed as evidence, never
            promoted to facts), repository, policy, sheet, per-file diff
            counts, measured size
ASSESSMENT  one chat request, and only one         assess()
  ▼         the evidence-framed prompt; the answer parsed tolerantly
POLICY      judge the assessment, never the model  decide()
  ▼         pure: labels to add, the two code-removed labels to drop, what
            to log — no network, no half-way failure
DECISION    the write contract                      Decision
  ▼         labels or comment, structured removals, rendered for dry-run
MUTATION    dry-run → logs only                     mutate()
            real    → labels and one marked comment, nothing else
````

The model's answer is matched exactly against the sheet, in the Policy stage:
`bug `, `Bug` and `BUG` are not `bug`, an off-sheet label is refused and
logged rather than coerced, and an answer entirely off-sheet fails the run
red. The ceiling rests on that exact match, not on the prompt; the sheet is
the one offer the repository itself declared.

The Read stage's first act is resolving the policy source — for a pull
request the base branch, for a push the pushed branch at the pushed SHA
([the full mapping](configuration.md#which-branch-governs--the-resolved-policy-source))
— and logging one audit line, `policy source: event=… basis=… branch=… sha=…
path=…`, before any model call: every run records which rules it answered to.
The config file loads at that resolved SHA, and a `schemaVersion` major this
build does not understand refuses at startup, naming the branch, SHA and path
it was found on.

Labels are applied add-only in this first version: re-classifying an edited
issue never removes a label a human chose, because the action does not yet
track which labels it applied itself. Two labels are removed by code, never
by the model's choice. Size is one: one size label is meaningful at a time
and size is measured rather than judged, so a new size replaces the old one,
including one a human applied by hand; an out-of-date size label is wrong
whoever set it. The other is the repository's workflow marker — the queue
label every issue form applies (`needs triage` here) — cleared once a
classification category is classified, because a thread carrying a category no
longer awaits triage. The model is never told the marker's name, because it
is on no sheet offered to it.

One write the Mutation stage makes that is not a label: the marked comment.
It is either the no-sheet classification — the whole of the action's write
surface when no policy exists — or, on a sheet-mode issue, the signal comment
the issue evaluators produced. Both are the same marked comment in the same
namespace, found and upserted by the same mechanism, so however the last run
ended, exactly one of the action's comments sits on the thread. The signal
comment is composed by code and carries no model wording beyond one
sanitised candidate title; it states that the thread stays open and nothing
is closed. A run that judged nothing incomplete and nothing related writes
no comment at all.

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
labels and one marked comment — the no-sheet classification, or the issue
evaluators' signal. Hostile issue wording can steer neither: the model's
labels are matched exactly against the sheet, and the comment is composed by
code.

## What `triage` will need from `core/`

| Module          | Kind     | What `triage` needs of it                                                                                                                                                         |
| --------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.mjs`      | protocol | timeouts, retries, the failure shapes a provider really returns                                                                                                                   |
| `chat.mjs`      | protocol | one chat-completions request, and that is all                                                                                                                                     |
| `forge.mjs`     | protocol | read an issue or PR, read a default-branch file, list a tree, search the repository's own open issues (bounded), add and remove a label, list, create and update a marked comment |
| `untrusted.mjs` | ceiling  | the evidence wrapper that layer 5 is framed by                                                                                                                                    |
| `sanitise.mjs`  | ceiling  | what model text survives into a comment                                                                                                                                           |
| `comment.mjs`   | ceiling  | the marker upsert — find by author, then by marker                                                                                                                                |

The config reader is none of these. A schema is an action's own domain, so
`triage` reads its file with the protocol primitives and keeps the knowledge
of what its keys mean; no other action imports that reader, and `core/` never
learns a key's name.
