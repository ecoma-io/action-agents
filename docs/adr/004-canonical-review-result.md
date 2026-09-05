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
2. **Finding identity is content-addressed and line-independent.** A finding's
   cross-run identity is a deterministic digest over its rule or kind, its
   normalized path and its normalized code span — never the line number, never
   the message wording. A moved finding keeps its identity; a rewritten span
   is a new finding.
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
