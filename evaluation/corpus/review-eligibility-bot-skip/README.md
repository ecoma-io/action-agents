Exercises the eligibility gate on the GitHub-attested bot anchor: the author
carries `user.type` "Bot" but is on no allowlist, so the derived context is
external — and the policy's contextless `when.author.isBot` rule skips the run
anyway, recorded, before any model call. This is the shape no allowlist could
reach: an unallowlisted bot whose PRs a consumer wants skipped without
admitting the login to the automation context. The recording holds no answer
file — a skip never asks the model. The snapshot is synthetic, written for
this corpus; no real repository or provider transcript is reproduced.
