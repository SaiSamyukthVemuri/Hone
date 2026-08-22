import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { AUTHORIZED, COMPLETE, INCOMPLETE, UNAUTHORIZED, UNKNOWN, actorAuthority, collectionEvidence, verdictEvidence } from "../../scripts/eng/evidence.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { collectFacts, flattenCheckRunPages, projectInlineComment, projectIssueComment, projectReview, serializeFacts } from "../../scripts/eng/github-facts.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { WAIT_FOR_OPERATOR_GO, ciFactsAtHead, classifyInlineComment, collectVerdicts, reviewFactsAtHead, shaMatches, summarize } from "../../scripts/eng/review-provenance.mjs";

// ===========================================================================
// CP-005 FACT-ONLY PACKET — acceptance.
// ===========================================================================
//
// THE CONTRACT, and it is a SUBTRACTION:
//
//   This tool reports what was OBSERVED and what was PROVEN NEGATIVE. It never
//   emits GREEN, CLEAN, TRUSTED or RELEASE_READY, and it never converts an
//   absence of bad evidence into readiness.
//
// Five vehicles (#617-#621) tried to decide when evidence was good enough to
// justify a positive assertion. All five were retired for one family: unknown,
// invalid or incomplete evidence producing a positive conclusion. The claim was
// the liability, so the claim is gone.
//
// Everything that read GitHub honestly is kept and still proved here:
// pagination completeness, actor authority by immutable id, re-anchoring,
// stale-vs-current heads, UNKNOWN as first class.

const FIXTURES = path.resolve(__dirname, "fixtures");
const FIX = (pr: number) => JSON.parse(readFileSync(path.join(FIXTURES, `pr-${pr}.json`), "utf8"));
const RAW = (name: string) => JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));

const HEAD_A = "a".repeat(40);
type Raw = Record<string, unknown>;

const ciFacts = (items: unknown[], opts: object) => ({ head: HEAD_A, checkRuns: collectionEvidence(items, opts) });
const reviewFacts = ({ issues = [] as Raw[], reviews = [] as Raw[], inline = [] as Raw[], head = HEAD_A } = {}) => ({
  head,
  issueComments: collectionEvidence(issues.map(projectIssueComment), {}),
  reviews: collectionEvidence(reviews.map(projectReview), {}),
  inlineComments: collectionEvidence(inline.map(projectInlineComment), {}),
});

// ---------------------------------------------------------------------------
// THE CONTRACT: NO POSITIVE CONCLUSION IS REACHABLE
// ---------------------------------------------------------------------------

const FORBIDDEN = ["GREEN", "COMPLETE_CLEAN", "COMPLETE_WITH_FINDINGS", "RELEASE_READY", "TRUSTED", "READY"];

describe("no positive conclusion is reachable, from any input", () => {
  const SPOOF = RAW("spoofed-verdict");
  // The MOST favourable inputs that exist: complete CI, trusted clean verdict,
  // no findings. Under every retired vehicle this produced GREEN + CLEAN.
  const perfect = {
    ...reviewFacts({ issues: [SPOOF.trusted_issue_comment] }),
    ...ciFacts([{ name: "validate", status: "completed", conclusion: "success", headSha: HEAD_A }], { totalCount: 1 }),
    head: HEAD_A,
    repo: "r",
    pr: 1,
    pullRequest: UNKNOWN,
    unavailable: [],
  };

  it("the perfect case yields facts and a constant, not a verdict", () => {
    const ci = ciFactsAtHead(perfect);
    const rv = reviewFactsAtHead(perfect);
    expect(ci.boundToHead).toBe(1);
    expect(ci.failuresObserved).toEqual([]);
    expect(ci.completeness).toBe(COMPLETE);
    expect(rv.verdictsAtHead).toBe(1);
    expect(rv.currentFindings).toEqual([]);
    // ...and there is no field anywhere saying it is good.
    expect("status" in ci).toBe(false);
    expect("status" in rv).toBe(false);
    expect(summarize(perfect).controlPlaneResult).toBe(WAIT_FOR_OPERATOR_GO);
  });

  it("no serialized packet from any fixture contains a positive verdict word", () => {
    const packets = [perfect, ...[610, 612, 613, 615, 616].map(FIX)].map((f) => JSON.stringify(summarize(f)));
    for (const p of packets) {
      for (const word of FORBIDDEN) expect(p).not.toContain(`"${word}"`);
      expect(p).toContain(WAIT_FOR_OPERATOR_GO);
    }
  });

  it("controlPlaneResult is a constant, never a computation", () => {
    // Every real history, plus a totally unreadable PR, yields the same value.
    const unreadable = collectFacts({ pr: 1, fetcher: () => ({ ok: false, reason: "gh: not found" }) });
    const all = [perfect, unreadable, ...[610, 612, 613, 615, 616].map(FIX)];
    expect(new Set(all.map((f) => summarize(f).controlPlaneResult))).toEqual(new Set([WAIT_FOR_OPERATOR_GO]));
    // And the source contains no branch that could make it anything else.
    const src = readFileSync(path.resolve(__dirname, "../../scripts/eng/review-provenance.mjs"), "utf8");
    expect(src).toMatch(/controlPlaneResult: WAIT_FOR_OPERATOR_GO/);
    expect(src).not.toMatch(/controlPlaneResult:\s*\w+\s*[?]/);
  });

  it("the gate is gone from evidence.mjs and imported nowhere", () => {
    for (const f of ["evidence.mjs", "github-facts.mjs", "review-provenance.mjs", "cli.mjs"]) {
      const code = readFileSync(path.resolve(__dirname, "../../scripts/eng", f), "utf8")
        .replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
      expect(code).not.toMatch(/mayAssertPositive/);
      for (const word of FORBIDDEN) expect(code).not.toContain(`"${word}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// CI FACTS — observations and proven negatives
// ---------------------------------------------------------------------------

describe("check-run collection facts", () => {
  const run = (o: Raw = {}) => ({ name: "validate", status: "completed", conclusion: "success", headSha: HEAD_A, ...o });

  it("1. a failure on a LATER page is seen and reported as an observed failure", () => {
    const { items, totalCount } = flattenCheckRunPages(RAW("check-runs-paginated"));
    const ci = ciFactsAtHead(ciFacts(items, { totalCount }));
    expect(ci.completeness).toBe(COMPLETE);
    expect(ci.failuresObserved.length).toBeGreaterThan(0);
  });

  it("1b. reading only the FIRST page reports INCOMPLETE, and states no more", () => {
    const pages = RAW("check-runs-paginated");
    const first = flattenCheckRunPages([pages[0]]);
    expect(first.items.every((c: { conclusion: string }) => c.conclusion === "success")).toBe(true);
    const ci = ciFactsAtHead(ciFacts(first.items, { totalCount: first.totalCount }));
    expect(ci.completeness).toBe(INCOMPLETE);
    expect(ci.failuresObserved).toEqual([]); // observed none...
    expect(JSON.stringify(ci)).not.toContain("GREEN"); // ...which is NOT green
  });

  it("2. total_count greater than collected is INCOMPLETE", () => {
    expect(ciFactsAtHead(ciFacts([run()], { totalCount: 12 })).completeness).toBe(INCOMPLETE);
  });

  it("2b. collected equal to total_count is COMPLETE", () => {
    expect(ciFactsAtHead(ciFacts([run()], { totalCount: 1 })).completeness).toBe(COMPLETE);
  });

  it("3. a pagination request that failed is UNKNOWN in every field", () => {
    const ci = ciFactsAtHead(ciFacts(null as never, { error: "gh api failed" }));
    expect(ci.completeness).toBe(UNKNOWN);
    expect(ci.checksObserved).toBe(UNKNOWN);
    expect(ci.failuresObserved).toBe(UNKNOWN);
  });

  it("4. zero check runs is reported as zero observed, not as success", () => {
    const ci = ciFactsAtHead(ciFacts([], { totalCount: 0 }));
    expect(ci.boundToHead).toBe(0);
    expect(ci.passedObserved).toBe(0);
    expect(ci.failuresObserved).toEqual([]);
  });

  it("runs belonging to another commit are counted as foreign, not for this head", () => {
    const ci = ciFactsAtHead(ciFacts([run(), run({ name: "o", headSha: "b".repeat(40) })], { totalCount: 2 }));
    expect(ci.boundToHead).toBe(1);
    expect(ci.foreign).toBe(1);
  });

  it("a confirmed failure is reported even when the collection is incomplete", () => {
    // A proven negative stands alone; only positives ever needed completeness.
    const ci = ciFactsAtHead(ciFacts([run({ conclusion: "failure" })], { totalCount: 9 }));
    expect(ci.completeness).toBe(INCOMPLETE);
    expect(ci.failuresObserved).toEqual(["validate"]);
  });

  it("skipped and neutral lanes are counted apart from passes and failures", () => {
    const ci = ciFactsAtHead(
      ciFacts([run(), run({ name: "db", conclusion: "skipped" }), run({ name: "n", conclusion: "neutral" })], { totalCount: 3 }),
    );
    expect(ci.passedObserved).toBe(1);
    expect(ci.skippedObserved).toBe(2);
    expect(ci.failuresObserved).toEqual([]);
  });

  it("a still-running check is reported as running, not as absent", () => {
    const ci = ciFactsAtHead(ciFacts([run({ status: "in_progress", conclusion: null })], { totalCount: 1 }));
    expect(ci.stillRunning).toEqual(["validate"]);
    expect(ci.passedObserved).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// REVIEW FACTS — authority is still decided, it just concludes nothing
// ---------------------------------------------------------------------------

describe("verdict authority remains a fact", () => {
  const SPOOF = RAW("spoofed-verdict");

  it("the spoof fixture differs from the trusted one ONLY by actor", () => {
    expect(SPOOF.spoofed_issue_comment.body).toBe(SPOOF.trusted_issue_comment.body);
    expect(SPOOF.spoofed_by_lookalike_bot.user.login).toBe(SPOOF.trusted_issue_comment.user.login);
    expect(SPOOF.spoofed_by_lookalike_bot.user.id).not.toBe(SPOOF.trusted_issue_comment.user.id);
  });

  it("5. an ordinary contributor's exact look-alike is reported as unauthorized", () => {
    const rv = reviewFactsAtHead(reviewFacts({ issues: [SPOOF.spoofed_issue_comment] }));
    expect(rv.unauthorizedAtHead.length).toBe(1);
    expect(rv.trustedOutcomesAtHead).toEqual([]);
  });

  it("5b. a look-alike BOT reusing the trusted login but a different id is unauthorized", () => {
    const rv = reviewFactsAtHead(reviewFacts({ issues: [SPOOF.spoofed_by_lookalike_bot] }));
    expect(rv.unauthorizedAtHead.length).toBe(1);
    expect(rv.trustedOutcomesAtHead).toEqual([]);
  });

  it("6/7. a trusted verdict from EITHER surface reports what it stated", () => {
    const fromIssue = reviewFactsAtHead(reviewFacts({ issues: [SPOOF.trusted_issue_comment] }));
    const fromReview = reviewFactsAtHead(reviewFacts({ reviews: [SPOOF.trusted_review_clean] }));
    expect(fromIssue.trustedOutcomesAtHead[0].statedOutcome).toBe("clean");
    expect(fromReview.trustedOutcomesAtHead[0].statedOutcome).toBe("clean");
  });

  it("8. a trusted verdict for a DIFFERENT head is stale, and stays visible", () => {
    const rv = reviewFactsAtHead(reviewFacts({ issues: [SPOOF.trusted_verdict_stale_head] }));
    expect(rv.verdictsAtHead).toBe(0);
    expect(rv.staleEvidence.length).toBe(1);
  });

  it("9. an EMPTY-BODY review from the trusted actor states UNKNOWN, not clean", () => {
    const rv = reviewFactsAtHead(reviewFacts({ reviews: [SPOOF.trusted_review_empty_body] }));
    expect(rv.trustedOutcomesAtHead[0].statedOutcome).toBe(UNKNOWN);
  });

  it("11. a verdict with a missing actor is UNKNOWN authority, not unauthorized", () => {
    const rv = reviewFactsAtHead(reviewFacts({ issues: [SPOOF.verdict_missing_actor] }));
    expect(rv.unknownAuthorityAtHead.length).toBe(1);
    expect(rv.unauthorizedAtHead.length).toBe(0);
  });

  it("authority comes from the immutable id, never author_association", () => {
    // Codex reports NONE while the human repository owner reports OWNER.
    expect(actorAuthority({ id: 199175422, type: "Bot", author_association: "NONE" }).authority).toBe(AUTHORIZED);
    expect(actorAuthority({ id: 123, type: "Bot", author_association: "OWNER" }).authority).toBe(UNAUTHORIZED);
  });

  it("both surfaces normalize into ONE verdict shape, with no cached usable flag", () => {
    const vs = collectVerdicts(reviewFacts({ issues: [SPOOF.trusted_issue_comment], reviews: [SPOOF.trusted_review_clean] }));
    expect(vs.length).toBe(2);
    for (const v of vs) {
      expect("usable" in v).toBe(false);
      expect(v.statedOutcome).toBeDefined();
    }
  });

  it("an abbreviated sha matches its full head; a different one does not", () => {
    expect(shaMatches("aaaaaaaaaa", HEAD_A)).toBe(true);
    expect(shaMatches("bbbbbbbbbb", HEAD_A)).toBe(false);
    expect(shaMatches("aaa", HEAD_A)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FINDINGS, FRESHNESS AND RE-ANCHORING
// ---------------------------------------------------------------------------

describe("10. finding freshness keys to the RAISED-at sha", () => {
  const badge = "**<sub><sub>![P1 Badge](x)</sub></sub>  A finding**\n\nbody.";
  const inline = (o: Raw = {}) => ({
    id: 9, user: { login: "c", id: 199175422, type: "Bot" }, commit_id: HEAD_A, original_commit_id: HEAD_A,
    path: "lib/x.ts", line: 3, original_line: 3, body: badge, ...o,
  });
  const one = (o: Raw = {}, head = HEAD_A) => classifyInlineComment(projectInlineComment(inline(o)), head);

  it("the display line and the original line are SEPARATE facts", () => {
    // One field held both in production, which is how a finding gets keyed to a
    // position that moves when GitHub re-anchors it.
    const p = projectInlineComment(inline({ line: 552, original_line: 407 }));
    expect(p.line).toBe(552);
    expect(p.originalLine).toBe(407);
    // An outdated comment has a null display line and keeps its original.
    const outdated = projectInlineComment(inline({ line: null, original_line: 407 }));
    expect(outdated.line).toBe(null);
    expect(outdated.originalLine).toBe(407);
  });

  it("the classified finding carries the STABLE line, which is what the CLI prints", () => {
    // The packet renders `${path}:${originalLine}` from here. If this ever
    // reads the display line, a re-anchored finding is reported at a position
    // that moved - the conflation this vehicle exists to remove.
    const f = one({ line: 552, original_line: 407 });
    expect(f.originalLine).toBe(407);
    expect(f.line).toBe(552);
    // An outdated comment has no display line at all and still locates.
    expect(one({ line: null, original_line: 407 }).originalLine).toBe(407);
  });

  it("re-anchoring moves the display commit but not the raised-at sha", () => {
    const f = one({ commit_id: "b".repeat(40) });
    expect(f.freshness).toBe("fresh");
    expect(f.raisedAt).toBe(HEAD_A);
    expect(f.reAnchored).toBe(true);
  });

  it("a finding raised at an earlier head is carried, not current", () => {
    expect(one({ original_commit_id: "b".repeat(40) }).freshness).toBe("carried");
  });

  it("ANTI-VACUITY: moving the raised-at sha flips carried to fresh", () => {
    expect(one({ original_commit_id: "b".repeat(40) }, "b".repeat(40)).freshness).toBe("fresh");
  });

  it("a comment with no raised-at sha has UNKNOWN freshness, never fresh", () => {
    expect(one({ original_commit_id: null }).freshness).toBe(UNKNOWN);
  });

  it("acknowledgements are split from findings by the severity badge", () => {
    expect(one({ body: "thanks, fixed" }).kind).toBe("acknowledgement");
    expect(one().kind).toBe("finding");
  });
});

// ---------------------------------------------------------------------------
// UNREADABLE SURFACES AND REAL HISTORIES
// ---------------------------------------------------------------------------

describe("12. an unreadable surface stays UNKNOWN", () => {
  it("names what could not be read and states no facts about it", () => {
    const f = collectFacts({ pr: 1, fetcher: () => ({ ok: false, reason: "gh: not found" }) });
    expect(f.head).toBe(UNKNOWN);
    expect(ciFactsAtHead(f).completeness).toBe(UNKNOWN);
    expect(reviewFactsAtHead(f).verdictObjects).toBe(UNKNOWN);
    expect(f.unavailable.length).toBeGreaterThan(0);
    expect(summarize(f).unknownEvidence.length).toBeGreaterThan(0);
  });

  it("the fetcher is injectable, so the suite needs no network or credentials", () => {
    const calls: string[] = [];
    collectFacts({ pr: 7, fetcher: (p: string) => { calls.push(p); return { ok: false, reason: "stub" }; } });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.includes("7"))).toBe(true);
  });
});

describe("the real fixture histories are reported as facts", () => {
  it("#613: 12 of 12 checks bound and complete, and seven current-head P1s", () => {
    const ci = ciFactsAtHead(FIX(613));
    expect(ci.boundToHead).toBe(12);
    expect(ci.completeness).toBe(COMPLETE);
    expect(ci.failuresObserved).toEqual([]);
    expect(reviewFactsAtHead(FIX(613)).currentFindings.length).toBe(7);
  });

  it("#610: 11 carried findings and 6 re-anchored, none current", () => {
    const rv = reviewFactsAtHead(FIX(610));
    expect(rv.currentFindings.length).toBe(0);
    expect(rv.carriedFindings.length).toBe(11);
    expect(rv.reAnchored).toBe(6);
    // The packet shows these instead of a one-word conclusion over them.
    expect(summarize(FIX(610)).findings.carried).toBe(11);
  });

  it("#612: carried findings and unauthorized look-alikes are BOTH visible", () => {
    const rv = reviewFactsAtHead(FIX(612));
    expect(rv.currentFindings.length).toBe(0);
    expect(rv.carriedFindings.length).toBeGreaterThan(0);
    expect(rv.unauthorizedAtHead.length).toBeGreaterThan(0);
  });

  it("#616: its own findings are reported at its head", () => {
    expect(reviewFactsAtHead(FIX(616)).currentFindings.length).toBeGreaterThan(0);
  });

  it("#615: its finding was raised at the previous head and is carried", () => {
    expect(reviewFactsAtHead(FIX(615)).carriedFindings.length).toBeGreaterThan(0);
  });

  it("every captured fixture's check-run collection is COMPLETE", () => {
    for (const pr of [610, 612, 613, 615, 616]) expect(FIX(pr).checkRuns.completeness).toBe(COMPLETE);
  });

  it("serialization is byte-identical across repeated runs, and carries no secrets", () => {
    const a = serializeFacts(FIX(613));
    expect(a).toBe(serializeFacts(FIX(613)));
    expect(a).not.toMatch(/gh[pousr]_[A-Za-z0-9]{16,}/);
  });
});

describe("this tool has no authority beyond reporting", () => {
  it("exposes no merge, no writes, no findings state and no stop law", () => {
    const src = ["evidence.mjs", "github-facts.mjs", "review-provenance.mjs", "cli.mjs"]
      .map((f) => readFileSync(path.resolve(__dirname, "../../scripts/eng", f), "utf8"))
      .join("\n")
      .replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    for (const forbidden of ["pr merge", "--merge", "gh pr close", "REPAIR_", "ACCEPTED_RISK"]) {
      expect(src).not.toContain(forbidden);
    }
    const s = summarize(FIX(613));
    expect(Object.keys(s)).not.toContain("decision");
    expect(Object.keys(s)).not.toContain("releaseReady");
    expect(s.controlPlaneResult).toBe(WAIT_FOR_OPERATOR_GO);
  });
});
