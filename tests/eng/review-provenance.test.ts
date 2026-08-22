import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { AUTHORIZED, COMPLETE, INCOMPLETE, UNAUTHORIZED, UNKNOWN, actorAuthority, collectionEvidence, mayAssertPositive, verdictEvidence } from "../../scripts/eng/evidence.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { collectFacts, flattenCheckRunPages, projectInlineComment, projectIssueComment, projectReview, serializeFacts } from "../../scripts/eng/github-facts.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { ciAtHead, classifyInlineComment, collectVerdicts, reviewCompletionAtHead, shaMatches, summarize } from "../../scripts/eng/review-provenance.mjs";

// ===========================================================================
// CP-005a acceptance: GitHub fact/provenance ingestion, and FACT QUALITY.
// ===========================================================================
//
// THE INVARIANT UNDER TEST:
//   a positive fact - CI GREEN, REVIEW CLEAN - may be emitted ONLY from
//   evidence that is both COMPLETE and AUTHORIZED.
//
// It exists because the first version stated that rule in prose and broke it
// twice at its first review: GREEN from an unpaginated read (5 of 12 checks),
// and COMPLETE_CLEAN from any actor's look-alike comment. The tests below aim
// at the invariant, not at a parser.
//
// Captured fixtures are PROJECTIONS of real Hone PRs (#610/#612/#613/#615/#616);
// raw responses are far larger than the fields provenance needs. Two synthetic
// fixtures cover cases GitHub has not handed us: a multi-page check-run
// collection whose failure is on page 2, and look-alike verdicts.
//
// This vehicle REPORTS. No findings state, no stop law, no release decision,
// no merge - CP-005b/CP-005c.

const FIXTURES = path.resolve(__dirname, "fixtures");
const FIX = (pr: number) => JSON.parse(readFileSync(path.join(FIXTURES, `pr-${pr}.json`), "utf8"));
const RAW = (name: string) => JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));

const HEAD_A = "a".repeat(40);
const findings = (f: { inlineComments: { value: never[] }; head: string }) =>
  f.inlineComments.value.map((c: never) => classifyInlineComment(c, f.head));

/** Build facts around a check-run collection, for the CI cases. */
const ciFacts = (items: unknown[], opts: object) => ({
  head: HEAD_A,
  checkRuns: collectionEvidence(items, opts),
});

/** Build facts around verdict surfaces, for the review cases. */
type Raw = Record<string, unknown>;
const reviewFacts = ({
  issues = [] as Raw[],
  reviews = [] as Raw[],
  inline = [] as Raw[],
  head = HEAD_A,
} = {}) => ({
  head,
  issueComments: collectionEvidence(issues.map(projectIssueComment), {}),
  reviews: collectionEvidence(reviews.map(projectReview), {}),
  inlineComments: collectionEvidence(inline.map(projectInlineComment), {}),
});

// ---------------------------------------------------------------------------
// THE GATE
// ---------------------------------------------------------------------------
describe("the invariant: a positive fact needs COMPLETE and AUTHORIZED evidence", () => {
  it("only complete AND authorized passes the gate", () => {
    const cases: [string, string, boolean][] = [
      [COMPLETE, AUTHORIZED, true],
      [COMPLETE, UNAUTHORIZED, false],
      [COMPLETE, UNKNOWN, false],
      [INCOMPLETE, AUTHORIZED, false],
      [INCOMPLETE, UNAUTHORIZED, false],
      [UNKNOWN, AUTHORIZED, false],
      [UNKNOWN, UNKNOWN, false],
    ];
    for (const [completeness, authority, allowed] of cases) {
      expect(mayAssertPositive({ completeness, authority })).toBe(allowed);
    }
    expect(mayAssertPositive(undefined)).toBe(false);
    expect(mayAssertPositive(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CHECK-RUN COLLECTION (required cases 1-4)
// ---------------------------------------------------------------------------
describe("check-run collection completeness", () => {
  it("1. a failure on a LATER page is seen, and the run is not green", () => {
    const pages = RAW("check-runs-paginated");
    const { items, totalCount, pages: n } = flattenCheckRunPages(pages);
    expect(n).toBe(2);
    expect(items.length).toBe(4);
    const ci = ciAtHead(ciFacts(items, { totalCount, pages: n }));
    expect(ci.status).toBe("RED");
    expect(ci.failing).toContain("browser shard 3 (extended)");
  });

  it("1b. reading only the FIRST page cannot report green - the original defect", () => {
    const pages = RAW("check-runs-paginated");
    const first = flattenCheckRunPages([pages[0]]);
    // Everything actually read is green, and it still must not be GREEN.
    expect(first.items.every((c: { conclusion: string }) => c.conclusion === "success")).toBe(true);
    const ci = ciAtHead(ciFacts(first.items, { totalCount: first.totalCount, pages: 1 }));
    expect(ci.status).toBe(UNKNOWN);
    expect(ci.status).not.toBe("GREEN");
    expect(ci.completeness).toBe(INCOMPLETE);
  });

  it("2. total_count greater than collected is INCOMPLETE, so never green", () => {
    // Arbitrary pagination: no page size is special-cased anywhere.
    for (const [collected, total] of [[1, 2], [7, 8], [29, 30], [30, 31], [99, 250]]) {
      const items = Array.from({ length: collected }, (_, i) => ({
        name: `check-${i}`, status: "completed", conclusion: "success", headSha: HEAD_A,
      }));
      const ci = ciAtHead(ciFacts(items, { totalCount: total }));
      expect(ci.completeness).toBe(INCOMPLETE);
      expect(ci.status).toBe(UNKNOWN);
    }
  });

  it("2b. collected equal to total_count is COMPLETE and may be green", () => {
    const items = Array.from({ length: 31 }, (_, i) => ({
      name: `check-${i}`, status: "completed", conclusion: "success", headSha: HEAD_A,
    }));
    const ci = ciAtHead(ciFacts(items, { totalCount: 31 }));
    expect(ci.completeness).toBe(COMPLETE);
    expect(ci.status).toBe("GREEN");
  });

  it("3. a pagination request that fails is UNKNOWN, never green", () => {
    const ci = ciAtHead({ head: HEAD_A, checkRuns: collectionEvidence(null, { error: "HTTP 502 on page 2" }) });
    expect(ci.status).toBe(UNKNOWN);
    expect(ci.reason).toMatch(/502/);
  });

  it("4. zero check runs is UNKNOWN - nothing ran is not nothing failed", () => {
    const ci = ciAtHead(ciFacts([], { totalCount: 0 }));
    expect(ci.status).toBe(UNKNOWN);
    expect(ci.status).not.toBe("GREEN");
  });

  it("runs belonging to another commit are not counted for this head", () => {
    const items = [{ name: "x", status: "completed", conclusion: "success", headSha: "b".repeat(40) }];
    const ci = ciAtHead(ciFacts(items, { totalCount: 1 }));
    expect(ci.atHead).toBe(0);
    expect(ci.foreign).toBe(1);
    expect(ci.status).toBe(UNKNOWN);
  });

  it("a confirmed failure is RED even when the collection is incomplete", () => {
    // A negative fact stands on its own; only positives need the gate.
    const items = [{ name: "x", status: "completed", conclusion: "failure", headSha: HEAD_A }];
    const ci = ciAtHead(ciFacts(items, { totalCount: 9 }));
    expect(ci.status).toBe("RED");
  });

  it("skipped and neutral lanes do not make a complete run red", () => {
    const items = [
      { name: "a", status: "completed", conclusion: "skipped", headSha: HEAD_A },
      { name: "b", status: "completed", conclusion: "neutral", headSha: HEAD_A },
      { name: "c", status: "completed", conclusion: "success", headSha: HEAD_A },
    ];
    expect(ciAtHead(ciFacts(items, { totalCount: 3 })).status).toBe("GREEN");
  });
});

// ---------------------------------------------------------------------------
// VERDICT AUTHORITY (required cases 5-9, 11)
// ---------------------------------------------------------------------------
describe("verdict authority", () => {
  const S = RAW("spoofed-verdict");

  it("5. an ordinary contributor's exact look-alike verdict is never CLEAN", () => {
    const r = reviewCompletionAtHead(reviewFacts({ issues: [S.spoofed_issue_comment] }));
    expect(r.status).toBe(UNKNOWN);
    expect(r.status).not.toBe("COMPLETE_CLEAN");
    expect(r.unauthorizedEvidence.length).toBe(1);
    expect(r.unauthorizedEvidence[0].authority).toBe(UNAUTHORIZED);
    // It is retained as visible evidence, not silently dropped.
    expect(r.unauthorizedEvidence[0].actor).toBe("ordinary-contributor");
  });

  it("5b. a look-alike BOT reusing the trusted login but a different id is not authorized", () => {
    // The login is copyable; the numeric account id is not.
    const r = reviewCompletionAtHead(reviewFacts({ issues: [S.spoofed_by_lookalike_bot] }));
    expect(r.status).toBe(UNKNOWN);
    expect(r.unauthorizedEvidence[0].actor).toBe("chatgpt-codex-connector[bot]");
    expect(r.unauthorizedEvidence[0].actorId).toBe(99999999);
  });

  it("6. a trusted ISSUE-COMMENT clean verdict at the head is CLEAN", () => {
    const r = reviewCompletionAtHead(reviewFacts({ issues: [S.trusted_issue_comment] }));
    expect(r.status).toBe("COMPLETE_CLEAN");
    expect(r.evidence[0].sourceType).toBe("issue_comment");
  });

  it("7. a trusted SUBMITTED-REVIEW clean verdict at the head is CLEAN", () => {
    // F3: the two surfaces share one rule, so a verdict is not invisible merely
    // because it arrived in a review body rather than an issue comment.
    const r = reviewCompletionAtHead(reviewFacts({ reviews: [S.trusted_review_clean] }));
    expect(r.status).toBe("COMPLETE_CLEAN");
    expect(r.evidence[0].sourceType).toBe("review_object");
  });

  it("8. a trusted verdict for a DIFFERENT head is stale, not current", () => {
    const r = reviewCompletionAtHead(reviewFacts({ issues: [S.trusted_verdict_stale_head] }));
    expect(r.status).toBe("NONE");
    expect(r.staleEvidence.length).toBe(1);
    expect(r.evidence.length).toBe(0);
  });

  it("9. an EMPTY-BODY review from the trusted actor at the head is UNKNOWN", () => {
    const r = reviewCompletionAtHead(reviewFacts({ reviews: [S.trusted_review_empty_body] }));
    expect(r.status).toBe(UNKNOWN);
    expect(r.status).not.toBe("COMPLETE_CLEAN");
    expect(r.reason).toMatch(/no body|states no verdict/i);
  });

  it("11. a verdict whose actor identity is missing is UNKNOWN, not unauthorized-and-not-clean-by-accident", () => {
    const v = verdictEvidence({ sourceType: "issue_comment", sourceId: 1, user: undefined, reviewedCommit: HEAD_A, clean: true });
    expect(v.authority).toBe(UNKNOWN);
    const r = reviewCompletionAtHead(reviewFacts({ issues: [S.verdict_missing_actor] }));
    expect(r.status).toBe(UNKNOWN);
  });

  it("authority never comes from author_association, which grades the wrong thing", () => {
    // Measured on real objects: Codex reports NONE while a human owner reports
    // OWNER, so a association-based rule would trust exactly the wrong actor.
    const owner = actorAuthority({ id: 26781116, type: "User", login: "SaiSamyukthVemuri" });
    expect(owner.authority).toBe(UNAUTHORIZED);
    const codex = actorAuthority({ id: 199175422, type: "Bot", login: "chatgpt-codex-connector[bot]" });
    expect(codex.authority).toBe(AUTHORIZED);
    const src = readFileSync(path.resolve(__dirname, "../../scripts/eng/evidence.mjs"), "utf8");
    expect(src.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "")).not.toMatch(/author_association/);
  });

  it("both surfaces normalize into ONE verdict shape", () => {
    const facts = reviewFacts({ issues: [S.trusted_issue_comment], reviews: [S.trusted_review_clean] });
    const vs = collectVerdicts(facts);
    expect(vs.length).toBe(2);
    for (const v of vs) {
      expect(Object.keys(v).sort()).toEqual(
        ["actor", "actorId", "atHead", "authority", "clean", "completeness", "reason", "reviewedCommit", "sourceId", "sourceType", "usable"].sort(),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// RE-ANCHORING (required case 10) - must not regress under the redesign
// ---------------------------------------------------------------------------
describe("10. inline finding freshness keys to the RAISED-at sha", () => {
  it("#615's finding was raised at the previous head and is carried, not fresh", () => {
    const f = FIX(615);
    const reAnchored = findings(f).filter((c: { reAnchored: boolean }) => c.reAnchored);
    expect(reAnchored.length).toBeGreaterThan(0);
    for (const c of reAnchored) {
      expect(c.displayedAt).toBe(f.head);
      expect(c.raisedAt).not.toBe(f.head);
      expect(c.freshness).toBe("carried");
    }
  });

  it("#610 carries six re-anchored comments, none of them fresh", () => {
    const f = FIX(610);
    const all = findings(f);
    expect(all.filter((c: { reAnchored: boolean }) => c.reAnchored).length).toBe(6);
    expect(all.filter((c: { kind: string; freshness: string }) => c.kind === "finding" && c.freshness === "fresh")).toEqual([]);
  });

  it("ANTI-VACUITY: moving a fixture's raised-at sha flips carried to fresh", () => {
    const f = FIX(610);
    const carried = findings(f).find((c: { kind: string; freshness: string }) => c.kind === "finding" && c.freshness === "carried");
    const rawC = f.inlineComments.value.find((c: { id: number }) => c.id === carried.id);
    expect(classifyInlineComment({ ...rawC, originalCommitId: f.head }, f.head).freshness).toBe("fresh");
    expect(carried.freshness).toBe("carried");
  });

  it("acknowledgements are split from findings by the severity badge", () => {
    const f = FIX(610);
    const all = findings(f);
    expect(all.filter((c: { kind: string }) => c.kind === "acknowledgement").length).toBe(11);
    expect(all.filter((c: { kind: string }) => c.kind === "finding").length).toBe(11);
  });

  it("a comment with no raised-at sha is UNKNOWN, not fresh", () => {
    const c = classifyInlineComment(projectInlineComment({ id: 1, body: "![P1 Badge](x)" }), HEAD_A);
    expect(c.freshness).toBe(UNKNOWN);
  });

  it("an abbreviated sha matches its full head; a different one does not", () => {
    expect(shaMatches("14baa34103", "14baa34103ce14fe47cb9ae472bec91baf95a7c1")).toBe(true);
    expect(shaMatches("0bee13502e", "14baa34103ce14fe47cb9ae472bec91baf95a7c1")).toBe(false);
    expect(shaMatches("14b", "14baa34103ce14fe47cb9ae472bec91baf95a7c1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// UNREADABLE SURFACES (required case 12)
// ---------------------------------------------------------------------------
describe("12. an unreadable surface stays UNKNOWN", () => {
  it("names what could not be read and reports no positive state", () => {
    const facts = collectFacts({ pr: 613, fetcher: () => ({ ok: false, reason: "gh: command not found" }) });
    expect(facts.head).toBe(UNKNOWN);
    expect(facts.unavailable.length).toBeGreaterThan(0);
    expect(facts.unavailable[0].reason).toMatch(/command not found/);
    expect(ciAtHead(facts).status).toBe(UNKNOWN);
    expect(reviewCompletionAtHead(facts).status).toBe(UNKNOWN);
    for (const bad of ["GREEN", "COMPLETE_CLEAN", "NONE"]) {
      expect(ciAtHead(facts).status).not.toBe(bad);
      expect(reviewCompletionAtHead(facts).status).not.toBe(bad);
    }
  });

  it("the fetcher is injectable, so the suite needs no network or credentials", () => {
    let asked = 0;
    collectFacts({ pr: 1, fetcher: () => { asked += 1; return { ok: false, reason: "stub" }; } });
    expect(asked).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// REAL HISTORIES + DETERMINISM
// ---------------------------------------------------------------------------
describe("the real fixture histories are still reported correctly", () => {
  it("#613: complete green CI at the exact head AND seven exact-head P1s", () => {
    const s = summarize(FIX(613));
    expect(s.ci.status).toBe("GREEN");
    expect(s.ci.completeness).toBe(COMPLETE);
    expect(s.review.status).toBe("COMPLETE_WITH_FINDINGS");
    expect(s.findings.fresh).toBe(7);
    expect(s.findings.bySeverity).toEqual({ P1: 7 });
  });

  it("#610: clean at the merged head, with carried findings and stale evidence retained", () => {
    const s = summarize(FIX(610));
    expect(s.review.status).toBe("COMPLETE_CLEAN");
    expect(s.findings.fresh).toBe(0);
    expect(s.findings.carried).toBe(11);
    expect(s.findings.acknowledgements).toBe(11);
    expect(s.review.staleEvidenceCount).toBeGreaterThan(0);
  });

  it("#612: twenty-nine findings, every one carried, none fresh", () => {
    const s = summarize(FIX(612));
    expect(s.findings.carried).toBe(29);
    expect(s.findings.fresh).toBe(0);
  });

  it("#616: the live F4 instance is raw evidence, not a finding", () => {
    // This fixture is the MERGED head. The one trusted finding raised there is
    // F4 itself; the badge-carrying comment beside it is the disposition reply
    // that reproduced F4 in the wild, and it is now attributed rather than
    // counted. Both guards name themselves in the reason.
    const s = summarize(FIX(616));
    expect(s.findings.fresh).toBe(1);
    expect(s.findings.bySeverity).toEqual({ P2: 1 });
    expect(s.findings.rawEvidence).toHaveLength(1);
    const raw = s.findings.rawEvidence[0];
    expect(raw.actorId).toBe(26781116);
    expect(raw.severity).toBe("P1");
    expect(raw.reason).toMatch(/not the trusted reviewer/);
    expect(raw.reason).toMatch(/reply rather than a finding/);
  });

  it("every captured fixture's check-run collection is COMPLETE", () => {
    for (const pr of [610, 612, 613, 615, 616]) {
      expect(FIX(pr).checkRuns.completeness).toBe(COMPLETE);
    }
  });

  it("serialization is byte-identical across repeated runs, and carries no secrets", () => {
    for (const pr of [610, 612, 613, 615, 616]) {
      const raw = readFileSync(path.join(FIXTURES, `pr-${pr}.json`), "utf8").trim();
      expect(serializeFacts(JSON.parse(raw))).toBe(raw);
      expect(raw).not.toMatch(/sk_live_|whsec_|ghp_|gho_|Bearer\s+[A-Za-z0-9]/);
    }
  });
});

describe("this vehicle has no authority beyond reporting", () => {
  it("exposes no merge, no writes, no findings state and no stop law", () => {
    const src = ["evidence.mjs", "github-facts.mjs", "review-provenance.mjs", "cli.mjs"]
      .map((f) => readFileSync(path.resolve(__dirname, "../../scripts/eng", f), "utf8"))
      .join("\n");
    const code = src.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    expect(code).not.toMatch(/pr\s+merge|--merge\b|mergePullRequest|squash/);
    expect(code).not.toMatch(/writeFileSync|appendFileSync|-X\s*(POST|PATCH|PUT|DELETE)|--method/);
    expect(code).not.toMatch(/REPAIRED@|VERIFIED@|ACCEPTED_RISK|repairRound/);
    expect(code).not.toMatch(/RELEASE_READY|ARCHITECTURE_REVIEW|TEST_AUTHORITY_STOP|WAIT_FOR_OPERATOR_GO|root_cause_family/);
    expect(code).not.toMatch(/setInterval|setTimeout|while\s*\(true\)|daemon/);
  });
});
