# Development — `review`

`review` is shipped behaviour — released and pinnable — and this
page is the architecture the running code is built to. It still reads as the
implementation contract: every behaviour below is stated precisely enough to
test, and is tested. The shared mechanism it
rests on — file discovery, the resolved policy source, precedence — is in [the
configuration page](configuration.md). The design was benchmarked against the
configuration surfaces of the two established AI reviewers, CodeRabbit and
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
arrangement. A fork's pull request reaches the action, but disarmed twice: the
token the event carries is read-only, and the endpoint's secrets are not
passed at all, so `api-url` arrives empty and [startup
validation](#inputs) refuses the run before the provider is contacted — a red
cross on a run that read nothing, judged nothing, and wrote nothing.

Activity types: `opened`, `synchronize`, `reopened`, `ready_for_review`.
`edited` is deliberately absent — a re-worded description does not change the
code under review, and re-reviewing it would only churn the comment.
`ready_for_review` is present so a pull request first opened as a draft is
reviewed the moment it is declared ready. The set is enforced in code, not
only by the workflow filter: the action re-reads the payload's `action`
field and refuses any activity type outside the declared set — and any
payload that carries none — so a calling workflow whose `types:` filter is
missing or wrong gets the same red refusal as one that triggered on the
wrong event name, not a silent success. The same posture as `triage`'s
thread reader.

Permissions: `contents: read` and `pull-requests: write` — a comment is the
whole write surface.

A draft pull request is skipped with a log line and nothing else: a draft says
"not ready", and reviewing it anyway reviews something the author has not
finished saying.

## The policy source, and the provenance it buys

Before anything else, `review` resolves its policy source from the execution
context — under `pull_request`, the pull request's **base branch** at its live
tip, pinned to that 40-hex SHA for the whole run ([the resolver's
mapping](configuration.md#which-branch-governs--the-resolved-policy-source)).
The config file and every rule and instruction document load at that SHA: a
push to the base branch mid-review cannot swap the policy the run is judged
by.

Two records make the source auditable. The run logs one line at startup —
`policy source: event=… basis=… branch=… sha=… path=…` — before the first
model call. And the posted comment carries a provenance line naming the basis
(`base` under `pull_request`), the branch and the short SHA the run read its
policy from, so a reader judging the findings knows exactly which rules
produced them.

A config file declaring a `schemaVersion` major this build does not understand
refuses at startup, naming the branch, SHA and path it was found on.

## The reviewed snapshot

The review target is a pair of commits: the pull request's head SHA and its
base SHA, both taken from a single `GET /pulls/{number}` read at the start of
the run. Everything the review consumes belongs to that snapshot: the pull
request's metadata, the changed-file inventory, the per-file diff patches, and
every workspace read. Nothing is re-read from a moving branch; the head SHA is
pinned once and compared again once, before publication (see
[Pull request state](#pull-request-state)).

Under `pull_request` the checked-out tree is the merge preview — head merged
onto base — not the head commit itself, and the spec says so rather than
pretending otherwise: **the workspace is declared to be the merge preview of
the reviewed head onto the pinned base**, and every workspace read reflects
that. For a file the pull request changes and base does not touch — the common
case — the preview is byte-identical to head. Where both sides modified a file
without a textual conflict, reads show the merged result, which is also what
will ship; finding anchors are validated against that same copy, so anchor and
evidence can never disagree about what a line contains. No byte-hash
comparison against head blobs is attempted: it would false-red on ordinary
checkouts (`.gitattributes` EOL smudging, LFS smudging) and would have to read
committed symlinks to work at all. What pins the review to a commit is the API
side — inventory and patches come from the pinned head SHA — and what prevents
stale publication is the pre-publication guard below.

Every touch of the working tree goes through one confined resolver, tools and
non-tool reads alike: the path resolves through `realpath`, the resolved
location must land inside `GITHUB_WORKSPACE`, anything under `.git` is
refused outright, and only regular files are ever opened. A changed file that
is a symlink or a directory in the checkout carries no readable snapshot
content; its anchors are refused with a log line, never followed. A second
resolution after opening is not attempted: the threat model in `SECURITY.md`
at the repository root covers untrusted _content_, not a concurrent
local attacker rewriting the runner's own checkout mid-review.

## Pull request state

At the start of the run, one read fixes the state:

- draft → skip: a green run, a log line, nothing written;
- closed or merged → skip, same shape;
- open → the review proceeds.

State changing _during_ the run is handled by the pre-publication guard, not
by polling: the review completes its work, then checks once more, immediately
before writing, that the pull request is still open and still at the reviewed
head SHA. Either check failing abandons the publication — a green run whose
log says the pull request moved underneath it. Commenting review of commit A
on a pull request now sitting at commit B is the one outcome here that would
be worse than no comment, and two independent guards stand against it: this
pre-publication re-check first, and core's marker head-guard at the write
itself. The guards share one honest limitation, stated rather than hidden:
the marker guard compares GitHub-server timestamps against the runner's own
clock, so a sufficiently skewed clock narrows it. That is why there are two
guards and why the pre-publication check — which compares SHAs read seconds
apart, no clocks involved — is the load-bearing one. A skip and an abandonment
are honest no-ops: no work was claimed, so nothing is red.

## The applicability axis

Before the first model call — before diff accounting, before the inventory —
the run classifies its execution context and decides whether a full review is
the right response to this pull request at all. The axis is declared policy,
not heuristics: absent an `applicability` key the classification never runs
and behaviour is byte-for-byte the pre-axis behaviour. Design and landing
sequence: [the applicability policy](applicability-policy.md).

### The context

Three contexts, derived in order, first match wins:

| Context      | Derived from                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `automation` | the author's account type is `Bot` and its login is on the policy's `bots` allowlist — exact, case-sensitive bytes |
| `maintainer` | a write-class `author_association` (`OWNER`, `MEMBER`, `COLLABORATOR`) on a provably same-repo head                |
| `external`   | everything else                                                                                                    |

An unallowlisted bot falls through, not down: a wrong guess about a bot must
cost more review, never less, so a `MEMBER` bot on a same-repo branch is a
maintainer, exactly as a human with the same standing would be. The head's
provenance is proven, not assumed: the event's head repository full name
compared against the base repository's, an absent name a deleted fork. Beside
the verdict, the derivation records what it actually read — the raw
association, the head provenance (`same-repo`, `fork`, `deleted`) and the
author provenance (`bot-allowlisted`, `bot-unlisted`, `human`, `unknown`) —
so the audit record shows the classification's inputs, not just its output.

### The rules

The `applicability` key carries `bots` (the allowlist) and `rules`, evaluated
in config order, first match wins — never reordered, scored or merged. A rule
names itself (`id`, unique, the audit record's name), may pin a context
(absent matches every context), carries conjunctive `when` conditions —
`title` and `branch` as regular-expression sources, `paths` as globs in the
one configuration dialect over the post-ignore inventory — and a `run`
boolean (default true). Nothing matching is the defaults: review runs, and
the record says so with basis `default`.

Two laws the validator enforces rather than asks reviewers to remember:

- `run: false` must declare a pinned context — a rule built from title,
  branch or paths conventions never governs alone; and
- that context is never `external` — the external context is frozen; full
  review is what an untrusted contribution is for.

An automation rule over an empty allowlist is refused too: it could classify
nothing and would exist only to confuse the audit. A rule carrying `posture`
or `intensity` — the later pull requests' surface — is refused as unknown,
never silently ignored. Every one of these refusals is red at startup, before
the first model call, the same refusal class as a bad `strictness`.

### What a skip leaves behind

A rule matching with `run: false` ends the run before the changed-file
listing is even fetched (a `paths` rule fetches it once, exactly), before
budget accounting, before the model: the run is green, writes no comment, and
publishes a **skipped-run record** where a full run would write its artifact —
the same repository/head/pull-request facts, `outcome: skipped` with the
reason naming the rule (`#N matched applicability rule '<id>' — review
intentionally not run`), and the applicability fact with `applicable: false`
and the deciding rule's id. A pull request already skipped by its draft or
closed state writes the same reduced record **when the policy is on**, with
basis `state` — under a policy, a skip is recorded honestly rather than only
logged; without one, today's log line alone, unchanged. The log carries one
audit line whenever the policy is in play:

```text
policy source: event=pull_request basis=base branch=main sha=<sha> path=.github/action-agents/review/review.json5
```

Dry run suppresses every skip record: absolute zero mutation means zero.
The artifact schema moves to `schemaVersion: 3` only when a run has an
applicability fact to carry; a policy-less run still writes `2`, and the two
shapes never mix in one record.

## Inputs

| Input                | Meaning                                                                                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github-token`       | the token the action writes with — the workflow's `permissions:` block is the real bound                                                                                                                         |
| `api-url`            | base URL of an OpenAI-compatible endpoint                                                                                                                                                                        |
| `api-key`            | key for that endpoint; empty is a supported keyless configuration                                                                                                                                                |
| `model`              | model id to ask                                                                                                                                                                                                  |
| `request-timeout-ms` | per-attempt timeout in milliseconds for one provider call — the attempt must complete the whole completion; raise it for endpoints that legitimately take longer than 30 seconds; default 30000, floored at 1000 |
| `config-path`        | overrides `.github/action-agents/review/review.json5` / `.json` — see the configuration page                                                                                                                     |
| `max-turns`          | ceiling on agent turns — reaching it ends the review and says so; the default is 30                                                                                                                              |
| `context-window`     | the configured model's token budget — the agent compacts before reaching it; default 128000                                                                                                                      |
| `dry-run`            | review and log, comment nothing — default false, because the comment is the action's only output                                                                                                                 |
| `artifact-path`      | where inside the workspace the machine-readable run record lands — see [The run artifact](#the-run-artifact); default `.review-artifact`                                                                         |

Timeouts come in two layers. `request-timeout-ms` bounds one provider attempt; retries,
backoff, `Retry-After` and the attempt limit are `core/src/http.mjs` policy, not inputs.
The workflow's `timeout-minutes` (15 in this repository's own `review.yml`) remains the
outer safety boundary — the per-request value bounds one call, the job timeout bounds the
run. A value below 1000 is a startup error, so the HTTP client's disabled-timeout path is
unreachable from a workflow.

The numbers — attempts, backoff, the `Retry-After` cap, the retryable
statuses — are stated in [the core ceilings](ceilings.md#the-retry-ceiling).

There is no `instructions-path` input: the seed the design sketched was
removed in the very change that shipped `review` (#37), so no release ever
carried it, and instruction documents reach the action through the config
file alone.

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

  // The review's posture, orthogonal to strictness. "standard" (the
  // default) reviews normally; "adversarial" tells the reviewer to treat
  // its candidate findings as hypotheses pending verification. It shapes
  // how the model reviews — never what the contract enforces.
  strategy: "standard",

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
  // resolved policy source — declaring a rule and leaving its file absent is
  // a startup error. Only the convention paths under `instructions` are
  // optional; a declared rule is required.
  rules: [
    {
      include: ["src/**/*.ts", "!src/generated/**"],
      instruction: ".github/action-agents/review/rules/typescript.md",
    },
  ],

  // Whether review applies to a pull request at all — the applicability
  // axis. Absent, the key is off entirely and nothing else changes. `bots`
  // allowlists the logins that classify as automation (exact bytes);
  // `rules` are first-match-wins: pin a context, declare conjunctive
  // `when` conditions, and whether review runs. `run: false` must pin a
  // context and that context is never `external`. See [the applicability
  // axis](#the-applicability-axis).
  applicability: {
    bots: ["ecoma-io", "renovate[bot]"],
    rules: [
      {
        id: "release-prs",
        context: "automation",
        when: { title: "^chore\\(release\\)", branch: "^release/" },
        run: false,
      },
    ],
  },

  // Prose, pointed at rather than embedded; this path is the default.
  instructions: {
    instruction: ".github/action-agents/review/instruction.md",
  },
}
```

### Validation, all of it at startup

- `strictness` is one of the three values, `strategy` one of the two,
  `language` a well-formed BCP-47 tag, `maxDiffLines` at least 1;
- every rule's instruction document must exist on the resolved policy source;
- instruction and rule documents carry the same 8 KiB cap as every action's
  documents on [the configuration page](configuration.md) — overflow is
  refused, never truncated;
- the `applicability` key, when present, validates as its own policy — see
  [the applicability axis](#the-applicability-axis) — in the same
  red-at-startup refusal class as every other key;
- a rule that matches no changed file in a given pull request is dormant, not
  an error — rules are declared for the repository, not for one diff.

Validation runs before the first model call. An invalid configuration is a red
refusal that never reaches the provider.

### Ignore is a universe filter

`ignore` defines what does not exist for this review. A path matching the
ignore set is excluded from all of these, before anything else happens:

- the changed-file inventory the model sees;
- the `maxDiffLines` basis;
- rule matching — a rule whose only matches are ignored is dormant;
- the diff evidence handed to the model;
- tool visibility. This is the strong half, and it is deliberate: `read_file`
  on an ignored path is refused with a tool error saying so, `list_files`
  omits ignored entries, and `search` skips ignored files. There is no path
  where a file is excluded from the count yet discoverable anyway — an ignore
  set that only hid files from the summary would be bookkeeping, not a
  ceiling.

Patterns use the one glob dialect of [the configuration
page](configuration.md). A file's membership is decided by the path it has at
the reviewed head — the new path for a rename, the recorded path for a
deletion. The old path of a rename is never consulted: renamed out of the
ignore set, the file is reviewed under its new name; renamed into it, the
file is gone, whatever it used to be called. Negation (`!`) composes with
this exactly as the dialect's last-match-wins rule says it does.

### Rules

All rules whose `include` matches at least one non-ignored changed file apply,
in config order, each contributing its instruction document. Rules are
additive: several may apply at once, and none overrides another, the system
contract, or the output contract — a rule document is guidance for judging,
never a grant of capability (see [the trust hierarchy](#the-trust-hierarchy)).
No matching rule is dormancy, not an error.

## Diff accounting

`maxDiffLines` is counted, never asked for. The count is the sum of
`additions + deletions` over the changed files that survive the ignore filter,
taken straight from GitHub's files API — the model is never in a position to
supply or influence the number. Renames contribute their own additions and
deletions; binary files, mode-only changes and submodule bumps contribute what
GitHub reports for them (normally zero).

When the count exceeds `maxDiffLines` the review is refused outright, red,
naming the counted total and the excluded remainder. The split is
deterministic: files accumulate in ascending path order — byte-wise, UTF-8
byte order, the only collation this document means wherever it says "sorted" —
until the budget breaks; that file and everything after it in that order is
the remainder. A half-reviewed diff presented as a complete review is
refused, not truncated.

Each non-ignored changed file's patch enters the prompt as its own evidence
block, capped at 64 KiB like any tool result. Where GitHub supplies no patch —
binary files, oversized diffs — the block says so instead of inventing one,
and the model can fall back to `read_file`.

## The tool surface

The doctrine raises this as a ceiling question; here is the answer. The loop's
tools are **fixed in code, and no input and no config key adds one** — a tool
an author cannot add is a tool an attacker cannot aim.

```text
read_file   { "path": string }
list_files  { "path": string }
search      { "query": string, "path"?: string }
```

`path` is relative to the workspace root; `search`'s `path` narrows the scan
to a subtree and defaults to the whole workspace.

### Call validation

Every call is checked against its schema before anything executes:

- unknown tool name, missing argument, wrong-typed argument, or an extra
  property → a tool error result the model sees, naming the defect. The turn
  still counts. Malformed calls are never repaired, coerced or guessed at;
- a path longer than 4096 bytes or a query longer than 512 bytes → the same
  kind of tool error result;
- violations of the wire contract itself — `arguments` that is not valid JSON,
  duplicate tool-call ids in one response, a result id that answers no
  outstanding call → provider failure, red. Those are defects in the
  conversation protocol, not in the model's manners, and the distinction is
  held: manners errors come back as tool results; protocol defects kill the
  run.

Several tool calls may arrive in one response. They execute sequentially in
the order given, each validated and capped on its own, each counted against
the per-run tool ceiling. Prose accompanying tool calls is carried in the
transcript verbatim and treated as data.

### What each tool does

- `read_file` — one file's content. Refused, with a reason, for: paths that
  resolve outside `GITHUB_WORKSPACE`; anything under `.git` (the checkout's
  credentials live there); ignored paths; directories; symlinks and any other
  non-regular file; binary content — a NUL byte in the first 8 KiB marks a
  file binary. Text is returned as-is otherwise; the 64 KiB evidence cap
  applies with its visible cut — the cut caps the transcript, not the run's
  record: the capture ledger holds every byte the read captured, up to the
  1 MiB read ceiling, whatever the wrapped block shows.
- `list_files` — every regular file beneath the directory, recursively, one
  path per line relative to the workspace root, sorted byte-wise. Capped at
  500 entries with a marked cut. Ignored paths and `.git` are omitted.
  Symlinks are never followed while listing — a symlink is not a regular
  file, so it appears as nothing at all — which makes traversal cycles
  impossible by construction rather than by detection.
- `search` — lines containing a fixed substring, case-sensitive. Not a
  regular expression: a pattern language is an unbounded compute surface, and
  a bounded tool is the point of a fixed list. At most 200 matches, then a
  marked cut; results grouped by file in byte-wise path order, each match
  carrying its 1-based line number and the trimmed line text. The scan itself
  is bounded too — at most 8 MiB of bytes read per search, then a marked cut
  naming how much was scanned — because capping matches caps the output, not
  the work, and untrusted content must not be able to make the run spend
  forever reading. Binary files, ignored files and `.git` are skipped.

Every result enters the transcript wrapped as evidence — a file's content is
data about the change, never an instruction to the reviewer. Symlink policy is
uniform and strict: a final-component symlink is never followed — `read_file`
refuses it by type, and listing and search skip it — so a link aimed outside
the workspace cannot leak what it points at, because nothing ever reads
through a link. Resolving through `realpath` stays as the containment
backstop for intermediate links, and anything under `.git` in the resolved
path is refused. No shell, no network, no write, ever.

## Hard ceilings

The user-facing knobs are `max-turns`, `context-window` and `maxDiffLines`.
Underneath them sit universal ceilings, fixed in code, not exposed as inputs —
a ceiling an input could raise is a preference, not a ceiling:

| Ceiling                         | Value                   | Fires when                                                           |
| ------------------------------- | ----------------------- | -------------------------------------------------------------------- |
| tool calls per review           | 200                     | the loop has executed 200 tool calls                                 |
| cumulative tool evidence        | 512 KiB                 | wrapped tool results have carried 512 KiB in total                   |
| per-result size                 | 64 KiB                  | one tool result exceeds it — cut, marked                             |
| search matches                  | 200                     | one search — see above                                               |
| bytes scanned per search        | 8 MiB                   | one search — see above                                               |
| listed entries                  | 500                     | one `list_files` — see above                                         |
| findings per review             | 50                      | the answer declares more                                             |
| message length                  | 1000 chars              | sanitiser truncation, visible                                        |
| summary length                  | 300 chars               | sanitiser truncation, visible                                        |
| initial prompt budget           | half the context window | the assembled prompt would exceed it                                 |
| verifier tool calls per finding | 40                      | the verifier's own loop has executed 40 calls for one finding        |
| verifier evidence per finding   | 128 KiB                 | one finding's wrapped verifier results have carried 128 KiB in total |

The last row closes the gap the others cannot see: the diff evidence enters
the prompt before any tool runs, so the cumulative-evidence ceiling never
counts it. Before the first model call, the fully assembled messages are
estimated (see [the loop](#the-loop-and-the-prompt) for the estimator) and a
prompt past half the configured window is refused, red, with the estimate
named — a review that cannot fit is refused, not silently truncated into a
smaller-looking one.

Reaching the tool-call or cumulative-evidence ceiling ends the reading phase
exactly as reaching `max-turns` does: the loop makes one finalisation request
(see below) and the review concludes partial. The log names the ceiling that
fired. None of these ceilings can be lifted by configuration, by an
instruction document, or by anything the model says.

## The loop, and the prompt

Assembled in one order, then extended as the loop runs:

```text
1  system    the task, the output contract, the review-mode paragraphs, the
             repository's name and description, the base…head range under
             review
2  custom    the instruction document, if it exists
3  rules     every rule whose include matches a changed file, its document,
             in config order
4  evidence  the pull request's title and body, the per-file diff patches,
             then, as the loop runs, each tool result
```

The tiers map onto the protocol's three roles exactly once, so no implementer
guesses: tiers 1–3 are concatenated, in that order, into the single `system`
message — several providers reject multiple system messages, and one message
leaves no ordering ambiguity. Tier 4 opens the single `user` message as
wrapped evidence blocks; from then on each tool result rides in a `tool`
message of its own, as the chat-completions wire format requires.

Two config keys each contribute a short mode paragraph to tier 1.
`strictness` picks the effort posture: `low` investigates lightly, prioritises
concerns and reports only what it is confident matters; `medium` states the
default — a normal, thorough review that anchors every finding; `high` is
strict and evidence-driven — every finding verified against concrete code
before reporting, no unconfirmed hypotheses, reading every changed file stated
as the expectation — and the expectation is enforced in code, not promised in
prose: at `high`, a review that has not read every changed file cannot
conclude complete (see [Coverage accounting](#coverage-accounting)).
`strategy: "adversarial"` appends a second paragraph at any strictness:
candidate findings are hypotheses pending verification, counterexamples are
actively sought, and a separate verification stage follows. The paragraphs
steer effort only — no ceiling, contract or enforcement is ever promised in
prose.

One thing is placed deliberately low: the pull request's title and body are
attacker-authored text, so they enter as wrapped evidence, below every
instruction tier — not in the system message, however convenient that would
be. The repository's name and description are maintainer-set configuration and
stay in the system message.

One turn is one model response, and the accounting is exact:

- a response carrying tool calls is a reading turn; executing its calls never
  costs turns, only tool-call budget;
- `max-turns` bounds reading turns;
- when a reading turn is consumed and none is left, the loop sends **one**
  finalisation request — transcript plus an explicit instruction to answer
  now, tools withheld from the request so no further tool call is even
  expressible. Its content is the final-answer candidate, and the review is
  partial, bound named;
- the same finalisation request ends the loop when the tool-call or evidence
  ceiling fires first;
- a response carrying no tool calls while reading turns remain is a natural
  stop: its content is the final-answer candidate, and the review will be
  complete if the candidate validates and — at strictness `high` — the
  coverage ledger shows every changed file read;
- a structurally invalid candidate on the natural-stop path gets **one**
  re-ask — same transcript, corrective instruction, tools withheld, logged.
  The re-ask is not a reading turn and cannot itself call tools; failing it is
  red. No re-ask follows a bound-driven finalisation — that request already
  was the second chance.

The transcript is compacted before `context-window` is reached — when the
token estimate crosses 80% of the window — deterministically, in code: the
system message and the original task message with its diff evidence are
kept; the model's own analysis messages are kept verbatim, with their tool
calls stripped; and every other later exchange is replaced by one state
message holding the inventory a reviewer would need to continue — turns
used, tools called, files read, the deletions already inspected via their
diff sections, search hits with their line numbers, and tool errors. The
stripping is not a nicety: a kept tool call without its kept answer is a
malformed request, so the calls go and their results enter context only as
the state inventory. Findings so far are not carried as structured data —
no findings ledger exists mid-run — so what survives of them is the model's
own prose, kept verbatim rather than summarised. Raw tool bodies are
discarded. Compaction may run before any request, including a finalisation
or re-ask. It is code, not a model call: a summary a model wrote is never
allowed to become context the loop trusts.

The estimator feeding both the 80% trigger and the initial prompt budget is
fixed so two implementations agree: per UTF-8 byte ÷ 4, except that
codepoints above U+2E80 count at byte ÷ 1.5 instead of ÷ 4 — crude on purpose,
biased against underestimating CJK-heavy text, and identical everywhere it
runs.

## Coverage accounting

What the reviewer read is ledgered in code, and what it was supposed to read
is derived in code; the two meet in a deterministic verdict that no model
text can move. The expected set comes from the same files list that builds
the inventory: each reviewed file is rendered as its canonical git-style diff
section — rename and copy extended headers included, `/dev/null` on the empty
side of an addition or deletion, quoted and C-escaped names resolved — and
that text is parsed back to paths by one shared parser. The parse must
reproduce the reviewed universe exactly: a derivation that names a path the
inventory does not hold, or misses one the inventory does, is a broken
derivation, and the run is refused, red, before any model call. A deleted
file is part of the expectation — a change that removes a path expects that
path to have been looked at as much as one that edits it.

For a deletion, the inspection is the deletion's own diff section. The
removed lines ride in the initial prompt's evidence by construction, and
`read_file` could not open the path anyway — the reviewed head no longer has
it. So the run records the deletion as inspected in code before the loop
starts: the paths come from the same inventory entries that rendered the
sections (`status: "removed"`), pass through the same normalisation as a
recorded read, and sit in the ledger beside the `read_file` calls. Nothing
the model writes can grow or shrink that set, and no input widens it — an
ignored deletion is outside the universe and never recorded. The expectation
set itself does not move: a deletion stays expected, and what changes is only
that the expectation can now be met.

The read record is the set of `read_file` calls whose bytes the run
captured — a refused attempt (a missing, ignored or unresolvable path, a
directory, binary content) is a tool error, never a read — plus that
code-recorded deletion set, every path normalised to the diff's canonical
spelling, so `./src/a.mjs` and `src/a.mjs` are one file. Coverage and the
verification pass draw on the same captures by construction: both move only
on a captured read, so a run that captured zero bytes of a changed file
cannot claim it examined — at `high` the coverage gate refuses.
`coverageReport(expected, read)` partitions the expected set into covered
and uncovered; nothing the model wrote — summary, findings, self-assessment
— enters the computation.

The verdict is strictness's to set, and strictness is the maintainer's:

- at `high`, the expectation is the whole diff. Any unread changed file ends
  the review **PARTIAL**, the banner naming the gap ("N of M changed files
  were never read: …") in the same voice and through the same code path as a
  bound's reason. A summary claiming completeness changes nothing — the
  ledger outvotes the prose;
- at `low` and `medium`, coverage never blocks completion. The accounting
  still runs, and the count line rides in the comment, so a maintainer can
  see how much of the diff the reviewer actually opened.

A bound and a coverage gap compose the way everything else here does: the
bound ends the review partial as before, and the examination count in the
comment tells the rest of the truth.

## The trust hierarchy

```text
system contract
  > repository instruction document
  > rule documents
  > pull request title, body and diff
  > tool results
```

Lower tiers are data; only the upper tiers steer. The instruction and rule
documents are configuration — they add judgement, never capability: no text at
any tier can grant a shell, network access, a write, an additional tool, a
raised ceiling, or a relaxed output contract, because those surfaces are fixed
in code and no code path reads them from the prompt. [Doctrine](../doctrine.md)
states the principle; this design is where it becomes a floor plan.

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

No other field exists in v1: no verdict, no score, no approval state. Parsing
follows the shared answer conventions — one wrapping fence stripped, the
outermost brace-balanced object, JSON5 — with one correction stated here so it
survives the copy this action owns: the brace scanner tracks both single- and
double-quoted strings, or a message like `'it{ breaks'` corrupts the balance
and a well-formed answer dies in extraction. The shape
is strict: the object holds exactly `findings` and `summary`; each finding
holds exactly `severity`, `file`, `line` and `message`.

Severity is the fixed two-value vocabulary — `concern` and `nit` — and the
refusal unit is the single finding, matching how anchors are judged: a finding
whose severity sits outside the vocabulary is dropped and logged with the
finding that produced it, never coerced, while the run continues on the
strength of its valid findings. This is deliberately not `triage`'s
whole-answer sheet semantics — there the labels _are_ the product, here a
review's product is a list, and one malformed entry must not poison twenty
good ones.

### Finding validation

Structural validity is necessary but not sufficient. Each finding is then
checked against the reviewed snapshot:

- `file` is a repository-relative path belonging to the non-ignored
  changed-file inventory — renamed files anchor to their new path; a deleted
  file, an ignored file, or a file the pull request does not touch is an
  invalid anchor;
- the file must be readable as text in the verified workspace copy — a
  binary file (a NUL byte in the first 8 KiB), a symlink, or a directory is
  an invalid anchor. A committed-secret worry about a binary change belongs
  in the summary, where the model can raise it unanchored;
- `line` is a 1-based line in the new file, at least 1 and at most the file's
  line count in the verified workspace copy — contextual lines are legitimate
  anchors, not only diff hunks.

An invalid finding is rejected individually and logged with the finding that
produced it — the run is not failed for one bad anchor among good ones, and
nothing is coerced into looking valid. Strictness is review policy, not a
rendering detail: after the cap, at `low` every surviving nit is dropped from
the published set and its drop logged — a nit at `low` never reaches the
comment, the published count or the reader, and concerns always survive
(concerns sort first, so the cap can never evict one). At `medium` and
`high` every finding survives to rendering. Filtering and rendering are
deterministic code — the model never controls its own inclusion bar.

Survivors are deduplicated — identity is `(file, line, severity, message)`
with the message trimmed, so only exact logical duplicates collapse, never two
genuine findings that happen to share a line — then ordered: concerns before
nits, then file path byte-wise ascending (UTF-8 byte order — the only
collation this document means wherever it says "sorted"), then line numerically
ascending, then message byte-wise ascending. Whatever order the model produced
is discarded. The findings cap takes the first 50 of that order and logs the
overflow. `message` and `summary` pass through the sanitiser before they reach
anything a human reads, with its visible truncation marks.

The rendered anchor is defanged with the same care as the message: an
inventory path carries attacker influence just as model text does — filenames
are chosen on the attacking branch — so backticks, angle-bracket sequences and
HTML-comment delimiters are stripped from the _displayed_ path before it is
placed inside the comment's backticks. Matching is done on the exact name;
rendering, on the defanged copy.

If the final answer is structurally invalid — unparsable, wrong shape, unknown
keys — the loop follows the re-ask rule of [the loop](#the-loop-and-the-prompt):
one corrective request, tools withheld, logged; failing it, red. A provider
that keeps failing the contract is not something to hide behind a green check.

## Evidence provenance

The provenance pass (#84) runs right after finding validation, before the
nit-drop: every finding is anchored to the recorded read that covers its
file and line — the first covering read in ledger order — and a finding
whose line no capture reached is quarantined, loudly, never published.
Anchoring attaches a reference; the run's read ledger remains the evidence.

The provenance run gate (#105) judges the **final published set** — the
collection the comment body carries: post nit-drop, post verification,
refuted and unresolved findings included. It re-derives every published
finding's anchor from the ledger instead of trusting the reference a
finding already wears: the reference must be well formed, name the
finding's own file at the normalised spelling, cover the finding's line,
and match a recorded read exactly — path and span together. Any miss
refuses the gate with the finding named in the reason, and the review
publishes partial. A claim no recorded read backs anchors nothing.

The verifier's own reads stay out of that ledger. The verification pass
investigates with bounded tools of its own, and those reads back the
verdict — the pass's evidence wrap shows them — not the finding's anchor.
Every published finding was anchored before the pass ran, so the
reviewer's recorded reads are the anchor provenance for confirmed,
refuted and unresolved findings alike.

Coverage, not a claim about an untouched line, is the bar a contextual
finding clears: a finding whose anchor line the diff does not touch is
anchored when a recorded capture demonstrably contains the line it points
at. Captures are recorded whole-file and spans are counted by the code
from the captured bytes, so coverage means the anchor line's bytes were in
evidence — a fabricated span matches no recorded read and refuses.

## The verification pass

The adversarial verification pass (#82) sits between the nit-drop and
rendering. What the reviewer's answer calls a finding is, at this stage, only
a claim; the pass tests each claim against evidence before it is allowed to
publish. Its verdicts never remove a finding — they assign it a lifecycle
state (#101). A planned finding is a `candidate` from the moment the plan
names it; the verdict moves it to exactly one of three published states, and
the pass publishes all three:

| State        | From verdict | Where it lands                                                                   |
| ------------ | ------------ | -------------------------------------------------------------------------------- |
| `confirmed`  | `confirmed`  | the severity sections, rendered exactly as before the pass existed               |
| `refuted`    | `refuted`    | its own "Refuted during verification" section, the verdict's reason riding along |
| `unresolved` | `uncertain`  | its severity section, marked `unverified:` with the verdict's reason             |

`refuted` publishes rather than disappears — a wrong refute is visible where
the work is, not buried in a log. `unresolved` publishes at every strictness:
the pass deleting what it could not judge was the old contract's failure, and
the strict arm no longer does it. The one state that never reaches a human is
`candidate`. A planned finding no verdict reached fails closed to
`unresolved` with a fixed reason, and a planned finding whose verification
was skipped publishes `unresolved` with the skip's reason. Findings the pass
never scheduled publish exactly as they arrived, no lifecycle attached —
verification states exist only where verification ran. Strictness keeps its
other jobs — the nit-drop at `low`, nit collapsing at `medium`, the coverage
gate at `high` — but it no longer decides whether an unverifiable finding
survives.

### What the verifier sees

One fresh conversation per planned finding: a system message carrying the
code-authored contract, and one user message holding the finding under test —
its id, severity, location and claim — plus the captured content around its
anchor line, wrapped as evidence. Nothing else from the run ever enters this
prompt: no reviewer transcript, no chain of thought, no summary, no other
findings. The claim is data under test, not instruction.

The plan and its skips are unchanged: a finding is planned when the strategy
is `adversarial`, or its severity is `concern`, or it sits on a deep lane —
and planning still requires a recorded read that reaches the anchor, so the
pass never verifies blind.

Those gates judge the captured record, not the transcript. A recorded read
holds up to the 1 MiB read ceiling of raw bytes per file; one wrapped block
shows at most 64 KiB of it. An anchor line past the transcript's visible
cut still resolves — the same record the verifier's excerpt is cut from —
and no ceiling moved to make that true.

### What the verifier does

Since the pass is an investigation, not a sanity check: the verifier holds the
reviewer's own fixed tools — the same `read_file`, `list_files`, `search`, the
same registry, the same confinement. Nothing adds a tool, no input widens the
reach. Its contract instructs active counter-evidence hunting: read around
the anchor, search for what the claim says is missing, then verdict.

The verifier's budget is its own, fixed in code, not an input — a ceiling an
input could raise is a preference:

| Budget              | Value   | Why this number                                                                                                        |
| ------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| tool calls          | 40      | a quarter of the reviewer's per-review ceiling — one finding needs a handful of reads and searches, not a whole review |
| cumulative evidence | 128 KiB | a quarter of the reviewer's per-review evidence — enough to read around an anchor several files deep                   |

The budget is per finding: a plan of five planned findings spends at most
five budgets, each in its own fresh conversation, its own evidence wrapper,
its own recorded-reads ledger (the verifier's reads never enter the
reviewer's ledger, and the reviewer's captured bytes never enter the
verifier's prompt beyond the excerpt the plan already showed).

### When the verifier misbehaves

The same dispatch rules as the reviewer's loop, with one deliberate
divergence:

- a manners defect — wrong arguments, an unknown tool name, a refused path —
  comes back as a tool error result the verifier can correct;
- reaching the tool-call or evidence budget fires one final no-tools request
  (tools withheld, so no further call is even expressible) and the verifier
  answers from the evidence already gathered;
- a protocol defect — unparsable or oversized call arguments — degrades that
  finding's verification to `uncertain` instead of ending the run. The
  reviewer's loop would treat the same defect as provider failure and go red,
  because the whole review's conversation is damaged. The verifier's
  conversation is per finding: one broken investigation is one finding
  judged `unresolved`, published marked `unverified:`, and the review
  continues. A misbehaving verifier must never delete a reviewer's finding it
  could not judge, and must never crash the review that produced the finding.

The verification gate judges the pass's completeness, not a count. Its facts
are the plan's identities, the outcome record each planned finding carries,
the skips the plan could not evidence, and the policy the run ran under.
Every planned finding must carry a recorded outcome with a verdict behind it
for the gate to pass: a planned finding with no record at all — a lost record —
or whose record is `unresolved` carrying no verdict — the shape the pass itself
writes when it never recorded one, a pass that never closed — is its own named
failure at every policy mode, and no count equality stands in for it. Only an
outcome whose verdict is genuinely `uncertain` is left to the mode policy. What
the records then say decides the posture.
The gate derives its mode from the review's policy — the `adversarial`
strategy is the most demanding whatever the strictness, a strictness `high`
on the standard strategy is `strict`, everything else is `normal` — and the
mode judges the unresolved accounting, the `unresolved` outcomes plus the
unevidenced skips, enumerated in plan order:

| Mode          | Strategy      | Strictness      | Unresolved findings                                                 |
| ------------- | ------------- | --------------- | ------------------------------------------------------------------- |
| `normal`      | `standard`    | `low`, `medium` | may publish — the accounting rides the report (`unverified:` lines) |
| `strict`      | `standard`    | `high`          | refuse COMPLETE — the review ends PARTIAL, findings named           |
| `adversarial` | `adversarial` | any             | refuse COMPLETE — the review ends PARTIAL, findings named           |

Refused answers, transport failures, protocol defects and budget exhaustions
all record `uncertain` and move on, so they surface as unresolved findings
where the mode policy can see them. A record the pass could never have
produced — a lifecycle outside the published vocabulary, a verdict that
contradicts the lifecycle map, a resolved state with no verdict behind it, an
outcome for an id the plan never
scheduled, a duplicate — is `GateFactsError`: the gate reads only
code-recorded state, and a missing fact is never a pass.

## Review states

Every run ends in exactly one of three states:

- **COMPLETE** — the model terminated normally, produced a valid,
  fully-validated answer, and every declared run gate passed. Publish: the
  marker comment is upserted with the findings — or, when there are none,
  with a literal "No findings.", so a clean re-review clears whatever an
  earlier push left behind.
  Findings the run withheld as unanchored are not "none": when nothing
  published but findings were quarantined, the comment says so and counts
  the withheld — a withheld review never renders as a clean one.
- **PARTIAL** — the review says so honestly: a declared run gate refused the
  complete posture. The conditions are the ones this page already states — a
  bound ended it (`max-turns`, the tool-call ceiling, the evidence ceiling),
  or, at strictness `high`, the coverage ledger shows changed files that were
  never read — plus the publication invariants: a published finding — post
  nit-drop, post verification — whose provenance no recorded read in the
  run's ledger backs (the provenance gate, judged over the final published
  set), or the verification gate refusing — an accounting that does not
  close, or, at strict and adversarial, an unresolved finding. Publish, with
  the partial
  status prominent at the top of the comment and the first failing gate's
  reason named.
- **FAILED** — provider failure, invalid configuration, a pull request past
  the changed-file ceiling, a prompt past the initial budget, a broken
  conversation protocol, or a persistently malformed final answer — any
  unrecoverable error. Write nothing. The previous complete review, if one
  exists, stays exactly as it is — a failed re-review must never destroy the
  last known-good record.

One window exists where a published review can end without its artifact: the
artifact file is written after the comment is upserted, and a write that
refuses there — a path-confinement error, an unwritable directory — is
caught and logged rather than failed. The comment stands and the run stays
green: the review was published, and the outcome is recorded as
`published-without-artifact` rather than as a failure that would contradict
the comment it just wrote.

Skips and abandonments are none of these: nothing was reviewed, so nothing is
written and the run goes green with its log line.

## The comment

One marker comment, upserted — created on the first published review, updated
on every run after; never duplicated. The marker carries the reviewed head SHA
in its `head=` field, which is what makes core's concurrent-run guard work:
two racing runs cannot clobber each other, and the loser walks away.

Identity rules for that upsert, stated because a naive reading of "find my
comment" deletes other people's words: a candidate is a comment carrying this
action's marker **and** authored by the identity the workflow's token writes
as — resolved from the API (`GET /user`) at the moment of writing, which is
`github-actions[bot]` under `GITHUB_TOKEN` and the app's bot login under an
App token, never the triggering user. A maintainer who quotes the review copies the marker
into their own comment; that quote is never updated and never deleted — it is
theirs, and claiming it would be destroying user content while the genuine
review still stands elsewhere. When candidates exist, the newest wins, the
body is written there, and any surplus _bot-authored_ marker comments are
removed; when none exists but foreign marker-bearing comments do, a fresh
marker is created and the situation is logged, never repaired by force.

```markdown
**Review** — Complete
Reviewed head `414dd39a…`

<summary line>

Changed files examined: 2/2.

### Concerns (1)

- `core/src/chat.mjs:42` — message…
  evidence: `core/src/chat.mjs:1-210`

### Nits (2)

- `core/src/http.mjs:7` — message…
  evidence: `core/src/http.mjs:1-88`
```

At `medium` strictness the nits section renders inside a collapsible
`<details>` block — each nit still individually anchored, one click away, not
hidden. At `low` there is no nits section — the nits were already dropped by
policy before rendering; at `high` there is no collapsing.

The body carries the status, the reviewed head SHA, the summary, the changed-
files examination count (rendered whenever the expected set is non-empty,
whatever the strictness) and the findings — each published finding carrying
one evidence line beneath it, the covering read the loop recorded, ledger
data only, never model-composed text — and nothing volatile: no
timestamp (the comment interface shows
when it was last updated), no run number, nothing that churns the comment
without changing the review. Model-supplied text passes the sanitiser before
rendering, so markers, HTML and mentions cannot be forged into the body.

Two boundary cases fix stale-record drift: a run that finds every changed file
ignored updates the marker comment, if one exists, to a deterministic
"Nothing to review." body — stale findings from an earlier push must not
outlive their own relevance — and creates nothing when no marker exists. A run
whose publication is abandoned leaves the previous comment untouched, head SHA
and all, which is exactly the record a maintainer wants while they look at
what moved.

`incremental` — re-reviewing only commits pushed since the last review — is
**designed and deliberately absent**. The comment is replaced, not appended;
reviewing only new commits would let an unaddressed finding vanish from the
record on the next push, and carrying findings forward needs anchor tracking
that does not exist yet. Both established reviewers ship it because they keep
per-thread resolution state; this action has one comment, and the price of
that simplicity is a full review each run. The key is additive when the
carry-forward lands, and the marker's recorded head commit is what it will
need.

## The run artifact

Every published run writes a machine-readable record of itself next to the
comment — `buildArtifact` in `artifact.mjs`, called on the publication path
in `run.mjs` **before** the comment exists, so every refusal the builder can
raise refuses a run that has written nothing irreversible. The comment's
identity is the one fact the record cannot hold yet: the upsert returns it
and `withCommentId` attaches it, so the two records still name each other.
The artifact is the contract a machine can read where the comment is the
contract a human reads; both are projections of the same final facts, and
neither can drift from the other, because both are built from the same
values in the same pass.

The schema is versioned (`schemaVersion: 2`; `3` once a run carries an
applicability fact, and the two never mix in one record) and the builder is
fail-closed:
a fact outside the declared key sets, a vocabulary word the code does not
declare (`severity`, `verdict`, lifecycle state, gate name, risk level,
attention lane, phase name), a gate table that is not the declared gates in
the declared order, or a verdict whose lifecycle does not follow from it is
a typed `ArtifactError`, never a coerced field. The fields:

| Field                                  | Carries                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `repository`, `pullRequest`, `headRef` | what was reviewed, the head as a 40-character hex sha                                                                                            |
| `outcome`                              | `published` and the same reason string the run logs                                                                                              |
| `policy`                               | the strictness and strategy the run ran under                                                                                                    |
| `risk`                                 | the per-file risk table, byte-wise sorted, one row per changed file                                                                              |
| `findings`                             | the published set — each with its identity, anchor line, and `provenance` naming the recorded read that covers it                                |
| `verification`                         | the gate's outcome plus one entry per bound verdict, derived from the findings — a separate verdict list that could disagree does not exist      |
| `gates`                                | every declared gate's result, in the declared order, a reason iff it failed                                                                      |
| `coverage`                             | the read/unread partition of the expected set, byte-wise sorted                                                                                  |
| `phases`                               | the loop's phase transitions, in order                                                                                                           |
| `provenance`                           | the marker comment's id — nothing else, no timestamp, no run id                                                                                  |
| `applicability`                        | schema version 3 only — the derived context, its inputs, the decision and what decided it; see [the applicability axis](#the-applicability-axis) |

Byte-determinism is a property, not a style: identical facts serialise to
identical bytes (`serialiseArtifact`), so two runs of the same review differ
in the artifact only where the reviews differ. There is no timestamp in the
record for the same reason a dry run logs the exact body — the artifact
describes the review, not the run's wall clock.

The lifecycles ride the findings: `confirmed` and `refuted` carry their
verdict and reason; `unresolved` carries its reason; a finding below the
strategy's threshold was never a candidate and publishes without a
lifecycle, byte for byte as it arrived. A skipped candidate is unresolved
with no id — the one state a finding can hold without one.

Publication-only, and stale-refusing twice. A run that publishes nothing —
`nothing-to-review`, an abandonment, a dry run — writes no artifact; a skip
writes nothing but its log line when no policy is present, and the reduced
skipped-run record when one is (see [the applicability
axis](#the-applicability-axis)), the newer-head rule extends to the record:
`assertFreshArtifact` compares
the artifact's head against a forge read taken before the comment exists, so
a refusal there writes nothing at all, and again against a second read taken
after the comment is published — the write-time guard. A head that moves in
that last window leaves the comment standing and the record unwritten; the
run reports the abandonment calmly rather than recording a snapshot the
pull request has already left.

The write is confined like every read. The `artifact-path` input (default
`.review-artifact`) is resolved inside `GITHUB_WORKSPACE` or refused; `.git`
is refused outright; a symlinked branch of the tree cannot carry the write
out. The file is named `review-artifact-<head sha>.json`. The shipped
workflow uploads it with `actions/upload-artifact` after the review step,
`if: always()` so a failed comment step still leaves its record, and
`if-no-files-found: ignore` because an unpublished run has no file — the
upload notifies nobody and grants nothing.

## Dry run

`dry-run: true` is absolute zero mutation: no comment created, updated or
deleted; nothing else exists to mutate — the action has no other write surface
to suppress. The rendered comment body is logged instead, so a dry run shows
precisely what would have appeared. Dry run changes nothing about the reading
side: the same snapshot checks, the same ceilings, the same validation.

## Edge cases

- a pull request with zero changed files, or every changed file ignored →
  the model is never invoked; an existing marker comment is updated to a
  deterministic "Nothing to review." body so stale findings do not outlive
  their own relevance, and with no marker present it is a green run and a log
  line;
- `maxDiffLines` exceeded, or the assembled prompt past its budget → a red
  refusal naming the counted total, or the estimate;
- more changed files than GitHub's 3000-file listing ceiling → red refusal,
  the same shape as any other ceiling;
- `max-turns` or a hard ceiling reached → a partial review, labelled partial,
  the bound named;
- the pull request closed, merged, or pushed forward mid-run → abandoned
  before writing, a green run, a log line;
- provider unreachable after retries, config that does not validate → red,
  not green-on-nothing.

## Failure posture

The same law as the other two actions: the provider unreachable after retries,
a config that does not validate — red, not green-on-nothing. Startup
validation precedes the first model call. A finding refused for being
off-vocabulary or off-snapshot is logged with the finding that produced it. A
failed run never deletes and never overwrites: the last complete review
survives every failure that comes after it.

## What `review` never does

Approve, or request changes — a verdict is not one-click reversible and
notifies, and no configuration opens it; CodeRabbit and cubic both ship
auto-approval, and cubic gates it behind a dozen exception rules, which is
the complexity the option drags in rather than a reason to have it. Assign a
reviewer, mention anyone, apply a label — labels are `triage`'s job, and one
action has one responsibility. Write or propose code, however small the fix.
Edit the pull request's title or body. Resolve a thread. The action's whole
write surface is one comment.

## What `review` uses from `core/`

Everything the design once named as a delta is shipped in `core/` today — the
table below is the contract `review` holds `core/` to, and the production path
imports all of it. All of it is protocol or ceiling; none of it is loop. The
coverage accounting (#69), the risk lanes (#74), the structured phases (#77),
the adversarial verification pass (#82), the evidence provenance (#84) and the
declared run gates (#89) are all on the production path, reachable from
`src/index.mjs`: lanes are assigned before the first model call
(`assignLanes` in `run.mjs`), provenance is attached before the nit-drop and
an unanchored finding is quarantined, never published (`attachProvenance` in
`run.mjs`), the provenance gate re-derives each published finding's anchor
from the run's read ledger over the final published set (`evaluateProvenance`
in `gates.mjs`), verdicts in the verification pass assign a lifecycle and
delete nothing (`runVerificationPass`), and the concluding posture — complete
or partial — is the declared gates' verdict over code-ledgered results
(`evaluateGates` in `run.mjs`). The machine-readable run artifact (#87) is on
the production path too: every published run writes one, and
[the section below](#the-run-artifact) is its contract.

| Module          | Kind     | What `review` gets                                                                                                                                                                                                                           |
| --------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat.mjs`      | protocol | optional `tools` on the request; a response may carry tool calls — `{ content, toolCalls, finishReason }`, with a tool-call response's `content` null. With no tools requested, behaviour is byte-for-byte what `triage` and `harmonise` see |
| `forge.mjs`     | protocol | `getPullRequest(number)` → state, draft flag, head SHA, base SHA, title, body — and `listPullRequestFiles` retaining the `patch` and per-file blob `sha` GitHub already sends                                                                |
| `glob.mjs`      | protocol | the one glob dialect of the configuration page, promoted to `core/` — `triage`, `review` and `harmonise` all import it                                                                                                                       |
| `comment.mjs`   | ceiling  | the marker upsert's identity guard: only comments authored by known bot identities are candidates for update or deletion, so a quoted marker in a maintainer's comment is never claimed and never destroyed                                  |
| `workspace.mjs` | ceiling  | path resolution confined to `GITHUB_WORKSPACE`, `.git` refused, regular files only — every workspace touch goes through it, tools and non-tool reads alike, with `review` as its first consumer                                              |
| `http.mjs`      | protocol | nothing new was needed — timeouts, retries, cross-origin refusal and capped error excerpts already serve                                                                                                                                     |
| `untrusted.mjs` | ceiling  | nothing new was needed — the evidence wrapper frames the diff and every tool result                                                                                                                                                          |
| `sanitise.mjs`  | ceiling  | nothing new was needed — what finding text survives into the comment                                                                                                                                                                         |

There is no `core/agent.mjs` and there will not be one: the agent loop — what
to read next, when to stop, how to compact — speaks no protocol and enforces
no ceiling, which is the test, and it stays in `review/`.
