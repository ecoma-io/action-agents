/**
 * The SARIF 2.1.0 projection of a canonical result — the shape GitHub Code
 * Scanning ingests (ADR 004 consequence: the same canonical result always
 * projects to byte-identical SARIF, so an upload is diffable like any other
 * artifact). Deliberately not a general SARIF writer: no timestamps, no
 * invocation ids, no environment echoes — the projection is a pure function
 * of the canonical result and nothing else.
 *
 * Each result carries the finding's Ecoma fingerprint (`identity.mjs`) as its
 * `partialFingerprints` — under `primaryLocationLineHash`, the one key GitHub
 * Code Scanning consults when deduplicating alerts across uploads, and under
 * the review's own named slot beside it. One identity, two consumers: the
 * comment's record block and the Code Scanning alert carry the same string.
 *
 * Only `confirmed` findings publish. A `refuted` claim was answered wrong
 * and an `unresolved` one carries no verdict; neither may enter Code
 * Scanning. The model never decides what this projection contains — the
 * lifecycle, spelled by `verify.mjs` and frozen into the canonical result,
 * already is that decision.
 */
/**
 * One SARIF reporting descriptor — one distinct finding kind.
 *
 * @typedef {object} SarifRule
 * @property {string} id the finding kind
 * @property {{ text: string }} shortDescription the kind, spelled for the Code Scanning rules list
 */

/**
 * One SARIF result — one published finding.
 *
 * @typedef {object} SarifResult
 * @property {string} ruleId the finding kind — the rule this result reports
 * @property {number} ruleIndex the rule's position in `tool.driver.rules`
 * @property {"warning" | "note"} level the severity's SARIF grade
 * @property {{ text: string }} message the finding's claim as answered
 * @property {Array<{ physicalLocation: { artifactLocation: { uri: string, uriBaseId: string }, region: { startLine: number } } }>} locations the finding's anchor
 * @property {{ primaryLocationLineHash: string, "reviewFindingFingerprint/v2": string }} partialFingerprints the finding's Ecoma fingerprint under GitHub's dedup key, and the review's named slot beside it
 */

/**
 * The SARIF 2.1.0 log this module projects — pinned to the one run shape
 * the review publishes.
 *
 * @typedef {object} SarifLog
 * @property {"https://json.schemastore.org/sarif-2.1.0.json"} $schema
 * @property {"2.1.0"} version
 * @property {Array<{ tool: { driver: { name: string, informationUri: string, rules: SarifRule[] } }, results: SarifResult[] }>} runs
 */

/**
 * Two strings in code-point order — the projection's only sort key shape,
 * so ordering never depends on the host locale.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareStrings(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** The SARIF schema this projection pins, so no reader guesses. */
const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";

/** The URI base id GitHub Code Scanning resolves relative artifact locations against. */
const SRC_ROOT = "%SRCROOT%";

/** The partial fingerprint key GitHub Code Scanning consults when deduplicating alerts across uploads. */
const PRIMARY_LOCATION_LINE_HASH = "primaryLocationLineHash";

/** The review's named slot the fingerprint rides beside GitHub's key — the string a ruleset or a human joins comment and SARIF on. */
const FINGERPRINT_SLOT = "reviewFindingFingerprint/v2";

/**
 * The SARIF `level` each finding severity projects to. The severity set is
 * closed (`answer.mjs` exports `SEVERITIES` = concern, nit), so the map is
 * total; a severity outside it is a constructor defect this module refuses
 * to guess at.
 * @type {Readonly<Record<import("./answer.mjs").Finding["severity"], "warning" | "note">>}
 */
const LEVEL_OF_SEVERITY = Object.freeze({ concern: "warning", nit: "note" });

/**
 * Normalises a repository-relative path the way a SARIF artifact location
 * spells it: backslashes become forward slashes. The canonical layer has
 * already normalised `./` segments; this is the last-mile spelling only.
 *
 * @param {string} file
 * @returns {string}
 */
function sarifUri(file) {
  return file.replaceAll("\\", "/");
}

/**
 * Projects the canonical result's confirmed findings to SARIF 2.1.0. Pure
 * and deterministic: fixed key insertion order everywhere, sorting copies
 * and never mutates the input, and the same result always yields
 * byte-identical JSON.
 *
 * @param {import("./canonical.mjs").CanonicalResult} result the canonical result to project
 * @returns {import("./sarif.mjs").SarifLog} the SARIF log — ready for `JSON.stringify` and upload
 */
export function toSarif(result) {
  const published = result.findings
    .filter((finding) => finding.lifecycle === "confirmed")
    .sort(
      (a, b) =>
        compareStrings(a.file, b.file) ||
        a.line - b.line ||
        compareStrings(a.fingerprint, b.fingerprint),
    );

  /** @type {import("./sarif.mjs").SarifRule[]} */
  const rules = [];
  /** @type {Map<string, number>} */
  const ruleIndexOfKind = new Map();
  for (const finding of published) {
    if (!ruleIndexOfKind.has(finding.kind)) {
      ruleIndexOfKind.set(finding.kind, rules.length);
      rules.push({ id: finding.kind, shortDescription: { text: finding.kind } });
    }
  }

  const results = published.map((finding) => {
    const severity = LEVEL_OF_SEVERITY[finding.severity];
    if (severity === undefined) {
      throw new TypeError(`severity ${JSON.stringify(finding.severity)} is not a finding severity`);
    }
    return {
      ruleId: finding.kind,
      ruleIndex: /** @type {number} */ (ruleIndexOfKind.get(finding.kind)),
      level: severity,
      message: { text: finding.message },
      locations: [
        {
          physicalLocation: {
            artifactLocation: {
              uri: sarifUri(finding.file),
              uriBaseId: SRC_ROOT,
            },
            region: { startLine: finding.line },
          },
        },
      ],
      partialFingerprints: {
        [PRIMARY_LOCATION_LINE_HASH]: finding.fingerprint,
        [FINGERPRINT_SLOT]: finding.fingerprint,
      },
    };
  });

  return {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "ecoma-io/action-agents/review",
            informationUri: "https://github.com/ecoma-io/action-agents",
            rules,
          },
        },
        results,
      },
    ],
  };
}
