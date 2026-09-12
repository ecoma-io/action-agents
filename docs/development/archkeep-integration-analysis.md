# Development — Archkeep runtime integration

This page is the design record for [issue #518](https://github.com/ecoma-io/action-agents/issues/518):
what it takes for the three actions to consume Archkeep as first-class
architecture evidence at runtime — review first — without any of the
separations that keep both tools honest blurring. It is written ahead of the
implementation it governs: every phase that lands amends
[the run contract](../run-contract.md) and the ADRs it touches first, in the
same pull request as the code, per the freeze rule. Where this page and a
landed contract disagree, the contract wins and this page gets corrected.

Evidence base: source-level investigation of archkeep v0.29.0 (working tree
at `ea83d998` — package graph, frozen semantic contract, command semantics,
two runtime probes, measured timings) and of this repository at `1d147e3`
(runtime seams, per-action pipelines, test infrastructure), 2026-09-12. The
design went through an adversarial panel before landing here; its blocking
findings and their resolutions are folded in and cited as _panel_ rulings.
Archkeep facts below cite the archkeep repository as plain paths (this
page, like every page here, links only within `docs/`).

# 1. The separation this preserves

- **Archkeep owns** deterministic architecture truth: the law, the graph,
  evidence snapshots, verdicts, waivers, provenance, history. Nothing an
  agent writes becomes architecture authority.
- **The actions own** probabilistic reasoning over that truth: policy and
  intent interpretation, risk assessment, decisions, bounded mutations,
  audit records.

Four prohibitions follow, and every design decision below is checked
against them: no thin wrapper; no duplicated architecture engine; the model
never infers structural facts Archkeep determines deterministically; no
agent-generated conclusion masquerades as architecture authority.

# 2. Current state — this repository

Three actions over one shared layer, zero runtime dependencies, `node24`
entries, no build. In brief (the per-action development pages carry the
depth):

- **triage**: record draft first → event gate + live-thread arbitration →
  SHA-pinned sheet load → wrapped evidence → one model call → closed-sheet
  decision → label writes with newer-head guard → v1 record. Reads
  everything through the API, never the working tree.
- **review**: applicability classification → ignore/budget inventory →
  deterministic risk/lanes → two-message prompt → multi-turn loop over the
  working tree with the frozen three-tool registry (`read_file`,
  `list_files`, `search`) → anchor/provenance/coverage/verification gates →
  canonical record embedded in the marker comment → SARIF to
  `RUNNER_TEMP` → v5/v6 artifact.
- **harmonise**: config-or-refuse → own-branch state + translation memory →
  chunked translation jobs with deterministic fingerprint skips →
  three-way merge → one commit behind an optimistic lock → PR → v3 record.

**Architecture enters at runtime nowhere.** Archkeep is a devDependency;
`pnpm arch` plus the canaries in CI prove exactly invariants I1 and I12 of
[the run contract](../run-contract.md) — the module-boundary law and the
no-rogue-copies law. At runtime, review stands in path heuristics where
architecture evidence belongs: `review/src/risk.mjs` (ten path rules,
dependency-blind, self-described as the seam a later table widens),
`inventory.mjs`, `lanes.mjs`.

The load-bearing seams the integration builds on: `policyReader`
(SHA-pinned repository reads — a pull request cannot edit its own policy),
constructor-injected forge/chat seams with typed failures, additive record
schemas (the v5→v6 precedent), the corpus evaluator with fail-closed
doubles, and review's evidence-capture boundary that verifies every
finding's anchor against real workspace bytes.

# 3. Current state — Archkeep, the parts that matter here

Measured at v0.29.0 against source (not README):

- **Frozen 1.0 semantic contract** (`doctrine/1-0-semantic-contract.md` in
  the archkeep repository): 24 commands, exit codes 0/1/2/3, JSON envelope
  schemaVersion 2 enforced by a two-directional shape gate, nine read-only
  MCP tools.
- **`check` is the sole enforcement authority**; **`delta` is the bounded
  verdict carrier for change review**: it re-judges both sides (a baseline
  evidence snapshot captured at a base commit, plus the live head tree)
  under the current law and one shared instant, classifying every item
  `introduced | resolved | unchanged | unknown`. A non-waived introduced
  violation exits 1; any unclassifiable item exits 3.
- **Evidence snapshots** (`delta --capture`): raw import-site records +
  graph + coverage + provenance + policy fingerprint. No verdicts, no id —
  the bytes are the identity (canonical serialization; double-capture
  verified byte-identical).
- **Provenance**: `{commit, remote, dirty}|null` per side; full HEAD SHA;
  dirty means tracked-file dirt only.
- **Coverage and unknown**: `coverage.complete` is an enforced predicate;
  exit 3 may arrive with no envelope at all — consumers branch on the
  process exit code before parsing stdout.
- **Waivers**: expired waivers re-assert loudly; the **delta verdict is
  time-dependent** — waiver expiry flips the same tree+law from clean to
  findings. The envelope bytes themselves are deterministic and carry no
  time-relative fields (verified by compare across instants), so the flip
  is semantic, not textual.
- **Tamper resistance does not hold** (probe-verified): a baseline with a
  fabricated `provenance.commit` and edited records is consumed silently —
  shape validation only. Fabricated base records can mask real head
  violations as `unchanged`. Baseline authenticity is a consumer-storage
  trust question, closed here by the recipe laws of §6.1 and upstream ask
  #1 of §9, never by the reader's shape checks.
- **Agent write-back is absent by design** (archkeep ADR 0007: AI output is
  never admissible as an authoritative judge). The sanctioned agent channel
  is `origin` records and ADR text through a human-reviewed pull request.
- **No staleness guard**: delta has none on baseline age or commit
  distance; the consumer pins commits. Provider mismatch between the sides
  throws. A law edit between the sides produces a `policyChanged` note,
  never a refusal.

# 4. Authority and provenance model

Strictly ordered layers; nothing flows upward:

| Layer                     | Owner                                                       | Examples                                                         | Becomes authority?                              |
| ------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------- |
| Architecture law          | archkeep config/intent/ADR (human-reviewed commits)         | `module-boundaries.config.mjs`, `architecture-intent.json`, ADRs | is the authority                                |
| Architecture evidence     | archkeep output (deterministic)                             | evidence snapshots, delta envelopes, coverage                    | no — re-judgeable facts                         |
| Architecture verdict      | archkeep's fold (deterministic; time-dependent via waivers) | `pass \| fail \| unknown` + buckets                              | no — a verdict of the law at one instant        |
| Agent observation         | action-agents records (labelled, non-authoritative)         | artifact architecture section, triage record facts               | only via human-reviewed PR into law/origin text |
| Agent inference           | model prose, framed as evidence                             | findings citing architecture facts                               | never                                           |
| Agent decision / mutation | code-owned                                                  | comment content, closed-sheet label picks                        | never composes an API call from model output    |

Provenance chain for every architecture-aware fact (Archkeep's own field
model; no second provenance system is invented):

```
workflow step (trusted infra, consumer-pinned archkeep)
  → evidence snapshot @ base commit (worktree, clean)      [bytes = identity]
  → delta envelope @ head commit                           [schemaVersion 2]
  → report file in workspace (PR-visible bytes ⇒ untrusted)
  → core reader: envelope validation + commit pinning + digests
  → ArchitectureEvidence (typed, frozen, deterministic given inputs)
  → review artifact architecture section (digests + bounded facts)
  → marker-comment record block (cross-run reconciliation)
```

Every hop is digest-anchored: the artifact records the report's sha256 over
the **raw bytes**, the baseline's sha256, `tool.version`, both policy
fingerprints, and both provenance commits. Retention follows
[ADR 003](../adr/003-evidence-retention.md) (new row lands with P0).

# 5. Capability matrix

Trigger classes: **AO** always-on when the consumer wires the recipe;
**REL** release/periodic; **OPT** optional/future; **—** not consumed.

| Archkeep capability                                      | Stability                          | Today here                  | review                                                                                                                                                                                               | triage                 | harmonise                       | Trigger                                  |
| -------------------------------------------------------- | ---------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------- | ---------------------------------------- |
| `delta --capture` + `delta <base>`                       | stable                             | dev gate only, runtime none | **primary evidence** — buckets, sites, waivers, coverage                                                                                                                                             | P4, conditional (§6.4) | —                               | AO                                       |
| `check` envelope + exits                                 | stable                             | CI gate only                | not consumed at runtime — the consumer's own gate stays the enforcement                                                                                                                              | —                      | —                               | consumer CI                              |
| `graph` snapshot / `diff`                                | stable                             | none                        | narrative structural context; `diff` is depConstraints-only and explicitly not a verdict — parked to avoid a second, weaker verdict-shaped surface                                                   | —                      | —                               | OPT                                      |
| `history --capture` dirs                                 | stable                             | none                        | —                                                                                                                                                                                                    | —                      | —                               | REL                                      |
| `drift` / `reconcile`                                    | stable                             | none                        | remediation context (ranked law-edit candidates, never auto-applied)                                                                                                                                 | —                      | doc-vs-intent mismatch evidence | OPT                                      |
| waiver semantics (expired re-assert, `introducedWaived`) | stable                             | none                        | consumed via delta buckets, carried verbatim                                                                                                                                                         | —                      | —                               | AO                                       |
| run provenance `{commit,remote,dirty}`                   | stable                             | none                        | commit pinning (the reader's staleness check)                                                                                                                                                        | P4                     | —                               | AO                                       |
| ADR registry / `decisions`                               | stable                             | none                        | interpretation context: constraint → `decisionRef` → ADR text, read policy-pinned from base                                                                                                          | —                      | —                               | AO                                       |
| row `origin` records                                     | stable                             | none                        | context                                                                                                                                                                                              | —                      | —                               | OPT                                      |
| `health` / `report`                                      | stable, descriptive                | none                        | —                                                                                                                                                                                                    | —                      | —                               | REL                                      |
| `debt` ledger                                            | maturing                           | none                        | —                                                                                                                                                                                                    | —                      | —                               | REL (needs a consumer-owned history dir) |
| `trajectory`                                             | maturing                           | none                        | —                                                                                                                                                                                                    | —                      | —                               | REL                                      |
| `intent`                                                 | stable                             | folded into CI gate         | folded into delta already; direct read not needed                                                                                                                                                    | —                      | —                               | —                                        |
| `scenario` (what-if)                                     | stable                             | none                        | —                                                                                                                                                                                                    | —                      | —                               | OPT                                      |
| `context` / `context --plan`                             | stable — the agentic fact surfaces | none                        | deferred with reason: the delta-buckets + pinned-ADR assembly covers the P3 need; a second fact surface now is a second surface to firewall; revisit when dogfood shows the prompt starving          | —                      | —                               | OPT                                      |
| `explain`                                                | stable                             | none                        | deferred with reason: deterministic "why is this a violation" is strictly better than the model guessing from a message id — candidate once dogfood shows prompt need; costs one recipe step + bytes | —                      | —                               | OPT                                      |
| `impact`                                                 | stable                             | none                        | deferred with reason: blast-radius facts are narrative context, same treatment as `explain`                                                                                                          | —                      | —                               | OPT                                      |
| `change` (declared-intent gate)                          | stable                             | none                        | rejected with reason: judges declared intent, not re-judged baselines — different semantics from pull-request review; its `base.commit` pinning is the model for upstream ask #2                     | —                      | —                               | —                                        |
| `discover` / `fitness` / `evolution`                     | stable / stable / maturing         | none                        | not consumed: propose-only scaffolding; folded into the consumer's own `check`; linear-history machinery — none is a review input                                                                    | —                      | —                               | —                                        |
| MCP server (9 read-only tools)                           | stable                             | none                        | not used at action runtime (stdio server needs archkeep installed; the actions have no install step) — the dev-time agent surface                                                                    | —                      | —                               | —                                        |
| `./commands` in-process facade                           | stable                             | none                        | deliberately not used (zero-runtime-dependency law)                                                                                                                                                  | —                      | —                               | —                                        |
| custom rules (wasm), presets, profiles                   | stable                             | none                        | ride the policy fingerprint inside delta; `customRules.findings.*` buckets carried by the reader (§6.2)                                                                                              | —                      | —                               | AO (passive)                             |
| SARIF output                                             | stable                             | none                        | the consumer may upload archkeep SARIF in its own workflow — complementary, outside the actions                                                                                                      | —                      | —                               | consumer choice                          |
| federation / cross-repo                                  | missing (deferred upstream)        | none                        | out of scope                                                                                                                                                                                         | —                      | —                               | —                                        |

Rejected as always-on: `health`/`debt`/`trajectory` on every pull request —
descriptive surfaces that cannot exit 1, need long-lived stores the actions
must never own, and would turn architecture intelligence into noise. The
delta envelope already carries what a pull-request decision needs.

# 6. Integration boundary

## 6.1 Who runs Archkeep: the consumer's workflow, never the action

The actions cannot import or run Archkeep: zero runtime dependencies is a
design line (adding one is a design decision, and this design decides no),
and the no-intelligence-layer ceiling of
[ADR 002](../adr/002-no-intelligence-layer.md) is untouched — this is
deterministic evidence, not intelligence. The consumer's workflow runs
pinned archkeep steps before the action and leaves reports in the
workspace:

```yaml
# sketch — the shipped guide carries the full pinned recipe, and the five
# laws below are normative: they land in P0's docs and the dogfood copies
# are the drift canary for them
- uses: actions/checkout@<full-sha>        # merge preview (review's subject)
        with: { fetch-depth: 0 }           # law 4: the base commit must resolve
- uses: actions/setup-node@<full-sha>
- run: npm install -g @ecoma-io/archkeep@<pinned>   # consumer-pinned
- run: |                                   # law 1: clear planted evidence
    rm -rf .archkeep && mkdir .archkeep
- run: |                                   # baseline at the live merge-base (law 4)
    BASE_SHA="$(git merge-base origin/"$BASE_REF" "$HEAD_SHA")"
    git fetch origin "$BASE_SHA"
    git worktree add --detach ../base "$BASE_SHA"
    (cd ../base && archkeep delta --capture --output "$GITHUB_WORKSPACE/.archkeep/base.json")
- run: |                                   # delta at head; laws 1+2+3
    archkeep delta .archkeep/base.json --format json --output .archkeep/delta.json
    code=$?
    case $code in
      1|3) echo "exit=$code" >> .archkeep/exit        # verdict-carrier exits: recorded
            rm -f .archkeep/delta.json ;;             # law 1: no report survives a failed run
      *)   exit $code ;;                              # law 2: everything else is red
    esac
- run: |                                   # law 5: manifest freshly written from the append-only exit file
    …assemble .archkeep/run.json…
- uses: ./review
  with:
    architecture-report: .archkeep/delta.json
```

**The five recipe laws (normative, land in P0):**

1. **Clear, then delete.** The evidence directory is cleared before
   capture, and the report file is deleted on any nonzero delta exit.
   Archkeep leaves `--output` files untouched when a run dies before
   building an envelope, so a pull-request-planted `.archkeep/delta.json`
   would otherwise survive a failed delta and be read as Archkeep's
   verdict — the one channel that makes the report bytes PR-supplied. The
   exit file is append-only, so a plant can only ever contribute a nonzero
   exit line: plants can make evidence look worse, never better.
2. **Tolerate exactly {1, 3}.** Exit 1 (verdict: fail) and exit 3 (no
   verdict) are recorded, not red. Exit 2 — a usage error, a mis-wiring,
   not a verdict — and everything else redden the step.
3. **Capture steps never `||`, never `continue-on-error`.** A failed
   capture is a red run: evidence absent, review never starts. A consumer
   "fixing" a flaky capture with `continue-on-error: true` reopens the
   planted-file channel of law 1; the guide says so at the exact line a
   frightened consumer would edit.
4. **The baseline commit is the live merge-base, fetched.** Never the
   payload's `base.sha` alone — it can be stale (base moved ⇒ the delta
   attributes other people's merged changes to this pull request as
   `introduced`: loud but wrong), and the fetch strategy must make the
   commit resolvable (`fetch-depth: 0` or an explicit fetch; `fetch-depth:
1` makes the worktree step dead on arrival).
5. **The manifest is freshly written** from the append-only exit file,
   overwriting any plant, at the end of the evidence steps.

The manifest (`run.json`) shape:
`{ exitCode, stderrDigest, base: { capturePath, commit }, head: { commit } }`.

Everything is uploaded as workflow artifacts, so evidence survives provider
outages and runner loss.

## 6.2 The boundary module: `architecture.mjs` (protocol + ceiling)

One module, the only place Archkeep's contract is spoken. Doctrine-clean by
content kind, not by caller count ([doctrine](../doctrine.md): the test is
"is this a protocol, or is this ceiling?", never "would a second action
want this?"): it speaks a protocol whose specification lives outside this
repository — the frozen envelope contract, the way `config-file.mjs` and
`answer-json.mjs` already speak foreign formats — and it enforces a
ceiling: incompleteness can never read as pass, I10/I11 made mechanical
for one input class. The content line is policed at review time: the
moment the module maps waiver states to severity, classifies rule rows by
criticality, or shapes prompt content, it has become an action's domain
logic wearing core's tag — those belong to review (§6.3). **Placement
lever, named:** the reader lands with review as consumer #1; if P4's
triage consumption is not evidenced by dogfood, the doctrinally safer path
is promotion-later — decided on evidence, per ADR 002's own standard. The
module is a **constructor-injected seam** (like forge and chat) so the
corpus evaluator can double it; never an ambient import.

`readArchitectureReport({ workspace, reportPath, manifestPath, expect })`
→

1. **Read** both files through workspace confinement (I7). Measured delta
   envelope sizes: 20.6 KB (175-file repository) to 138 KB (631-file); the
   reader's byte cap is 2 MiB with those sizes recorded. Baseline
   snapshots are not read by the action.
2. **Validate the envelope**: parses; `schemaVersion === 2`;
   `tool.name === "archkeep"`; `command === "delta"`; the frozen
   status↔exit↔coverage coherence table (a disagreement is a typed
   refusal, mirroring archkeep's own shape-gate latch); bucket shapes;
   family marker (an evidence snapshot, a graph report, or a history file
   here is a typed refusal naming the family — and a `check` envelope must
   never feed this seam).
3. **Pin provenance**: the head-side `provenance.commit` must equal the
   run's head SHA; mismatch ⇒ the evidence is **stale — verdict `unknown`**,
   never used as current. The baseline-side commit is recorded verbatim,
   never re-derived. A null head provenance is the unknown-stale arm too —
   no origin claim is not a clean claim.
4. **Normalize** into a frozen `ArchitectureEvidence` object: verdict
   (`pass | fail | unknown` — Archkeep's own, recorded, never re-derived),
   stale flag, both provenance commits and both `dirty` flags (carried
   disclosed; never silently trusted as clean), `policyChanged`, provider,
   `toolVersion`, `introduced[]` (messageId, sourceProject, target,
   constraint, waived, waivedBy, headSites `{file, line}`, counts, note),
   `resolved[]`, `unchanged` count, `introducedWaived`,
   `customRules.findings.{introduced, resolved, unchanged, unknown}` bucket
   facts (counts, rule ids, sites — a separate bucket family that gates on
   introduced **with no waiver lane by construction**; a governed
   repository with wasm rules must never get an honest verdict over blind
   evidence), `unresolvable` counts (counts, never findings),
   `occurrencesReduced` notes, coverage facts, capped verbatim notes.
   Delta envelopes are verified to carry no time-relative fields; a
   defensive strip of `*Ms`/`sampleTime`-shaped fields is retained for
   forward compatibility at negligible cost.
5. **Classify incompleteness** — the mandatory tri-state, with the reason
   taxonomy P0 names: **stale** (head pin mismatch) / **incomplete**
   (exit 3, no-verdict, unparseable-with-nonzero-exit; per-item unknown
   reasons carried capped) / **absent-though-configured** (F-02 reader
   arm, red, distinct path). Architecture-blind — input unset — is a
   fourth, non-unknown state: byte-identical to today.

**Exit-evidence precedence law:** any nonzero exit recorded in the
manifest wins over the report's self-description — verdict `unknown`
regardless of bytes; `envelope.exitCode` must equal the manifest's
exitCode, and a mismatch is a typed refusal (a coin-flip read is not
admissible); report absent with recorded exit 0 ⇒ F-02 reader arm; a
report past the byte cap ⇒ F-02 reader arm (a file the reader cannot
honestly consume is configured-but-unusable, consistent with the
config-file byte-cap precedent — one lane, not a third).

## 6.3 Review integration (the flagship)

- **New input** `architecture-report` (path, default `""` = off).
- **Prompt grounding** — a code-built architecture evidence section, like
  lanes; not a model tool, and the tool registry stays frozen ("a tool an
  author cannot add is a tool an attacker cannot aim"): introduced
  violations with rule ids and sites, waiver state, resolved list,
  `policyChanged` carried verbatim and rendered prominently (a law edit is
  the one loud signal when the law itself rode in with the pull request),
  and ADR context — constraint → `decisionRef` → ADR text, resolved
  through `policyReader` at the pinned base SHA, so a pull request cannot
  edit the ADRs that interpret it. Wrapped as untrusted evidence through
  the framing seam, reduced by code to ≤8 KiB (raw envelopes are 20–138 KB
  with up to 94 blindSpot rows — the reduction is mandatory, not
  cosmetic). The model interprets — intentional? impact? remediation? —
  and never recomputes structure.
- **Risk/lanes grounding** — files named in introduced-violation head
  sites get a deterministic risk floor and deep lanes, widening
  `risk.mjs`'s declared seam. Criticality vocabulary: a frozen
  messageId→criticality table in review (review-owned — interpretation is
  review's domain), unmapped default `high`, explicit. The grounding is
  strictly additive-when-present: blind runs stay byte-identical, and the
  floor never bypasses the bound gate — deep lanes consume reading budget
  like any lane; a bound-gate interaction test is in P3's exit criteria.
- **Artifact section** — schemaVersion-family bump, additive: the v7
  family carries the `architecture` block (basis: report digest over raw
  bytes, baseline digest, tool version, both commits, both policy
  fingerprints; verdict; stale flag; bounded facts). Retention (new
  [ADR 003](../adr/003-evidence-retention.md) row): **persist** the
  decision basis — verdict, stale flag, digests, commits, bucket counts,
  `policyChanged`; **fingerprint** the detail lists (identity + count
  persist, full site lists drop to the digest-referenced workflow
  artifact); never raw model text (there is none).
- **Declared gate** — an `architecture` gate row, **coupled to the
  artifact schemaVersion family, not to the input**. `GATES` is a frozen
  constant, unknown gate keys are refused, and the artifact validator
  enforces exact length and order — a conditional row is unimplementable,
  and a `passed: true` for an unrun gate would violate I11's "a missing
  fact is never a pass". The implementable shape follows the v5→v6
  precedent: architecture-blind runs emit the v6 family byte-identically
  to today; architecture-aware runs emit a **v7 family** — six-gate table
  with `architecture` appended after `verification` — carrying the
  architecture section. Reconciliation accepts v6 and v7 comment-embedded
  records side by side.
- **Gate predicate (verbatim, lands in the run contract with P0)**: the
  `architecture` gate passes iff **evidence-established** — verdict ∈
  {pass, fail} ∧ head pinned ∧ not stale. Never `verdict === pass`:
  Archkeep's `fail` (introduced violations exist) leaves review's verdict
  untouched while the artifact records it — review's `fail` keeps its
  "could not complete" meaning exactly because the predicate is not "found
  problems". `unknown` (stale or incomplete) fails the gate, so an
  architecture-aware review can never publish `pass` over unestablished
  architecture facts. The artifact records `coverage.complete` beside the
  verdict so a `fail` is never mistaken for "fully read" (findings are
  certain regardless of unread remainder — the reverse does not hold).
  Enforcement stays the consumer's — the action records, GitHub disposes
  ([ADR 006](../adr/006-code-scanning-merge-enforcement.md)): architecture
  violations do not become review findings, do not enter SARIF, do not
  flip review's verdict semantics.
- **Cross-run** — architecture facts ride the marker-comment record block
  like every canonical fact. Cross-run waiver-time semantics (P0
  sentence): the architecture verdict is a fact about (base, head, law,
  now), re-judged per run; the same head can legitimately flip verdicts
  across runs when a waiver expires; the basis fields are the explanation;
  reconciliation never reads such a flip as finding churn — architecture
  facts stay out of the `new | persisting | moved | resolved | unresolved`
  vocabulary.

## 6.4 Triage and harmonise (P4)

- **Triage** is a deliberate posture change, not a plan item. Today triage
  reads everything through the API, never the working tree — a security
  simplification worth more than marginal label signal. P4 consumption
  happens only if all three hold: (a) an explicit docs-first posture
  change in triage's development page; (b) P3 dogfood evidence that
  review's architecture facts ever changed a triage-relevant decision;
  (c) acknowledged as consumer #2 in the placement argument of §6.2. Where
  a report exists for the same event, architecture facts may join the
  model's evidence; label picks remain closed-sheet; new record facts are
  epistemic-state fields from a small closed vocabulary mapped from delta
  facts — never a new GitHub-visible state. **Fallback, recorded**: if (b)
  fails, triage stays API-only (a documented non-goal) and the placement
  lever of §6.2 moves to promotion-later.
- **Harmonise** is unchanged through P1–P3 (it reads through its own
  branch/API machinery — no workspace read, no posture change). P4
  explores documentation-vs-intent consistency (drift output as evidence
  for doc staleness): architecture authority is never rewritten from
  documentation; mismatches surface as evidence + interpretation in the
  pull request the human merges.

## 6.5 Retry and outage (measured)

Today a provider outage burns the whole run red — dogfood shows a
7.9-minute run consumed entirely by provider failure before any useful
work survived. The integration splits that: deterministic evidence is
produced by workflow steps **before** any model call and persists as
workspace files + workflow artifacts, so a rerun after outage repays only
the LLM loop; evidence restoration is by base commit (cache) or
re-capture (measured 0.8–1.9 s). The action itself never runs Archkeep,
adding no new retry surface inside the run contract.

## 6.6 Performance and invocation budget (measured, Node 24)

| Operation                                            | 175-file repo | 631-file repo  |
| ---------------------------------------------------- | ------------- | -------------- |
| `delta --capture` baseline (detached worktree)       | 0.78–0.85 s   | 1.66–1.85 s    |
| `delta --capture` head (in-tree; optional audit)     | 0.80 s        | 1.56–1.61 s    |
| `delta <baseline>` compare                           | 0.77–0.79 s   | 1.56–1.63 s    |
| `git worktree add --detach` (base)                   | 0.03 s        | 0.11 s         |
| `npm i @ecoma-io/archkeep` (once per job, cacheable) | —             | 4.87 s / 28 MB |

Budgets the guide will state: evidence steps ≤10 s combined on ≤2000
analyzed files; any single archkeep step ≤30 s (the existing U-2 trigger
threshold, reused verbatim); review latency growth ≤15 s (measured
overhead vs a real review run: 1.3–6%); prompt architecture evidence ≤8
KiB after reduction. Scaling ceiling: ~2.5 ms/file crosses the 30-s step
budget near ~12k files — the recipe ships per-step timeouts +
`continue-on-error` on the _delta_ step only, so a slow repository
degrades to today's architecture-blind review rather than a red run, and
the degraded outcome is recorded as architecture `unknown`, never pass.

Caching verdicts (measured): baseline reuse via `actions/cache` keyed by
**(base commit, engine version)** — yes: `tool.version` is recorded inside
every snapshot, cross-version reuse measured safe (byte-identical output
except `tool.version`), law/provider changes are functions of the base
commit, and a miss costs ≤1.9 s. Candidate-side reuse: no — delta
re-analyzes the head tree in-process on every compare; the compare is
O(tree), not O(diff); two invocations are the minimum. `history
--capture` directories: no for the pull-request path — wrong family
(graph snapshots; delta refuses them).

Invocation matrix: pull request opened = 2 captures cold; synchronize /
re-review = 1 cache-warm compare; merge group = 0 (review is absent there
by design — the consumer's own arch gate covers the queue); triage = 0;
harmonise = 0; automation/release pull requests = 0 (their review runs
are 13-second skips — evidence steps would add 60–80% for nothing; the
steps live in review's job, which skips fast). External pull requests
always carry evidence (the deepening is free relative to a real review
run); large pull requests keep evidence — the capacity refusal stays red
and recorded, unchanged.

# 7. Alternatives, steelmanned and rejected

**"Call every archkeep feature" — rejected.** The matrix consumes delta +
provenance + waivers + ADR context as the always-on core; everything
descriptive stays behind release/periodic triggers; the agentic fact
surfaces (`context`, `explain`, `impact`) are deferred with reasons, not
silenced. Rationale: descriptive surfaces cannot exit 1, need long-lived
stores, and the delta envelope already carries the per-pull-request
decision facts.

**"Health/debt/trajectory on every pull request" — rejected.** They are
descriptive and need consumer-maintained history directories the actions
must never own; per-PR they would have to hydrate and re-append a stateful
store inside a stateless workflow.

**"The LLM can interpret architecture directly" — rejected, without a
steelman that survives.** The frozen tool registry and archkeep's own ADR
0007 agree from both sides: any channel by which the model fetches
architecture facts on demand is a tool by another name. Code-mediated
context is the only compliant shape.

**"An archkeep violation fails the pull request" — rejected as a
collapse.** Eleven states stay distinct (the panel corrected an original
eight): hard violation (exit 1, non-waived introduced) / waived
introduction (`introducedWaived` — a waived class this pull request grew:
new debt under an existing acceptance, disclosed; a reviewer may
legitimately care that a PR adds occurrences even under waiver) /
expired-waiver re-assertion (law-time event, carried verbatim) / known
pre-existing debt (`unchanged`) / shrinking debt (`unchanged` +
`occurrencesReduced` — a shrink is never a resolution; improvement
direction, never netted against introduced) / rename pair
(introduced+resolved over identical sites — archkeep does no rename
matching; rendered as one human-reviewable item, never "1 introduced, 1
resolved" as a wash) / intentional evolution (ADR context found) /
policy-change artifact (`policyChanged` — not code-caused) /
custom-finding introduction (`customRules.findings.introduced` —
waiverless by construction) / insufficient evidence (`unresolvable`, exit 3) / stale evidence. None is silently merged into pass/fail; the action
records, the consumer's gate enforces.

**"Agent decisions stored as architecture truth" — rejected.** Agent
observations live in action-agents records labelled non-authoritative;
promotion into authority happens only through a human-reviewed pull
request into law/origin/ADR text — archkeep's own sanctioned channel. No
write-back API is used or proposed (§9).

**Design alternatives, each challenged and settled:**

1. **Vendoring the archkeep engine** — duplicates a deterministic analyzer;
   the sync burden is the whole point of its determinism guarantees.
   Rejected.
2. **A fourth composite action that runs Archkeep** — sustained for P1–P3
   on single-job workspace locality (a reusable-workflow middle option
   removes copy-paste without a new action surface, but its cross-job
   artifact handoff breaks that locality). The decision is filed as its
   own issue with a concrete trigger — the second consumer-visible
   mis-wiring in a dogfood copy (the first copy-paste mistakes manifest
   as a security posture hole and a dead recipe, not noise) — and the
   four org-repository dogfood copies act as the drift canary until it
   fires.
3. **Importing `@ecoma-io/archkeep/commands` in-process** — violates the
   zero-runtime-dependency line. Rejected.
4. **Deterministic archkeep findings in review's canonical result +
   SARIF** — makes review a second enforcement surface, double-judging
   the same law with two vocabularies, and muddies
   [ADR 004](../adr/004-canonical-review-result.md)'s "findings are
   model-emitted picks bound by verification". Rejected.
5. **MCP at action runtime** — stdio server, archkeep installed, no
   install step on consumer runners. Rejected; MCP stays the dev-time
   surface.
6. **In-action execution via child_process** — "which binary, whose
   version" inside the action is a trust question the workflow placement
   answers for free, and a subprocess is a reach the corpus doubles
   cannot see. Rejected.

# 8. Phased plan

Each phase is its own issue + branch + draft pull request; contract and
ADR edits land with the code they govern.

- **P0 — contracts first (docs only).** Run-contract amendment: the v7
  record family (six-gate table, `architecture` after `verification`),
  the gate predicate verbatim, the reason taxonomy (`stale` /
  `incomplete` / `absent-though-configured`, + architecture-blind), the
  cross-run waiver-time sentence, F-class mappings, and the five recipe
  laws as normative text; the [ADR 003](../adr/003-evidence-retention.md)
  retention row; a new ADR recording the integration decision
  (consumer-run archkeep, protocol+ceiling reader,
  records-never-enforces); this page landed. Exit: docs name every new
  word before code spells it.
- **P0.5 — pin bump prerequisite.** The devDependency pin must reach the
  version whose delta contract this design was measured against, as its
  own dependency-validation pull request that re-measures every claim on
  [the archkeep integration page](../archkeep-integration.md) per that
  page's own rule and re-blesses contract goldens.
- **P1 — reader boundary.** `architecture.mjs` as a constructor-injected
  seam + its unit tests (canned bytes; no spawns, network, or clock)
  landing in the same commit (the coverage floor admits no stub) + the
  contract gate — `pnpm arch:contract`, the boundary-canary "measured,
  not assumed" rule one layer out: synthetic git trees in temp dirs (the
  generator owns every provenance commit; delta needs two committed
  trees), the pinned devDependency executed, normalized goldens diffed
  under `tools/fixtures/arch-reports/`, `--bless` re-pins — + review input
  wiring (architecture-blind default byte-identical). Exit: typed
  contract, deterministic tests, goldens pinned, provenance preserved,
  incomplete can never read as pass.
- **P2 — delta semantics complete.** Buckets, waiver/expired/
  policyChanged/occurrencesReduced carried verbatim, customRules buckets,
  rename-pair rendering, stale classification,
  unresolvable-never-findings. Exit: all eleven states of §7
  distinguishable in records and comment.
- **P3 — review flagship, and dogfood begins.** Prompt grounding + ADR
  context via policyReader + risk/lanes grounding + artifact v7 family +
  declared gate + comment rendering + corpus scenarios + the adversarial
  security fixtures. Dogfood starts here, not at P6: the recipe runs on
  this repository's own pull requests first (the merge-preview risk is
  [ADR 005](../adr/005-pr-execution-trust-boundary.md)-accepted),
  archkeep's repository second. Exit: the model reasons over structured
  facts; no graph reconstruction; explainable decisions; blind behavior
  unchanged; first dogfood findings triaged to owner repositories.
- **P4 — triage + harmonise.** Triage as the deliberate posture change of
  §6.4 (three conditions); harmonise doc-vs-intent exploration. Exit:
  neither action becomes an architecture authority.
- **P5 — selective higher intelligence.** health/debt/trajectory behind
  release/architecture triggers, with history-dir guidance for consumers
  — the actions never write the history dir. Exit: selective activation,
  measured budgets, no per-PR noise.
- **P6 — feedback loop + dogfood completion.** Agent-observation
  recording conventions; dogfood completes across
  archkeep/loom/release-craft/action-agents with real architecture
  differences; upstream outcomes folded back. Exit: truth ≠ observation ≠
  inference ≠ decision ≠ mutation, all provenance-safe, demonstrated on
  four repositories.

## 8.1 Test strategy

This repository runs three runners by layer, not one: vitest over
`*/src/**/*.test.mjs` (required, coverage-floored at 80% on every source
line), node:test over `tools/**` and `security/fixtures/**` (required),
and the offline corpus evaluator (advisory — nothing in this design may
quietly start gating on corpus numbers). The strategy maps onto them with
no new framework and no new dependency:

- **Unit** — canned bytes only: envelope shape and family refusals
  (evidence snapshot, graph, history, `check` masquerade, foreign schema
  major, wrong tool), the coherence table, provenance pinning
  (fresh/stale/null-head/verbatim-base), delta-semantics normalization
  (waived/expired/policyChanged/unresolvable/occurrencesReduced/counts
  reconcile/site caps), defensive hygiene (byte cap, time-relative strip,
  double-read determinism, workspace confinement), the three-way
  absent-evidence taxonomy, and blind-mode byte-identity.
- **Contract — hybrid.** Generated goldens verified against the pin in
  CI: frozen-only goldens rot silently (the vendored-skills lesson);
  generate-only drags spawns into vitest. The gate script owns git, so it
  owns every provenance commit; assertions come from real runs, then
  freeze. Waiver fixtures use far-dated instants (2999/2000) because the
  CLI clock cannot be injected — any nearer date in review is a time bomb.
- **Fixture** — goldens are data, in the coverage-exempt home; delta
  envelopes carry no wall-clock and the contract layer enforces it by
  double-run byte-identity.
- **E2E** — the existing harness extended with workspace report helpers
  and the entrypoint input: proves evidence-before-model ordering (an
  outage run still lands architecture facts in the red record),
  stale-vs-abandoned non-collision (moved head ⇒ `abandoned`, no comment;
  foreign head pin ⇒ stale-unknown **published**), cross-surface identity
  (artifact block ≡ comment record block ≡ disk), the two-run
  waiver-expiry reconciliation as a byte fixture pair (the one legitimate
  cross-run time-dependence — pinned so a future "stabilizer" turns
  visibly red), and artifact-path confinement.
- **Corpus** — advisory: interpretation quality (ADR present vs absent ⇒
  different classification, same contract) and refusal honesty (the model
  must not narrate unknown architecture as fine), plus hostile-note
  goldens; the deterministic layers remain the only gate, and a
  `security/fixtures/arch-report/` entry pins that no report byte reaches
  a published surface unsanitised even when the model obeys it.

Scenario coverage: **15/15 designed, 13/15 executable by P3** — debt
introduced and health regression are P5-deferred with fixtures designed
now behind documented deferral notes; their delta-side proxies
(occurrence growth/reduction) run in P2. Honest limits, stated rather
than papered over: the workflow recipe itself (base-commit worktree,
pinned install, artifact upload) is untestable here and is dogfood
territory; and tamper is undetectable at the reader by measurement — the
tests pin the compensating posture (record-without-enforce, digest
anchoring, trusted-infra capture) instead of promising a false green.

# 9. Upstream archkeep asks

1. **Baseline digest in the delta envelope** (class B — supported
   internally, not exposed). The envelope carries baseline metadata but
   nothing binding the report to the baseline bytes it was computed
   against — probe-verified. Proposal: `result.baseline.digest` (sha256
   of the snapshot file bytes). Additive; turns chain-verification into
   envelope-borne fact. Filed with this campaign.
2. **Commit pinning for `delta`, both sides primary** (class B/C —
   semantically incomplete for consumers). `change` pins its base
   (`base.commit` → `unproven`); `delta` has no staleness guard, so every
   consumer reimplements pinning, each slightly differently. Proposal:
   `--expect-head-sha` / `--expect-base-sha` producing the existing
   unproven-style refusal on mismatch. Filed with this campaign.
3. **Observation ingestion store — deliberately not filed.** The absence
   is incidental, but no dogfooded need exists; ADR 0007's sanctioned
   channel covers this campaign's loop. Filing now would propose surface
   without a consumer. Revisit after P6.
4. **Federation — not filed** (deferred research class upstream).
5. **Candidate follow-up, optional** — envelope-on-refusal: some early
   exit-3 refusals are stderr-only, leaving the reader's unknown reason
   an opaque digest. An upstream option "always write a no-verdict
   envelope when `--output` is given" would give structured reasons. Not
   required; noted, not filed.
6. **Watch item** — archkeep's byte-identity guarantee currently covers
   `check` only; if contract goldens ever need delta byte-identity pins,
   coordinate with that program rather than filing a duplicate.

# 10. Security and trust analysis

- **Threat: a pull request forges or replaces workspace report files.**
  The sharpest channel: archkeep leaves `--output` untouched when a run
  dies before building an envelope, so a planted `.archkeep/delta.json`
  would survive a failed delta and be read as Archkeep's verdict — the
  report bytes become PR-supplied in exactly the failure case. Closed
  structurally by recipe laws 1+5 (clear the evidence directory; delete
  the report on nonzero exit; the manifest freshly written from an
  append-only exit file — a plant can only make evidence look worse,
  never better), not probabilistically. Beyond that: the action validates
  shape and coherence, pins commits, digests everything, and — decisively
  — records without enforcing; merges still require the consumer's own
  gates. The probe-confirmed residual: a same-repository attacker who
  rewrites the workflow itself is inside
  [ADR 005](../adr/005-pr-execution-trust-boundary.md)'s accepted
  merge-ref posture and gains nothing new here — the worst new artifact
  is a wrong comment. Fork pull requests get no secrets and their
  workflow edits are ignored; planted data files ride the merge tree,
  which is exactly the channel law 1 closes. Baseline integrity rides
  storage trust (cache/artifact digest anchoring) — the same trust class
  as the run record.
- **Untrusted framing**: report bytes are pull-request-visible ⇒ untrusted
  data under the third ceiling; they enter prompts only through the
  framing seam and the ≤8 KiB code-owned reduction, and records only
  through sanitised, capped, digest-anchored fields (I14/I16 unchanged).
- **Determinism**: delta envelope bytes are deterministic and carry no
  time-relative fields (measured); the architecture section is
  byte-deterministic given the run's inputs (I15 extended to it).
  Waiver-expiry flips are semantic and time-dependent — a rerun after
  expiry legitimately records different verdict facts, and reconciliation
  treats a waiver-state change between runs as an explicit note, not
  drift.
- **Degradation**: per-step timeouts and `continue-on-error` on the delta
  step only degrade a slow repository to today's architecture-blind
  review rather than a red run; the degraded outcome is recorded as
  architecture `unknown`, never pass.

# 11. Panel resolutions

The design went through an adversarial panel before landing. Verdict:
**ready, with changes** — the three blocking findings were specification
defects, not architecture defects, and all ten required changes are
folded into this page:

1. **Stale-head classification: `unknown`-stale + gate fail — sustained.**
   Silent skip violates I10/I11 (a hollow pass); a typed refusal misuses
   the vocabulary (no ceiling declined) and would destroy the review for
   a wiring-quality problem. Unknown-stale publishes the review as
   Partial with the reason named.
2. **Artifact section: bounded normalized facts + raw-byte digests —
   sustained**, with the retention split of §6.3.
3. **Gate verdict law: evidence-established, never `verdict === pass` —
   sustained**, mechanics corrected to the v7/v6 family shape (a
   conditional row is unimplementable against the frozen gate-table
   law).
4. **P4 triage workspace reads: a deliberate posture change, not a plan
   item** — the three conditions of §6.4, with the promotion-later
   fallback recorded.
5. **Caps fixed**: report byte cap 2 MiB; prompt evidence ≤8 KiB;
   per-note caps in retention; waiver fixtures far-dated.

The load-bearing choices the panel could not move: consumer-run archkeep
over in-action execution; a protocol+ceiling reader with the content line
policed; records-never-enforces with the consumer's gate as the
enforcement; evidence-established as the gate predicate; unknown-stale
over refusal or skip; delta as the primary evidence surface.
