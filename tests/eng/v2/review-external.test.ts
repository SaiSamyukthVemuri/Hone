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
/** An OPEN key at `headSha`: the binder accepts nothing less (SPEC-05A §0). */
const key = (headSha: string) => ({
  prNumber: 809,
  state: "OPEN",
  isDraft: false,
  headSha,
  headRef: "feat/x",
  headRepoId: 1240764106,
  baseRef: "claude/build-hone-saas-hOex7",
  baseRepoId: 1240764106,
  baseSha: "6cdd830b0bcc5e3532016bc612bd0298db3533fb",
});
const HEAD_810_RECORDED = "958b9d536e055e746499262cdc1a740e13501bf2";
const HEAD_776_RECORDED = "7d25459de1fe63a7fd4ed3348ecb11ab35ab6338";
/** The PR or commit each fixture was requested for: the parsers require it. */
const REQUESTED: Record<string, any> = {
  "review/review-800.json": { expectedNumber: 800 },
  "review/review-809.json": { expectedNumber: 809 },
  "review/review-776.json": { expectedNumber: 776 },
  "rollup/rollup-800.json": { headSha: HEAD_800 },
  "rollup/rollup-810.json": { headSha: HEAD_810_RECORDED },
  "rollup/rollup-776.json": { headSha: HEAD_776_RECORDED },
};
const P809 = REQUESTED["review/review-809.json"];
const P800_ROLLUP = REQUESTED["rollup/rollup-800.json"];

describe("parseReviewEvidence: one complete response or a typed failure", () => {
  it("reads #800's reviews, comments and threads in full", () => {
    const r = ok(parseReviewEvidence(load("review/review-800.json"), { expectedNumber: 800 }));
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
    return parseReviewEvidence(raw, P809);
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

  it("the answer must echo the requested pull request; a missing request is malformed", () => {
    expect(REVIEW_EVIDENCE_QUERY).toMatch(/pullRequest\(number:\$n\)\{number /);
    const raw = load("review/review-809.json");
    for (const opts of [undefined, null, {}, { expectedNumber: "809" }, { expectedNumber: 0 }]) {
      expect(parseReviewEvidence(raw, opts as any), JSON.stringify(opts)).toMatchObject({ ok: false, reason: "malformed" });
    }
    expect(parseReviewEvidence(raw, { expectedNumber: 800 })).toMatchObject({ ok: false, reason: "malformed" });
    const unechoed = clone(raw);
    delete unechoed.data.repository.pullRequest.number;
    expect(parseReviewEvidence(unechoed, P809)).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("a repeated review or comment id is malformed: one id is one artifact", () => {
    expect(edit((p) => p.reviews.nodes.push(clone(p.reviews.nodes[0])) && (p.reviews.totalCount += 1))).toMatchObject({
      reason: "malformed",
    });
    expect(edit((p) => p.comments.nodes.push(clone(p.comments.nodes[0])) && (p.comments.totalCount += 1))).toMatchObject({
      reason: "malformed",
    });
  });

  it("any reordering of the same answer normalizes to the same evidence (CAP-01 L7)", () => {
    const raw = load("review/review-800.json");
    const reversed = clone(raw);
    const p = reversed.data.repository.pullRequest;
    for (const c of [p.reviews, p.comments, p.reviewThreads]) c.nodes.reverse();
    expect(parseReviewEvidence(reversed, { expectedNumber: 800 })).toEqual(parseReviewEvidence(raw, { expectedNumber: 800 }));
  });

  it("an exotic input is malformed, never an exception", () => {
    const hostile = new Proxy(clone(load("review/review-809.json")), {
      ownKeys() {
        throw new Error("hostile proxy");
      },
    });
    expect(() => parseReviewEvidence(hostile, P809)).not.toThrow();
    expect(parseReviewEvidence(hostile, P809)).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("a GitHub error or a missing pull request is read_failed", () => {
    const err = clone(load("review/review-809.json"));
    err.errors = [{ message: "boom" }];
    expect(parseReviewEvidence(err, P809)).toMatchObject({ reason: "read_failed" });
    const gone = clone(load("review/review-809.json"));
    gone.data.repository.pullRequest = null;
    expect(parseReviewEvidence(gone, P809)).toMatchObject({ reason: "read_failed" });
  });
});

describe("bindReviews: trusted review artifacts at the exact head", () => {
  const bind = (fixture: string, headSha: string) =>
    ok(bindReviews({ key: key(headSha), evidence: ok(parseReviewEvidence(load(fixture), REQUESTED[fixture])), policy: REVIEW_POLICY }));

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

  const withComment = (body: string, author: object, lastEditedAt: string | null = null) => {
    const raw = clone(load("review/review-809.json"));
    raw.data.repository.pullRequest.comments.nodes.push({ databaseId: 1, body, lastEditedAt, author });
    raw.data.repository.pullRequest.comments.totalCount += 1;
    return ok(bindReviews({ key: key(HEAD_809), evidence: ok(parseReviewEvidence(raw, P809)), policy: REVIEW_POLICY }));
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

  it("R4-EDIT: a Codex clean comment someone edited never qualifies, however its marker reads", () => {
    // A writer can edit another account's comment while its author stays Codex. Real Codex clean verdicts are never
    // edited (#802-#809: 12 of 12); only its running "Codex Review Summary" comment is.
    const body = `Codex Review: Didn't find any major issues.\n\n${marker(HEAD_809.slice(0, 10))}`;
    expect(withComment(body, CODEX).reviews.find((r: any) => r.id === 1)).toMatchObject({ qualifiesAtHead: true });
    expect(withComment(body, CODEX, "2026-10-07T21:00:00Z").reviews.find((r: any) => r.id === 1)).toMatchObject({
      channel: "CLEAN_COMMENT",
      qualifiesAtHead: false,
    });
  });

  it("the real clean verdicts are unedited, and the real edited Codex comment is only its review summary", () => {
    for (const f of ["review/review-800.json", "review/review-809.json", "review/review-776.json"]) {
      for (const c of load(f).data.repository.pullRequest.comments.nodes) {
        if (c.author?.databaseId !== 199175422) continue;
        if (c.body.startsWith("Codex Review: Didn't find any major issues.")) expect(c.lastEditedAt, f).toBeNull();
        else if (c.lastEditedAt !== null) expect(c.body.startsWith("<!-- codex-pull-request-review-summary -->"), f).toBe(true);
      }
    }
  });

  it("the review policy is required and is exactly { cleanPrefix }: never defaulted, never empty", () => {
    const evidence = ok(parseReviewEvidence(load("review/review-809.json"), P809));
    const policies: any[] = [
      undefined,
      null,
      {},
      { cleanPrefix: "" },
      { cleanPrefix: "   " },
      { cleanPrefix: 5 },
      { cleanPrefix: REVIEW_POLICY.cleanPrefix, humanResolvers: "anyone" },
    ];
    for (const policy of policies) {
      expect(bindReviews({ key: key(HEAD_809), evidence, policy }), JSON.stringify(policy) ?? "undefined").toMatchObject({
        ok: false,
        reason: "malformed",
      });
    }
    expect(bindReviews({ key: key(HEAD_809), evidence })).toMatchObject({ ok: false, reason: "malformed" });
    expect(Object.keys(REVIEW_POLICY)).toEqual(["cleanPrefix"]);
  });

  it("every binder refuses an input outside its contract — null, a partial key — as malformed, never throwing", () => {
    const evidence = ok(parseReviewEvidence(load("review/review-809.json"), P809));
    for (const input of [null, undefined, {}, { key: { headSha: HEAD_809 }, evidence }, { key: key(HEAD_809), evidence: { reviews: [] } }]) {
      expect(() => bindReviews(input as any)).not.toThrow();
      expect(bindReviews(input as any)).toMatchObject({ ok: false, reason: "malformed" });
    }
    for (const input of [null, undefined, {}, { contexts: [{ kind: "CheckRun", name: "x" }] }]) {
      expect(() => bindExternal(input as any)).not.toThrow();
      expect(bindExternal(input as any)).toMatchObject({ ok: false, reason: "malformed" });
    }
  });

  it("synthetic: a comment that does not BEGIN with the clean verdict is not a channel-B artifact", () => {
    const v = withComment(`Thanks! Codex Review: Didn't find any major issues. ${marker(HEAD_809.slice(0, 10))}`, CODEX);
    expect(v.reviews.find((r: any) => r.id === 1)).toBeUndefined();
  });

  it("a review state outside GitHub's closed set is malformed", () => {
    const raw = clone(load("review/review-809.json"));
    raw.data.repository.pullRequest.reviews.nodes[0].state = "SORT_OF";
    expect(bindReviews({ key: key(HEAD_809), evidence: ok(parseReviewEvidence(raw, P809)), policy: REVIEW_POLICY })).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("parseRollup and bindExternal (EXT-CONTEXT-01)", () => {
  const ext = (fixture: string) => bindExternal(ok(parseRollup(load(fixture), REQUESTED[fixture])));

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
  const parse800 = (raw: any) => parseRollup(raw, P800_ROLLUP);
  const nonActions = (nodes: any[]) => nodes.find((n) => n.__typename === "CheckRun" && n.checkSuite.app?.slug !== "github-actions");
  const status = (nodes: any[]) => nodes.find((n) => n.__typename === "StatusContext");

  it.each([
    ["REQUESTED", "pending"],
    ["QUEUED", "pending"],
    ["IN_PROGRESS", "pending"],
    ["WAITING", "pending"],
    ["PENDING", "pending"],
  ])("an external check run %s is %s", (s, expected) => {
    const v = ok(bindExternal(ok(parse800(mutate((n) => Object.assign(nonActions(n), { status: s, conclusion: null }))))));
    expect(v.external.some((e: any) => e.state === expected)).toBe(true);
  });

  it.each(["SUCCESS", "NEUTRAL", "SKIPPED"])("completed + %s is success", (c) => {
    const v = ok(bindExternal(ok(parse800(mutate((n) => Object.assign(nonActions(n), { conclusion: c }))))));
    expect(v.external.every((e: any) => e.state === "success")).toBe(true);
  });

  it.each(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"])(
    "completed + %s is failure",
    (c) => {
      const v = ok(bindExternal(ok(parse800(mutate((n) => Object.assign(nonActions(n), { conclusion: c }))))));
      expect(v.external.some((e: any) => e.state === "failure")).toBe(true);
    },
  );

  it("unknown status or conclusion strings, and a completed run with a null conclusion, are unrecognized_context_state", () => {
    for (const patch of [{ status: "PAUSED" }, { conclusion: "MAYBE" }, { conclusion: null }]) {
      expect(bindExternal(ok(parse800(mutate((n) => Object.assign(nonActions(n), patch)))))).toMatchObject({
        reason: "unrecognized_context_state",
      });
    }
  });

  it("status-context states map by the closed table; unknown is unrecognized", () => {
    for (const [s, e] of [["SUCCESS", "success"], ["PENDING", "pending"], ["EXPECTED", "pending"], ["ERROR", "failure"], ["FAILURE", "failure"]]) {
      const v = ok(bindExternal(ok(parse800(mutate((n) => (status(n).state = s))))));
      expect(v.external.find((x: any) => x.source === "Vercel")?.state).toBe(e);
    }
    expect(bindExternal(ok(parse800(mutate((n) => (status(n).state = "MAYBE")))))).toMatchObject({
      reason: "unrecognized_context_state",
    });
  });

  it("a check run with no app is malformed, and malformed wins over an unrecognized state in either order", () => {
    expect(bindExternal(ok(parse800(mutate((n) => (nonActions(n).checkSuite.app = null)))))).toMatchObject({
      reason: "malformed",
    });
    const both = mutate((n) => {
      nonActions(n).checkSuite.app = null;
      status(n).state = "MAYBE";
    });
    expect(bindExternal(ok(parseRollup(both, P800_ROLLUP)))).toMatchObject({ reason: "malformed" });
    const reversed = clone(both);
    reversed.data.repository.object.statusCheckRollup.contexts.nodes.reverse();
    expect(bindExternal(ok(parseRollup(reversed, P800_ROLLUP)))).toMatchObject({ reason: "malformed" });
  });

  it("a null or non-string state is the reader's malformed, never reclassified (EXT-CONTEXT-01 §3)", () => {
    expect(parse800(mutate((n) => (status(n).state = null)))).toMatchObject({ reason: "malformed" });
    expect(parse800(mutate((n) => (nonActions(n).status = 3)))).toMatchObject({ reason: "malformed" });
  });

  it("a rollup that cannot be complete in one response is external_contexts_too_large; null is an empty set", () => {
    const more = clone(load("rollup/rollup-800.json"));
    more.data.repository.object.statusCheckRollup.contexts.pageInfo.hasNextPage = true;
    expect(parseRollup(more, P800_ROLLUP)).toMatchObject({ reason: "external_contexts_too_large" });
    const none = clone(load("rollup/rollup-800.json"));
    none.data.repository.object.statusCheckRollup = null;
    expect(ok(bindExternal(ok(parseRollup(none, P800_ROLLUP)))).external).toEqual([]);
  });

  it("the answer must echo the requested commit; a missing request is malformed", () => {
    expect(ROLLUP_QUERY).toContain("... on Commit{oid statusCheckRollup{");
    const raw = load("rollup/rollup-800.json");
    for (const opts of [undefined, null, {}, { headSha: HEAD_800.slice(0, 10) }, { headSha: HEAD_800.toUpperCase() }]) {
      expect(parseRollup(raw, opts as any), JSON.stringify(opts)).toMatchObject({ ok: false, reason: "malformed" });
    }
    expect(parseRollup(raw, { headSha: HEAD_810_RECORDED })).toMatchObject({ ok: false, reason: "malformed" });
    const unechoed = clone(raw);
    delete unechoed.data.repository.object.oid;
    expect(parseRollup(unechoed, P800_ROLLUP)).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("any reordering of the contexts gives the identical record (CAP-01 L7), and nothing throws", () => {
    const raw = load("rollup/rollup-776.json");
    const reversed = clone(raw);
    reversed.data.repository.object.statusCheckRollup.contexts.nodes.reverse();
    const p776 = REQUESTED["rollup/rollup-776.json"];
    expect(parseRollup(reversed, p776)).toEqual(parseRollup(raw, p776));
    const hostile = new Proxy(clone(raw), {
      ownKeys() {
        throw new Error("hostile proxy");
      },
    });
    expect(() => parseRollup(hostile, p776)).not.toThrow();
    expect(parseRollup(hostile, p776)).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("permutation of the contexts gives the same normalized multiset", () => {
    const a = ok(ext("rollup/rollup-776.json")).external;
    const raw = clone(load("rollup/rollup-776.json"));
    raw.data.repository.object.statusCheckRollup.contexts.nodes.reverse();
    const b = ok(bindExternal(ok(parseRollup(raw, REQUESTED["rollup/rollup-776.json"])))).external;
    const key = (e: any) => `${e.source}|${e.state}`;
    expect(b.map(key).sort()).toEqual(a.map(key).sort());
  });
});
