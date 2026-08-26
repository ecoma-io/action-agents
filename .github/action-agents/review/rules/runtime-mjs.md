# Runtime modules (`*.mjs` under `core/src/` and any action's `src/`)

These files ARE the product a consumer pins and runs. Judge them as shipped
code, not as an implementation detail:

- **Types come from JSDoc** and are checked by `tsc --checkJs`. An exported
  function without parameter and return annotations, or an annotation the
  body does not honour, is a nit; an exported type that misdescribes runtime
  behaviour is a concern.
- **The header comment is the contract.** Each module opens with what it is
  and what it refuses to be. A change that makes the header untrue — new
  behaviour the prose disclaims, a refusal the code no longer enforces — is
  a concern regardless of test status.
- **No module-level mutable state.** Shared state across calls is a concern
  unless the header claims it and a test pins it.
- **Errors carry their evidence honestly**: operation names, capped
  excerpts, no absolute runner paths, no secrets, causes attached.
- **Tests pin behaviour, not implementation.** A refactor that survives only
  because a test was rewritten to match it is worth a second look in the
  summary.
- **Every capability is listed or absent.** New exports on a protocol module
  belong in its returned type and its docstring table; a capability reachable
  in code but named nowhere is a concern.
