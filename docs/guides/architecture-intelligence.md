# Guide: architecture intelligence

Archkeep's descriptive surfaces — `health`, `report`, `debt`, `trajectory`,
over a history directory your repository maintains — answer questions a pull
request cannot: is the architecture getting healthier or worse across
releases, how long has each accepted violation been carried, and which way is
the graph drifting. None of the three actions in this repository is involved
in answering them, and that is a decision rather than a gap: this page ships
the recipe that runs those surfaces behind release triggers, the law that
keeps them off every pull request, and the history-directory rule that keeps
the record yours.

- [What the surfaces answer](#what-the-surfaces-answer)
- [Never per pull request](#never-per-pull-request)
- [The history directory is yours](#the-history-directory-is-yours)
- [The recipe](#the-recipe)
- [Budgets, measured](#budgets-measured)
- [Exit semantics](#exit-semantics)
- [What the actions do with these reports](#what-the-actions-do-with-these-reports)

Everything below was measured by running the pinned `@ecoma-io/archkeep`
binary against real trees — the numbers in [Budgets, measured](#budgets-measured)
name their trees. Where this page and a run of the pinned binary disagree, the
run wins and this page is wrong.

## What the surfaces answer

| Surface      | The question it answers                                                                                                                                                                                | Needs a history dir | Other needs                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | ------------------------------------------------ |
| `health`     | The metric panel — projects, edges, coverage, violations, waiver surface, cycles, edge density, debt, fitness — with trends across the snapshot series.                                                | optional            | none                                             |
| `report`     | One governance document composing health, waivers, fitness, the ADR registry and provenance through the same functions those commands run — it cannot disagree with them about the same tree.          | optional            | none                                             |
| `debt`       | The aged ledger: every accepted violation (waiver), aspirational gap, drift finding and unresolved intent boundary, each aged across snapshots — age in snapshots, not days.                           | yes                 | a tracked `architecture-intent.json`             |
| `trajectory` | The aggregate across transitions between consecutive snapshots: what kind of change each was (architecture, policy, provider, code drift, unchanged), with disclosures for what could not be compared. | yes                 | at least two snapshots for anything to aggregate |

A history directory is a series of graph snapshots produced by
`archkeep history --capture <dir>` — one full `graph` envelope per capture,
named `<sequence>-<identity8>.json`, so the leading number of each filename is
history order. The directory is the whole record: no index file, no database.
Capture deduplicates by architecture identity — a release whose architecture
did not move writes nothing — and an identity match is not fooled by churn: in
the repository that maintains these actions, an entire campaign of tooling and
documentation changes measured as one snapshot, because none of it moved the
project graph or the law.

## Never per pull request

These surfaces run behind release, periodic or manual triggers in your
workflow — never in the job that reviews a pull request. The grounds are
recorded in the [runtime-integration design
record](../development/archkeep-integration-analysis.md) and are worth stating
where a consumer would meet them:

- **They are descriptive.** None of them can fail a build — their contract
  holds no findings exit — so wiring them per pull request would add steps
  that can never gate anything, only spend runner time.
- **They need a long-lived store.** A pull-request run is stateless: hydrating
  a snapshot series, appending to it, and shipping it back inside one job is a
  stateful dance in a workflow that has no state, and the store must never be
  owned by an action.
- **The per-pull-request question is already answered.** The `delta` envelope
  — what changed in architecture terms between the base and this head — is the
  evidence a review needs, and [`review`'s recipe](review.md#architecture-evidence--record-an-archkeep-delta)
  records it. Health, debt and trajectory answer questions about the series,
  not about one change.

Mechanically, the split is enforced on both sides. Your intelligence workflow
has no `pull_request` trigger at all. And the actions cannot consume these
reports even by accident: the only architecture input any action takes is
`review`'s `architecture-report`, whose reader is frozen to the `delta` family —
feed it a health, report, debt or trajectory envelope and it is a red typed
refusal naming the family, not a quiet read.

## The history directory is yours

What each side holds:

- **What you maintain** — the directory: capture on each release or periodic
  run, and carry the series between runs. Two shapes work, both sanctioned by
  the tool:
  - **Carry it in CI storage.** Restore a cache (or artifact) into the
    directory before capture, save it after. No repository noise; the series
    is bounded by your storage retention. The recipe below uses this shape.
  - **Commit it.** The series is reviewable git history — a change to it is a
    pull request, and the record travels with the clone. A deliberate
    repository decision, taken once, in review.
- **What the actions read at most — nothing.** No action input names the
  history directory. No action reads a snapshot. The runtime read surface of
  the entire integration is one thing: the `delta` report and its manifest,
  through `review`'s `architecture-report`. These reports never enter an
  action run, so they can never enter a prompt, a record or a comment.
- **Why the actions never write it.** Three independent reasons, any one of
  which is enough. The zero-runtime-dependency law: an action never runs
  Archkeep, so it has no capture to perform. The write ceilings: an action's
  writes are the reversible, visible, notification-free surfaces — a
  persistent series store is none of those. And the untrusted-input ceiling: a
  pull-request-triggered run writing into a persistent store would let
  pull-request content steer what later runs read as architecture memory —
  the one channel the integration was designed never to open.

One hygiene line in the carried-storage shape: clear the directory before you
restore into it, so the series is exactly what your storage held — never a mix
with anything the checked-out tree happens to contain. Snapshots are
self-validating on read (a malformed one stops the read loudly rather than
degrading it), so a corrupted entry is a visible refusal, not silent rot.

## The recipe

A release-triggered job, wired to your cadence. The trigger block is left
commented because it is the one part that is yours, not the recipe's: a
release, a periodic schedule, or both — never `pull_request`, for the
grounds above. Pinned by you; the action never learns any of this ran.

```yaml
# The trigger is the recipe's law and it is yours to wire — release,
# periodic, or both; never pull_request. Uncomment:
#   on:
#     release:
#       types: [published]
#     schedule:
#       - cron: "0 3 * * 1"
permissions:
  contents: read
jobs:
  architecture-intelligence:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      # The released tree on a release run, the firing commit on a periodic
      # or manual one. A release tag is clean by construction, and a
      # snapshot captured from a dirty tree is disclosed as such — judge
      # released commits, not work in progress.
      - uses: actions/checkout@v5
        with:
          persist-credentials: false
          ref: ${{ github.event.release.tag_name || github.sha }}

      - uses: actions/setup-node@v5
        with:
          node-version: 24

      # Pinned by you, exactly as the review recipe pins it.
      - run: npm install --global @ecoma-io/archkeep@0.29.0

      # The series is carried in CI storage: clear, then restore, so the
      # directory is exactly what the cache held. A first run finds no cache
      # and starts the series here.
      - run: rm -rf .archkeep/history
      - uses: actions/cache@v6
        with:
          path: .archkeep/history
          # A fresh key every run, so the post-job save always writes; the
          # prefix restore picks up the most recent previous entry.
          key: archkeep-history-${{ github.run_id }}
          restore-keys: archkeep-history-

      # Capture requires the directory to exist; a cache miss leaves it
      # absent. An unchanged architecture writes nothing — the deduplication
      # is the tool's, not the recipe's.
      - run: mkdir -p .archkeep/history
      - run: archkeep history --capture .archkeep/history

      # The reads. No exit tolerance, no `continue-on-error`: these commands
      # are descriptive — none of them fails on findings — so a nonzero exit
      # means the run could not determine its answer, and an advisory job
      # that degrades silently is worse than a red one.
      - run: mkdir -p .archkeep/intelligence
      - run: archkeep health .archkeep/history --format json --output .archkeep/intelligence/health.json
      - run: archkeep report .archkeep/history --format json --output .archkeep/intelligence/report.json
      - run: archkeep debt .archkeep/history --format json --output .archkeep/intelligence/debt.json
      - run: archkeep trajectory .archkeep/history --format json --output .archkeep/intelligence/trajectory.json

      # The series and the reports survive the runner. `include-hidden-files`
      # because `.archkeep` is a hidden directory and upload-artifact prunes
      # hidden files by default; `if-no-files-found: warn` because a declared
      # upload that lands nowhere must be loud.
      - name: Upload the architecture intelligence
        if: always()
        uses: actions/upload-artifact@v5
        with:
          name: architecture-intelligence
          path: .archkeep/
          include-hidden-files: true
          if-no-files-found: warn
```

For the per-pull-request surface — the `delta` evidence a review records —
see the [`review` guide's recipe](review.md#architecture-evidence--record-an-archkeep-delta).
The two jobs share nothing: different triggers, different steps, and the
intelligence job invokes no action at all.

## Budgets, measured

Measured at `@ecoma-io/archkeep` 0.29.0 on the repository that maintains these
actions (5 projects, 181 analyzed files, 634 imports), September 2026:

| Step                | Wall   | Output                                         |
| ------------------- | ------ | ---------------------------------------------- |
| `history --capture` | ~1.3 s | ≈2 KiB per snapshot; nothing when deduplicated |
| `health <dir>`      | ~1.3 s | ≈1.8 KiB envelope                              |
| `report <dir>`      | ~1.4 s | ≈15 KiB envelope                               |
| `debt <dir>`        | ~1.3 s | ≈1.7 KiB envelope                              |
| `trajectory <dir>`  | ~1.3 s | ≈2.2 KiB envelope                              |

The whole recipe is ≈6.5 s on five steps, every step far under the 30 s
per-step ceiling the integration budgets hold (the existing U-2 trigger
threshold, reused). The dominant term is the tree scan every Archkeep command
performs; the snapshot count is a small addition — over a synthetic series on
the contract-gate rig, 36 snapshots against 12 moved no read by a tenth of a
second, and only the trend-bearing envelopes (`health`, `report`) grow in
bytes, by their per-snapshot trend rows.

The per-pull-request budget this adds is zero. The recipe runs in its own
workflow on its own triggers; no step of it executes in a review, triage or
harmonise run, and the actions' archkeep invocation counts per pull request
are exactly what the [design record's invocation
matrix](../development/archkeep-integration-analysis.md) records.

## Exit semantics

All four surfaces are descriptive: none of them exits 1 — no finding these
commands can report is allowed to fail a build. What each does when the record
is thin, measured against the pin:

| Surface      | Directory argument | Empty directory (exists, no snapshots)                                                                         | The exit-3 lane — the run could not determine its answer                                                                                                                          |
| ------------ | ------------------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `health`     | optional           | exit 0: the live-tree panel with an empty trend list                                                           | a named directory that does not exist or cannot be read; an unreadable or malformed snapshot                                                                                      |
| `report`     | optional           | exit 0: the document without trend rows                                                                        | as `health`                                                                                                                                                                       |
| `debt`       | required           | exit 3: "no record to age the ledger against, so 'no architecture debt' would be a claim this run cannot make" | a missing or unreadable directory; a malformed snapshot; and — measured — no tracked `architecture-intent.json`, which the ledger needs as the declared intent to compare against |
| `trajectory` | required           | exit 3: "there is no history to aggregate"                                                                     | a missing or unreadable directory; a malformed snapshot; otherwise a completed run always exits 0 — no no-verdict lane                                                            |

A first run holds one snapshot: `trajectory` answers `available: false` with
its reason (`insufficient_history`) rather than pretending to aggregate, and
`debt` reports every age as 0 — observed, not yet aged. Both are exit-0
honesty, not failures; the series starts earning its answers on the second
capture.

`history --capture` does not create the directory either — a missing one is
exit 3 — which is why the recipe creates it before the first capture. Exit 2
is a usage error (a wrong argument, an unknown flag) and reddens the step like
any wiring mistake.

## What the actions do with these reports

Nothing, deliberately. The actions' architecture consumption is the `delta`
envelope and nothing else: recorded by `review` when its
`architecture-report` input is set, never enforced anywhere
([ADR 007](../adr/007-archkeep-runtime-evidence.md)). The descriptive surfaces
have no input, no record field and no code path in any action, and widening
that is a design decision — an issue and an ADR on this repository, never a
configuration flag a workflow sets.
