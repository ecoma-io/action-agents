// The layer-axis half of this fixture, plus its control edge. The first
// import is the CONTROL: `canary-app → canary-core` is legal — the row names
// `layer:core`, and the real core carries exactly that tag. The second import
// is the violation: the impostor carries `layer:corex`, which the row does
// not name, and a gate that prefix-matched would accept it. The measured
// contract is that BOTH facts hold on one run: exactly two violations, and
// this file's legal edge is not one of them.
import { coreName } from "#canary-core/index.mjs";
import { corexName } from "#canary-corex/index.mjs";

/**
 * Consumes both edges so each is a real dependency — the legal one the gate
 * must keep allowing, the illegal one it must keep naming.
 *
 * @returns {string} what the two targets answer, joined
 */
export function appLabel() {
  return `${coreName()}:${corexName()}`;
}
