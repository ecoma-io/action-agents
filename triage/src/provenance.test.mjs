// Tests for classification provenance — the read path that lets a later run
// prove which labels THIS action applied, from the record block embedded in
// its own marker comment. The block is evidence, never instruction: only the
// token's own login counts as authorship, malformed blocks are ignored, and
// any identity or listing read that cannot be resolved leaves provenance
// null — the caller must then refuse, never replace.
import { describe, expect, it } from "vitest";

import { extractRecordBlock, readClassificationProvenance, recordBlock } from "./provenance.mjs";

describe("recordBlock / extractRecordBlock", () => {
  it("round-trips the applied labels", () => {
    const body = recordBlock(["bug", "size/xs"]);
    expect(extractRecordBlock(`context\n\n${body}\n\nfooter`)).toEqual({
      schemaVersion: 1,
      applied: ["bug", "size/xs"],
    });
  });

  it("ignores anything that is not a well-formed record block", () => {
    expect(extractRecordBlock("no block here")).toBeNull();
    expect(extractRecordBlock("action-agents-record:triage:not base64!")).toBeNull();
    expect(
      extractRecordBlock(
        `action-agents-record:triage:${Buffer.from(
          JSON.stringify({ schemaVersion: 2, applied: ["bug"] }),
          "utf8",
        ).toString("base64")}`,
      ),
    ).toBeNull();
    expect(
      extractRecordBlock(
        `action-agents-record:triage:${Buffer.from(
          JSON.stringify({ schemaVersion: 1, applied: "bug" }),
          "utf8",
        ).toString("base64")}`,
      ),
    ).toBeNull();
    expect(
      extractRecordBlock(
        `action-agents-record:triage:${Buffer.from(
          JSON.stringify({ schemaVersion: 1, applied: [42] }),
          "utf8",
        ).toString("base64")}`,
      ),
    ).toBeNull();
  });
});

describe("readClassificationProvenance", () => {
  /**
   * @param {{ login: string, body: string }[]} comments
   * @param {string} [login]
   */
  const forgeWith = (comments, login = "action-agents[bot]") => ({
    /** @returns {Promise<{ login: string }>} */
    whoami: async () => ({ login }),
    /**
     * @param {number} issueNumber
     * @returns {Promise<{ id: number, user: { login: string }, body: string }[]>}
     */
    listComments: async (issueNumber) =>
      comments.map((comment, index) => ({
        id: index + 1 + issueNumber,
        user: { login: comment.login },
        body: comment.body,
      })),
  });

  it("unions the applied labels across the action's own comments", async () => {
    const provenance = await readClassificationProvenance(
      forgeWith([
        {
          login: "action-agents[bot]",
          body: `<!-- action-agents:triage:a1b2c3 -->\n\n${recordBlock(["bug"])}`,
        },
        {
          login: "action-agents[bot]",
          body: `<!-- action-agents:triage:d4e5f6 -->\n\n${recordBlock(["docs"])}`,
        },
      ]),
      7,
    );
    expect(provenance).toEqual(new Set(["bug", "docs"]));
  });

  it("ignores a record block authored by any other login", async () => {
    const provenance = await readClassificationProvenance(
      forgeWith([{ login: "octocat", body: recordBlock(["bug"]) }]),
      7,
    );
    expect(provenance).toEqual(new Set());
  });

  it("ignores an own-authored comment that carries no classification marker", async () => {
    const provenance = await readClassificationProvenance(
      forgeWith([{ login: "action-agents[bot]", body: recordBlock(["bug"]) }]),
      7,
    );
    expect(provenance).toEqual(new Set());
  });

  it("leaves provenance null when the token's identity cannot be resolved", async () => {
    const provenance = await readClassificationProvenance(
      {
        whoami: async () => {
          throw new Error("rate limited");
        },
        listComments: async () => [],
      },
      7,
    );
    expect(provenance).toBeNull();
  });

  it("leaves provenance null when the comment listing cannot be read", async () => {
    const provenance = await readClassificationProvenance(
      {
        whoami: async () => ({ login: "action-agents[bot]" }),
        listComments: async () => {
          throw new Error("boom");
        },
      },
      7,
    );
    expect(provenance).toBeNull();
  });
});
