# adversarial fixtures

The reliability half of the corpus: GitHub's own failure modes, not a hostile
model or thread. GitHub webhooks are at-least-once (events are redelivered) and
runs die mid-mutation (a red run part-way through a plan, or a workflow
cancellation with `cancel-in-progress: true` — the no-throw producer of the
same half-state). Each fixture pins the accepted semantics against the real
production pipeline: the second run re-derives its plan from live state and
never replays a previous run's plan, and a run that cannot establish its own
identity refuses instead of guessing it.

- `duplicate-delivery.test.mjs` — same event redelivered: the second run
  re-derives from live state (its own model call, its own policy decision) and
  the thread converges to the intended state; a redelivery that follows a
  partial mutation repairs the half-state; a redelivered no-sheet
  classification updates the one comment in place instead of duplicating it.
  Documented consumer guidance: set a `concurrency` group.
- `own-logins-failure.test.mjs` — the identity read (`whoami`) fails under an
  App-token-style identity: the run refuses as a typed red run before any
  write, never falls back to `github-actions[bot]` — a guessed identity would
  read the action's own prior comment as somebody else's and duplicate it.

Deterministic and offline throughout: scripted model answers, recording fakes,
stateful label stores. The `node --test` files run zero network and zero
wall-clock assertions.
