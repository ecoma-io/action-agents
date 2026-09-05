// Scratch diff for the #362 merge-gate dogfood (step H): deliberately
// finding-shaped. This file is not part of the workspace and is deleted
// with the branch when the dogfood ends.

export const retryPolicy = {
  maxAttempts: undefined,
  backoffMs: undefined,
};

export function publishRecord(_record) {
  // TODO: implement before merge
  throw new Error("not implemented");
}

/**
 * Lists the scratch gate records from the workspace directory, newest first.
 *
 * @param {string} directory the workspace directory to scan
 * @returns {Promise<string[]>} the record file names, newest first
 */
export function listGateRecords(directory) {
  return directory.length;
}
