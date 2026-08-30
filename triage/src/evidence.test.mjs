// Tests for the Evidence layer — the deterministic facts a decision may rest
// on, packaged apart from the untrusted semantic content (the thread's title
// and body). This module only packages what the orchestrator read; the point
// pinned here is that nothing is dropped or relabelled, and that the two
// untrusted fields stay on the thread, never promoted to facts.

import { describe, expect, it } from "vitest";

import { gatherEvidence } from "./evidence.mjs";

describe("gatherEvidence", () => {
  /** @type {import("./evidence.mjs").ThreadEvidence} */
  const thread = {
    type: "issue",
    number: 7,
    title: "Import fails",
    body: "Steps to reproduce.",
    labels: ["triage"],
    createdAt: "2026-01-02T03:04:05Z",
    creator: "someauthor",
    state: "open",
  };

  it("exposes the trusted thread facts and defaults absent ones", () => {
    const { createdAt: _createdAt, creator: _creator, state: _state, ...bare } = thread;
    void _createdAt;
    void _creator;
    void _state;
    const evidence = gatherEvidence({
      thread: bare,
      repository: { name: "repo", description: "d" },
      config: null,
      sheet: null,
      metadata: new Map(),
      files: [],
      size: null,
      eventAction: "opened",
    });
    expect(evidence.thread.createdAt).toBe("");
    expect(evidence.thread.creator).toBe("");
    expect(evidence.thread.state).toBe("");
  });

  it("packages the thread, repository, sheet, metadata, files and event action", () => {
    const sheet = new Map([["bug", "a bug"]]);
    const files = [{ filename: "a.mjs", status: "modified", additions: 1, deletions: 2 }];
    const metadata = new Map([["bug", { name: "bug", description: "a bug", color: "blue" }]]);
    const evidence = gatherEvidence({
      thread,
      repository: { name: "repo", description: "d" },
      config: null,
      sheet,
      metadata,
      files,
      size: null,
      eventAction: "opened",
    });
    expect(evidence.thread).toEqual(thread);
    expect(evidence.repository).toEqual({ name: "repo", description: "d" });
    expect(evidence.policy).toBeNull();
    expect(evidence.sheet).toBe(sheet);
    expect(evidence.labelMetadata).toBe(metadata);
    expect(evidence.files).toBe(files);
    expect(evidence.measuredSize).toBeNull();
    expect(evidence.quality).toBeNull();
    expect(evidence.forgeSearch).toBeNull();
    expect(evidence.eventAction).toBe("opened");
  });

  it("passes quality and forge search facts through when present", () => {
    const quality = {
      template: null,
      fieldsPresent: [],
      missingRequired: [],
      bodyLength: 1,
      urlCount: 0,
      templatesOverflow: false,
    };
    const forgeSearch = { candidates: [], totalCount: 0, cappedAt: 5 };
    const evidence = gatherEvidence({
      thread,
      repository: { name: "repo", description: "d" },
      config: null,
      sheet: null,
      metadata: new Map(),
      files: [],
      size: null,
      quality,
      forgeSearch,
      eventAction: "opened",
    });
    expect(evidence.quality).toBe(quality);
    expect(evidence.forgeSearch).toBe(forgeSearch);
  });

  it("packages the thread, repository, sheet, metadata, files and event action", () => {
    const sheet = new Map([["bug", "a bug"]]);
    const files = [{ filename: "a.mjs", status: "modified", additions: 1, deletions: 2 }];
    const metadata = new Map([["bug", { name: "bug", description: "a bug", color: "blue" }]]);
    const evidence = gatherEvidence({
      thread,
      repository: { name: "repo", description: "d" },
      config: null,
      sheet,
      metadata,
      files,
      size: null,
      eventAction: "opened",
    });
    expect(evidence.thread).toEqual(thread);
    expect(evidence.repository).toEqual({ name: "repo", description: "d" });
    expect(evidence.policy).toBeNull();
    expect(evidence.sheet).toBe(sheet);
    expect(evidence.labelMetadata).toBe(metadata);
    expect(evidence.files).toBe(files);
    expect(evidence.measuredSize).toBeNull();
    expect(evidence.eventAction).toBe("opened");
  });

  it("keeps title and body as thread content — never promoted to facts", () => {
    const evidence = gatherEvidence({
      thread,
      repository: { name: "repo", description: "d" },
      config: null,
      sheet: null,
      metadata: new Map(),
      files: [],
      size: null,
      eventAction: "opened",
    });
    // The evidence object has exactly the packaged shape: thread (with the
    // unscoped title/body inside), and no top-level title/body that a
    // consumer could mistake for a fact.
    expect("title" in evidence).toBe(false);
    expect("body" in evidence).toBe(false);
    expect(evidence.thread.title).toBe("Import fails");
    expect(evidence.thread.body).toBe("Steps to reproduce.");
  });

  it("passes a measured size through when present", () => {
    const size = { counted: 42, excluded: 7, files: 3, label: "size/s" };
    const evidence = gatherEvidence({
      thread,
      repository: { name: "repo", description: "d" },
      config: null,
      sheet: null,
      metadata: new Map(),
      files: [],
      size,
      eventAction: "synchronize",
    });
    expect(evidence.measuredSize).toBe(size);
    expect(evidence.eventAction).toBe("synchronize");
  });

  it("defaults an absent event action to an empty string rather than undefined", () => {
    const evidence = gatherEvidence({
      thread,
      repository: { name: "repo", description: "d" },
      config: null,
      sheet: null,
      metadata: new Map(),
      files: [],
      size: null,
      eventAction: "",
    });
    expect(evidence.eventAction).toBe("");
  });

  it("packages the PR-side deterministic facts when the reads are available", () => {
    /** @type {import("./evidence.mjs").PrEvidence} */
    const pr = {
      state: "open",
      draft: true,
      merged: false,
      mergeable: null,
      hasConflicts: false,
      base: { ref: "main", sha: "ffff0000ffff0000111122223333444455556666" },
      head: { ref: "feature", sha: "aaaabbbbccccdddd000011112222333344445555" },
      body: "",
      checks: { total: 2, byConclusion: { success: 1, pending: 1 } },
      reviewRequested: ["alice"],
      reviews: [{ state: "APPROVED", count: 1 }],
    };
    const evidence = gatherEvidence({
      thread: { ...thread, type: "pr" },
      repository: { name: "repo", description: "d" },
      config: null,
      sheet: null,
      metadata: new Map(),
      files: [],
      size: null,
      eventAction: "opened",
      pr,
    });
    expect(evidence.pr).toEqual(pr);
  });

  it("defaults an absent PR read to null — an issue never carries pr facts", () => {
    const evidence = gatherEvidence({
      thread,
      repository: { name: "repo", description: "d" },
      config: null,
      sheet: null,
      metadata: new Map(),
      files: [],
      size: null,
      eventAction: "opened",
    });
    expect(evidence.pr).toBeNull();
  });
});
