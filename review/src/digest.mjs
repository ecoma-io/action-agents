/**
 * Content digests over the bytes a run judged — the checkable half of the
 * evidence story. The run artifact already names what a run read; the digest
 * makes "the judgment rested on these bytes" verifiable by whoever can
 * re-read the same path at the recorded head, so a stale or reordered replay
 * cannot masquerade as the content the run saw.
 *
 * The only operation is sha256 over a UTF-8 encoding of the content, spelled
 * as lowercase hex — one hash, one spelling, no options: a record's digest
 * field must mean exactly one thing everywhere it appears.
 */

import { createHash } from "node:crypto";

/**
 * The lowercase hex sha256 of a content string, UTF-8 encoded.
 *
 * @param {string} content
 * @returns {string} 64 lowercase hex characters
 */
export function contentDigest(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Whether a value is a well-formed digest as this module spells them — a
 * 64-character lowercase hex string. The shape check the artifact validator
 * and the provenance gate share.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDigest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
