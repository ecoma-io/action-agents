---
id: 004-canonical-review-result
status: accepted
created: 2026-09-06
---

# 004 — The canonical review result is the one source of truth a review projects from

## Context

A review run already verifies before it claims: the verification pass binds
code-owned verdicts (`confirmed`, `refuted`, `uncertain`) to finding ids and
publishes them as lifecycle states (`confirmed`, `refuted`, `unresolved` — an
`uncertain` verdict is no verdict, and publishes as `unresolved`). But the
only surface the publication set reaches is the comment. Nothing mechanical
stops a pull request with a confirmed blocking finding from being merged;
there is no Code Scanning view of the findings; and nothing ties a finding on
one revision of a pull request to the same finding on the next — a moved line
reads as a different finding, a re-worded one can duplicate.

## Decision

1. **One source of truth.** The verified publication set — findings with
   verdicts, verification evidence, coverage and the run's terminal facts — is
   canonical. The comment, the Code Scanning upload and the merge gate are
   projections computed from it; none of them is authoritative, and none
   records state the canonical result does not carry.
2. **Finding identity is content-addressed and position-independent.** A
   finding's cross-run identity is a versioned digest over its normalized
   path, its claim kind and its normalized code span — never the line
   number, never the message wording, never the severity. The kind is
   epistemic state: a model-emitted pick from a closed, code-validated
   vocabulary, bound by the verification pass from evidence the way it
   binds the verdict, and trusted to exactly that degree. The span is
   captured from the reviewed bytes by code, never written by the model,
   and stored so the fingerprint is recomputable. That capture is the
   integration boundary that reads the snapshot: the canonical constructor
   itself never touches the filesystem — it verifies a stored fingerprint
   against the recomputed tuple, and the boundary rejects a span the
   reviewed bytes do not spell. A moved, re-worded or
   re-graded finding keeps its identity; a rewritten span or a new file
   mints a new one. A reclassified claim does too — the one identity
   change kind can mint — and its consequence is reconciliation churn
   (`resolved` beside `new`), never enforcement drift: the gate reads the
   current set, and a confirmed blocking finding blocks under either
   label. Claims that share the full key inside one run collapse to the
   first in publication order, recorded on the result — no occurrence
   rank ever enters the identity.
3. **Reconciliation is code, not model.** `previous + current → new |
persisting | moved | resolved | unresolved` is a pure deterministic
   function over artifacts. An incomplete or unknown current run never
   declares a previous finding `resolved`.
4. **The merge gate is a pure function.** `decideReviewGate(canonicalResult,
policy)` reads nothing but the canonical result and the policy, and never
   calls the model. Incomplete, unknown, abandoned and refused runs do not
   pass. The gate's verdict lands as a check run a repository can make
   required.
5. **The vocabulary already in code stays the vocabulary.** Verdicts remain
   `confirmed|refuted|uncertain`; published lifecycles remain
   `confirmed|refuted|unresolved`. The reconciliation states are new fields
   beside them, per the state-separation rule — no fourth meaning is added to
   an existing field.
6. **Determinism at the red boundary.** A deterministic verifier failure is
   recorded, never retried; a review that could not complete never passes the
   gate.

## Consequences

- The run contract gains the gate as a merge-consequence surface; the ceiling
  manifest gains the check-run operation before any run performs it. The
  integration change carries both — this record alone changes no runtime
  behavior.
- SARIF is byte-identical for the same canonical result — same findings, same
  fingerprints, no timestamps.
- A comment that disagrees with the canonical result is a defect in the
  projection, and the projection is rebuilt; the comment is never patched to
  win an argument.
- Consumers opt in per workflow: without the gate check and the SARIF upload
  steps, a review run behaves as it does today.

## Landing

Landed as a serial under epic #362. Decision 2's canonical contract
(`canonical.mjs`, `identity.mjs`, `vocabulary.mjs` — B), decision 3's
reconciliation (`reconcile.mjs` — B) and decision 4's merge gate
(`merge-gate.mjs` — C) with the SARIF projection (`sarif.mjs` — D) are pure
modules on `main`; the integration (E — the run wiring: the capture boundary
in `run.mjs`, the kind-bound verification pass, gate execution behind
`gate-mode`, and the job outputs, `runner.temp` SARIF write and `review gate`
check run in the entrypoint) changed the runtime behavior this record only
described. The ceiling manifest's check-run entry and the gate fixtures in
`security/fixtures/canonical-gate/` landed with it.
