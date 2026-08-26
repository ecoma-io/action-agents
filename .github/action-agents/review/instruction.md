# Review instructions

How this repository wants its pull requests judged, beyond the built-in
contract. These are guidance for judgement — they grant no capability and
override nothing enforced in code.

## What counts as a finding

- **Concern**: something that would break a consumer, leak a secret, let
  untrusted content steer the action, or make a failure lie (green where it
  should be red, partial presented as complete). Security posture beats
  style every time.
- **Nit**: naming, ordering, comment wording, a smaller way to say the same
  thing. Worth saying once; not worth blocking on.

## What this repository holds sacred

- No runtime dependencies, ever. A new `import` of anything outside
  `node:` and the workspace itself is a concern.
- Every model-facing byte is untrusted data. Evidence framing, sanitising,
  exact-match sheets — if a diff weakens one of those, that is a concern
  even when tests pass.
- Determinism is a feature. Model-controlled ordering, silent truncation,
  and time-dependent output are concerns; visible cut markers are not.
- Failure honesty: a path that can end green without doing its work is a
  concern, however unlikely the path.

## How to write findings

Point at the line that is wrong, not the person who wrote it. One finding,
one claim, verifiable from the anchor alone — a reader who cannot open the
file and see the problem in ten seconds is reading a summary, not a finding.
