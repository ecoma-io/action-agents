#!/usr/bin/env node
/**
 * Holds every surface that declares `on:` triggers for an action to the event
 * names the action's entrypoint accepts.
 *
 * Issue #463 is the shape this gate exists to keep impossible. The dogfood
 * kit, a getting-started template, the triage guide's policy table and this
 * repository's own `.github/workflows/triage.yml` all declared
 * `workflow_dispatch` for `triage` — and `triage` refuses every event name
 * outside `issues` / `pull_request` at its entrypoint. Each dispatched run
 * went red with `event-name-unsupported` (run contract F-01), which is the
 * contract working; the defect was four surfaces promising a run the action
 * cannot produce, and nothing comparing the promise to the refusal. `pnpm
 * lint`, `typecheck`, `arch` and `test` were green throughout, because no
 * gate read both sides.
 *
 * THE TWO DIRECTIONS.
 *
 * - A surface declaring a trigger the entrypoint refuses is a FAILURE: a run
 *   on that trigger ends `failed` at the event gate, before any decision.
 *   What the red run leaves behind is action-specific, and the run contract
 *   says so: triage's gate throws inside the record-writing try, so its
 *   `failed` record is still written; review's refusal is the F-01a carve-out
 *   — red, no artifact. This is the direction that bit (#463).
 * - An accepted event no surface declares is DRIFT, surfaced but not red: the
 *   runtime is the more permissive side, so an undeclared acceptance is a fact
 *   to notice, not a defect to block on. `harmonise` is the live case — it
 *   resolves a policy source for `pull_request` and `push` runs that nothing
 *   declares. `evaluate` returns the two lists separately; only `failures`
 *   reddens the gate.
 *
 * THE TRUTH IS IMPORTED, NOT PARSED. The accepted sets are `ACCEPTED_EVENTS`,
 * exported by each action's entrypoint beside the gate that enforces them —
 * `threadFromEvent`'s throw in `triage`, `readEvent`'s throw in `review`. The
 * exception is `harmonise`, which has no throw gate at all: its constant is
 * the set of event names its policy resolution handles by name, and its JSDoc
 * says so. Importing the runtime's own statement means this file cannot drift
 * from the runtime without editing the runtime, which is a reviewed act.
 * `tools/evaluate.mjs` already imports action source for the same reason.
 *
 * THE PARSER. No YAML library: this repository ships no runtime dependency,
 * and adding a development one to read a handful of trigger blocks would be
 * the wrong trade. What reads the surfaces is a line/state machine over the
 * shapes they actually use, and its assumptions are load-bearing:
 *
 * - a fenced ```yaml block in a document is a trigger surface only when it
 *   names exactly one of the actions in a `uses:` value
 *   (`ecoma-io/action-agents/<action>@…` or `./<action>`). A fence naming
 *   none is a config snippet, nobody's trigger surface — but a fence that
 *   declares an `on:` block and names no action fails closed, because an
 *   unattributable trigger promise is exactly the shape that hid #463. A
 *   fence naming two actions is ambiguous and fails closed;
 * - the `on:` key is read at column 0 only. Block style takes the keys two
 *   spaces in; scalar (`on: pull_request`) and flow (`on: [a, b]`) style take
 *   the names in the value. Anything deeper than the trigger level is a
 *   trigger's own body (`types:`, `cron:`, `inputs:`) and is not descended
 *   into; a line at column 0 ends the block;
 * - `#` starts a comment at line start or after a space, outside quotes, the
 *   same rule `check-workflow-inputs` applies;
 * - an event name that is not a plain word fails closed: prose the parser
 *   cannot read may be hiding the very drift this gate exists to catch.
 *
 * A workflow file with no `on:` block at all also fails closed: GitHub then
 * defaults the workflow to `push` and `pull_request` — triggers the entrypoints
 * may refuse, declared by nobody.
 *
 * Coverage is explicit: this repository's own workflow per action, plus
 * README.md, README.vi.md and every markdown page under `docs/` — the same
 * surface set the other document gates read.
 *
 * WHY ZERO IS A FAILURE. Finding no workflow file for an action, or no
 * template in any document, means the gate stopped reading the thing it exists
 * to read — a moved directory, a renamed trigger, a glob that matches nothing.
 * A gate that reports green over nothing gets trusted anyway, so an empty scan
 * goes red.
 *
 * The facts are gathered by the readers at the bottom; the judgment is the
 * pure function `evaluate`, which takes them as arguments, so the tests need
 * no repository and no mocking library.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ACCEPTED_EVENTS as triageAccepted } from "../triage/src/index.mjs";
import { ACCEPTED_EVENTS as reviewAccepted } from "../review/src/index.mjs";
import { ACCEPTED_EVENTS as harmoniseAccepted } from "../harmonise/src/index.mjs";

/** The directory this repository's own workflows live in. */
export const WORKFLOWS_DIR = join(".github", "workflows");

/**
 * Every action the gate judges, with the event set imported from its
 * entrypoint — the runtime's own statement, not this file's copy of it.
 *
 * @type {Record<string, readonly string[]>}
 */
export const ACCEPTED = {
  triage: triageAccepted,
  review: reviewAccepted,
  harmonise: harmoniseAccepted,
};

/** An event name as GitHub spells them: a plain word, `_`, `-` and `.`. */
const EVENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * One declared trigger, with the line it was read from — a failure names the
 * line the operator has to delete, not the block it sits in.
 *
 * @typedef {object} Trigger
 * @property {string} name the event name as declared
 * @property {number} line the 1-based line of the declaration
 */

/**
 * A surface's declared triggers: one workflow file, or one document fence.
 *
 * @typedef {object} TriggerSurface
 * @property {string} action the action the triggers are declared for
 * @property {string} surface the file the declaration was read from
 * @property {number | null} line the 1-based line of the `on:` key; null when
 *   the surface is a whole workflow file read without a fence offset
 * @property {Trigger[]} triggers the declared event names, in file order
 */

/**
 * @typedef {object} ParseError
 * @property {string} surface the file the unreadable line was read from
 * @property {number} line 1-based line number
 * @property {string} text the line the parser could not classify
 */

/**
 * @typedef {object} ParseResult
 * @property {Trigger[]} triggers the declared event names, in file order
 * @property {number | null} line the 1-based line of the `on:` key
 * @property {boolean} found whether an `on:` key exists at all
 * @property {ParseError[]} errors lines the parser could not classify
 */

/**
 * Strips a trailing comment: `#` at line start or after a space, outside
 * quotes — the same rule `check-workflow-inputs` applies.
 *
 * @param {string} line
 * @returns {string} the line with any comment stripped, right-trimmed
 */
function stripComment(line) {
  let single = false;
  let double = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !double) single = !single;
    else if (c === '"' && !single) double = !double;
    else if (c === "#" && !single && !double && (i === 0 || line[i - 1] === " ")) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

/**
 * Matching quotes around a scalar are spelling, not content.
 *
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * The event names in an `on:` value — scalar (`pull_request`) or flow
 * (`[pull_request, push]`) style. Anything that is not a plain event name is
 * an error, because prose the parser cannot read may be hiding a trigger.
 *
 * @param {string} value the value after `on:`
 * @param {string} surface
 * @param {number} line
 * @returns {{ names: string[], error: ParseError | null }}
 */
function parseInlineEvents(value, surface, line) {
  const names = value
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((part) => unquote(part.trim()))
    .filter((part) => part !== "");
  const bad = names.filter((name) => !EVENT_NAME.test(name));
  if (bad.length > 0) {
    return {
      names: [],
      error: {
        surface,
        line,
        text: `on: ${value} — these are not event names: ${bad.join(", ")}`,
      },
    };
  }
  return { names: names.map((name) => ({ name, line })), error: null };
}

/**
 * Reads one `on:` block starting at `lines[start]`, which is at column 0.
 * Block style takes the keys two spaces in; anything deeper is a trigger's
 * own body and is not descended into; a line back at column 0 ends the block.
 *
 * @param {string[]} lines the lines of the whole surface, fences included
 * @param {number} start the 0-based index of the `on:` line
 * @param {string} surface
 * @param {number} baseLine the 1-based line number of `lines[0]`
 * @returns {ParseResult}
 */
function readOnBlock(lines, start, surface, baseLine) {
  const onLine = stripComment(lines[start] ?? "").trim();
  /** @type {ParseError[]} */
  const errors = [];
  const inline = onLine.slice(3).trim();
  const line = baseLine + start;
  if (inline !== "") {
    const { names, error } = parseInlineEvents(inline, surface, line);
    if (error !== null) errors.push(error);
    return { triggers: names, line, found: true, errors };
  }

  /** @type {Trigger[]} */
  const triggers = [];
  for (let i = start + 1; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (/^\t/.test(raw)) {
      errors.push({ surface, line: baseLine + i, text: raw.trim() });
      break;
    }
    const content = stripComment(raw).trim();
    if (content === "") continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) break; // a new top-level key: the block is over
    if (indent === 2) {
      const key = content.split(":")[0] ?? "";
      if (!EVENT_NAME.test(key) || !content.startsWith(`${key}:`)) {
        errors.push({ surface, line: baseLine + i, text: content });
        continue;
      }
      triggers.push({ name: key, line: baseLine + i });
    }
    // Deeper than two spaces is a trigger's own body (types, cron, inputs) —
    // not descended into.
  }
  return { triggers, line, found: true, errors };
}

/**
 * Every `on:` declaration in one yaml document (a whole workflow file, or one
 * fenced block's lines).
 *
 * @param {string[]} lines
 * @param {string} surface
 * @param {number} baseLine the 1-based line number of `lines[0]`
 * @returns {{ declarations: TriggerSurface[], errors: ParseError[] }}
 */
function readOnDeclarations(lines, surface, baseLine) {
  /** @type {TriggerSurface[]} */
  const declarations = [];
  /** @type {ParseError[]} */
  const errors = [];
  let any = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const content = stripComment(raw).trimStart();
    if (!content.startsWith("on:")) continue;
    // A longer key that merely begins with these characters (`onfoo:`) is not
    // this key; YAML's required space after the colon settles it.
    if (content.length > 3 && !content.startsWith("on: ")) continue;
    if (raw.trimStart().length !== raw.length) continue; // indented: not top level
    any = true;
    const parsed = readOnBlock(lines, i, surface, baseLine);
    errors.push(...parsed.errors);
    if (parsed.triggers.length === 0 && parsed.errors.length === 0) {
      errors.push({
        surface,
        line: parsed.line ?? baseLine + i,
        text: "declares an on: block with no trigger — the workflow never runs, so every covered surface is judged over nothing",
      });
    }
    declarations.push({
      action: "",
      surface,
      line: parsed.line,
      triggers: parsed.triggers,
    });
  }
  if (!any) {
    errors.push({
      surface,
      line: baseLine,
      text: "declares no on: block — GitHub then defaults the workflow to push and pull_request, triggers an entrypoint may refuse",
    });
  }
  return { declarations, errors };
}

/**
 * The `uses:` values in one fenced block that name one of the judged actions.
 * Comment lines are skipped before matching, so a quoted historical note
 * about a `uses:` line is not read as one.
 *
 * @param {string[]} fence
 * @returns {Set<string>} the distinct actions named, judged ones only
 */
function namedActions(fence) {
  /** @type {Set<string>} */
  const actions = new Set();
  for (const raw of fence) {
    const line = stripComment(raw).trim();
    const match = /(?:^|\s)uses:\s*(\S+)/.exec(line);
    if (match === null) continue;
    const value = unquote(match[1] ?? "");
    let action = null;
    if (value.startsWith("ecoma-io/action-agents/")) {
      action =
        (value.slice("ecoma-io/action-agents/".length).split("@")[0] ?? "").split("/")[0] ?? null;
    } else if (value.startsWith("./")) {
      action = value.slice(2).split("@")[0] ?? null;
    }
    if (action !== null && action !== "" && action in ACCEPTED) actions.add(action);
  }
  return actions;
}

/**
 * The workflow templates one markdown document declares: its ```yaml fences
 * that name one judged action and declare an `on:` block. A fence naming an
 * action without an `on:` block is a step snippet, not a trigger surface. A
 * fence declaring `on:` without naming an action fails closed — an
 * unattributable trigger promise cannot be judged, and #463 hid behind
 * exactly that gap.
 *
 * @param {string} text
 * @param {string} surface the document's path, for failure messages
 * @returns {{ templates: TriggerSurface[], errors: ParseError[] }}
 */
export function extractDocTemplates(text, surface) {
  const lines = text.split("\n");
  /** @type {TriggerSurface[]} */
  const templates = [];
  /** @type {ParseError[]} */
  const errors = [];
  let inFence = false;
  let start = 0;
  /** @type {string[]} */
  let fence = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!inFence) {
      if (/^\s*```yaml\s*$/.test(line)) {
        inFence = true;
        start = i + 2; // 1-based line number of the fence's first content line
        fence = [];
      }
      continue;
    }
    if (/^\s*```\s*$/.test(line)) {
      inFence = false;
      judgeFence(fence, start, surface, templates, errors);
      continue;
    }
    fence.push(line);
  }
  if (inFence) {
    errors.push({ surface, line: start, text: "an unterminated ```yaml fence" });
  }
  return { templates, errors };
}

/**
 * @param {string[]} fence
 * @param {number} start 1-based line number of the fence's first content line
 * @param {string} surface
 * @param {TriggerSurface[]} templates mutated with any template found
 * @param {ParseError[]} errors mutated with any parse failure
 * @returns {void}
 */
function judgeFence(fence, start, surface, templates, errors) {
  const actions = namedActions(fence);
  const hasOn = fence.some((raw) => stripComment(raw).startsWith("on:"));
  if (!hasOn) return; // a step or config snippet: no trigger promise to judge
  if (actions.size === 0) {
    errors.push({
      surface,
      line: start,
      text: "a yaml fence declares an on: block but names none of the actions this gate judges — attribute it with a uses: line so its triggers can be judged",
    });
    return;
  }
  if (actions.size > 1) {
    errors.push({
      surface,
      line: start,
      text: `a yaml fence names ${[...actions].sort().join(" and ")} — ambiguous, so its triggers cannot be judged; split it per action`,
    });
    return;
  }
  const action = [...actions][0] ?? "";
  const { declarations, errors: onErrors } = readOnDeclarations(fence, surface, start);
  errors.push(...onErrors);
  for (const declaration of declarations) {
    templates.push({ ...declaration, action });
  }
}

/**
 * @param {object} input
 * @param {TriggerSurface[]} input.workflows this repository's own workflow surfaces
 * @param {TriggerSurface[]} input.templates the documents' workflow templates
 * @param {ParseError[]} input.errors lines the readers could not classify
 * @param {Record<string, readonly string[]>} input.accepted the runtime truth, per action
 * @returns {{ failures: string[], drift: string[], workflows: number, templates: number, declared: number }}
 */
export function evaluate({ workflows, templates, errors, accepted }) {
  /** @type {string[]} */
  const failures = [];
  const actions = Object.keys(accepted).sort();
  const every = [...workflows, ...templates];

  for (const error of errors) {
    failures.push(
      `${error.surface}:${String(error.line)}: a line this gate cannot parse (\`${error.text}\`). ` +
        `A line it cannot read may be hiding the very drift it exists to catch.`,
    );
  }

  // WHY ZERO IS A FAILURE: a missing workflow file or an empty document scan
  // means the gate stopped reading the tree it exists to judge.
  for (const action of actions) {
    if (!workflows.some((surface) => surface.action === action)) {
      failures.push(
        `${join(WORKFLOWS_DIR, `${action}.yml`)} was not read — ` +
          `every judged action needs its own workflow, or the gate has nothing on the runtime's side.`,
      );
    }
  }
  if (templates.length === 0) {
    failures.push(
      "no workflow template was found in README.md, README.vi.md or docs/ — " +
        "a gate that read no declared surface judges nothing and reports green over it.",
    );
  }

  // Direction A — the #463 class: a surface promising an event the runtime
  // refuses. The failure names the trigger's own line, the line the operator
  // has to delete or move.
  for (const surface of every) {
    const allowed = accepted[surface.action];
    if (allowed === undefined) continue;
    for (const trigger of surface.triggers) {
      if (allowed.includes(trigger.name)) continue;
      failures.push(
        `${surface.surface}:${String(trigger.line)}: declares '${trigger.name}' for ${surface.action}, ` +
          `which accepts ${allowed.map((name) => `'${name}'`).join(" and ")}. ` +
          `A run on '${trigger.name}' refuses at the entrypoint's event gate (run contract F-01). ` +
          `Remove the trigger, or move the workflow to an action that accepts it.`,
      );
    }
  }

  // Direction B — drift, surfaced but not red: the runtime accepting an event
  // no surface declares.
  /** @type {string[]} */
  const drift = [];
  for (const action of actions) {
    const allowed = accepted[action] ?? [];
    const declared = new Set(
      every
        .filter((surface) => surface.action === action)
        .flatMap((surface) => surface.triggers.map((trigger) => trigger.name)),
    );
    for (const event of allowed) {
      if (declared.has(event)) continue;
      drift.push(
        `${action} accepts '${event}' and no covered surface declares it — neither ` +
          `${join(WORKFLOWS_DIR, `${action}.yml`)} nor a workflow template in the documents. ` +
          `Either a trigger was lost, or the accepted set grew without a surface to fire it.`,
      );
    }
  }

  failures.sort();
  drift.sort();
  const declared = every.reduce((sum, surface) => sum + surface.triggers.length, 0);
  return {
    failures,
    drift,
    workflows: workflows.length,
    templates: templates.length,
    declared,
  };
}

/**
 * One workflow file's declared triggers, with the action filled in — the shape
 * `collect` builds for each of this repository's own workflows, exported so
 * the tests can judge a synthetic workflow file without writing one.
 *
 * @param {string} text
 * @param {string} surface
 * @param {string} action
 * @returns {{ surfaces: TriggerSurface[], errors: ParseError[] }}
 */
export function parseWorkflowTriggers(text, surface, action) {
  const { declarations, errors } = readOnDeclarations(text.split("\n"), surface, 1);
  return {
    surfaces: declarations.map((declaration) => ({ ...declaration, action })),
    errors,
  };
}

/**
 * This repository's own workflow per action, plus README.md, README.vi.md and
 * every markdown page under `docs/` — the same document set the other gates
 * read, walked the way `check-uses-refs` walks it.
 *
 * @returns {{ workflows: TriggerSurface[], templates: TriggerSurface[], errors: ParseError[] }}
 */
export function collect() {
  /** @type {TriggerSurface[]} */
  const workflows = [];
  /** @type {ParseError[]} */
  const errors = [];

  for (const action of Object.keys(ACCEPTED).sort()) {
    const path = join(WORKFLOWS_DIR, `${action}.yml`);
    if (!existsSync(path)) continue; // evaluate names the missing file
    const parsed = readOnDeclarations(readFileSync(path, "utf8").split("\n"), path, 1);
    errors.push(...parsed.errors);
    for (const declaration of parsed.declarations) {
      workflows.push({ ...declaration, action });
    }
  }

  /** @type {string[]} */
  const docPaths = [];
  for (const readme of ["README.md", "README.vi.md"]) {
    if (existsSync(readme)) docPaths.push(readme);
  }
  if (existsSync("docs")) {
    for (const entry of readdirSync("docs", { recursive: true })) {
      const rel = String(entry);
      if (rel.endsWith(".md")) docPaths.push(join("docs", rel));
    }
  }
  /** @type {TriggerSurface[]} */
  const templates = [];
  for (const path of docPaths.sort()) {
    const facts = extractDocTemplates(readFileSync(path, "utf8"), path);
    templates.push(...facts.templates);
    errors.push(...facts.errors);
  }

  return { workflows, templates, errors };
}

function main() {
  const files = collect();
  const { failures, drift, workflows, templates, declared } = evaluate({
    ...files,
    accepted: ACCEPTED,
  });

  if (failures.length > 0) {
    for (const failure of failures) console.error(`✗ ${failure}`);
    console.error(`\n${String(failures.length)} event-parity failure(s).`);
    process.exit(1);
  }

  for (const note of drift) console.warn(`! ${note}`);
  console.log(
    `✔ ${String(workflows)} workflow file(s) and ${String(templates)} documented template(s) ` +
      `promise only events the entrypoints accept (${String(declared)} declared trigger(s) judged, ` +
      `${String(drift.length)} drift note(s) surfaced)`,
  );
}

/**
 * Whether this file was RUN rather than imported, compared on real paths. The
 * same shape as the gates beside it, and not shared with them for the same
 * reason: a helper imported across the gates would make each one's failure
 * depend on a third file.
 *
 * @param {string} moduleUrl
 * @param {string | undefined} [argv1]
 * @returns {boolean}
 */
function isProgramEntry(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const real = (/** @type {string} */ path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(argv1) === real(fileURLToPath(moduleUrl));
}

if (isProgramEntry(import.meta.url)) main();
