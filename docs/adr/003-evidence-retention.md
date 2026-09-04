---
id: 003-evidence-retention
status: accepted
created: 2026-09-03
---

# 003 — Evidence retention: persist, fingerprint, never

## Context

A run reads threads, diffs, repository files and model answers, and the
records it keeps must make the run auditable without turning the record into
an archive of untrusted text or an injection surface. What a record may hold
of what the run saw is a policy question, and this is the policy.

## Decision

Every recorded fact carries one of three retention classes:

- **persist** — the content itself is recorded;
- **fingerprint** — a sha256 digest of the content is recorded; the raw text
  never is;
- **never** — nothing about the content beyond the fact that it was read.

Per record kind:

| Record kind                             | Retention                                                                                                                                                                                                        | Why                                                                                                                                                    |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Thread snapshot (issue/PR/comment text) | fingerprint                                                                                                                                                                                                      | proves what the run actually saw; untrusted text stays out; GitHub's copy is editable after the fact                                                   |
| Policy config                           | fingerprint (policy SHA + config digest)                                                                                                                                                                         | reproducibility needs the pin, not the bytes; the bytes live at the pinned ref                                                                         |
| Instruction doc                         | fingerprint                                                                                                                                                                                                      | tamper-evidence is the point                                                                                                                           |
| Review file-span                        | persist span + digest                                                                                                                                                                                            | an anchor must be re-derivable against the pinned head                                                                                                 |
| Verifier counter-evidence               | persist digest + excerpt ≤300 chars                                                                                                                                                                              | a refuted verdict's basis survives the run; the one raw-text exception, capped and sanitiser-scrubbed                                                  |
| Model I/O (raw messages/answers)        | never                                                                                                                                                                                                            | already distilled into decision + capped rationale; raw text is injection surface                                                                      |
| Harmonise TM/state entries              | fingerprint                                                                                                                                                                                                      | source/translation fingerprints and the transformation version are already the record                                                                  |
| Triage run record                       | persist: decision facts (on-sheet label names, reasoned removals, refusals, rationale ≤300, related title ≤80) + the policy pin; never: thread title/body, raw model I/O                                         | the record carries the decision the code owns, not the thread's words; untrusted text enters only through the sanitiser at a declared cap              |
| Harmonise run record                    | persist: run facts (outcome, terminal reason, per-pair counts, pull request number and created flag, head sha, event name, source language, dry-run flag); never: document text, translation text, raw model I/O | the record carries the run's own pair accounting and terminal state, not the documents' words; the translation's durable form is the pull request body |

Net new persistence is digests and spans only. A digest is either
**re-derivable** — its preimage is still fetchable at a pinned ref — or
**consistency-only** — it proves the run saw today's bytes, and remains the
only proof once the source is edited or deleted.

## Consequences

- A record field carrying content beyond its declared class and cap is a
  validator defect, and the validator fails closed.
- Retention is decided per kind, here — not per feature, per action, or per
  pull request. A new record kind lands with a row in this table or it does
  not land.
- The ceilings this table keeps honest (config caps, evidence caps, excerpt
  caps) are stated in `SECURITY.md` and enforced in code; this record says
  what may be kept, not how the caps are applied.
