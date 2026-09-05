/**
 * The capture boundary — the integration point that reads the reviewed
 * snapshot. A canonical finding's span and evidence are bound here, from the
 * working tree at the finding's own (file, line) anchor, never from anything
 * a model wrote ([ADR 004](../../docs/adr/004-canonical-review-result.md)):
 * the canonical constructor verifies a fingerprint against the tuple it is
 * given, and this module is where the tuple's span comes from.
 *
 * The rule is fail-closed, never skip-and-continue: a finding whose anchor
 * cannot be captured from the reviewed bytes has no evidence, and a finding
 * without a digest is not confirmed by anything — so every capture failure
 * refuses the run (`refused` per the failure taxonomy, through the typed
 * class the red boundary reads). Every refusal names the file and the line
 * that could not be captured.
 *
 * The read itself rides the same confinement every other read honours: the
 * path resolves through `core/workspace.mjs`, so an anchor outside the
 * workspace, inside `.git`, or behind a final-component symlink is a refusal
 * before any byte moves.
 */

import { closeSync, openSync, readSync } from "node:fs";

import { sanitiseCommentText } from "#core/sanitise.mjs";

import { contentDigest } from "./digest.mjs";
import { EVIDENCE_EXCERPT_CHARS } from "./verify.mjs";
import { BINARY_SNIFF_BYTES, MAX_READ_BYTES } from "./tools.mjs";

/** @typedef {import("#core/workspace.mjs").Workspace} Workspace */

/** A capture the boundary refuses — the anchor's evidence cannot be bound. */
export class CaptureRefusal extends Error {}

/**
 * One captured anchor: the reviewed bytes at the finding's anchor, bound as
 * the finding's span and its checkable evidence.
 *
 * @typedef {object} CapturedEvidence
 * @property {string} subject the anchor line exactly as the reviewed bytes carry it — the canonical tuple's span input, normalised downstream
 * @property {string} digest sha256 (lowercase hex) over the anchor line's UTF-8 bytes, restatable by whoever re-reads the same path at the recorded head
 * @property {string} excerpt the anchor line through the sanitiser, capped at the evidence-retention ceiling — the canonical finding's evidence excerpt
 */

/**
 * Captures one finding's anchor from the working tree: reads the reviewed
 * file through the workspace confinement, takes the line the finding anchors,
 * and binds `{ subject, digest, excerpt }`. Line endings fold — a trailing CR
 * is a checkout artifact, not content — so the same line at the same commit
 * digests identically whatever checked it out.
 *
 * @param {object} input
 * @param {Workspace} input.workspace the confined resolver every path goes through
 * @param {string} input.file the finding's repository-relative anchor path
 * @param {number} input.line the finding's 1-based anchor line
 * @returns {CapturedEvidence}
 */
export function captureFindingEvidence({ workspace, file, line }) {
  const where = `${file}:${String(line)}`;
  if (!Number.isInteger(line) || line < 1) {
    throw new CaptureRefusal(
      `capture refused for ${where} — the anchor line must be a 1-based integer`,
    );
  }
  let content;
  try {
    const entry = workspace.resolve(file);
    if (entry.kind !== "file") {
      throw new CaptureRefusal("the anchor names no file in this checkout");
    }
    content = readBounded(entry.absolute);
  } catch (cause) {
    // The confinement's refusals travel with their own reason and the asked
    // path; absence is named as absence. Every capture failure names the
    // file and the line that could not be captured.
    const reason =
      cause instanceof Error
        ? cause instanceof CaptureRefusal
          ? cause.message
          : `the reviewed file could not be read from the checkout: ${cause.message}`
        : `the reviewed file could not be read from the checkout: ${String(cause)}`;
    throw new CaptureRefusal(`capture refused for ${where} — ${reason}`, {
      cause: cause instanceof Error ? cause : undefined,
    });
  }
  if (content === "") {
    throw new CaptureRefusal(`capture refused for ${where} — the reviewed file is empty`);
  }
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (line > lines.length) {
    throw new CaptureRefusal(
      `capture refused for ${where} — the reviewed file carries ${String(lines.length)} line(s)`,
    );
  }
  const subject = /** @type {string} */ (lines[line - 1]).replace(/\r$/, "");
  return {
    subject,
    digest: contentDigest(subject),
    excerpt: sanitiseCommentText(subject, { maxChars: EVIDENCE_EXCERPT_CHARS }).text,
  };
}

/**
 * Reads up to the reviewer's own read cap — the same ceiling the anchor
 * validation already honours, so a line that passed it is inside what this
 * reads. Binary content carries no line to anchor: refused like any other
 * unreadable file.
 *
 * @param {string} absolute the resolved absolute path the confinement returned
 * @returns {string}
 */
function readBounded(absolute) {
  const fd = openSync(absolute, "r");
  try {
    const buffer = Buffer.alloc(MAX_READ_BYTES);
    const read = readSync(fd, buffer, 0, MAX_READ_BYTES, 0);
    if (buffer.subarray(0, Math.min(read, BINARY_SNIFF_BYTES)).includes(0)) {
      throw new CaptureRefusal("the reviewed file is binary and carries no capturable line");
    }
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
