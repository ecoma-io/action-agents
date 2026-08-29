// Hostile tool-output and completion bytes — the control-byte surface.
//
// A hostile provider or model can smuggle NUL (`\u0000`) and other control
// bytes into the bytes that flow back from the seam: a completion `content`
// string, an argument, a file path pulled off disk. Control bytes are log-
// forgery and severity-spoofing material — a NUL or ESC embedded in a
// summary can corrupt how the run's output is rendered or archived. The
// question each assertion pins is where the *real* bound lives, because the
// forbid seam does NOT catch every hostile byte:
//
//   - `core/src/forge.mjs`'s `decodeBase64` decodes with
//     `new TextDecoder("utf-8", { fatal: true })`. That refuses bytes that
//     are not valid UTF-8, but a NUL is *legal* UTF-8, so the fatal decoder
//     does not refuse it. Pinned below, honestly: the decode seam's ceiling
//     is UTF-8 validity, not "no control bytes".
//   - `core/src/chat.mjs` returns the provider's `content` raw (per its own
//     contract: "the provider's answer is returned raw otherwise"). A NUL
//     inside a completion round-trips verbatim. The bound against hostile
//     bytes therefore does NOT live in the chat seam — it lives at the
//     text-writing surfaces downstream.
//
// What DOES bound control bytes is documented in the code and pinned here:
//
//   - `core/src/workspace.mjs` (`resolve`) refuses any path carrying a NUL
//     byte as a typed `WorkspaceRefusal` ("contains a NUL byte") — a hostile
//     tool argument naming a path can never reach the filesystem with a NUL.
//   - `core/src/one-line.mjs` (`oneLine`, option `stripControlChars`) maps
//     control characters (code <= 0x1F or 0x7F) to spaces before collapsing —
//     the rule the log-summary call sites use, so a summary line can never
//     carry a live control byte to a log.
//
// So the fixture asserts: the NUL content is either refused or sanitised by
// the seam that WRITES text, never passed through as if clean trusted text —
// and where the code genuinely lets it pass (the chat seam's verbatim
// content), the test says so and pins the real downstream bound instead.
//
// Deterministic and offline: the provider is a scripted fetch, paths are
// resolved against a throwaway temp dir, and no model or network is touched.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as p from "node:path";
import { describe, it } from "node:test";

import { createChat } from "#core/chat.mjs";
import { createWorkspace, WorkspaceRefusal } from "#core/workspace.mjs";
import { oneLine } from "#core/one-line.mjs";

/**
 * A provider that answers every chat-completions call with a fixed content
 * string, so the fixture can decide byte-for-byte what the seam carries.
 *
 * @param {string} content
 * @returns {{ chat: ReturnType<typeof createChat> }}
 */
function chatWithContent(content) {
  const fetchImpl = /** @type {typeof globalThis.fetch} */ (
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
  );
  const chat = createChat({
    apiUrl: "https://api.example/v1",
    apiKey: "sk-secret",
    fetchImpl,
    maxAttempts: 1,
  });
  return { chat };
}

describe("control-byte content — what the seams refuse and what they let pass", () => {
  it("a NUL in a completion content string round-trips verbatim through the chat seam (its real, documented bound)", async () => {
    // `chat.complete` is the provider's answer "returned raw otherwise" — the
    // chat seam's only ceiling is wire shape, not byte content. A hostile
    // model can place a NUL in its answer and it arrives unchanged. The bound
    // against that byte is NOT here; it is the workspace and log surfaces
    // below, pinned next.
    const { chat } = chatWithContent("a\u0000b");
    const result = await chat.complete({
      model: "gpt-4",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(result.content, "a\u0000b", "the chat seam hands the content through verbatim");
  });

  it("a NUL in a file path is refused as a typed WorkspaceRefusal, never resolved to disk", async () => {
    const root = mkdtempSync(p.join(tmpdir(), "control-byte-"));
    try {
      mkdirSync(p.join(root, "src"));
      const workspace = createWorkspace({ root });
      assert.throws(
        () => workspace.resolve("src/a\u0000b.mjs"),
        (error) => {
          assert.ok(error instanceof WorkspaceRefusal, "the NUL path is refused, typed");
          assert.match(error.message, /contains a NUL byte/, "the refusal names the NUL");
          return true;
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("control characters in a log summary are stripped to spaces by one-line", async () => {
    // The `stripControlChars` rule maps code <= 0x1F and 0x7F to a space
    // before the whitespace collapse — the harmonise log-summary surface.
    // NUL, ESC, BEL and a tab all become the same neutral space; the result
    // carries no live control byte to a log.
    assert.equal(oneLine("a\u0000b\u001bc\u0007d\te", { stripControlChars: true }), "a b c d e");
    assert.equal(
      oneLine("clean\u0000with\u001b\u007fbytes", { stripControlChars: true }),
      "clean with bytes",
    );
  });

  it("the strip is opt-in: without stripControlChars a control run is collapsed but a lone NUL is not a space", async () => {
    // The contrast is the bound's shape: default one-line collapses
    // whitespace but leaves control bytes untouched; the surface that treats
    // control bytes as forgery material turns it on explicitly. A call site
    // that forgets the option does NOT silently gain sanitisation.
    assert.equal(oneLine("a\u0000b"), "a\u0000b", "default one-line keeps the NUL");
  });

  it("the fatal UTF-8 decode refuses invalid bytes but NOT a legal NUL — so the NUL bound lives downstream", async () => {
    // This mirrors core/src/forge.mjs's decodeBase64 exactly:
    // `new TextDecoder("utf-8", { fatal: true })`. A byte that is not valid
    // UTF-8 (0xFF) is refused; a NUL is legal UTF-8 and decodes cleanly, so
    // the decode seam's ceiling is UTF-8 validity — which is why the
    // workspace and one-line surfaces, not the decoder, are the NUL's bound.
    const decoder = new TextDecoder("utf-8", { fatal: true });
    assert.equal(decoder.decode(Buffer.from("AA==", "base64")), "\u0000", "a NUL decodes cleanly");
    assert.throws(
      () => decoder.decode(Buffer.from([0xff])),
      TypeError,
      "invalid UTF-8 is refused by the fatal decoder",
    );
  });
});
