---
id: 002-no-intelligence-layer
status: accepted
created: 2026-09-03
---

# 002 — No intelligence layer

## Context

A shared intelligence layer — shared retrieval, a common risk engine, a memory
that accumulates across actions — was proposed as a workstream of the
archkeep-v0.21 hardening plan, and dissolved on review before any of it was
built. The dissolution is recorded here so it is not re-litigated every
quarter, and so what remains is a decision rather than a gap.

The evidence that dissolved it: `review`'s risk engine is deterministic,
per-action, and working; `triage`'s retrieval is a bounded five-candidate
search; nothing in the defect history, the issues, or the adversarial corpus
asks for a shared retrieval or intelligence engine. Building one would freeze
an abstraction with one real consumer — the exact mistake this repository's
third-caller rule exists to prevent.

## Decision

The workstream is dissolved, and the following are permanent non-goals of this
repository — not deferred work, not a roadmap:

- no vector database and no embedding store;
- no shell-out to model CLIs;
- no swarm orchestration;
- no self-training loop — consumer-repo activity never updates prompts, code
  or model behavior except through a reviewed commit in this repository;
- no planner/executor split.

And the ceiling that outranks the list: **intelligence of any kind adds no
mutation authority.** Whatever ranks, judges or retrieves may inform only a
refusal or a choice inside a closed sheet the repository declared. It never
composes an API call, never widens the sheet, and never acts where the code
did not already decide to.

## Consequences

- A proposal for anything on the list may be closed by citing this record.
- The trigger to revisit is a third concrete consumer with an evidenced need —
  the third-caller rule — filed as an issue that says what it needs and why.
  A roadmap hunch does not reopen this.
- The run contract's vocabulary in [the run contract](../run-contract.md) is
  the part a future consumer would reuse; it is frozen independently of this
  decision.
