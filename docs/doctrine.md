# Doctrine

The rules that decide where a new piece of code goes, and what an action is
allowed to become. Written down because the alternative is re-deriving them in
each pull request, and arriving somewhere slightly different every time.

All three actions shipped do their work — `triage`, `review` and `harmonise`
are released and pinnable — so this page describes
running code rather than intent. What it keeps doing is naming the shape that
code is built to, and the constraints it is not allowed to escape on the way.

## The shape

```text
core/          shared runtime primitives — infrastructure only
triage/        action.yaml + src/
review/        action.yaml + src/
harmonise/     action.yaml + src/
```

Three actions over one shared layer. The unit a consumer adopts is a directory:
`ecoma-io/action-agents/review@v0.1` names one, and that directory plus `core/`
is the whole of what runs. Adopting `review` never brings `triage` along.

Two edges are mechanical rather than remembered, and `pnpm arch` is what judges
them: **`core/` may not import an action**, and **no action may import
another**. The table both are read off is `module-boundaries.config.mjs`, and
the reasoning for each row is written beside it there.

## What may live in `core/`

The boundary law fixes the _direction_ of every import. It says nothing about
_what_ is allowed to move down into the shared layer, and that is the gap a
repository like this rots through: `core/` quietly absorbing whatever the second
action happened to need, until the shared layer is a second copy of every
action and no action can be adopted without all of it.

So the direction rule is paired with a content rule:

> **`core/` holds two kinds of code, and no third. Code that speaks a protocol,
> and code that enforces a ceiling.**

A **protocol** is something with a specification outside this repository — the
Actions runtime's `::command::` lines, GitHub's REST API, the OpenAI-compatible
chat-completions request, the filesystem. Nobody here decides what these look
like; the code exists to speak them correctly, and correctly is the same for
every action.

A **ceiling** is a limit that must hold no matter which action is running,
because a consumer's safety rests on it and a per-action copy would be three
chances to get it wrong instead of one.

One boundary case is worth making explicit: `untrusted.mjs` produces prompt
content, and the security policy says ceilings are enforced in code rather than
asked for in a prompt — what makes it a ceiling is that one code path fixes how
untrusted content may appear in any prompt, and no action may frame evidence its
own way; the framing is determinism, not persuasion, and no ceiling rests on the
words around the evidence (the ceilings that bite are exact match and the
sanitiser downstream).

Read as a table, with what is already written and what the end state needs:

| `core/`           | Kind     | What it is for                                                                           |
| ----------------- | -------- | ---------------------------------------------------------------------------------------- |
| `runtime.mjs`     | protocol | Reading inputs, writing workflow commands, masking secrets, reading the runner's context |
| `inputs.mjs`      | protocol | The five inputs every action takes, validated once                                       |
| `json5-parse.mjs` | protocol | JSON5 — config files and model answers, parsed by one implementation                     |
| `http.mjs`        | protocol | Timeouts, retries, and the failure shapes a provider really returns                      |
| `chat.mjs`        | protocol | The chat-completions request — the whole of what crosses the seam to a model             |
| `forge.mjs`       | protocol | The GitHub calls these actions make, as an explicit list rather than a general client    |
| `untrusted.mjs`   | ceiling  | Wrapping a thread, a diff or a file as evidence, so it never reads as instruction        |
| `sanitise.mjs`    | ceiling  | What model output must survive before it can become comment text                         |
| `workspace.mjs`   | ceiling  | Path resolution confined to `GITHUB_WORKSPACE`, with `.git` refused outright             |
| `comment.mjs`     | ceiling  | Marker-based upsert — the one route by which model text reaches a thread                 |

The test is not "would a second action want this?" — a second action wants
everything eventually, which is exactly how the rot happens. The test is
"**is this a protocol, or is this a ceiling?**" A helper that is neither belongs
to the action that needed it, duplicated into the second action if the second
action needs it too. Duplication is the cheaper mistake here: it is visible in
a diff, and it is undone by promoting the code once the third caller appears.

### What that rules out, concretely

`review`'s agent loop — deciding what to read next, calling a tool, compacting
the transcript before the context window runs out — is **not** `core/`. It
speaks no protocol: the shape of a turn is this repository's own decision. It
enforces no ceiling: the ceilings apply to what a turn may reach, not to how
turns are sequenced. So it lives in `review/`, and if `triage` ever wants
something loop-shaped it gets its own, until a third caller makes the case.

A classification prompt is not `core/` for the same reason, more obviously. A
retry policy for a flaky provider is, because every action talks to the same
provider and there is one right answer.

## The path model output takes

The ceilings in the security policy are the reason `core/` has a ceiling half at
all. They are stated there as rules; here is the same thing as a route, because
what makes them true is that the routes are enumerable — each one is drawn, and
each is bounded where it lands:

```text
  an issue body · a pull-request description · a diff hunk · a file in the repo
                                  │
                                  │  wrapped as evidence, never as instruction
                                  ▼
                            core/chat.mjs ──────────► the configured api-url
                                  │                    (and no other host)
                                  ▼  what the model answered
                           core/sanitise.mjs
                                  │
              ┌───────────────────┴───────────────────┐
              ▼                                       ▼
       core/comment.mjs                a closed set the repository declared
    one comment, created or            in its config file — triage's sheet,
    updated by its marker              narrowed per call site, never widened
              │                                       │
              ▼                                       ▼
   the model chose the text                 the model chose an entry;
   and nothing about the call               the action built the call

  `harmonise` takes a third route, and it leaves the sanitiser on purpose:
  the rewritten document is written verbatim into a commit the action itself
  assembled — no sheet, and the human at the pull request is the control.
  Its development page carries the argument for why verbatim.
```

Two properties of that picture are the whole design:

- **There is no arrow from model output to an arbitrary API call.** The model
  writes text, or it picks an entry out of a list somebody else wrote. It never
  composes a request. A model that has been talked into demanding something is
  answering a printed multiple-choice sheet, not writing on a blank page.
- **What may go on the sheet is bounded, and no input widens it.** An operation
  is offered to a model only if it is reversible in one click, visible where the
  work is, and notifies nobody. Applying a label passes. Closing a thread,
  assigning, `@mention`, a review verdict, a merge, a push, a permission change
  do not — and no configuration opens them, because a maintainer enumerating
  something they should not have is a failure that enumeration alone still
  allows.

A sheet is declared in one place: `.github/action-agents/<action>/<action>.json5` on
the default branch. A workflow input may narrow it for one call site — an
entry the file does not declare is refused at startup, with both names in the
message — and nothing widens it, ever. With no file there is no sheet at all:
the classification becomes the marker comment, and a `labels:` input set with
no sheet to narrow is refused too. The working tree is evidence, never
configuration: a pull request cannot edit the policy that governs its own
triage.

The security policy at the repository root carries the table that second point
is read off, along with the threat model it answers. It is the authority; this
page is the architectural half of the same argument.

## What the code decides

The route above bounds what a model's answer may do; inside one run, the same
law decides what a model's answer may claim. Every judgement that could have
been the model's is the code's, and the answer is data the code rules on:

- **Provenance quarantine** — `review` attaches provenance from the reads the
  loop actually recorded; a finding without recorded evidence is quarantined,
  never published.
- **Adversarial verification** — the verification pass's verdicts assign a
  finding a lifecycle state — confirmed, refuted or unresolved — and never
  remove, add or reword one; a refuted or unresolved finding still publishes,
  in its own section or marked unverified, rather than disappearing.
- **Declared run gates** — the concluding posture is a set of gates evaluated
  over code-ledgered results, the result and the gate kept apart, so a green
  answer cannot declare itself complete.
- **Bounded concurrency** — `harmonise`'s pairs translate through a
  fixed-capacity pool whose outcomes return in input order; completion order
  never reaches the record.
- **Manual-edit protection, three-way merge** — a target that drifted outside
  the action is merged against a base the translation memory proves, and a
  merge that cannot be proven fails the pair closed.
- **Code-owned accounting** — the report model and the machine-readable run
  artifact are built in code; both are landed, wiring tracked.

## Rules that are runnable, and rules that are not

A rule nobody can run is not a rule. Where a constraint on this page can be
mechanised it has been, and the gate is named so the claim can be checked:

| Constraint                                                                                                                                                        | What runs it                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `core/` imports no action; no action imports another — at any distance, over the transitively closed graph — and the four required projects exist with their tags | `pnpm arch`                                    |
| Every `action.yaml` and its code agree on the input list                                                                                                          | `pnpm check-action-inputs`                     |
| No build output, no runtime dependency                                                                                                                            | The absence of both, and a review that says so |
| The `core/` content rule on this page                                                                                                                             | **Nothing — a reviewer**                       |

The boundary row is the whole of what `pnpm arch` enforces, stated once here
and once in `docs/adr/001-core-boundary.md`: the direction rule over the
transitively closed import graph, and the existence of the four projects with
their tags. The boundary rows and the intent rows carry `decisionRef` to that
record, so a run whose citations do not resolve has no verdict at all — an
unbound gate is never mistaken for a passing one.

That last row is honest rather than aspirational. Protocol-or-ceiling is a
judgement, and a judgement is what a reviewer is for. It earns its place by
being a question with a short answer, asked every time something is proposed for
`core/`, rather than a principle nobody can apply under pressure.

## What is not decided yet

Stated so it is not mistaken for settled:

- **Per-action versioning.** All three actions share one version and one
  floating tag today, which means a fix in one moves the tag a consumer of
  another is pinned to. The trade is written down in the contributing guide; it
  is not permanent.

The development pages carry each action's design and the contracts of the
ceilings they share.
