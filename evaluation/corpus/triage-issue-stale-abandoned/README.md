Exercises the freshness gate and, with it, the replay posture: the event
payload claims no labels while the recorded live thread carries
`needs triage`, the assessment proposes `bug`, the code mints the plan, and
the mutate call reads the live thread before writing — the divergence is a
`ThreadMovedError`, nothing lands, and the run ends `abandoned` with the
decision still in the record. A re-run against moved state never replays an
earlier decision; the stale event is evidence, not instruction. This is also
the idempotency posture a consumer observes: a duplicate or delayed event
lands in this same gate. The snapshot is synthetic, written for this corpus;
no real thread or provider transcript is reproduced.
