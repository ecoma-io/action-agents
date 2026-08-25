# Development — `review`

Design, not behaviour: nothing on this page runs yet. This is the architecture
`review` is to be built to, written before implementation starts. The shared
mechanism it rests on — file discovery, the default branch, precedence — is in
[the configuration page](configuration.md). The design was benchmarked against
the configuration surfaces of the two established AI reviewers, CodeRabbit and
cubic; where an option of theirs is absent here, the reason is recorded rather
than left to look like an oversight.

## What `review` decides

A pull request arrives; `review` reads what it needs to judge it — the diff
first, then the files around the change, following its own judgement — and
writes its findings as one comment. It never files a verdict: no approval, no
request-for-changes, ever, from any configuration. The reviewer a maintainer
cannot talk out of a red check is the one thing this action refuses to be.

## Trigger and surface

`review` runs on `pull_request`, raised from within the repository. Unlike
`triage` and `harmonise` its subject is a working tree, so the calling
workflow checks the pull request out — safe under `pull_request` precisely
because a fork's pull request gets a read-only token and no secrets. Combining
`pull_request_target` with a checkout of the pull request's head is the
"pwn request" pattern; the security policy at the repository root carries that
argument, and this action is designed so that nothing about it encourages the
arrangement.

Permissions: `contents: read` and `pull-requests: write` — a comment is the
whole write surface.

A draft pull request is skipped with a log line and nothing else: a draft says
"not ready", and reviewing it anyway reviews something the author has not
finished saying.

## Inputs

| Input            | Meaning                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `github-token`   | the token the action writes with — the workflow's `permissions:` block is the real bound         |
| `api-url`        | base URL of an OpenAI-compatible endpoint                                                        |
| `api-key`        | key for that endpoint; empty is a supported keyless configuration                                |
| `model`          | model id to ask                                                                                  |
| `config-path`    | overrides `.github/action-agents/review/review.json5` / `.json` — see the configuration page     |
| `max-turns`      | ceiling on agent turns — reaching it ends the review and says so; the default is 30              |
| `context-window` | the configured model's token budget — the agent compacts before reaching it; default 128000      |
| `dry-run`        | review and log, comment nothing — default false, because the comment is the action's only output |

The seed `action.yaml` carries an `instructions-path` input; the config file's
instruction documents supersede it. Nothing has shipped, so the input is
reshaped now rather than deprecated later.

## The config file

`.github/action-agents/review/review.json5`, in full:

```json5
{
  // The inclusion bar for findings — one dial, not a wall of toggles.
  //   low     concerns only
  //   medium  concerns and nits, nits collapsed   (the default)
  //   high    everything, nothing collapsed — style observations as nits
  // Strictness is not tone: how findings are worded lives in the
  // instruction document, not here.
  strictness: "medium",

  // The language findings are written in, as a BCP-47 tag.
  language: "en",

  // Paths the reviewer never reads, never comments on — and never counts:
  // ignored files are dropped from the maxDiffLines basis too. The guard
  // exists to bound reading effort, and an ignored file costs none.
  ignore: ["pnpm-lock.yaml", "dist/**", "**/*.min.js"],

  // A diff with more than this many counted lines is refused outright.
  // A half-reviewed monster presented as a complete review is the worse
  // failure, and this is how it is made impossible.
  maxDiffLines: 5000,

  // Path-scoped rubrics. `include` takes globs, and `!` negates within them.
  // A rule's document is its name in the log, and it must exist on the
  // default branch — declaring a rule and leaving its file absent is a
  // startup error. Only the convention paths under `instructions` are
  // optional; a declared rule is required.
  rules: [
    {
      include: ["src/**/*.ts", "!src/generated/**"],
      instruction: ".github/action-agents/review/rules/typescript.md",
    },
  ],

  // Prose, pointed at rather than embedded; this path is the default.
  instructions: {
    instruction: ".github/action-agents/review/instruction.md",
  },
}
```

### Validation, all of it at startup

- `strictness` is one of the three values, `language` a well-formed BCP-47
  tag, `maxDiffLines` at least 1;
- every rule's instruction document must exist on the default branch;
- a rule that matches no changed file in a given pull request is dormant, not
  an error — rules are declared for the repository, not for one diff.

## The tool surface

The doctrine raises this as a ceiling question; here is the answer. The loop's
tools are **fixed in code, and no input and no config key adds one** — a tool
an author cannot add is a tool an attacker cannot aim.

```text
read_file   one file's content, by path relative to the workspace
list_files  the files under a path
search      lines containing a fixed substring, with file and line
```

All three are read-only. Every path is resolved through `realpath` and refused
unless it lands inside `GITHUB_WORKSPACE`; `.git` is refused outright, because
it holds the credential the checkout was performed with. No shell, no network,
no write, ever. Each tool result enters the transcript wrapped as evidence —
a file's content is data about the change, never an instruction to the
reviewer. Every tool result is capped (64 KiB) and the cut is marked, never
silent; `search` matches a fixed substring, not a regular expression — a pattern
language is an unbounded compute surface, and a bounded tool is the point of a
fixed list; at most 200 matches per search.

## The loop, and the prompt

Assembled in one order, then extended as the loop runs:

```text
1  system    the task, the output contract, the repository's name and
             description, the pull request's title and base…head range
2  custom    the instruction document, if it exists
3  rules     every rule whose include matches a changed file, its document
4  evidence  the diff — then, as the loop runs, each tool result
```

The model asks for tools until it stops asking or `max-turns` is reached. The
transcript is compacted before `context-window`, deterministically — an
inventory of what was read (paths and ranges) replaces the raw results, and
findings so far are kept verbatim. Compaction is code, not a model call: a
summary a model wrote is never allowed to become context the loop trusts.
Reaching `max-turns` ends the review and **the comment says it is partial**; a
partial review presented as a complete one is the one dishonesty this design
refuses.

## The output contract

```json
{
  "findings": [
    { "severity": "concern", "file": "src/http.mjs", "line": 42, "message": "…" },
    { "severity": "nit", "file": "src/chat.mjs", "line": 7, "message": "…" }
  ],
  "summary": "one line, sanitised into the comment's header"
}
```

The severity vocabulary — `concern` and `nit` — is fixed in code and validated
like a sheet: an answer outside it is refused and logged, never coerced.
`strictness` filters what survives into the comment. `message` and `summary`
pass through the sanitiser before they reach anything a human reads.

## The comment

One marker comment, upserted — created on first review, updated on every run
after. Findings grouped by severity, each anchored to its file and line. The
comment records the head commit it reviewed.

`incremental` — re-reviewing only commits pushed since the last review — is
**designed and deliberately absent**. The comment is replaced, not appended;
reviewing only new commits would let an unaddressed finding vanish from the
record on the next push, and carrying findings forward needs anchor tracking
that does not exist yet. Both established reviewers ship it because they keep
per-thread resolution state; this action has one comment, and the price of
that simplicity is a full review each run. The key is additive when the
carry-forward lands, and the marker's recorded head commit is what it will
need.

## Edge cases

- every changed file ignored → nothing to read: no comment, a green run, and
  a log line saying so;
- `maxDiffLines` exceeded → a red refusal naming the counted total and the
  excluded remainder;
- `max-turns` reached → a partial review, labelled partial;
- the pull request closed or merged mid-run → the review is abandoned before
  writing, with a log line — commenting on a closed thread is noise.

## Failure posture

The same law as the other two actions: the provider unreachable after
retries, a config that does not validate — red, not green-on-nothing. A
finding refused for being off-vocabulary is logged with the answer that
produced it.

## What `review` never does

Approve, or request changes — a verdict is not one-click reversible and
notifies, and no configuration opens it; CodeRabbit and cubic both ship
auto-approval, and cubic gates it behind a dozen exception rules, which is
the complexity the option drags in rather than a reason to have it. Assign a
reviewer, mention anyone, apply a label — labels are `triage`'s job, and one
action has one responsibility. Write or propose code, however small the fix.
Edit the pull request's title or body. Resolve a thread. The action's whole
write surface is one comment.

## What `review` will need from `core/`

| Module          | Kind     | What `review` needs of it                                                                                                                                                                          |
| --------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.mjs`      | protocol | timeouts, retries, the failure shapes a provider really returns                                                                                                                                    |
| `chat.mjs`      | protocol | the chat-completions request, now carrying tool calls and their results back — the tools protocol is a protocol, which is why this grows in `core/` while the loop that uses it stays in `review/` |
| `forge.mjs`     | protocol | read the pull request and its files                                                                                                                                                                |
| `untrusted.mjs` | ceiling  | the evidence wrapper for the diff and every tool result                                                                                                                                            |
| `sanitise.mjs`  | ceiling  | what finding text survives into the comment                                                                                                                                                        |
| `comment.mjs`   | ceiling  | the marker upsert — find by author, then by marker                                                                                                                                                 |
| `workspace.mjs` | ceiling  | path resolution confined to `GITHUB_WORKSPACE`, `.git` refused — `review` is its only consumer today                                                                                               |

The agent loop itself — what to read next, when to stop, how to compact — is
none of `core/`: it speaks no protocol and enforces no ceiling, which is the
test, and it stays in `review/`.
