# policy-tampering

Evidence for the doctrine claim "a tampered policy cannot change the action's
capabilities". The policy file is attacker-adjacent — a config checked into a
repo tree, or carried by a pull request's upstream — so these fixtures pin the
four ceilings that keep a hostile policy data-shaped:

- `schema-version.test.mjs` — a tampered `schemaVersion` (future major,
  string, float, string-float) is a typed startup refusal naming branch + sha
  - path before any model call; an absent or supported version is accepted.
- `deep-policy-parse.test.mjs` — the iterative JSON5 parser handles the
  deepest nesting the 64 KiB byte cap admits without stack overflow, and
  truncated documents (open brackets, unterminated comment) refuse with a
  typed `SyntaxError` rather than hanging.
- `stale-base-fork.test.mjs` — a fork PR's stale payload `base.sha` never
  governs the policy read: the live tip of `base.ref` is the pin. A deleted
  target branch is a typed `PolicyResolutionError` raised before any chat
  call.
- `tampered-instruction.test.mjs` — instructions are data, never commands: an
  unknown instruction key is refused at validation, and a hostile instruction
  document cannot make the action apply an off-sheet label.

Each test drives the real production modules; only the forge, the event and
the model seam are faked, and everything is deterministic and offline.
