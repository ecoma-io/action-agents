// The violation this fixture exists to hold: an action reaching into the
// transport project over its PUBLIC SUBPATH. The subpath form is
// load-bearing — it is the exact shape of the real tree's
// `#core-transport/http.mjs` — and it only resolves because this fixture
// carries a `package.json` imports map and its `archkeep.json` names a
// `tsConfig`, so the refusal comes from the depConstraints row itself:
// `scope:transport` is absent from the action's allow-list. See
// `module-boundaries.config.mjs` beside this file, and
// `tools/check-transport-seam.mjs`, which fails the run the day the gate
// stops reporting this import.
import { transportClientName } from "#seam-transport/http.mjs";

/**
 * Consumes the cross-boundary import so the dependency is used rather than
 * dead — the edge this file exists to keep illegal is one the resolver can
 * see and the gate must judge.
 *
 * @returns {string} whatever the transport client's export answers
 */
export function seamActionLabel() {
  return transportClientName();
}
