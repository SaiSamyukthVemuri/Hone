import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { ACKNOWLEDGEMENT, RAW_EVIDENCE, TRUSTED_FINDING, classifyEvidence, findingIdentity, isReply, partitionEvidence } from "../../scripts/eng/finding-identity.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { collectionEvidence, UNKNOWN } from "../../scripts/eng/evidence.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { projectInlineComment, projectIssueComment } from "../../scripts/eng/github-facts.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { reviewCompletionAtHead, summarize } from "../../scripts/eng/review-provenance.mjs";

// ===========================================================================
// CP-005b-1 acceptance: trusted finding identity.
// ===========================================================================
//
// THE CONTRACT:
//   a TRUSTED FINDING requires the trusted reviewer AND not being a reply;
//   anything else carrying finding-shaped markup is retained as RAW EVIDENCE,
//   attributed to its real author; and identity is keyed only on provenance
//   GitHub does not rewrite.
//
// It exists because of F4 on PR #616, accepted there as a known limitation and
// carried here as the mandatory first contract. F4 reproduced on live data
// during its own disposition: the reply written to RECORD the spoof scenario
// quoted the badge markup and was itself counted as a P1 authored by a human.
//
// This vehicle stores nothing. No OPEN/REPAIRED/VERIFIED, no ACCEPTED_RISK
// persistence, no repair round, no release readiness, no stop law, no merge.

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const CODEX = { login: "chatgpt-codex-connector[bot]", id: 199175422, type: "Bot" };
const HUMAN = { login: "ordinary-contributor", id: 12345678, type: "User" };
const LOOKALIKE = { login: "chatgpt-codex-connector[bot]", id: 99999999, type: "Bot" };

const badge = (t: string) =>
  `**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  ${t}**\n\nsome detail.`;

/** A projected inline comment, through the real projection. */
const comment = (over: Record<string, unknown> = {}) =>
  projectInlineComment({
    id: 1001,
    user: CODEX,
    commit_id: HEAD,
    original_commit_id: HEAD,
    path: "lib/x.ts",
    line: 42,
    original_line: 42,
    body: badge("A real finding"),
    ...over,
  });

const FIX = (pr: number) =>
  JSON.parse(readFileSync(path.resolve(__dirname, `fixtures/pr-${pr}.json`), "utf8"));

// ---------------------------------------------------------------------------
// THE MANDATORY F4 FIXTURE
// ---------------------------------------------------------------------------
describe("F4: the #616 spoof scenario, closed by construction", () => {
  const verdict = {
    id: 1,
    user: CODEX,
    body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `aaaaaaaaaa`",
  };
  const facts = (inline: unknown[]) => ({
    head: HEAD,
    issueComments: collectionEvidence([verdict].map(projectIssueComment), {}),
    reviews: collectionEvidence([], {}),
    inlineComments: collectionEvidence(inline, {}),
  });

  it("a trusted clean verdict stays COMPLETE_CLEAN despite an unauthorized badge comment", () => {
    const spoof = comment({ id: 2002, user: HUMAN, body: badge("Fabricated finding") });
    const r = reviewCompletionAtHead(facts([spoof]));
    expect(r.status).toBe("COMPLETE_CLEAN");
    expect(r.freshFindings).toHaveLength(0);
  });

  it("the spoof is retained and attributed to its real author, not to the reviewer", () => {
    const spoof = comment({ id: 2002, user: HUMAN, body: badge("Fabricated finding") });
    const r = reviewCompletionAtHead(facts([spoof]));
    expect(r.rawEvidence).toHaveLength(1);
    expect(r.rawEvidence[0].actor).toBe("ordinary-contributor");
    expect(r.rawEvidence[0].actorId).toBe(12345678);
    // Still visible, and its severity markup is preserved as observed text.
    expect(r.rawEvidence[0].severity).toBe("P1");
  });

  it("the spoof creates zero trusted finding records", () => {
    const spoof = comment({ id: 2002, user: HUMAN, body: badge("Fabricated finding") });
    expect(classifyEvidence(spoof).kind).toBe(RAW_EVIDENCE);
    expect(classifyEvidence(spoof).identity).toBeNull();
  });

  it("the LIVE instance from #616 is classified as raw evidence", () => {
    // Not synthetic: this is the disposition reply that reproduced F4 while
    // documenting it. Both guards reject it, and both say so.
    const s = summarize(FIX(616));
    const raw = s.findings.rawEvidence.find((e: { id: number }) => e.id === 3836338301);
    expect(raw).toBeDefined();
    expect(raw.actorId).toBe(26781116);
    expect(raw.reason).toMatch(/not the trusted reviewer/);
    expect(raw.reason).toMatch(/reply rather than a finding/);
  });
});

// ---------------------------------------------------------------------------
// THE TWO GUARDS, EACH INDEPENDENTLY LOAD-BEARING
// ---------------------------------------------------------------------------
describe("authority and reply-status are independent guards", () => {
  it("trusted reviewer, top-level, fully provenanced -> a trusted finding", () => {
    expect(classifyEvidence(comment()).kind).toBe(TRUSTED_FINDING);
  });

  it("an ordinary contributor copying the badge -> raw evidence", () => {
    expect(classifyEvidence(comment({ user: HUMAN })).kind).toBe(RAW_EVIDENCE);
  });

  it("a TRUSTED-author reply quoting the badge -> raw evidence, not a finding", () => {
    // Authority alone would admit this. It is the live F4 shape.
    const c = comment({ in_reply_to_id: 999 });
    expect(isReply(c)).toBe(true);
    const e = classifyEvidence(c);
    expect(e.kind).toBe(RAW_EVIDENCE);
    expect(e.reason).toMatch(/reply rather than a finding/);
  });

  it("an ordinary-contributor reply quoting the badge -> raw evidence, both reasons", () => {
    const e = classifyEvidence(comment({ user: HUMAN, in_reply_to_id: 999 }));
    expect(e.kind).toBe(RAW_EVIDENCE);
    expect(e.reason).toMatch(/not the trusted reviewer/);
    expect(e.reason).toMatch(/reply rather than a finding/);
  });

  it("a look-alike bot reusing the trusted login but a different id -> raw evidence", () => {
    // The login is copyable; the numeric account id is not.
    const e = classifyEvidence(comment({ user: LOOKALIKE }));
    expect(e.kind).toBe(RAW_EVIDENCE);
    expect(e.actorId).toBe(99999999);
  });

  it("neither guard alone is sufficient", () => {
    // Removing either one admits something it must not.
    const trustedReply = comment({ in_reply_to_id: 5 });
    const strangerTopLevel = comment({ user: HUMAN });
    expect(classifyEvidence(trustedReply).kind).toBe(RAW_EVIDENCE); // reply guard
    expect(classifyEvidence(strangerTopLevel).kind).toBe(RAW_EVIDENCE); // authority guard
    expect(classifyEvidence(comment()).kind).toBe(TRUSTED_FINDING); // both pass
  });

  it("a comment with no severity markup is an acknowledgement, never raw evidence", () => {
    const e = classifyEvidence(comment({ body: "Fixed on the current head, thanks." }));
    expect(e.kind).toBe(ACKNOWLEDGEMENT);
  });
});

// ---------------------------------------------------------------------------
// IDENTITY STABILITY
// ---------------------------------------------------------------------------
describe("identity is keyed only on provenance GitHub does not rewrite", () => {
  const original = comment();
  const baseline = findingIdentity(original).key;

  it("a trusted finding has a stable, self-describing key", () => {
    expect(baseline).not.toBe(UNKNOWN);
    expect(baseline).toContain("1001");
    expect(baseline).toContain(HEAD);
    expect(baseline).toContain("lib/x.ts");
  });

  it("re-anchoring onto a later head does not change identity", () => {
    // GitHub moves the DISPLAY commit forward; the raised-at sha does not move.
    const reAnchored = comment({ commit_id: OTHER_HEAD });
    expect(findingIdentity(reAnchored).key).toBe(baseline);
  });

  it("the current line becoming null does not change identity", () => {
    // 8 of 11 findings on PR #610 are in exactly this state.
    const outdated = comment({ line: null });
    expect(findingIdentity(outdated).key).toBe(baseline);
  });

  it("the current line being REWRITTEN does not change identity", () => {
    // Measured on PR #610 comment 3825368031: line 552, original_line 407.
    const moved = comment({ line: 552 });
    expect(findingIdentity(moved).key).toBe(baseline);
  });

  it("position being rewritten does not change identity", () => {
    const repositioned = comment({ position: 552, original_position: 407 });
    expect(findingIdentity(repositioned).key).toBe(baseline);
  });

  it("all four mutations at once still yield the same identity", () => {
    const churned = comment({ commit_id: OTHER_HEAD, line: null, position: 900, original_position: 42 });
    expect(findingIdentity(churned).key).toBe(baseline);
  });

  it("the key contains no mutable field", () => {
    // A key that embedded the display commit or the current line would give one
    // finding several identities over its life.
    expect(baseline).not.toContain(OTHER_HEAD);
    expect(findingIdentity(comment({ line: 552 })).key).not.toContain("552");
  });

  it("same-looking text in two distinct objects yields distinct identities", () => {
    const a = comment({ id: 1 });
    const b = comment({ id: 2 });
    expect(findingIdentity(a).key).not.toBe(findingIdentity(b).key);
  });

  it("the same finding at a different path or original line is a different identity", () => {
    expect(findingIdentity(comment({ path: "lib/y.ts" })).key).not.toBe(baseline);
    expect(findingIdentity(comment({ original_line: 43 })).key).not.toBe(baseline);
  });
});

describe("unnameable TRUSTED evidence must never be papered over by a clean verdict", () => {
  // The dangerous inverse of F4, found at exact head on #617. A trusted,
  // top-level, finding-shaped comment that cannot be NAMED (a file-level
  // comment has no original_line) was dropped as raw evidence, and a trusted
  // clean verdict for the same head then reported COMPLETE_CLEAN over the top
  // of a real reviewer finding. Incomplete evidence must never manufacture a
  // positive clean fact.
  const verdict = {
    id: 1,
    user: CODEX,
    body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `aaaaaaaaaa`",
  };
  const withInline = (inline: unknown[]) => ({
    head: HEAD,
    issueComments: collectionEvidence([verdict].map(projectIssueComment), {}),
    reviews: collectionEvidence([], {}),
    inlineComments: collectionEvidence(inline, {}),
  });

  it("a trusted FILE-LEVEL finding blocks clean instead of vanishing", () => {
    const fileLevel = comment({ id: 7, line: null, original_line: null, subject_type: "file" });
    const r = reviewCompletionAtHead(withInline([fileLevel]));
    expect(r.status).toBe(UNKNOWN);
    expect(r.status).not.toBe("COMPLETE_CLEAN");
    expect(r.reason).toMatch(/lack stable provenance/);
    expect(r.unnameableAtHead).toHaveLength(1);
  });

  it("it is still not a trusted FINDING - it cannot be tracked", () => {
    const fileLevel = comment({ id: 7, line: null, original_line: null });
    const e = classifyEvidence(fileLevel);
    expect(e.kind).toBe(RAW_EVIDENCE);
    expect(e.trustedButUnidentified).toBe(true);
    expect(reviewCompletionAtHead(withInline([fileLevel])).freshFindings).toHaveLength(0);
  });

  it("the spoof and reply behaviour is PRESERVED - they still do not block clean", () => {
    // Only evidence rejected SOLELY for incomplete identity blocks clean.
    const spoof = comment({ id: 8, user: HUMAN });
    const trustedReply = comment({ id: 9, in_reply_to_id: 1 });
    const strangerReply = comment({ id: 10, user: HUMAN, in_reply_to_id: 1 });
    for (const c of [spoof, trustedReply, strangerReply]) {
      expect(classifyEvidence(c).trustedButUnidentified).toBeFalsy();
      expect(reviewCompletionAtHead(withInline([c])).status).toBe("COMPLETE_CLEAN");
    }
  });

  it("a clean head with no inline evidence is still clean", () => {
    expect(reviewCompletionAtHead(withInline([])).status).toBe("COMPLETE_CLEAN");
  });

  it("each missing provenance field blocks clean, not just original_line", () => {
    for (const over of [{ original_commit_id: null }, { path: null }, { original_line: null }]) {
      const r = reviewCompletionAtHead(withInline([comment({ id: 11, ...over })]));
      expect(r.status).not.toBe("COMPLETE_CLEAN");
    }
  });
});

describe("identity is never invented", () => {
  it("missing stable provenance yields UNKNOWN, naming what is absent", () => {
    for (const [field, over] of [
      ["originalCommitId", { original_commit_id: null }],
      ["path", { path: null }],
      ["originalLine", { original_line: null }],
    ] as [string, Record<string, unknown>][]) {
      const r = findingIdentity(comment(over));
      expect(r.key).toBe(UNKNOWN);
      expect(r.reason).toContain(field);
    }
  });

  it("a trusted, non-reply comment that cannot be named is NOT a finding", () => {
    // Trusted and top-level, but unnameable. A record that cannot be identified
    // cannot be tracked monotonically, so it stays raw evidence.
    const e = classifyEvidence(comment({ original_line: null }));
    expect(e.kind).toBe(RAW_EVIDENCE);
    expect(e.identity.key).toBe(UNKNOWN);
    expect(e.reason).toContain("originalLine");
  });
});

// ---------------------------------------------------------------------------
// REAL HISTORIES
// ---------------------------------------------------------------------------
describe("real fixture histories", () => {
  it("#610's eleven trusted findings all key uniquely and stably", () => {
    const { findings, rawEvidence } = partitionEvidence(FIX(610).inlineComments.value);
    expect(findings).toHaveLength(11);
    expect(rawEvidence).toHaveLength(0);
    const keys = findings.map((f: { identity: { key: string } }) => f.identity.key);
    expect(new Set(keys).size).toBe(11);
    // Six of these are re-anchored; none of their keys mentions a display head.
    expect(keys.every((k: string) => k.startsWith("gh:"))).toBe(true);
  });

  it("#612's twenty-nine findings are all trusted and uniquely keyed", () => {
    const { findings } = partitionEvidence(FIX(612).inlineComments.value);
    expect(findings).toHaveLength(29);
    expect(new Set(findings.map((f: { identity: { key: string } }) => f.identity.key)).size).toBe(29);
  });

  it("across every fixture, no trusted finding comes from an untrusted actor", () => {
    for (const pr of [610, 612, 613, 615, 616]) {
      const { findings } = partitionEvidence(FIX(pr).inlineComments.value);
      for (const f of findings) {
        expect(f.actorId).toBe(199175422);
        expect(f.isReply).toBe(false);
        expect(f.identity.key).not.toBe(UNKNOWN);
      }
    }
  });

  it("gating changes the count on #616 and nowhere it should not", () => {
    // #616 carries the live F4 instance; the others do not, so their counts are
    // unchanged by the gate. That is what makes this a targeted fix.
    const counts = [610, 612, 613, 615, 616].map((pr) => {
      const p = partitionEvidence(FIX(pr).inlineComments.value);
      return { pr, findings: p.findings.length, raw: p.rawEvidence.length };
    });
    expect(counts.find((c) => c.pr === 616)!.raw).toBe(1);
    for (const pr of [610, 612, 613, 615]) {
      expect(counts.find((c) => c.pr === pr)!.raw).toBe(0);
    }
  });
});
