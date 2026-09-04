/**
 * The event matrix — which webhook events triage re-runs on, and which are
 * trivially deterministic and skip everything but an audit line.
 *
 * Triage's expensive work is one model call plus the evidence reads that
 * feed it; opt-in verification (issue #274) adds at most one bounded verify
 * call. Both are only worth paying when the event could have changed
 * triage-relevant evidence: the thread's content, its diff, its draft
 * state, or the queue state the `labels.workflowMarkers` lifecycle keys
 * on. A rerun of an unchanged thread would only re-derive the same decision
 * and write nothing new — so every event is classified here, determinis-
 * tically, before any read past the config is made:
 *
 *   - `issues` and `pull_request` events triage can receive and what they
 *     mean; anything not listed is re-triaged, never silently skipped —
 *     an event that is not on the matrix may carry evidence this table has
 *     not seen.
 *   - `labeled` re-triages only when the change could move the queue
 *     lifecycle: the queue marker itself was applied, or a classification
 *     category was applied to a thread still carrying the marker (so the
 *     marker clears once the run confirms the classification). Any other
 *     label change is a skip with a reason — a label the policy does not
 *     own or read cannot change what the model would classify.
 *   - `unlabeled` always skips: removing a label changes no content
 *     evidence, and removing the queue marker is a human dequeue that
 *     triage must respect rather than rewrite.
 *
 * The decision is a pure function of payload facts (`eventName`, `action`,
 * the changed label) and the policy's own declarations (the first
 * `workflowMarkers` entry, the role map). There is no forge read and no
 * model call in this module — a skip is decided before either exists, and
 * the audit line it produces is the whole trace of a skipped run.
 */

/** The `issues` event actions triage understands. An unlisted action is re-triaged, not skipped. */
export const ISSUE_ACTIONS = [
  "opened",
  "edited",
  "reopened",
  "labeled",
  "unlabeled",
  "transferred",
  "milestoned",
];

/** The `pull_request` event actions triage understands. An unlisted action is re-triaged, not skipped. */
export const PULL_REQUEST_ACTIONS = [
  "opened",
  "edited",
  "synchronize",
  "ready_for_review",
  "reopened",
  "labeled",
  "unlabeled",
  "review_requested",
  "converted_to_draft",
  "closed",
];

/**
 * @typedef {"retriage" | "skip"} EventMode
 */

/**
 * @typedef {object} EventDecision
 * @property {EventMode} mode `retriage` runs the pipeline; `skip` logs and stops, writing nothing
 * @property {string} reason a human-auditable sentence naming the evidence basis
 */

/**
 * @param {string} reason
 * @returns {EventDecision}
 */
function retriage(reason) {
  return { mode: "retriage", reason };
}

/**
 * @param {string} reason
 * @returns {EventDecision}
 */
function skip(reason) {
  return { mode: "skip", reason };
}

/**
 * The label a `labeled`/`unlabeled` event names, or null when the payload
 * carries none. A missing or malformed label reads as "unknown" — and an
 * unknown label event is re-triaged, the same refusal-by-name posture as
 * the thread's own label list, because a payload this action was not built
 * for is not silently classified as a no-op.
 *
 * @param {Record<string, unknown>} event the webhook payload
 * @returns {string | null}
 */
export function eventChangedLabel(event) {
  const label = event["label"];
  const name =
    typeof label === "object" && label !== null
      ? /** @type {Record<string, unknown>} */ (label)["name"]
      : null;
  return typeof name === "string" && name !== "" ? name : null;
}

/**
 * Decides whether the event it was given may have changed triage-relevant
 * evidence. `retriage` means the pipeline runs; `skip` means the run stops
 * here — no evidence read, no model call, no mutation — after logging the
 * decision and its reason.
 *
 * @param {object} input
 * @param {string} input.eventName the `GITHUB_EVENT_NAME`: `issues` or `pull_request`
 * @param {string} input.action the payload's `action` field; "" when the payload has none
 * @param {string | null} input.changedLabel the label a `labeled`/`unlabeled` event names, else null
 * @param {string | null} input.markerLabel the config's first `labels.workflowMarkers` entry, else null
 * @param {(name: string) => string | undefined} [input.roleOf] the config's `labels.roles` lookup
 * @param {string[]} [input.threadLabels] the labels the thread already carries, from the payload
 * @returns {EventDecision}
 */
export function decideEvent({
  eventName,
  action,
  changedLabel,
  markerLabel,
  roleOf,
  threadLabels = [],
}) {
  if (eventName !== "issues" && eventName !== "pull_request") {
    throw new Error(
      `triage runs on 'issues' and 'pull_request' events — this run was '${eventName}'`,
    );
  }
  if (action === "") {
    return retriage(
      `the '${eventName}' event carried no action — a run that cannot name its event is re-triaged, never silently skipped`,
    );
  }

  // Actions both event names share. `closed` is additionally supported for
  // issues even though the spec matrix lists it only under pull_request: a
  // consumer may trigger either, and a closed thread awaits no triage.
  if (action === "opened") return retriage("a new thread is new evidence");
  if (action === "edited") return retriage("the thread's content may have changed");
  if (action === "reopened") return retriage("the thread re-enters triage");
  if (action === "closed") return skip("a closed thread awaits no triage");
  if (action === "labeled" || action === "unlabeled") {
    return decideLabelEvent({ action, changedLabel, markerLabel, roleOf, threadLabels });
  }

  if (eventName === "issues") {
    if (action === "transferred") {
      return skip("moving a thread between repositories changes no triage evidence");
    }
    if (action === "milestoned") {
      return skip("a milestone is not triage evidence");
    }
  } else {
    if (action === "synchronize") return retriage("new commits are new evidence");
    if (action === "ready_for_review") {
      return retriage("a pull request that leaves draft is ready for triage");
    }
    if (action === "review_requested") {
      return skip("requesting reviewers changes no triage evidence");
    }
    if (action === "converted_to_draft") {
      return skip(
        "moving a pull request to draft changes no triage evidence — it is re-triaged when it leaves draft",
      );
    }
  }

  return retriage(
    `'${eventName}.${action}' is not on the event matrix — an unlisted event is re-triaged, never silently skipped`,
  );
}

/**
 * The `labeled`/`unlabeled` half of the matrix: a label event re-triages
 * only when it could move the queue lifecycle, because that is the only way
 * a label change can change what a run would write.
 *
 * @param {object} input
 * @param {"labeled" | "unlabeled"} input.action
 * @param {string | null} input.changedLabel
 * @param {string | null} input.markerLabel
 * @param {(name: string) => string | undefined} [input.roleOf]
 * @param {string[]} input.threadLabels
 * @returns {EventDecision}
 */
function decideLabelEvent({ action, changedLabel, markerLabel, roleOf, threadLabels }) {
  const queued =
    markerLabel !== null && threadLabels !== null && threadLabels.includes(markerLabel);
  if (action === "labeled") {
    if (changedLabel === null) {
      return retriage(
        "the label the event names is unknown — a label event that cannot name its change is re-triaged",
      );
    }
    if (markerLabel !== null && changedLabel === markerLabel) {
      return retriage(
        `the queue marker '${markerLabel}' was applied — re-triaged so a classified thread leaves the queue`,
      );
    }
    if (markerLabel !== null && queued && roleOf?.(changedLabel) === "semantic-classification") {
      return retriage(
        `a classification was applied to a thread still carrying '${markerLabel}' — re-triaged so the marker clears once classified`,
      );
    }
    return skip(
      `'${changedLabel}' is neither the queue marker nor a classification of a queued thread — content evidence is unchanged`,
    );
  }
  // unlabeled: removal is a deterministic state change, never new evidence.
  // Removing the queue marker in particular is a human dequeue; triage
  // respects it by writing nothing, not by re-adding the marker.
  if (changedLabel === null) {
    return retriage(
      "the label the event names is unknown — a label event that cannot name its change is re-triaged",
    );
  }
  if (markerLabel !== null && changedLabel === markerLabel) {
    return skip(
      `the queue marker '${markerLabel}' was removed — the thread leaves the queue by hand and triage writes nothing`,
    );
  }
  return skip(`removing '${changedLabel}' changes no content evidence — triage writes nothing`);
}

/**
 * The audit line every event gets, retriage and skip alike: which event,
 * which decision, and the reason. This is the whole trace of a skipped run.
 *
 * @param {object} input
 * @param {string} input.eventName
 * @param {string} input.action
 * @param {EventDecision} input.decision
 * @returns {string}
 */
export function eventAuditLine({ eventName, action, decision }) {
  return `triage: event ${eventName}.${action} → ${decision.mode} — ${decision.reason}`;
}
