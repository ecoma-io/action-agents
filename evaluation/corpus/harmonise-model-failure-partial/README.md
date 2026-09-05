Exercises the partial terminal state end to end: two source documents on a
serial schedule (`concurrency: 1` keeps the ask order deterministic), one
recorded provider answer proposes the vi translation of `manual/dev.md` and
the other is prose no parser accepts — the deterministic failure class never
retries, the failed pair is reported and carried, and the run still publishes
one branch, one commit and one pull request for the pair that proposed. The
durable record is written before the run exits red: `pairs.proposed + pairs.failed
=== pairs.selected` holds in the validated record, and the failure report the
run throws names one failed pair. The snapshot is synthetic, written for this
corpus; no real document or provider transcript is reproduced.
