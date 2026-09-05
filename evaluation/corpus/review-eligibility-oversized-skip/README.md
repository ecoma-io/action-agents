Exercises the eligibility gate on the size anchor: a maintainer-authored pull
request whose change totals 9,000 pre-ignore lines trips the policy's
contextless `when.changes.lines.gt` rule, and the run ends as a recorded skip
before any model call — the same oversized change would otherwise die as a
red maxDiffLines refusal in the scope layer. The skip reason carries the
measured numbers that decided it (9,000 changed lines across 1 file — the
snapshot compresses the sweep into one synthetic file). The recording holds
no answer file — a skip never asks the model. The snapshot is synthetic,
written for this corpus; no real repository or provider transcript is
reproduced.
