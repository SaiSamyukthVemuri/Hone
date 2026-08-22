import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { AUTHORIZED, COMPLETE, POSITIVE, PROVEN_NEGATIVE, UNAUTHORIZED, UNKNOWN, collectionEvidence, evidenceCertainty, sourceField } from "../../scripts/eng/evidence.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { flattenCheckRunPages, projectInlineComment, projectIssueComment } from "../../scripts/eng/github-facts.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { PROVEN_REPLY, PROVEN_TOP_LEVEL, RAW_EVIDENCE, TRUSTED_FINDING, classifyEvidence, replyCertainty } from "../../scripts/eng/finding-identity.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { ciAtHead, reviewCompletionAtHead } from "../../scripts/eng/review-provenance.mjs";

// ===========================================================================
// CP-005 FOUNDATION: the evidence-certainty pipeline.
// ===========================================================================
//
// THE LAW UNDER TEST:
//   UNKNOWN never proves absence, and never permits a positive CLEAN / GREEN /
//   TRUSTED state. PROVEN_NEGATIVE is different from UNKNOWN.
//
// A retired vehicle (#617) shipped the same defect family four times, one
// review round apart: unknown identity, unknown finding authority, unknown
// verdict authority, and - the root - a projection that normalized an ABSENT
// property into a proven `null`. This suite exists to make that family
// impossible rather than to catch its instances.
//
// TEST LAW: every case enters through a RAW GitHub-shaped object and the
// PRODUCTION projection. Building a projected object and deleting a property
// afterwards is forbidden - it proves the production path handles a shape it
// may never actually produce, which is exactly how #617 certified a branch it
// could not reach.

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const CODEX = { login: "chatgpt-codex-connector[bot]", id: 199175422, type: "Bot" };
const HUMAN = { login: "ordinary-contributor", id: 12345678, type: "User" };
const BADGE = "**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange)</sub></sub>  A finding**\n\ndetail.";

/**
 * RAW review-comment shape, matching what GitHub actually returns for a
 * TOP-LEVEL comment: `in_reply_to_id` is OMITTED, not null. Overrides land on
 * the RAW object, never after projection.
 */
const rawFinding = (over: Record<string, unknown> = {}) => ({
  id: 9, pull_request_review_id: 77, user: CODEX, commit_id: HEAD, original_commit_id: HEAD,
  path: "lib/x.ts", line: 3, original_line: 3, body: BADGE, ...over,
});
/** Remove a property from a RAW object, so the projection genuinely sees absence. */
const omit = (o: Record<string, unknown>, k: string) => { const c = { ...o }; delete c[k]; return c; };

const rawVerdict = (over: Record<string, unknown> = {}) => ({
  id: 1, user: CODEX,
  body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `aaaaaaaaaa`", ...over,
});

const statusOf = (issues: Record<string, unknown>[], inline: Record<string, unknown>[] = []) =>
  reviewCompletionAtHead({
    head: HEAD,
    issueComments: collectionEvidence(issues.map(projectIssueComment), {}),
    reviews: collectionEvidence([], {}),
    inlineComments: collectionEvidence(inline.map(projectInlineComment), {}),
  }).status;

const classifyRaw = (raw: Record<string, unknown>) => classifyEvidence(projectInlineComment(raw));

// ---------------------------------------------------------------------------
// THE FOUNDATION: absence survives ingestion
// ---------------------------------------------------------------------------
describe("raw absence is preserved end to end", () => {
  it("sourceField separates ABSENT from PRESENT-with-null", () => {
    expect(sourceField({}, "x")).toBe(UNKNOWN);
    expect(sourceField({ x: null }, "x")).toBeNull();
    expect(sourceField({ x: 7 }, "x")).toBe(7);
  });

  it("the PRODUCTION projection preserves raw presence AND applies the contract", () => {
    // The raw presence is still preserved verbatim...
    expect(projectInlineComment(rawFinding({ in_reply_to_id: 5 })).inReplyToId).toBe(5);
    expect(projectInlineComment(rawFinding()).inReplyToId).toBe(UNKNOWN);
    // ...and the declared contract turns that into a reply status.
    expect(projectInlineComment(rawFinding({ in_reply_to_id: 5 })).replyStatus).toBe(PROVEN_REPLY);
    expect(projectInlineComment(rawFinding()).replyStatus).toBe(PROVEN_TOP_LEVEL);
  });

  it("all states survive a JSON fixture round-trip", () => {
    // `undefined` would be erased here, which is why the sentinel is a string.
    for (const raw of [rawFinding({ in_reply_to_id: 5 }), rawFinding()]) {
      const projected = projectInlineComment(raw);
      const roundTripped = JSON.parse(JSON.stringify(projected));
      expect(roundTripped.inReplyToId).toEqual(projected.inReplyToId);
      expect(roundTripped.replyStatus).toEqual(projected.replyStatus);
      expect(replyCertainty(roundTripped)).toBe(replyCertainty(projected));
    }
  });

  it("reply certainty reads the projected status, and never re-derives it", () => {
    expect(replyCertainty(projectInlineComment(rawFinding({ in_reply_to_id: 5 })))).toBe(PROVEN_REPLY);
    expect(replyCertainty(projectInlineComment(rawFinding()))).toBe(PROVEN_TOP_LEVEL);
    expect(replyCertainty({})).toBe(UNKNOWN);
  });

  it("an absent actor is UNKNOWN, never UNAUTHORIZED", () => {
    // "We cannot tell who wrote this" is not "someone untrusted wrote this".
    const projected = projectInlineComment(omit(rawFinding(), "user"));
    expect(projected.authorId).toBe(UNKNOWN);
    expect(classifyEvidence(projected).authority).toBe(UNKNOWN);
    expect(classifyEvidence(projected).authority).not.toBe(UNAUTHORIZED);
  });

  it("ANTI-PATTERN GUARD: source-absence cases must go through the projector", () => {
    // #617 tested absence by deleting a property AFTER projection, certifying a
    // branch production could never reach. Here the raw object omits the field
    // and the projection itself must produce UNKNOWN.
    const raw = rawFinding();
    expect("in_reply_to_id" in raw).toBe(false);
    const projected = projectInlineComment(raw);
    expect("inReplyToId" in projected).toBe(true);
    expect(projected.inReplyToId).toBe(UNKNOWN);
    // And the post-projection shortcut must NOT be what makes the case pass:
    // a projected object with the key deleted is a shape production cannot emit.
    const fabricated = projectInlineComment(rawFinding());
    delete (fabricated as Record<string, unknown>).inReplyToId;
    expect(fabricated.inReplyToId).toBeUndefined();
    expect(projected.inReplyToId).not.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// THE ONE AUTHORITY
// ---------------------------------------------------------------------------
describe("one certainty authority", () => {
  it("splits NOT-POSITIVE into PROVEN_NEGATIVE and UNKNOWN", () => {
    expect(evidenceCertainty({ completeness: COMPLETE, authority: AUTHORIZED })).toBe(POSITIVE);
    expect(evidenceCertainty({ completeness: COMPLETE, authority: UNAUTHORIZED })).toBe(PROVEN_NEGATIVE);
    expect(evidenceCertainty({ completeness: COMPLETE, authority: UNKNOWN })).toBe(UNKNOWN);
    expect(evidenceCertainty({ completeness: UNKNOWN, authority: AUTHORIZED })).toBe(UNKNOWN);
    expect(evidenceCertainty({ completeness: COMPLETE, authority: AUTHORIZED }, { provenNegative: true })).toBe(PROVEN_NEGATIVE);
  });

  it("ARCHITECTURE GUARD: no surface interprets the vocabulary itself", () => {
    // Small and readable on purpose: it greps the consuming modules for a
    // re-derivation of the gate, nothing more.
    const read = (f: string) => readFileSync(path.resolve(__dirname, "../../scripts/eng", f), "utf8")
      .replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    for (const f of ["review-provenance.mjs", "finding-identity.mjs"]) {
      const code = read(f);
      expect(code).toMatch(/evidenceCertainty\(/);
      expect(code).not.toMatch(/completeness === COMPLETE\s*&&/);
      expect(code).not.toMatch(/mayAssertPositive\(/);
    }
    // Only evidence.mjs may define the rule.
    expect(read("evidence.mjs")).toMatch(/export function evidenceCertainty/);
  });
});

// ---------------------------------------------------------------------------
// THE REQUIRED ACCEPTANCE MATRIX - all raw-sourced
// ---------------------------------------------------------------------------
describe("the required acceptance matrix", () => {
  it("1. complete authorized clean verdict -> CLEAN", () => {
    expect(statusOf([rawVerdict()])).toBe("COMPLETE_CLEAN");
  });

  it("2. unauthorized verdict spoof -> nonblocking", () => {
    expect(statusOf([rawVerdict(), rawVerdict({ id: 2, user: HUMAN })])).toBe("COMPLETE_CLEAN");
  });

  it("2b. an unauthorized spoof verdict ALONE never produces CLEAN", () => {
    // Without this, a verdict surface that skipped the authority would let a
    // stranger's clean-looking comment stand as the verdict for the head.
    const s = statusOf([rawVerdict({ id: 2, user: HUMAN })]);
    expect(s).not.toBe("COMPLETE_CLEAN");
    expect(s).toBe(UNKNOWN);
  });

  it("3. verdict actor ABSENT -> UNKNOWN, never CLEAN", () => {
    const s = statusOf([rawVerdict(), omit(rawVerdict({ id: 3 }), "user")]);
    expect(s).toBe(UNKNOWN);
    expect(s).not.toBe("COMPLETE_CLEAN");
  });

  it("4. trusted complete finding -> TRUSTED_FINDING", () => {
    expect(classifyRaw(rawFinding()).kind).toBe(TRUSTED_FINDING);
    expect(classifyRaw(rawFinding()).certainty).toBe(POSITIVE);
    expect(statusOf([rawVerdict()], [rawFinding()])).toBe("COMPLETE_WITH_FINDINGS");
  });

  it("5. unauthorized badge spoof -> raw evidence, nonblocking", () => {
    const e = classifyRaw(rawFinding({ user: HUMAN }));
    expect(e.kind).toBe(RAW_EVIDENCE);
    expect(e.certainty).toBe(PROVEN_NEGATIVE);
    expect(e.actorId).toBe(12345678);
    expect(statusOf([rawVerdict()], [rawFinding({ user: HUMAN })])).toBe("COMPLETE_CLEAN");
  });

  it("6. proven reply -> proven non-finding, nonblocking", () => {
    const e = classifyRaw(rawFinding({ in_reply_to_id: 1 }));
    expect(e.kind).toBe(RAW_EVIDENCE);
    expect(e.certainty).toBe(PROVEN_NEGATIVE);
    expect(statusOf([rawVerdict()], [rawFinding({ in_reply_to_id: 1 })])).toBe("COMPLETE_CLEAN");
  });

  it("7A. real GitHub top-level semantics: absent in_reply_to_id is PROVEN top-level", () => {
    // GitHub OMITS this property on top-level review comments. Censused at 97
    // comments across #610/#612/#613/#615/#616: 52 key-absent (all top-level),
    // 45 key-present (all with a real id), and PRESENT+null never once. So for
    // this field omission is the semantic value, and a real Codex finding must
    // stay recognized rather than becoming UNKNOWN because of it.
    const raw = rawFinding();
    expect("in_reply_to_id" in raw).toBe(false);
    const projected = projectInlineComment(raw);
    expect(projected.replyStatus).toBe(PROVEN_TOP_LEVEL);
    expect(classifyEvidence(projected).kind).toBe(TRUSTED_FINDING);
    expect(classifyEvidence(projected).certainty).toBe(POSITIVE);
    expect(statusOf([rawVerdict()], [raw])).toBe("COMPLETE_WITH_FINDINGS");
  });

  it("7B. an object that is not provably a review comment -> UNKNOWN, blocks CLEAN", () => {
    // The field contract applies ONLY when the discriminator proves the object
    // came from this API. Without it we cannot know omission means top-level,
    // so the answer is UNKNOWN - not an assumed top-level.
    const raw = omit(rawFinding(), "pull_request_review_id");
    const projected = projectInlineComment(raw);
    expect(projected.replyStatus).toBe(UNKNOWN);
    expect(classifyEvidence(projected).certainty).toBe(UNKNOWN);
    expect(statusOf([rawVerdict()], [raw])).toBe(UNKNOWN);
  });

  it("7C. PRESENT + null is never observed, and no meaning is invented for it", () => {
    const projected = projectInlineComment(rawFinding({ in_reply_to_id: null }));
    expect(projected.replyStatus).toBe(UNKNOWN);
    expect(statusOf([rawVerdict()], [rawFinding({ in_reply_to_id: null })])).toBe(UNKNOWN);
  });

  it("the omission contract holds across every real fixture", () => {
    // If a real fixture ever contradicts absent==top-level, this fails rather
    // than the code quietly coping.
    for (const pr of [610, 612, 613, 615, 616]) {
      const f = JSON.parse(readFileSync(path.resolve(__dirname, `fixtures/pr-${pr}.json`), "utf8"));
      for (const c of f.inlineComments.value) {
        expect([PROVEN_TOP_LEVEL, PROVEN_REPLY]).toContain(c.replyStatus);
        // A finding is never a reply, and a reply never carries a badge here.
        if (c.replyStatus === PROVEN_REPLY) expect(c.inReplyToId).not.toBe(UNKNOWN);
      }
    }
  });

  it("8. identity field ABSENT -> UNKNOWN, blocks CLEAN", () => {
    for (const field of ["original_commit_id", "path", "original_line"]) {
      const raw = omit(rawFinding(), field);
      expect(classifyRaw(raw).certainty).toBe(UNKNOWN);
      expect(statusOf([rawVerdict()], [raw])).toBe(UNKNOWN);
    }
  });

  it("9. later-page check failure -> RED", () => {
    const pages = JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/check-runs-paginated.json"), "utf8"));
    const { items, totalCount } = flattenCheckRunPages(pages);
    expect(ciAtHead({ head: HEAD, checkRuns: collectionEvidence(items, { totalCount }) }).status).toBe("RED");
  });

  it("10. incomplete check collection -> UNKNOWN, never GREEN", () => {
    const pages = JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/check-runs-paginated.json"), "utf8"));
    const first = flattenCheckRunPages([pages[0]]);
    expect(first.items.every((c: { conclusion: string }) => c.conclusion === "success")).toBe(true);
    const ci = ciAtHead({ head: HEAD, checkRuns: collectionEvidence(first.items, { totalCount: first.totalCount }) });
    expect(ci.status).toBe(UNKNOWN);
    expect(ci.status).not.toBe("GREEN");
  });

  it("11. a re-anchored finding preserves its raised-at sha", () => {
    const p = projectInlineComment(rawFinding({ commit_id: OTHER }));
    expect(p.originalCommitId).toBe(HEAD);
    expect(p.commitId).toBe(OTHER);
    expect(classifyEvidence(p).kind).toBe(TRUSTED_FINDING);
  });

  it("12. absence of findings is only CLEAN when a verdict PROVES it", () => {
    // A clean verdict proves it. No verdict at all does not.
    expect(statusOf([rawVerdict()], [])).toBe("COMPLETE_CLEAN");
    expect(statusOf([], [])).toBe("NONE");
    expect(statusOf([], [])).not.toBe("COMPLETE_CLEAN");
  });

  it("a check run with an ABSENT conclusion is not counted as passing", () => {
    const runs = [{ name: "x", status: "completed", conclusion: UNKNOWN, headSha: HEAD }];
    expect(ciAtHead({ head: HEAD, checkRuns: collectionEvidence(runs, { totalCount: 1 }) }).status).not.toBe("GREEN");
  });
});

// ---------------------------------------------------------------------------
// REAL FIXTURES - the histories must still read correctly
// ---------------------------------------------------------------------------
describe("real fixture histories", () => {
  const FIX = (pr: number) => JSON.parse(readFileSync(path.resolve(__dirname, `fixtures/pr-${pr}.json`), "utf8"));

  it("#613: complete green CI at the exact head and seven exact-head P1s", () => {
    const f = FIX(613);
    expect(ciAtHead(f).status).toBe("GREEN");
    const r = reviewCompletionAtHead(f);
    expect(r.freshFindings.length).toBe(7);
    expect(r.status).toBe("COMPLETE_WITH_FINDINGS");
  });

  it("#610: eleven carried findings, none fresh, and stale evidence retained", () => {
    const r = reviewCompletionAtHead(FIX(610));
    expect(r.freshFindings.length).toBe(0);
    expect(r.carriedFindings.length).toBe(11);
    expect(r.staleEvidence.length).toBeGreaterThan(0);
  });

  it("every captured fixture's findings come from the trusted reviewer", () => {
    for (const pr of [610, 612, 613, 615]) {
      for (const f of reviewCompletionAtHead(FIX(pr)).freshFindings.concat(reviewCompletionAtHead(FIX(pr)).carriedFindings)) {
        expect(f.actorId).toBe(199175422);
      }
    }
  });
});
