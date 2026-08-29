/**
 * The review vocabulary — the arms a policy may name for strictness and
 * strategy. Single home: phases, gates, lanes, applicability and config all
 * read these values from here instead of re-spelling the arms, so a rename or
 * an added arm cannot drift between mirrors.
 */

/** The strictness values a policy may name. */
export const STRICTNESS = /** @type {const} */ (["low", "medium", "high"]);

/** The strategy values a policy may name. */
export const STRATEGY = /** @type {const} */ (["standard", "adversarial"]);
