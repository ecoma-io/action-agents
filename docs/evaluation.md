# Evaluation

How this repository answers "did this change make the actions worse?" — with a
replayable corpus, a deterministic evaluator, and a certification bar a release
is judged against. The corpus and the evaluator are issue #278's deliverables;
`pnpm eval` is the command that runs them, and the printed table is the metric
set. This page maps that set and records the two decisions taken beside it —
the certification bar, and the deferral of the production signals to U-8.

The actions are judged in two different places, and keeping them apart is the
page's point. Offline, the corpus replays recorded runs through the real action
modules with no network and no model, and the metrics that are computable there
are computed. In production, the signals that would say whether the actions'
judgments are _any good_ are defined but not collected — deferred to U-8, and
marked as deferred everywhere they appear. Neither list is silent: a metric
that cannot be computed here says so, with the reason and the unlock.

## One owner per fact

The header of `tools/evaluate.mjs` is the executable definition: every metric's
formula, data source, threshold and computability marking lives there, in the
wording issue #278 froze, and the run enforces what it declares — a threshold
miss or a corpus defect exits non-zero. This page does not restate those
formulas; it names each metric, its computability class and its threshold
posture, and defers the rest. When the two disagree, the header is the owner
and this page is stale — fix this page, and treat the drift as a bug in
whichever edit introduced it. Tightening a threshold is likewise a reviewed
change to `THRESHOLDS` in that file, never a silent one.

## The corpus

`evaluation/corpus/` holds the recorded runs. Each entry is a directory:

| File            | What it is                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `snapshot.json` | The run's recorded world: the event, the inputs, the forge reads (by ref for harmonise), the model |
| `answers/`      | The recorded provider answers, served in ask order — absent entirely for a run that asks for none  |
| `expected.json` | The pin: the terminal outcome, and what a divergence from it means                                 |
| `README.md`     | One paragraph on what the entry proves                                                             |

Snapshots are synthetic — authored, never captured — because a captured run
carries whoever wrote the thread it recorded. A redacted real run is allowed
only with its text replaced wholesale; what the replay then judges is
structure, which is the point. A run that asks nothing — triage in a
zero-ask posture, harmonise refused before any translation — legitimately has
no `answers/` directory: git does not track empty directories, and the
evaluator treats absence as the zero-ask case it is, not as a defect.

The posture is fail-closed in both directions. A snapshot, an answer file or an
`expected.json` that does not match its declared shape is a `CorpusDefect` and
the run exits non-zero — never a silent zero — and so is a replay that reaches
for a read the recording does not hold, asks for more answers than it holds, or
stops before spending them. `pnpm eval` replays every entry, prints the table,
and exits 0 only with every threshold met and no defect.

Determinism is what makes the table a regression instrument: the clock is
fixed, `fetch` is replaced with a throwing stub for the duration of a replay,
and the doubles are the only provider. Same corpus and same code, same printed
bytes.

## The metrics

Three computability classes, and every metric in the evaluation sits in exactly
one, marked in the evaluator's header where it is defined:

| Metric                                            | Class                     | Threshold posture          |
| ------------------------------------------------- | ------------------------- | -------------------------- |
| triage `refusal-rate`                             | offline-computable        | reported, unbounded        |
| review `precision`                                | offline-computable        | ≥ 0.5, initially           |
| review `false-positive-rate`                      | offline-computable        | ≤ 0.5, initially           |
| review `severity-agreement`                       | offline-computable        | ≥ 0.5, initially           |
| review `verifier-agreement`                       | offline-computable        | ≥ 0.5, initially           |
| review `verification-accuracy`                    | offline-computable        | ≥ 0.5, initially           |
| review `anchoring-integrity`                      | offline-computable        | exactly 1.0 — pinned       |
| harmonise `validation-refusal-rate`               | offline-computable        | reported, unbounded        |
| `mutation-surface` (write ops by kind, all three) | offline-computable        | no threshold — drift watch |
| `archkeep violation rate`                         | not computed here         | enforced by `pnpm arch`    |
| triage `sheet-accuracy`                           | production-deferred (U-8) | —                          |
| harmonise `apply-clean-rate`                      | production-deferred (U-8) | —                          |
| duplicate-detection precision/recall              | not applicable            | —                          |
| routing accuracy                                  | not applicable            | —                          |
| finding recall                                    | caveated                  | —                          |

**Offline-computable** — the rows `pnpm eval` prints. Each has a formula, a
data source and the decision it informs, stated in the evaluator's header.
Two postures are worth naming because they are deliberate: the refusal and
validation-refusal rates are reported unbounded — a ceiling posture is a dial,
not a defect, and the number exists so a change that moves it is visible — and
anchoring-integrity is pinned at exactly 1.0, because a digest that fails to
re-derive is a defect, not a calibration matter. Every initial threshold is
deliberately loose: the corpus is the seed, and thresholds earn strictness with
calibration history. Mutation-surface is absolute counts per write-op kind, so
a run's growth is visible — growth is a design smell, and the table is where it
would show first.

**Production-deferred (U-8)** — defined with formulas in the header, never
computed here, never silently absent. Triage `sheet-accuracy` needs 30 days of
non-revert observation and actor attribution the label timeline cannot always
give. Harmonise has no offline model-quality metric at all — translation
quality is not judgeable without a reference translation — so
`apply-clean-rate` waits for production merge outcomes. What would unlock each
is [the U-8 decision](#the-u-8-decision) below.

**Not applicable or caveated** — marked as such, never silently. Duplicate
precision/recall: no offline ground truth exists, and the relationship signal
is advisory text, not a dedupe behaviour — a number here would measure the
fixture, not a capability. Routing accuracy: triage has no routing concept, and
a metric over a behaviour that does not exist is N/A, not zero. Finding recall:
computable only against the synthetic corpus itself, so its ceiling is the
corpus — reported, it would read as a quality measure while measuring the
fixture, which is why this page states the caveat and the table computes no
such row.

## The certification bar

A change is certified when all four hold:

1. **Archkeep verdicts green** — `pnpm arch`, its canaries beside it.
2. **All gates green** — lint, typecheck, tests, the monopoly and shape gates;
   the full command table is in `CONTRIBUTING.md`.
3. **Adversarial corpus green** — `pnpm security`.
4. **Offline thresholds met** — `pnpm eval` exits 0.

CI's evaluation job is **advisory** — path-filtered, `continue-on-error` —
and becomes required only after wall-clock is measured and the thresholds have
calibration history. Until then the bar is a reviewed claim, not a mechanical
one: a release or a merge certifies on the strength of a human having run the
four, which is exactly why the release checklist names them.

## The U-8 decision

U-8 is the open decision about where production telemetry lives. The offline
corpus can pin structure; it cannot say whether a label was right, a
translation clean, or a finding real, because those facts exist only in the
consumer repositories where the actions run. Until U-8 names a collection
path, the production signals stay defined and uncollected:

- **triage `sheet-accuracy`** — decisions surviving 30 days without human
  revert ÷ applied decisions. Two dependencies: production observation time,
  and actor attribution — the label timeline cannot always distinguish
  triage's own removals from a human's. Unlocked by diffing the run record's
  mutation list against the label timeline, so each removal carries an actor.
- **harmonise `apply-clean-rate`** — PRs merged without manual fix ÷ PRs
  opened. Unlocked by production merge outcomes, which no corpus holds.
- **human edit rate** — how often a human edits what a run wrote (a harmonise
  translation corrected before merge, a review finding reworded or withdrawn
  by hand). Deferred for the same reason: no collection path named yet.
- **merge-conflict rate** — harmonise PRs that land with conflicts resolved by
  hand, a structural signal that translations are being applied against stale
  bases. Deferred: no collection path named yet.
- **stale mutation rate** — mutations still in place long after the state they
  responded to has changed. Deferred: no collection path named yet.

The first two carry frozen formulas in the evaluator's header; the last three
do not, and will not until a collection path makes them computable — a formula
over data nobody collects is a fiction with a division sign. What a collection
path would mean for all five is the same thing: an aggregation job run offline
in this repository, its output landing as fixtures, instruction and threshold
changes through normal reviewed pull requests.

**The frozen rule**, and it is a rule about architecture rather than about
metrics: human feedback enters as observed events — label reverts, comment
edits, merge outcomes — aggregated offline into fixtures, instructions and
docs via normal PRs. **No path exists or is built where consumer-repo activity
updates behavior without a reviewed commit in this repository.** The actions
are text and prompts read from this tree; the only way consumer experience
changes them is a pull request here that a human reviewed. A telemetry loop
that writes behavior back would be a model-update path with the model's name
removed, and issue #278 rejected it in those words.

## Keeping this page true

The evaluator's header and this page move together: a metric added, renamed,
re-thresholded or re-classified lands in the same pull request in both places,
and a corpus entry that changes what the table prints updates both. The
certification bar changes only with a reviewed decision recorded beside it —
it is the claim a release stands on, which makes it the last thing to move
casually.

The floor this page sits on: [the run contract](run-contract.md) owns the
terminal states and failure classes the corpus pins, and
[the Archkeep integration](archkeep-integration.md) records why the arch gate
is one authority among three rather than the whole verdict.
