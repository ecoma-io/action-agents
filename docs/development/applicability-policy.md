# Development — the review applicability policy (design)

> **Status: landed — the sequence is complete; this page is retired as
> design record.** All three axes are shipped behaviour, documented
> normatively in [`review`](review.md): the context and `run` axes (PR 1),
> the posture axis (PR 2), and the eligibility conditions (this change):
> the bot attestation (`when.author.isBot` — GitHub's own `user.type`
> attestation, never a title convention) and the size guard (`when.changes`)
> that reclassifies the scope layer's `maxDiffLines` refusal as a green,
> measured skip. The intensity axis (PR 3) — the one
> `strictness` delta, absolute per matched rule, with the lower-gates the
> design proposed: lowering anchored to a pinned non-`external` context,
> deepening free everywhere. The implementation contract lives in
> [`review`](review.md#the-applicability-axis); nothing below describes
> open work.

`review` today applies one full human-style review to every pull request. The
`strictness`, `strategy` and `ignore` dials vary review _intensity_; nothing
varies **whether review runs at all, which posture it takes, or how deep it
goes for a given class of pull request**. Yet execution contexts have
genuinely different review purposes: an external contributor's fork is where
a full adversarial pass pays most, a maintainer's own branch has already
passed the author's review, and a Release Please pull request contains no
hand-written code at all — this repository's own release pull request #192
consumes a full review today for exactly that reason. This design gives the
consumer a declarative, deterministic **applicability policy** that decides,
per pull request, three independent things — whether review runs, which
posture it takes, and how deep it goes — under the security discipline the
rest of this repository runs on: classification reads event metadata and
consumer-declared conventions, never review content; the model never decides
any axis, least of all a review bypass; and a skipped review is a recorded,
machine-readable outcome rather than a silent no-run.

## Relationship to the policy-source resolver (#113)

The applicability policy is a consumer of the policy-source resolver designed
in issue #113 (implementation on the `feat/113-policy-source-resolver`
branch, `core/src/policy.mjs`). That design decides **which trusted ref
governs a run**: `resolvePolicySource` maps the execution context to a
`PolicySource` (a basis, a branch, an immutable 40-hex SHA — the base branch
at its live tip under `pull_request`), and `policyReader` pins every policy
read to that SHA. This design decides **whether and how review applies** to
a pull request once that policy is in hand. The two are siblings and this
page keeps their invariants aligned: both are deterministic, both fail
closed with a red refusal before the first model call, both keep zero-config
behaviour identical to today, neither uses branch-name heuristics for
governance, and no workflow input widens a security-relevant set. Where this
page says "the policy file", it means the review config file read at the
resolved policy source through `policyReader` — never the working tree,
never the pull request's head.

## The three execution contexts

Classification derives exactly one **context** per pull request, from
PR-author-immune signals only — facts GitHub computes about the author's
relationship to the base repository, not anything the pull request says.
Derivation is ordered and first-match:

| Order | Context      | Derived when                                                                                               |
| ----- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| 1     | `automation` | `pull_request.user.type === "Bot"` **and** the exact login is listed in the policy file's `bots` allowlist |
| 2     | `maintainer` | write-class association (`OWNER`, `MEMBER`, `COLLABORATOR`) **and** same-repo head                         |
| 3     | `external`   | everything else — fork head, external association, or both                                                 |

Decisions inside the table, each with its reason:

- **A bot is an allowlisted bot.** `user.type === "Bot"` alone is not
  sufficient: anyone may register a GitHub App and open pull requests
  through it, so automation context requires the login to be listed, exactly
  and case-sensitively, in the policy file's `bots` allowlist. The allowlist
  lives on the resolved policy source, so an author cannot add their own app
  to it. This ordering is what makes the table correct for this
  repository's own releases: pull request #192 is authored by `app/ecoma-io`
  with association `NONE` (an App holds no membership) and a same-repo
  release-please head — association alone would misfile it as external, and
  only the type-plus-allowlist test files it as automation.
- **An unallowlisted bot falls through, not down.** A bot-typed author
  missing from the allowlist continues to the maintainer and external tests,
  which it fails on association and head — landing in `external`, the most
  reviewed context. A wrong guess about a bot must cost more review, never
  less.
- **Association fails toward more review.** `OWNER`, `MEMBER` and
  `COLLABORATOR` name write-class relationships GitHub itself computes;
  `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `NONE` and anything unrecognised
  are not write-class. A value this design has never heard of is external.
- **Same-repo must be provable.** `pull_request.head.repo` compared against
  the base repository; an absent head repo (deleted fork) classifies as
  fork, because same-repo is claimed, never assumed.
- **`github.actor` is not an input.** It names whoever triggered the
  workflow run — the PR author for a fresh `pull_request`, but a rebasing or
  pushing colleague after that, and the app identity elsewhere. A context
  decision taken from the trigger actor alone misfiles exactly the runs the
  policy exists to sort. Every classification field above is scoped to the
  pull request's author and head; `github.actor` is never read in v1, and no
  single field — including the author login — decides a context by itself.
- **Labels are not a signal**, although they look structural: an author with
  triage permission can label their own pull request. Excluded for the same
  reason the body is.

Never an input, in any context: the pull request body, commit messages,
diff or file content, labels, review content, model output.

## The three axes, each with its own surface

The policy decides three independent questions, and the configuration keeps
them as three independent keys so a consumer can move one without touching
the others:

| Axis          | Question                 | Key         | Values                                             | Default     |
| ------------- | ------------------------ | ----------- | -------------------------------------------------- | ----------- |
| Applicability | should review run at all | `run`       | `true` / `false`                                   | `true`      |
| Posture       | which review is this     | `posture`   | `standard` / `maintainer` / `automation`           | `standard`  |
| Intensity     | how deep does it go      | `intensity` | `{ strictness }` deltas over the file's own values | file values |

A policy may skip (`run: false`), reframe (`posture`), or deepen
(`intensity` raised) — each alone, each on its own key. A non-standard
posture is not a second engine: it is the same pipeline with a mode-scoped
instruction document (the existing 8 KiB document mechanism) saying what
this posture is _for_ — `maintainer` narrows the rubric to what a
maintainer's own branch still needs; `automation` points the same tools at
the specialised checks an automation PR warrants (release metadata,
lockfile, changelog consistency). Intensity v1 carries one delta,
`strictness`, which may be set up or down per rule; a rule that declares a
key sets it, and every undeclared key inherits the policy file's value.
Mode set and posture set are fixed in code — neither a workflow input nor a
policy file adds a fifth value; a policy file selects, it never defines.

## The eligibility doctrine, per axis

The change-intent signals — title, branch name, changed paths — are
PR-author-writable: an author chooses their title, their branch name, and
which files a pull request touches. The doctrine that stops a pull request
from steering its own classification is mechanical, enforced at startup
validation, not by review discipline:

- **The external context is frozen.** No rule may skip an external pull
  request, reframe it off the standard posture, or lower its intensity —
  the class where full review pays most gets full review, and a rule that
  tries is refused at startup. An external author cannot gain write-class
  association or same-repo head provenance by anything they write in the
  pull request, so no eligible configuration can weaken their review. An
  external-context rule may only deepen (raise `strictness`), which is the
  safe direction.
- **Weakening requires naming an immune context.** A rule that sets
  `run: false`, sets a non-standard `posture`, or lowers `intensity` must
  declare `context: "maintainer"` or `"automation"` — the immune anchor the
  derivation table computed from signals the author does not control. A
  rule built only from `title`, `branch` or `paths` conditions **is refused
  at startup: a convention never governs alone.** Conventions specialise
  within an immune context — a docs-paths rule can narrow a maintainer's
  pull request to the maintainer posture, and the same pattern matched
  against a first-time fork never fires, because the fork's context is
  external and the rule would be refused if it claimed otherwise.
- **Deepening is free everywhere.** Raising `strictness` needs no immune
  anchor on any context, including from a contextless rule — the only
  contextless rules that survive validation.
- **The one residual is the trusted class itself.** A maintainer can title
  their own pull request into a convention, and a maintainer could edit the
  policy file outright — trusted for the same reason as in the resolver
  design: what a write-class actor does to governance is the repository's
  own choice, enforced by branch protection, not by this action.
- **Fork pull requests, honestly.** Under `pull_request` a fork carries no
  secrets, so `api-url` arrives empty and startup validation refuses the
  run today — a red cross on a run that read nothing. Full review is
  unachievable for a fork whatever the policy says; a consumer who wants
  the outcome recorded rather than red declares an explicit external-context
  exception? No — external is frozen. Instead the design permits exactly
  one external-context rule shape: `run: false` alone, recording the skip
  (a green run whose record says review was considered and intentionally
  not run) in place of the red no-secrets refusal. That is not a weakening:
  it trades an unachievable `full` for the most informative achievable
  outcome, and it remains opt-in — without such a rule, secretless forks
  hit today's startup refusal exactly as before.

## The rule list

```json5
{
  // At the top level of review.json5, beside strictness and rules.
  // Absent entirely — the default — means: no classification, no axes,
  // byte-for-byte today's behaviour.
  applicability: {
    // Exact logins (case-sensitive) that may classify as automation authors
    // when user.type is "Bot". This repository's own release App first.
    bots: ["ecoma-io", "dependabot[bot]"],

    // Ordered, first-match-wins. Each rule needs an id — the name the audit
    // record carries. `context` plus `when` conditions combine
    // conjunctively; the three axis keys are independent.
    rules: [
      {
        id: "release-prs",
        context: "automation",
        when: {
          title: "^chore(\\([\\w-]+\\))?: release",
          branch: "^release-please--",
        },
        run: false, // applicability axis, alone
      },
      {
        id: "dep-manifests",
        context: "automation",
        when: { paths: ["**/pnpm-lock.yaml"] },
        posture: "automation", // posture axis
        instruction: ".github/action-agents/review/postures/manifests.md",
      },
      {
        id: "docs-maintainer",
        context: "maintainer",
        when: { paths: ["docs/**"] },
        posture: "maintainer",
        instruction: ".github/action-agents/review/postures/docs.md",
        intensity: { strictness: "low" }, // intensity axis, alongside posture
      },
      {
        id: "hard-infra",
        context: "external", // frozen context: deepening only
        when: { paths: ["core/src/**"] },
        intensity: { strictness: "high" },
      },
    ],
  },
}
```

- **Precedence is the declared order.** The engine evaluates rules in config
  order and the first match wins; it never reorders, scores or merges.
- **Nothing matches means: run, standard posture, file intensity — the
  defaults, literally.** An unallowlisted bot's pull request, or an
  allowlisted one with no matching rule, gets a full review; rules opt a
  context out or sideways, never the default.
- **Conditions.** `context` is one of the three derived values; `title` and
  `branch` take regular expressions, compiled at startup and refused on
  failure; `paths` takes globs in the one dialect the configuration page
  defines, evaluated over the reviewed inventory — the same post-ignore set
  the rules and the model would see, because ignore is a universe filter.
  `title`/`branch`/`paths` match against GitHub-bounded strings (a
  256-character title, a bounded ref name); a pathological pattern in a
  consumer's own policy file makes itself visible on the first run it
  matches, the same way any bad config does.
- **Determinism.** Identical event metadata, identical policy file and
  identical reviewed inventory yield identical context, axes and rule. No
  clocks, no retries, no randomness, no network beyond reads the run
  already makes, no model anywhere in the decision.

### Where classification sits in the run

On the resolver's flow — snapshot, policy source, config and documents at
the pinned SHA — classification slots in after `validateConfig` and before
diff accounting and the first model call:

1. the existing code-owned state skips are unchanged and first: draft, and
   closed-or-merged, still return their skip before anything else;
2. `resolvePolicySource` and the pinned policy load run as the resolver
   design specifies;
3. with `applicability` present, the changed-file inventory is fetched (only
   when some rule carries a `paths` condition — otherwise the listing is
   skipped, costing zero extra calls), the context is derived, and the
   rules are evaluated;
4. `run: false` short-circuits here: no prompt, no provider contact, no
   diff accounting — one record written;
5. anything else proceeds exactly as today, with the matched posture and
   intensity applied to the run's effective config.

Classification deliberately precedes the `maxDiffLines` refusal: a skipped
pull request spends no model calls and makes no budget judgment, and its
record says so. A pull request that matches no rule reaches the budget
refusal exactly as it does today.

The code-owned skips join the audit story when the policy is enabled: a
draft or closed pull request writes the same skipped record with
`matchedRule: null` and basis `"state"`, so a required-check wrapper or an
auditor reads one artifact shape for every intentionally-not-reviewed case.
Without the policy they keep today's behaviour — a log line, nothing
written.

## The audit record

Every run under an enabled policy — including a skipped one — writes the
machine-readable run artifact. Three changes to the artifact contract, all
additive and all gated on the policy being present:

- `outcome.classification` gains an explicit **`"skipped"`** value, beside
  `published`, `abandoned` and `refused`. "Reviewed, clean", "reviewed,
  partial" and "intentionally not reviewed because rule X matched" become
  three machine-distinguishable outcomes.
- A new `applicability` fact section:

  ```json
  {
    "context": "automation",
    "applicable": false,
    "posture": "standard",
    "intensity": {},
    "matchedRule": "release-prs",
    "basis": "rule",
    "inputs": { "association": "NONE", "head": "same-repo", "author": "bot-allowlisted" }
  }
  ```

  `basis` is `"rule"` (a rule matched), `"default"` (nothing matched, the
  defaults apply) or `"state"` (the code-owned draft/closed skip).
  `matchedRule` is the rule's `id`, or `null`. `inputs` snapshots the three
  provenance values the context derivation actually read. The record names
  all three axes, so the source of every deviation from the defaults stays
  auditable.

- Skipped runs write a reduced artifact — repository, pull request, head
  SHA, the skipped outcome, the applicability section — and the artifact
  validator learns that second shape. Policy-enabled runs carry an artifact
  `schemaVersion` that names the new shape; runs without the policy keep
  today's artifact byte-for-byte.

## Security boundaries

- **The model never decides any axis — least of all the bypass.**
  Classification completes before any conversation exists, so for
  `run: false` there is no model in the run at all. The output contract is
  frozen — findings and a summary, no field that could express, request or
  negotiate a context, a posture or a skip — and a model-chosen bypass is
  not a configuration mistake but a design violation, refused the way an
  off-sheet label answer is refused. The LLM is a reviewer inside the
  posture it is given; it is never the decider of whether review happens.
- **No workflow input, and none planned.** The policy's on-switch is the
  presence of the `applicability` key in the policy file. If a workflow
  input is ever justified, the sheet-narrowing precedent bounds it the way
  triage's `labels:` input is bounded: it may disable the policy outright
  or remove options from what rules may select, and nothing may add a
  context, a posture, or an eligibility exception. This mirrors the
  resolver design's own conclusion that no input ships in the first
  version.
- **The policy file is the only widening surface, and it is trusted.** Every
  widening-capable declaration — the bot allowlist, the eligibility
  anchors, the posture documents — lives in the file the resolver reads at
  a pinned trusted SHA. A pull request cannot edit the policy that
  classifies it, which is the same property that stops a pull request
  editing the policy that judges it.
- **Everything untrusted stays untrusted.** Titles, branch names, changed
  paths and diffs remain evidence; the classification treats them as values
  to match, never as instruction, and no match result feeds anything but
  the axes.

## Validation, all of it at startup

With `applicability` present, startup validation refuses — red, before the
first model call, the same refusal class as a bad `strictness` today:

- an axis value outside the declared sets, or `posture: "standard"` stated
  explicitly in a rule (the default restated is dead weight);
- an external-context rule that skips, reframes or lowers — refused; the
  external context admits only deepening;
- a weakening rule (`run: false`, non-standard `posture`, lowered
  `intensity`) with no `context` — **a convention never governs alone**;
- a rule without an `id`, a duplicate `id`, or a `context` outside the
  three derived values;
- a `bots` allowlist entry that is not a non-empty string, or a rule
  declaring `context: "automation"` with an empty allowlist;
- a `title` or `branch` pattern that does not compile as a regular
  expression;
- a `paths` glob the dialect rejects;
- a non-standard posture whose `instruction` document does not exist at the
  resolved policy source, or exceeds the 8 KiB document cap.

One consequence is stated rather than hidden: config validation is
exhaustive today, so a consumer who pins an older tag and adds
`applicability` gets a startup refusal naming the unknown key — visible and
fail-closed, not a silently ignored policy. Consumers opt in by moving the
tag, which is how every other config addition here has shipped.

## Zero-config equivalence

Without the `applicability` key: classification never runs, no inventory is
fetched for it, skips are log-line-and-nothing as today, artifacts carry no
new keys and no `skipped` classification, and every refusal, outcome and
write is byte-for-byte today's behaviour. The policy exists only where a
consumer declared it.

## Acceptance evidence: dogfooding on this repository

The design's acceptance test is this repository's own automation pull
requests — the cases exist here today, and the first implementation PR
records them as fixtures:

| Pull request                                                     | Author         | Provenance (observed)                                                                                       | Today                   | Under the policy                                                                      |
| ---------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------- |
| #192 `chore(workspace): release 0.6.0` (the Release Please case) | `app/ecoma-io` | `type: Bot`, association `NONE`, same-repo head `release-please--branches--main--components--action-agents` | full human-style review | context `automation`; rule `release-prs` matches; `run: false` — green, recorded skip |
| #193 `docs: correct the permissions-block attribution…`          | `johnitvn`     | write-class association, same-repo head, docs paths                                                         | full review             | context `maintainer`; eligible for `docs-maintainer` posture + lowered intensity      |
| #195 `feat(core): resolve the trusted policy source…`            | `johnitvn`     | write-class, same-repo, code paths                                                                          | full review             | context `maintainer`; no rule matches — defaults: run, standard, file intensity       |
| (no external pull request has landed in this repository yet)     | —              | synthetic fixtures built from the forge payload contract until the first one arrives                        | —                       | context `external`; frozen — full review, deepening only                              |

The fixture plan: recorded event metadata (author login and type,
association, head repository, head ref, title, changed paths) for each row,
stored under the review action's test fixtures, plus golden assertions —
#192's shape classifies `automation` and skips with a record; a
#193-shaped maintainer docs PR classifies `maintainer` and takes the
posture; a synthetic fork-first-time-contributor shape classifies
`external`, and any rule attempting to weaken it is refused at validation.
The zero-config parity test closes the loop: with the key absent, every
recorded fixture produces byte-identical today-behaviour.

## Landing as small pull requests

Each PR lands one architectural outcome, states observable acceptance
criteria, and ships its regression tests. The sequence assumes #113's
resolver lands first (the config read path and `policyReader` are
prerequisites).

1. **PR 1 — `feat(review): classify the execution context and apply the
applicability axis.`** Context derivation, the `bots` allowlist, the
   `run` key, the skipped record, and the dogfood fixtures above. First
   architectural outcome: this repository's Release Please pull requests
   stop consuming full review and become recorded skips.
   Acceptance: a #192-shaped event skips green with a record naming
   context and rule; zero-config fixtures byte-identical; an
   external-weakening rule is refused at validation; classification is
   deterministic across replayed fixtures.
2. **PR 2 — `feat(review): add the posture axis.`** The three postures,
   mode-scoped instruction documents at the pinned policy source, audit of
   posture in the record. Acceptance: a #193-shaped maintainer docs PR runs
   the maintainer posture with the 8 KiB instruction in effect; the
   artifact records posture and matched rule; an instruction document over
   the cap or missing from the policy source is refused; external-context
   posture rules are refused.
3. **PR 3 — `feat(review): add the intensity axis.`** `strictness` deltas,
   lower-gates for weakening, deepening anywhere, effective values in the
   existing policy section. Acceptance: lowering without an immune context
   is refused; deepening from a contextless rule is accepted; effective
   strictness is audited; every earlier fixture still classifies
   identically (no cross-PR drift).

## Shared abstractions: duplicated text versus duplicated semantics

The three actions will grow surfaces that _look_ alike — ordered lists, sheet
validation, first-match-wins. The rule for consolidation is the doctrine's:
duplicated text is not duplicated semantics. Triage's label sheet and
review's applicability policy share a text shape and nothing else — one
picks a value from a closed sheet, the other weakens a review pipeline
under an eligibility doctrine with different failure semantics. Each keeps
its own implementation until three tests hold at once: the semantic
invariant is genuinely identical, the failure semantics are identical (red
refusal, never silent fallback), and the duplication reduction is real.
And even then the consolidation must not cross the action boundary —
`core/` stays infrastructure-only, so the policy-source resolver (#113)
remains the only shared piece. Within `review/src`, the context derivation
and the rule evaluator are one module shared by all three axes — the axes
are three keys over one match, not three engines.

## Boundary placement

The classification engine is review's domain logic and lives in `review/src`
as a pure module over injected inputs — event metadata, the validated policy
shape, the reviewed inventory. `core/` gains nothing: the resolver is
already the shared piece, and an applicability engine only review could want
does not belong beside it, exactly as the boundary law states. If `triage`
or `harmonise` ever genuinely need execution-context classification of
their own, that is the moment to apply the three-part consolidation test,
not before.

## Acceptance criteria, as observable invariants

- For a fixed policy file and fixed PR metadata, the derived context and
  the three axis values are deterministic and derived only from declared,
  non-model sources; no single field — author login, `github.actor`,
  association — decides alone.
- No configuration or model-output path lets the model select or widen any
  axis; a pull request cannot move itself off full review by editing its
  title, body or labels, because every weakening rule names an
  author-immune context the derivation computed from signals the author
  does not control.
- Every run under the policy — including a skipped one — writes a record
  naming the context, all three axes, the basis and the matched rule.
- Without the policy, behaviour is byte-for-byte today's: every reviewable
  pull request gets a full review, skips stay log lines.
- The external context is frozen: full review, deepening only, whatever the
  policy declares.
- The policy reads its rules, allowlist and posture documents through the
  resolved policy source, fails closed on invalid configuration, and
  refuses before the first model call.
- Dogfood: this repository's own release pull requests are the fixtures
  proving automation PRs get policy-appropriate handling instead of
  default full human-style review.

## Out of scope, and what would reopen each

- **The same policy for `triage` and `harmonise`.** Reopen when one of them
  has a concrete class of runs it should skip or reframe — the three-part
  consolidation test is the mechanism, evidence is the trigger.
- **More intensity deltas than `strictness`.** `maxDiffLines`, `max-turns`
  and ignore deltas are the same shape; add them only when a posture
  demonstrates the need, under the same lower-gates.
- **Posture-specific tool surfaces.** The tool registry is fixed in code
  and the per-phase policy already narrows it; postures do not touch it in
  this design.
- **Auto-skipping secretless forks.** The explicit external `run: false`
  rule covers it, opt-in; the default stays review.
- **Scoring, weighting or model-judged classification.** Rejected outright;
  see the security boundaries.
