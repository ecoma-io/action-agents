/**
 * The agent loop — what to read next, when to stop, how to compact. It
 * speaks no protocol of its own and invents no ceilings: the protocol is
 * `chat.mjs`'s, the bounds are the spec's constants, and the model never
 * touches GitHub — every effect this loop produces is a line in its own
 * transcript.
 *
 * Accounting, exactly as specified:
 *
 *   - one turn is one model response; responses carrying tool calls are
 *     reading turns, bounded by `maxTurns`;
 *   - every tool call in a response gets exactly one result message — calls
 *     past the tool-call ceiling receive a budget-spent notice instead of
 *     execution, because an answered `tool_calls` with missing results is a
 *     wire violation of our own making;
 *   - wrapped results charge the cumulative-evidence ceiling;
 *   - when any reading bound fires first, ONE finalisation request goes out
 *     with the tools withheld — no further call is even expressible — and
 *     its content is the candidate, flagged partial with the bound named;
 *   - a response without tool calls while reading turns remain is a natural
 *     stop, and its content is the candidate — the only path a corrective
 *     re-ask may ever follow;
 *   - before every request, the token estimate is checked: past 80% of the
 *     window the transcript is compacted deterministically — system and task
 *     messages kept, everything later replaced by one state message built
 *     from the ledger. The model's prose along the way is discarded
 *     wholesale; a summary a model wrote never becomes context the loop
 *     trusts.
 *
 * A fatal tool result — arguments that were not JSON at all — ends the run
 * here: the conversation's wire format broke, which is provider failure,
 * not a turn to hand back.
 */

import { coverageReport, normaliseReadPath } from "./coverage.mjs";
import { FIRST_PHASE, nextPhase, phaseTools } from "./phases.mjs";

/** @typedef {import("#core/chat.mjs").Chat} Chat */
/** @typedef {import("#core/chat.mjs").ChatMessage} ChatMessage */
/** @typedef {import("./phases.mjs").PhaseName} PhaseName */

export const MAX_TOOL_CALLS = 200;

/** No honest read_file/list_files/search arguments approach this. */
export const MAX_CALL_ARGUMENT_BYTES = 64 * 2 ** 10;
export const MAX_CUMULATIVE_EVIDENCE_BYTES = 512 * 2 ** 10;

/** @typedef {"max-turns" | "tool-calls" | "evidence"} Bound */

/**
 * @typedef {object} LoopOutcome
 * @property {string} candidate the final-answer candidate's text
 * @property {boolean} naturalStopped true when the model stopped on its own
 * @property {Bound | undefined} bound the reading bound that fired, when one did
 * @property {import("./coverage.mjs").CoverageReport} coverage the deterministic read-coverage report over the expected set
 * @property {PhaseName} phase the machine's phase at exit
 * @property {number} readingTurns
 * @property {number} toolCalls
 * @property {number} evidenceBytes the evidence captured by the loop
 * @property {number} maxTurns the turn cap the loop enforced
 * @property {number} maxToolCalls the tool-call cap the loop enforced
 * @property {number} maxEvidenceBytes the evidence cap the loop enforced
 * @property {ChatMessage[]} transcript the loop's final transcript, for the re-ask
 * @property {string[]} log lines for the runner's log
 * @property {PhaseLogEntry[]} phaseLog the phase transitions the loop took, in order — the artifact's phase record
 */

/**
 * One phase transition the loop logged at the moment it happened.
 *
 * @typedef {object} PhaseLogEntry
 * @property {PhaseName} from the phase the machine left
 * @property {PhaseName} to the phase the machine entered
 */

/**
 * The loop's own bookkeeping — the inventory that survives compaction.
 *
 * @typedef {object} Ledger
 * @property {number} readingTurns
 * @property {number} toolCalls
 * @property {number} evidenceBytes
 * @property {string[]} filesRead the read_file paths whose bytes the loop captured —
 *   recorded only on the tool's success, never for a refused attempt; entries are JSON-encoded
 * @property {string[]} diffInspected the paths the code itself recorded as inspected — a
 *   deletion's diff section rides in the initial prompt, so its removed content is on the
 *   record without a read_file (which could not open the removed path anyway). Seeded
 *   before the loop; nothing the model writes or calls can grow or shrink it.
 * @property {string[]} searchesRun
 * @property {string[]} toolErrors
 */

/**
 * @param {object} input
 * @param {Chat} input.chat
 * @param {string} input.model
 * @param {{ execute: (name: string, argumentsJson: string) => { ok: boolean, output: string, fatal?: true } }} input.tools
 * @param {ChatMessage[]} input.messages the assembled system + task messages, evidence included
 * @param {number} input.maxTurns
 * @param {number} input.contextWindow
 * @param {{ maxToolCalls?: number, evidenceBytes?: number }} [input.limits]
 * @param {string[]} [input.expectedPaths] the diff-derived expected set; defaults to none
 * @param {string[]} [input.diffInspectedPaths] the code-recorded inspections — a deletion's own
 *   diff section is the inspection of that path; defaults to none
 * @param {import("./config.mjs").Strictness} [input.strictness] the review policy; the conclude edge tightens at "high" (defaults to "medium")
 * @returns {Promise<LoopOutcome>}
 */
export async function runLoop({
  chat,
  model,
  tools,
  messages,
  maxTurns,
  contextWindow,
  limits,
  expectedPaths,
  diffInspectedPaths,
  strictness = "medium",
}) {
  const maxToolCalls = limits?.maxToolCalls ?? MAX_TOOL_CALLS;
  const maxEvidenceBytes = limits?.evidenceBytes ?? MAX_CUMULATIVE_EVIDENCE_BYTES;
  const expected = expectedPaths ?? [];
  /** @type {PhaseName} */
  let phase = FIRST_PHASE;

  if (messages[0] === undefined || messages[1] === undefined) {
    throw new Error("the loop needs a system message and a task message");
  }
  /** @type {Ledger} */
  const ledger = {
    readingTurns: 0,
    toolCalls: 0,
    evidenceBytes: 0,
    filesRead: [],
    diffInspected: diffInspectedPaths ?? [],
    searchesRun: [],
    toolErrors: [],
  };
  /** @type {ChatMessage[]} */
  let transcript = [...messages];
  /** @type {PhaseLogEntry[]} */
  const phaseLog = [];
  /** @type {string[]} */
  const log = [];

  /**
   * The machine's input, rebuilt from the ledger at every update — the
   * coverage report over the expected set, the budgets as consumed against
   * their caps, the lanes code fixed before the loop, the policy. No model
   * text enters: the machine reads the ledger, not the transcript.
   *
   * @returns {import("./phases.mjs").PhaseContext}
   */
  function phaseContext() {
    return {
      coverage: readCoverage(expected, ledger),
      toolCalls: ledger.toolCalls,
      maxToolCalls,
      readingTurns: ledger.readingTurns,
      maxTurns,
      evidenceBytes: ledger.evidenceBytes,
      evidenceLimit: maxEvidenceBytes,
      // Lanes are fixed by code before the loop starts.
      lanesAssigned: true,
      strictness,
    };
  }

  /**
   * One request, preceded by the compaction check. The transcript IS what
   * is sent; nothing is pending outside it.
   *
   * @param {import("#core/chat.mjs").ChatTool[] | undefined} offeredTools
   * @param {ChatMessage[]} [pending] one-shot additions — the finalisation instruction — never persisted
   */
  async function ask(offeredTools, pending = []) {
    if (estimateTokens(transcript) > 0.8 * contextWindow && transcript.length > 2) {
      transcript = [
        ...transcript.slice(0, 2),
        // The model's own analysis prose is the one thing no ledger
        // re-derives, so it is kept verbatim. Its toolCalls payload is
        // stripped: the results those calls produced are not carried
        // across, and a tool call without its answers breaks the wire.
        ...transcript
          .slice(2)
          .filter((m) => m.role === "assistant" && (m.content ?? "") !== "")
          .map(({ role, content }) => ({ role, content: /** @type {string} */ (content) })),
        { role: "user", content: renderState(ledger, phase) },
      ];
      log.push(
        `compacted the transcript to ${String(estimateTokens(transcript))} estimated tokens`,
      );
    }
    const response = await chat.complete({
      model,
      messages: [...transcript, ...pending],
      ...(offeredTools === undefined ? {} : { tools: offeredTools }),
    });
    return { response, transcript };
  }

  for (;;) {
    const { response, transcript: currentTranscript } = await ask(phaseTools(phase));
    transcript = currentTranscript;

    if (response.toolCalls.length === 0) {
      // Natural stop while reading turns remain: the candidate speaks now.
      return {
        candidate: response.content,
        naturalStopped: true,
        bound: undefined,
        coverage: readCoverage(expected, ledger),
        phase,
        readingTurns: ledger.readingTurns,
        toolCalls: ledger.toolCalls,
        evidenceBytes: ledger.evidenceBytes,
        maxTurns,
        maxToolCalls,
        maxEvidenceBytes,
        transcript,
        log,
        phaseLog,
      };
    }

    transcript.push({
      role: "assistant",
      content: response.content === "" ? null : response.content,
      toolCalls: response.toolCalls,
    });

    for (const call of response.toolCalls) {
      if (ledger.toolCalls >= maxToolCalls) {
        // Past the ceiling nothing executes — but the conversation stays
        // well-formed: every call receives its answer.
        transcript.push({
          role: "tool",
          toolCallId: call.id,
          content: "(not executed — the review's tool budget was spent)",
        });
        continue;
      }
      ledger.toolCalls++;
      if (Buffer.byteLength(call.arguments, "utf8") > MAX_CALL_ARGUMENT_BYTES) {
        // No legitimate call to a three-tool registry carries this much
        // argument text; a provider that emits one is breaking the wire.
        throw new Error(
          `the provider's tool call '${call.id}' carried ${String(Buffer.byteLength(call.arguments, "utf8"))} ` +
            `bytes of arguments — beyond any legitimate call`,
        );
      }
      const readPath = track(ledger, call.name, call.arguments);

      const result = tools.execute(call.name, call.arguments);
      if (result.fatal === true) {
        throw new Error(
          `the provider's tool call '${call.id}' carried unparsable arguments — the wire contract is broken`,
        );
      }
      if (!result.ok) {
        ledger.toolErrors.push(`${call.name}: ${result.output.slice(0, 160)}`);
      } else {
        ledger.evidenceBytes += Buffer.byteLength(result.output, "utf8");
        // Coverage counts captures: the read joins the ledger only where its
        // bytes joined the evidence — a refused attempt is a tool error, not
        // a read. Same success condition, same spelling, as the capture the
        // tool recorded for the verification pass.
        if (readPath !== undefined) ledger.filesRead.push(JSON.stringify(readPath));
      }
      transcript.push({ role: "tool", toolCallId: call.id, content: result.output });
    }
    ledger.readingTurns++;
    const previousPhase = phase;
    phase = nextPhase(phase, phaseContext());
    if (phase !== previousPhase) {
      log.push(`phase: ${previousPhase} → ${phase}`);
      phaseLog.push({ from: previousPhase, to: phase });
    }
    if (
      ledger.readingTurns >= maxTurns ||
      ledger.toolCalls >= maxToolCalls ||
      ledger.evidenceBytes >= maxEvidenceBytes
    ) {
      const bound =
        ledger.evidenceBytes >= maxEvidenceBytes
          ? "evidence"
          : ledger.toolCalls >= maxToolCalls
            ? "tool-calls"
            : "max-turns";
      log.push(`reading bound fired: ${bound}`);
      if (phase !== "conclude") {
        log.push(
          `phase machine holds the review in ${phase}: strict policy with ` +
            `${String(phaseContext().coverage.uncovered.length)} uncovered file(s)`,
        );
      }
      return await conclude({
        ask,
        ledger,
        log,
        bound,
        transcript,
        expectedPaths: expected,
        phase,
        maxTurns,
        maxToolCalls,
        maxEvidenceBytes,
        phaseLog,
      });
    }
  }
}

/**
 * The read-coverage report at a loop exit: the expected set against the reads on
 * record — the ledger's captured `read_file` calls (a refused attempt never
 * enters the ledger), each decoded from the JSON argument it was stored as
 * (`track()` only ever stores `JSON.stringify` output, so the decode cannot
 * throw), plus the code-recorded deletion inspections. Both sides are
 * normalised to the diff's canonical spelling.
 *
 * @param {string[]} expectedPaths
 * @param {Ledger} ledger
 * @returns {import("./coverage.mjs").CoverageReport}
 */
function readCoverage(expectedPaths, ledger) {
  return coverageReport(expectedPaths, [
    ...ledger.filesRead.map((entry) => normaliseReadPath(String(JSON.parse(entry)))),
    ...ledger.diffInspected,
  ]);
}

/**
 * The one finalisation request: transcript plus an explicit instruction,
 * tools withheld so no further call is even expressible.
 *
 * @param {object} input
 * @param {(offeredTools: import("#core/chat.mjs").ChatTool[] | undefined, pending?: ChatMessage[]) => Promise<{ response: { content: string }, transcript: ChatMessage[] }>} input.ask
 * @param {Ledger} input.ledger
 * @param {string[]} input.log the log line accumulator
 * @param {Bound} input.bound the bound that fired at the exit
 * @param {ChatMessage[]} input.transcript the transcript at the bound's firing
 * @param {string[]} input.expectedPaths the diff-derived expected set
 * @param {PhaseName} input.phase the machine's phase at the exit
 * @param {number} input.maxTurns the turn cap the loop enforced
 * @param {number} input.maxToolCalls the tool-call cap the loop enforced
 * @param {number} input.maxEvidenceBytes the evidence cap the loop enforced
 * @param {PhaseLogEntry[]} input.phaseLog the transitions the loop logged
 */
async function conclude({
  ask,
  ledger,
  log,
  bound,
  transcript: _transcript,
  expectedPaths,
  phase,
  maxTurns,
  maxToolCalls,
  maxEvidenceBytes,
  phaseLog,
}) {
  const { response, transcript: finalTranscript } = await ask(undefined, [
    {
      role: "user",
      content:
        "The review's reading budget is exhausted. Produce the final answer now: only the " +
        "JSON object the output contract specifies, findings you are confident in, nothing else.",
    },
  ]);
  return {
    candidate: response.content,
    naturalStopped: false,
    bound,
    coverage: readCoverage(expectedPaths, ledger),
    phase,
    readingTurns: ledger.readingTurns,
    toolCalls: ledger.toolCalls,
    evidenceBytes: ledger.evidenceBytes,
    maxTurns,
    maxToolCalls,
    maxEvidenceBytes,
    transcript: finalTranscript,
    log,
    phaseLog,
  };
}

/**
 * One corrective re-ask after a NATURAL stop produced a structurally invalid
 * answer. Tools withheld; not a reading turn; never follows a bound.
 *
 * @param {object} input
 * @param {Chat} input.chat
 * @param {string} input.model
 * @param {ChatMessage[]} input.transcript the loop's final transcript
 * @returns {Promise<string>}
 */
export async function reaskFinalAnswer({ chat, model, transcript }) {
  const response = await chat.complete({
    model,
    messages: [
      ...transcript,
      {
        role: "user",
        content:
          "That answer does not satisfy the output contract. Answer again: only the JSON object " +
          "the contract specifies — findings and summary — with no prose around it.",
      },
    ],
  });
  return response.content;
}

/**
 * UTF-8 bytes ÷ 4, except codepoints above U+2E80 at ÷ 1.5 — crude on
 * purpose, biased against underestimating CJK-heavy text, identical
 * everywhere it runs.
 *
 * @param {ChatMessage[]} messages
 * @returns {number}
 */
export function estimateTokens(messages) {
  let tokens = 0;
  const charge = (/** @type {string} */ text) => {
    for (const char of text) {
      const bytes = Buffer.byteLength(char, "utf8");
      tokens += /** @type {number} */ (char.codePointAt(0)) > 0x2e80 ? bytes / 1.5 : bytes / 4;
    }
  };
  for (const message of messages) {
    charge(message.content ?? "");
    if (message.role === "assistant" && message.toolCalls !== undefined) {
      // The wire carries these strings verbatim on the way back; an estimate
      // that cannot see them cannot protect the window they ride in.
      for (const call of message.toolCalls) charge(call.arguments);
    }
  }
  return Math.ceil(tokens);
}

/**
 * @param {Ledger} ledger
 * @param {PhaseName} phase
 * @returns {string}
 */
function renderState(ledger, phase) {
  /** @type {string[]} */
  const parts = [
    "[state inventory]",
    `reading turns used: ${String(ledger.readingTurns)}; tool calls made: ${String(ledger.toolCalls)}`,
    `current phase: ${phase}`,
  ];
  if (ledger.filesRead.length > 0) {
    // Display truncation only: the ledger entry keeps the full path; the
    // state message shows a bounded spelling so one long path cannot eat
    // the inventory.
    parts.push(
      `files read:\n- ${ledger.filesRead.map((entry) => entry.slice(0, 300)).join("\n- ")}`,
    );
  }
  if (ledger.diffInspected.length > 0) {
    parts.push(
      "inspected via their diff sections (deleted files; read_file cannot open them):\n- " +
        ledger.diffInspected.join("\n- "),
    );
  }
  if (ledger.searchesRun.length > 0) {
    parts.push(`searches run:\n- ${ledger.searchesRun.join("\n- ")}`);
  }
  if (ledger.toolErrors.length > 0) {
    parts.push(`tool errors seen (do not repeat them):\n- ${ledger.toolErrors.join("\n- ")}`);
  }
  parts.push("Earlier tool results were discarded to fit the window. Re-read anything you need.");
  return parts.join("\n\n");
}

/**
 * Answers one question for the caller: is this a well-formed read_file, and
 * what path did it name? The path is NOT recorded here — coverage counts
 * captures, and a capture exists only once the tool succeeded; `runLoop`
 * files the returned path on the success arm, the same condition under which
 * the tool recorded the bytes for the verification pass. Search queries are
 * inventory only, so they are still recorded here.
 *
 * @param {Ledger} ledger
 * @param {string} name
 * @param {string} argumentsJson
 * @returns {string | undefined} the named path when the call is a read_file with a string path
 */
function track(ledger, name, argumentsJson) {
  try {
    const args = /** @type {Record<string, unknown>} */ (JSON.parse(argumentsJson));
    if (name === "read_file" && typeof args["path"] === "string") {
      return String(args["path"]);
    } else if (name === "search" && typeof args["query"] === "string") {
      ledger.searchesRun.push(JSON.stringify(String(args["query"]).slice(0, 60)));
    }
  } catch {
    // Unparsable arguments are fatal upstream; nothing to record here.
  }
  return undefined;
}
