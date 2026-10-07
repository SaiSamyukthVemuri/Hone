/* eslint-disable @typescript-eslint/no-explicit-any -- these tests feed raw, untyped GitHub JSON on purpose */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { REVIEW_EVIDENCE_QUERY, parseReviewEvidence } from "../../../scripts/eng/v2/adapter/internal/github/parse-review.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { REVIEW_POLICY, bindReviews } from "../../../scripts/eng/v2/adapter/internal/bind/review.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { ROLLUP_QUERY, parseRollup } from "../../../scripts/eng/v2/adapter/internal/github/parse-rollup.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { bindExternal } from "../../../scripts/eng/v2/adapter/internal/bind/external.mjs";

// ===========================================================================
// ENG-LOOP V1 05A, gap rows 4-6:
//   4. trusted Codex review provenance at the exact head (ARCH-01 §17-§21,
//      channel B as the documented 10-hex V1 binding)
//   5. review threads: trusted opener, resolution and resolver identity
//   6. external contexts, normalized by EXT-CONTEXT-01's closed tables
// Every collection is one complete GraphQL response or fails closed (CAP-01 §17).
// Real fixtures recorded 2026-10-07; synthetic edits are marked.
// ===========================================================================

const F = path.join(__dirname, "fixtures");
const load = (p: string) => JSON.parse(readFileSync(path.join(F, p), "utf8"));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const ok = (r: any) => {
  if (!r.ok) throw new Error(`did not parse: ${r.reason} ${r.detail}`);
  return r.record ?? r.value;
};
const HEAD_800 = "fe62f51f0fd95fc97d2e21eef71d179e2e701358";
const HEAD_809 = "9dbbdb808748023d8b835d9d3875552cd81d18e0";
const STALE_809 = "b54e4382847a909dbd448f7c1b175e2ba49866e0";
const key = (headSha: string) => ({ headSha });

describe("parseReviewEvidence: one complete response or a typed failure", () => {
  it("reads #800's reviews, comments and threads in full", () => {
    const r = ok(parseReviewEvidence(load("review/review-800.json")));
    expect(r.reviews).toHaveLength(21);
    expect(r.comments).toHaveLength(11);
    expect(r.threads).toHaveLength(13);
    expect(r.threads.filter((t: any) => !t.isResolved)).toHaveLength(1);
  });

  it("asks for every connection at first:100 with its completeness fields", () => {
    const q = REVIEW_EVIDENCE_QUERY.replace(/\s+/g, "");
    for (const c of ["reviews(first:100)", "comments(first:100)", "reviewThreads(first:100)"]) expect(q).toContain(c);
    expect(q.match(/totalCountpageInfo\{hasNextPage\}/g)?.length).toBe(4);
  });

  const edit = (f: (pr: any) => void) => {
    const raw = clone(load("review/review-809.json"));
    f(raw.data.repository.pullRequest);
    return parseReviewEvidence(raw);
  };

  it.each([
    ["reviews with another page", (p: any) => (p.reviews.pageInfo.hasNextPage = true)],
    ["comments whose totalCount exceeds the nodes", (p: any) => (p.comments.totalCount += 1)],
    ["threads with another page", (p: any) => (p.reviewThreads.pageInfo.hasNextPage = true)],
    ["a thread whose own comments are incomplete", (p: any) => (p.reviewThreads.nodes[0].comments.totalCount = 101)],
  ])("%s is review_evidence_too_large, never partial evidence", (_n, f) => {
    expect(edit(f)).toMatchObject({ ok: false, reason: "review_evidence_too_large" });
  });

  it.each([
    ["a review with no body", (p: any) => delete p.reviews.nodes[0].body],
    ["a review commit that is not 40 hex", (p: any) => (p.reviews.nodes[0].commit = { oid: "abc" })],
    ["an unrequested review field", (p: any) => (p.reviews.nodes[0].url = "x")],
    ["a thread with a non-boolean isResolved", (p: any) => (p.reviewThreads.nodes[0].isResolved = "yes")],
    ["an author without a typename", (p: any) => (p.comments.nodes[0].author = { login: "x" })],
  ])("%s is malformed", (_n, f) => {
    expect(edit(f)).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("a GitHub error or a missing pull request is read_failed", () => {
    const err = clone(load("review/review-809.json"));
    err.errors = [{ message: "boom" }];
    expect(parseReviewEvidence(err)).toMatchObject({ reason: "read_failed" });
    const gone = clone(load("review/review-809.json"));
    gone.data.repository.pullRequest = null;
    expect(parseReviewEvidence(gone)).toMatchObject({ reason: "read_failed" });
  });
});

describe("bindReviews: trusted review artifacts at the exact head", () => {
  const bind = (fixture: string, headSha: string) =>
    ok(bindReviews({ key: key(headSha), evidence: ok(parseReviewEvidence(load(fixture))), policy: REVIEW_POLICY }));

  it("#809: the clean comment naming the head qualifies (channel B); the one naming the earlier head does not", () => {
    const v = bind("review/review-809.json", HEAD_809);
    const clean = v.reviews.filter((r: any) => r.channel === "CLEAN_COMMENT");
    expect(clean).toHaveLength(2);
    expect(clean.filter((r: any) => r.qualifiesAtHead)).toHaveLength(1);
    expect(clean.every((r: any) => r.actor.id === 199175422 && r.actor.type === "Bot" && r.verdict === "CLEAN")).toBe(true);
  });

  it("#809 at its earlier head: the stale clean verdict qualifies there, and only there", () => {
    const v = bind("review/review-809.json", STALE_809);
    const q = v.reviews.filter((r: any) => r.qualifiesAtHead);
    expect(q.map((r: any) => r.channel).sort()).toEqual(["CLEAN_COMMENT", "PR_REVIEW"]);
  });

  it("#800: Codex's findings review at the head qualifies (channel A); reviews at older heads do not", () => {
    const v = bind("review/review-800.json", HEAD_800);
    const codexA = v.reviews.filter((r: any) => r.channel === "PR_REVIEW" && r.actor.id === 199175422);
    expect(codexA.length).toBeGreaterThan(1);
    expect(codexA.filter((r: any) => r.qualifiesAtHead)).toHaveLength(1);
  });

  it("#800: threads carry the opener and resolver identities, never logins", () => {
    const v = bind("review/review-800.json", HEAD_800);
    const open = v.threads.filter((t: any) => !t.resolved);
    expect(open).toHaveLength(1);
    expect(open[0].opener).toEqual({ id: 199175422, type: "Bot" });
    for (const t of v.threads.filter((t: any) => t.resolved)) expect(t.resolver).toEqual({ id: 26781116, type: "User" });
    expect(JSON.stringify(v)).not.toContain("chatgpt-codex-connector");
  });

  const withComment = (body: string, author: object) => {
    const raw = clone(load("review/review-809.json"));
    raw.data.repository.pullRequest.comments.nodes.push({ databaseId: 1, body, author });
    raw.data.repository.pullRequest.comments.totalCount += 1;
    return ok(bindReviews({ key: key(HEAD_809), evidence: ok(parseReviewEvidence(raw)), policy: REVIEW_POLICY }));
  };
  const CODEX = { __typename: "Bot", login: "chatgpt-codex-connector", databaseId: 199175422 };
  const marker = (h: string) => `**Reviewed commit:** \`${h}\``;

  it("synthetic: a clean comment with two markers, a 7-hex or an upper-case marker never qualifies", () => {
    const bad = [
      `Codex Review: Didn't find any major issues. ${marker(HEAD_809.slice(0, 10))} ${marker(HEAD_809.slice(0, 10))}`,
      `Codex Review: Didn't find any major issues. ${marker(HEAD_809.slice(0, 7))}`,
      `Codex Review: Didn't find any major issues. ${marker(HEAD_809.slice(0, 10).toUpperCase())}`,
    ];
    for (const b of bad) {
      const v = withComment(b, CODEX);
      expect(v.reviews.find((r: any) => r.id === 1)?.qualifiesAtHead).toBe(false);
    }
  });

  it("synthetic: the clean text from an untrusted actor is kept with its real identity, never as Codex", () => {
    const v = withComment(`Codex Review: Didn't find any major issues. ${marker(HEAD_809.slice(0, 10))}`, {
      __typename: "User",
      login: "someone",
      databaseId: 5,
    });
    expect(v.reviews.find((r: any) => r.id === 1)?.actor).toEqual({ id: 5, type: "User" });
  });

  it("synthetic: a comment that does not BEGIN with the clean verdict is not a channel-B artifact", () => {
    const v = withComment(`Thanks! Codex Review: Didn't find any major issues. ${marker(HEAD_809.slice(0, 10))}`, CODEX);
    expect(v.reviews.find((r: any) => r.id === 1)).toBeUndefined();
  });

  it("a review state outside GitHub's closed set is malformed", () => {
    const raw = clone(load("review/review-809.json"));
    raw.data.repository.pullRequest.reviews.nodes[0].state = "SORT_OF";
    expect(bindReviews({ key: key(HEAD_809), evidence: ok(parseReviewEvidence(raw)), policy: REVIEW_POLICY })).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("parseRollup and bindExternal (EXT-CONTEXT-01)", () => {
  const ext = (fixture: string) => bindExternal(ok(parseRollup(load(fixture))));

  it("asks for the rollup's contexts at first:100 with their completeness fields", () => {
    expect(ROLLUP_QUERY.replace(/\s+/g, "")).toContain("contexts(first:100){totalCountpageInfo{hasNextPage}");
  });

  it("#800: only the vercel check run and the Vercel status are external, both success", () => {
    expect(ok(ext("rollup/rollup-800.json")).external).toEqual(
      expect.arrayContaining([
        { source: "Vercel", state: "success" },
        { source: expect.any(String), state: "success" },
      ]),
    );
    expect(ok(ext("rollup/rollup-800.json")).external).toHaveLength(2);
  });

  it("#810: its GitHub Actions FAILURE is outside the external domain", () => {
    const v = ok(ext("rollup/rollup-810.json"));
    expect(v.external).toHaveLength(2);
    expect(v.external.every((e: any) => e.state === "success")).toBe(true);
  });

  const mutate = (f: (nodes: any[]) => void) => {
    const raw = clone(load("rollup/rollup-800.json"));
    f(raw.data.repository.object.statusCheckRollup.contexts.nodes);
    return raw;
  };
  const nonActions = (nodes: any[]) => nodes.find((n) => n.__typename === "CheckRun" && n.checkSuite.app?.slug !== "github-actions");
  const status = (nodes: any[]) => nodes.find((n) => n.__typename === "StatusContext");

  it.each([
    ["REQUESTED", "pending"],
    ["QUEUED", "pending"],
    ["IN_PROGRESS", "pending"],
    ["WAITING", "pending"],
    ["PENDING", "pending"],
  ])("an external check run %s is %s", (s, expected) => {
    const v = ok(bindExternal(ok(parseRollup(mutate((n) => Object.assign(nonActions(n), { status: s, conclusion: null }))))));
    expect(v.external.some((e: any) => e.state === expected)).toBe(true);
  });

  it.each(["SUCCESS", "NEUTRAL", "SKIPPED"])("completed + %s is success", (c) => {
    const v = ok(bindExternal(ok(parseRollup(mutate((n) => Object.assign(nonActions(n), { conclusion: c }))))));
    expect(v.external.every((e: any) => e.state === "success")).toBe(true);
  });

  it.each(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"])(
    "completed + %s is failure",
    (c) => {
      const v = ok(bindExternal(ok(parseRollup(mutate((n) => Object.assign(nonActions(n), { conclusion: c }))))));
      expect(v.external.some((e: any) => e.state === "failure")).toBe(true);
    },
  );

  it("unknown status or conclusion strings, and a completed run with a null conclusion, are unrecognized_context_state", () => {
    for (const patch of [{ status: "PAUSED" }, { conclusion: "MAYBE" }, { conclusion: null }]) {
      expect(bindExternal(ok(parseRollup(mutate((n) => Object.assign(nonActions(n), patch)))))).toMatchObject({
        reason: "unrecognized_context_state",
      });
    }
  });

  it("status-context states map by the closed table; unknown is unrecognized", () => {
    for (const [s, e] of [["SUCCESS", "success"], ["PENDING", "pending"], ["EXPECTED", "pending"], ["ERROR", "failure"], ["FAILURE", "failure"]]) {
      const v = ok(bindExternal(ok(parseRollup(mutate((n) => (status(n).state = s))))));
      expect(v.external.find((x: any) => x.source === "Vercel")?.state).toBe(e);
    }
    expect(bindExternal(ok(parseRollup(mutate((n) => (status(n).state = "MAYBE")))))).toMatchObject({
      reason: "unrecognized_context_state",
    });
  });

  it("a check run with no app is malformed, and malformed wins over an unrecognized state in either order", () => {
    expect(bindExternal(ok(parseRollup(mutate((n) => (nonActions(n).checkSuite.app = null)))))).toMatchObject({
      reason: "malformed",
    });
    const both = mutate((n) => {
      nonActions(n).checkSuite.app = null;
      status(n).state = "MAYBE";
    });
    expect(bindExternal(ok(parseRollup(both)))).toMatchObject({ reason: "malformed" });
    const reversed = clone(both);
    reversed.data.repository.object.statusCheckRollup.contexts.nodes.reverse();
    expect(bindExternal(ok(parseRollup(reversed)))).toMatchObject({ reason: "malformed" });
  });

  it("a null or non-string state is the reader's malformed, never reclassified (EXT-CONTEXT-01 §3)", () => {
    expect(parseRollup(mutate((n) => (status(n).state = null)))).toMatchObject({ reason: "malformed" });
    expect(parseRollup(mutate((n) => (nonActions(n).status = 3)))).toMatchObject({ reason: "malformed" });
  });

  it("a rollup that cannot be complete in one response is external_contexts_too_large; null is an empty set", () => {
    const more = clone(load("rollup/rollup-800.json"));
    more.data.repository.object.statusCheckRollup.contexts.pageInfo.hasNextPage = true;
    expect(parseRollup(more)).toMatchObject({ reason: "external_contexts_too_large" });
    const none = clone(load("rollup/rollup-800.json"));
    none.data.repository.object.statusCheckRollup = null;
    expect(ok(bindExternal(ok(parseRollup(none)))).external).toEqual([]);
  });

  it("permutation of the contexts gives the same normalized multiset", () => {
    const a = ok(ext("rollup/rollup-776.json")).external;
    const raw = clone(load("rollup/rollup-776.json"));
    raw.data.repository.object.statusCheckRollup.contexts.nodes.reverse();
    const b = ok(bindExternal(ok(parseRollup(raw)))).external;
    const key = (e: any) => `${e.source}|${e.state}`;
    expect(b.map(key).sort()).toEqual(a.map(key).sort());
  });
});
