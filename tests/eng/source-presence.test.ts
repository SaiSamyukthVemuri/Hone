import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { matchSourceField } from "../../scripts/eng/source-field.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { AUTHORIZED, PROVEN, PROVEN_REPLY, PROVEN_TOP_LEVEL, POSITIVE, PROVEN_NEGATIVE, UNAUTHORIZED, UNKNOWN, actorAuthorityFrom, collectionEvidence } from "../../scripts/eng/evidence.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { flattenCheckRunPages, projectCheckRun, projectInlineComment, projectIssueComment, provenanceOf, replyStatusOf } from "../../scripts/eng/github-facts.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { RAW_EVIDENCE, TRUSTED_FINDING, classifyEvidence } from "../../scripts/eng/finding-identity.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { ciAtHead, reviewCompletionAtHead } from "../../scripts/eng/review-provenance.mjs";

// ===========================================================================
// CP-005 FOUNDATION: checked source presence, end to end.
// ===========================================================================
//
// Every case starts from a RAW GitHub-shaped object and the production
// projection. No field is deleted after projection - that pattern certified a
// branch production could not reach in a retired vehicle.

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const CODEX = { login: "chatgpt-codex-connector[bot]", id: 199175422, type: "Bot" };
const HUMAN = { login: "ordinary-contributor", id: 12345678, type: "User" };
const BADGE = "**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange)</sub></sub>  A finding**\n\ndetail.";

/** RAW top-level review comment: GitHub OMITS in_reply_to_id on these. */
const rawFinding = (over: Record<string, unknown> = {}) => ({
  id: 9, pull_request_review_id: 77, user: CODEX, commit_id: HEAD, original_commit_id: HEAD,
  path: "lib/x.ts", line: 3, original_line: 3, body: BADGE, ...over,
});
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

describe("the primitive hands nothing to the consumer", () => {
  it("dispatches on own-property presence", () => {
    const h = { absent: () => "A", present: (v: unknown) => ["P", v] };
    expect(matchSourceField({}, "x", h)).toBe("A");
    expect(matchSourceField({ x: null }, "x", h)).toEqual(["P", null]);
    expect(matchSourceField({ x: "" }, "x", h)).toEqual(["P", ""]);
    expect(matchSourceField({ x: 0 }, "x", h)).toEqual(["P", 0]);
    expect(matchSourceField(Object.create({ x: 1 }), "x", h)).toBe("A"); // inherited is not source presence
    expect(matchSourceField(null, "x", h)).toBe("A");
  });

  it("preserves values exactly, without coercion", () => {
    const obj = { a: 1 };
    expect(matchSourceField({ x: obj }, "x", { absent: () => null, present: (v: unknown) => v })).toBe(obj);
    for (const v of [NaN, -0, false]) {
      expect(Object.is(matchSourceField({ x: v }, "x", { absent: () => null, present: (u: unknown) => u }), v)).toBe(true);
    }
  });

  it("BOTH branches are required - a partial migration throws at first call", () => {
    expect(() => matchSourceField({}, "x", { present: () => 1 } as never)).toThrow(/absent/);
    expect(() => matchSourceField({}, "x", { absent: () => 1 } as never)).toThrow(/present/);
  });

  it("the old consumer forms have nothing to operate on", () => {
    // There is no exported descriptor, no `.value`, and no fallback helper - so
    // `if (field)`, `field != null`, `field ?? x` and `field.value` cannot be
    // written against this API at all.
    const src = readFileSync(path.resolve(__dirname, "../../scripts/eng/source-field.mjs"), "utf8")
      .replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    expect(src).not.toMatch(/export\s+(const|function)\s+(absent|present|isPresent|isAbsent|valueOr|unwrap)/);
    expect(src).not.toMatch(/kind:\s*["']/);
    expect(src.match(/export /g) ?? []).toHaveLength(1);
  });
});

describe("field semantics, from raw input", () => {
  it("actor type: absent -> UNKNOWN, contradictory -> UNAUTHORIZED, never fabricated", () => {
    expect(actorAuthorityFrom(CODEX).authority).toBe(AUTHORIZED);
    expect(actorAuthorityFrom(omit(CODEX, "type")).authority).toBe(UNKNOWN);
    expect(actorAuthorityFrom({ ...CODEX, type: "User" }).authority).toBe(UNAUTHORIZED);
    expect(actorAuthorityFrom(omit(CODEX, "id")).authority).toBe(UNKNOWN);
    expect(actorAuthorityFrom({ ...CODEX, id: null }).authority).toBe(UNKNOWN);
    expect(actorAuthorityFrom(undefined).authority).toBe(UNKNOWN);
    const src = readFileSync(path.resolve(__dirname, "../../scripts/eng/finding-identity.mjs"), "utf8")
      .replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    expect(src).not.toMatch(/["']Bot["']/); // never synthesized
  });

  it("provenance: only a valid id proves it", () => {
    expect(provenanceOf(rawFinding())).toBe(PROVEN);
    expect(provenanceOf({ ...rawFinding(), pull_request_review_id: null })).toBe(UNKNOWN);
    expect(provenanceOf({ ...rawFinding(), pull_request_review_id: 0 })).toBe(UNKNOWN);
    expect(provenanceOf(omit(rawFinding(), "pull_request_review_id"))).toBe(UNKNOWN);
  });

  it("reply status: the omission exception applies only after provenance", () => {
    expect(replyStatusOf(rawFinding())).toBe(PROVEN_TOP_LEVEL);
    expect(replyStatusOf({ ...rawFinding(), in_reply_to_id: 5 })).toBe(PROVEN_REPLY);
    expect(replyStatusOf({ ...rawFinding(), in_reply_to_id: null })).toBe(UNKNOWN);
    expect(replyStatusOf(omit(rawFinding(), "pull_request_review_id"))).toBe(UNKNOWN);
  });

  it("the omission contract holds across every real fixture", () => {
    for (const pr of [610, 612, 613, 615, 616]) {
      const f = JSON.parse(readFileSync(path.resolve(__dirname, `fixtures/pr-${pr}.json`), "utf8"));
      for (const c of f.inlineComments.value) {
        expect([PROVEN_TOP_LEVEL, PROVEN_REPLY]).toContain(c.replyStatus);
        expect(c.provenance).toBe(PROVEN);
      }
    }
  });
});

describe("required acceptance matrix", () => {
  it("unknown actor never becomes authorized", () => {
    for (const over of [{ user: omit(CODEX, "type") }, { user: omit(CODEX, "id") }, {}]) {
      const raw = Object.keys(over).length ? rawFinding(over) : omit(rawFinding(), "user");
      const e = classifyRaw(raw);
      expect(e.kind).not.toBe(TRUSTED_FINDING);
      expect(e.certainty).toBe(UNKNOWN);
      expect(statusOf([rawVerdict()], [raw])).toBe(UNKNOWN);
    }
  });

  it("unknown provenance never becomes proven", () => {
    const raw = omit(rawFinding(), "pull_request_review_id");
    expect(classifyRaw(raw).certainty).toBe(UNKNOWN);
    expect(statusOf([rawVerdict()], [raw])).toBe(UNKNOWN);
  });

  it("an unauthorized spoof is nonblocking raw evidence", () => {
    const e = classifyRaw(rawFinding({ user: HUMAN }));
    expect(e.kind).toBe(RAW_EVIDENCE);
    expect(e.certainty).toBe(PROVEN_NEGATIVE);
    expect(e.actorId).toBe(12345678);
    expect(statusOf([rawVerdict()], [rawFinding({ user: HUMAN })])).toBe("COMPLETE_CLEAN");
  });

  it("a proven reply is a non-finding and nonblocking", () => {
    const e = classifyRaw(rawFinding({ in_reply_to_id: 1 }));
    expect(e.certainty).toBe(PROVEN_NEGATIVE);
    expect(statusOf([rawVerdict()], [rawFinding({ in_reply_to_id: 1 })])).toBe("COMPLETE_CLEAN");
  });

  it("unknown reply semantics block positive CLEAN", () => {
    const raw = rawFinding({ in_reply_to_id: null });
    expect(classifyRaw(raw).certainty).toBe(UNKNOWN);
    expect(statusOf([rawVerdict()], [raw])).toBe(UNKNOWN);
  });

  it("a trusted complete finding remains a finding", () => {
    expect(classifyRaw(rawFinding()).kind).toBe(TRUSTED_FINDING);
    expect(classifyRaw(rawFinding()).certainty).toBe(POSITIVE);
    expect(statusOf([rawVerdict()], [rawFinding()])).toBe("COMPLETE_WITH_FINDINGS");
  });

  it("identity provenance absent -> UNKNOWN, blocks CLEAN", () => {
    for (const f of ["original_commit_id", "path", "original_line"]) {
      const raw = omit(rawFinding(), f);
      expect(classifyRaw(raw).certainty).toBe(UNKNOWN);
      expect(statusOf([rawVerdict()], [raw])).toBe(UNKNOWN);
    }
  });

  it("verdict actor absent -> UNKNOWN, never CLEAN; spoof alone -> never CLEAN", () => {
    expect(statusOf([rawVerdict(), omit(rawVerdict({ id: 3 }), "user")])).toBe(UNKNOWN);
    expect(statusOf([rawVerdict({ id: 2, user: HUMAN })])).not.toBe("COMPLETE_CLEAN");
  });

  it("an incomplete check collection never becomes GREEN; a later-page failure is RED", () => {
    const pages = JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/check-runs-paginated.json"), "utf8"));
    const all = flattenCheckRunPages(pages);
    expect(ciAtHead({ head: HEAD, checkRuns: collectionEvidence(all.items, { totalCount: all.totalCount }) }).status).toBe("RED");
    const first = flattenCheckRunPages([pages[0]]);
    expect(first.items.every((c: { conclusion: string }) => c.conclusion === "success")).toBe(true);
    expect(ciAtHead({ head: HEAD, checkRuns: collectionEvidence(first.items, { totalCount: first.totalCount }) }).status).toBe(UNKNOWN);
  });

  it("the report distinguishes 'GitHub did not send this' from 'GitHub sent null'", () => {
    // The operator-visible half of "UNKNOWN is first class". Both readings are
    // unusable for identity, but a report that renders them the same way tells
    // the reader a malformed payload and an outdated comment are one state.
    const absent = projectInlineComment(omit(rawFinding(), "original_line"));
    const nulled = projectInlineComment(rawFinding({ original_line: null }));
    expect(absent.originalLine).toBe(UNKNOWN);
    expect(nulled.originalLine).toBe(null);
    expect(JSON.parse(JSON.stringify(absent)).originalLine).toBe(UNKNOWN);
    expect(JSON.parse(JSON.stringify(nulled)).originalLine).toBe(null);
    // ...and neither is ever mistaken for a usable position.
    expect(classifyEvidence(absent).certainty).toBe(UNKNOWN);
    expect(classifyEvidence(nulled).certainty).toBe(UNKNOWN);
  });

  it("a check run with no head_sha is never bound to the head", () => {
    const run = (over: Record<string, unknown> = {}) => ({
      name: "validate", status: "completed", conclusion: "success", head_sha: HEAD, ...over,
    });
    const runs = [run(), omit(run({ name: "orphan" }), "head_sha")].map(projectCheckRun);
    expect((runs[1] as { headSha: string }).headSha).toBe(UNKNOWN);
    const r = ciAtHead({ head: HEAD, checkRuns: collectionEvidence(runs, { totalCount: 2 }) });
    expect(r.atHead).toBe(1);
    expect(r.foreign).toBe(1);
  });

  it("re-anchoring preserves the original raised-at sha", () => {
    const p = projectInlineComment(rawFinding({ commit_id: OTHER }));
    expect(p.originalCommitId).toBe(HEAD);
    expect(p.commitId).toBe(OTHER);
    expect(classifyEvidence(p).kind).toBe(TRUSTED_FINDING);
  });

  it("real histories still read correctly", () => {
    const FIX = (pr: number) => JSON.parse(readFileSync(path.resolve(__dirname, `fixtures/pr-${pr}.json`), "utf8"));
    expect(ciAtHead(FIX(613)).status).toBe("GREEN");
    expect(reviewCompletionAtHead(FIX(613)).freshFindings.length).toBe(7);
    expect(reviewCompletionAtHead(FIX(610)).carriedFindings.length).toBe(11);
  });
});

describe("one authority, no legacy interpretation", () => {
  it("no migrated module re-derives the certainty vocabulary or coalesces a raw read", () => {
    // The single small static guard. The API shape carries the rest.
    for (const f of ["github-facts.mjs", "review-provenance.mjs", "finding-identity.mjs"]) {
      const code = readFileSync(path.resolve(__dirname, "../../scripts/eng", f), "utf8")
        .replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
      expect(code).not.toMatch(/mayAssertPositive\(/);
      expect(code).not.toMatch(/completeness === COMPLETE\s*&&/);
      expect(code).not.toMatch(/\bc\.(user|in_reply_to_id|pull_request_review_id|original_line|head_sha|conclusion)\s*\?\?/);
    }
  });
});
