// The scope-axis violation this fixture exists to hold: the real core
// reaching into the impostor over a resolvable subpath. The core's row allows
// targets tagged `scope:shared`; the impostor is tagged `scope:shared-2` —
// a different string, not a prefix match. If the gate ever compares tags by
// prefix, this edge goes quiet and the run collapses toward green, which is
// the fail-open `tools/check-arch-canary-extended.mjs` exists to catch.
import { corexName } from "#canary-corex/index.mjs";

/**
 * Consumes the cross-boundary import so the dependency is used rather than
 * dead — the edge this file exists to keep illegal is one the resolver can
 * see and the gate must judge by exact tag.
 *
 * @returns {string} whatever the impostor's export answers
 */
export function coreLabel() {
  return corexName();
}
