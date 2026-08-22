import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { collectFacts, projectInlineComment, projectIssueComment, projectReview, serializeFacts, UNKNOWN } from "../../scripts/eng/github-facts.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { ciAtHead, classifyInlineComment, classifyReview, reviewCompletionAtHead, shaMatches, summarize } from "../../scripts/eng/review-provenance.mjs";

// ===========================================================================
// CP-005a acceptance: GitHub fact/provenance ingestion.
// ===========================================================================
//
// Fixtures are PROJECTIONS of real Hone pull requests, captured from the
// GitHub API. Raw responses are 1.36 MB; the fields provenance actually needs
// are 88 KB, so the projection is what is vendored. No network, no credentials.
//
//   #610 - the false-clean watcher history: 19 reviews across 8 heads,
//          4 clean verdicts at 3 different shas, 6 re-anchored comments,
//          11 acknowledgements. Merged.
//   #612 - 9 review rounds, 29 findings, all P2, all on test files.
//   #613 - CI green 12/12 at the exact head AND 7 exact-head P1s.
//   #615 - a finding raised at the previous head, displayed at the current one.
//
// This vehicle REPORTS. It records no findings state, applies no stop law,
// decides no release readiness and cannot merge; those are CP-005b/CP-005c.

const FIX = (pr: number) =>
  JSON.parse(readFileSync(path.resolve(__dirname, `fixtures/pr-${pr}.json`), "utf8"));

type Facts = ReturnType<typeof FIX>;

const findings = (f: Facts) =>
  f.inlineComments.map((c: never) => classifyInlineComment(c, f.head));

describe("1. originalCommitId decides where a finding was RAISED", () => {
  it("distinguishes raised-at from where GitHub re-anchors it", () => {
    // #615's only finding was raised at 2c3e5bae and is DISPLAYED at 0bee1350.
    // Reading commitId alone would call it a current-head finding.
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
    const reAnchored = all.filter((c: { reAnchored: boolean }) => c.reAnchored);
    expect(reAnchored.length).toBe(6);
    // A P2 raised at the FIRST head is displayed at the merged head.
    expect(reAnchored.every((c: { freshness: string }) => c.freshness === "carried")).toBe(true);
    expect(all.filter((c: { kind: string; freshness: string }) => c.kind === "finding" && c.freshness === "fresh")).toEqual([]);
  });

  it("ANTI-VACUITY: moving a fixture's raised-at sha flips freshness", () => {
    // Without this, "no fresh findings" could pass for a classifier that never
    // reports fresh at all.
    const f = FIX(610);
    const carried = findings(f).find((c: { kind: string; freshness: string }) => c.kind === "finding" && c.freshness === "carried");
    expect(carried).toBeDefined();
    const raw = f.inlineComments.find((c: { id: number }) => c.id === carried.id);
    const moved = classifyInlineComment({ ...raw, originalCommitId: f.head }, f.head);
    expect(moved.freshness).toBe("fresh");
    expect(carried.freshness).toBe("carried");
  });

  it("a comment with no raised-at sha is UNKNOWN, not fresh", () => {
    const c = classifyInlineComment(projectInlineComment({ id: 1, body: "![P1 Badge](x)" }), "abc1234def");
    expect(c.freshness).toBe(UNKNOWN);
    expect(c.freshness).not.toBe("fresh");
  });
});

describe("2. review commitId identifies the exact reviewed head", () => {
  it("#613's single review is bound to the exact head", () => {
    const f = FIX(613);
    const c = classifyReview(f.reviews[0], f.head);
    expect(c.reviewedHead).toBe(f.head);
    expect(c.atHead).toBe(true);
    expect(c.staleness).toBe("current");
  });

  it("#610's nineteen reviews span eight heads; only those at head are current", () => {
    const f = FIX(610);
    const classified = f.reviews.map((r: never) => classifyReview(r, f.head));
    const heads = new Set(f.reviews.map((r: { commitId: string }) => r.commitId));
    expect(f.reviews.length).toBe(19);
    expect(heads.size).toBe(8);
    const current = classified.filter((c: { staleness: string }) => c.staleness === "current");
    const stale = classified.filter((c: { staleness: string }) => c.staleness === "stale");
    expect(stale.length).toBeGreaterThan(0);
    expect(current.length + stale.length).toBe(19);
  });

  it("an abbreviated sha still matches its full head, and a different one does not", () => {
    // Codex writes 10-character shas. Exact equality would make every verdict
    // read as "for some other head".
    expect(shaMatches("14baa34103", "14baa34103ce14fe47cb9ae472bec91baf95a7c1")).toBe(true);
    expect(shaMatches("14baa34103ce14fe47cb9ae472bec91baf95a7c1", "14baa34103")).toBe(true);
    expect(shaMatches("0bee13502e", "14baa34103ce14fe47cb9ae472bec91baf95a7c1")).toBe(false);
    // Too short to be evidence of anything.
    expect(shaMatches("14b", "14baa34103ce14fe47cb9ae472bec91baf95a7c1")).toBe(false);
  });
});

describe("3. verdicts are ingested separately from review objects", () => {
  it("#610's four clean verdicts live in ISSUE comments, at three different heads", () => {
    const f = FIX(610);
    const verdicts = f.issueComments.filter((c: { isVerdict: boolean }) => c.isVerdict);
    expect(verdicts.length).toBe(4);
    expect(verdicts.every((v: { verdictClean: boolean }) => v.verdictClean)).toBe(true);
    expect(new Set(verdicts.map((v: { verdictCommit: string }) => v.verdictCommit)).size).toBe(3);
    // The verdict for 3859f636 is the one an operator recorded as never having
    // arrived, 43 minutes after it was posted.
    expect(verdicts.some((v: { verdictCommit: string }) => v.verdictCommit.startsWith("3859f636"))).toBe(true);
  });

  it("a review request is a distinct surface from a verdict", () => {
    const req = projectIssueComment({ id: 1, body: "@codex review\n\nHead under review: `abc1234def0`" });
    expect(req.isReviewRequest).toBe(true);
    expect(req.isVerdict).toBe(false);
    expect(req.requestedCommit).toBe("abc1234def0");

    const verdict = projectIssueComment({
      id: 2,
      body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `abc1234def`",
    });
    expect(verdict.isVerdict).toBe(true);
    expect(verdict.verdictClean).toBe(true);
    expect(verdict.isReviewRequest).toBe(false);
  });
});

describe("4. check runs are bound to an exact head sha", () => {
  it("#613 is green with every check bound to the head under evaluation", () => {
    const f = FIX(613);
    const ci = ciAtHead(f);
    expect(ci.status).toBe("GREEN");
    expect(ci.atHead).toBe(12);
    expect(f.checkRuns.every((c: { headSha: string }) => c.headSha === f.head)).toBe(true);
  });

  it("checks belonging to another commit are NOT counted for this head", () => {
    const f = FIX(613);
    const foreign = { ...f, checkRuns: f.checkRuns.map((c: object) => ({ ...c, headSha: "f".repeat(40) })) };
    const ci = ciAtHead(foreign);
    expect(ci.status).toBe(UNKNOWN);
    expect(ci.atHead).toBe(0);
    expect(ci.foreign).toBe(12);
  });

  it("ZERO checks at this head is UNKNOWN, never GREEN", () => {
    // "nothing failed" and "nothing ran" are different facts.
    const f = FIX(613);
    const ci = ciAtHead({ ...f, checkRuns: [] });
    expect(ci.status).toBe(UNKNOWN);
    expect(ci.status).not.toBe("GREEN");
  });

  it("a single failing or pending check is not green", () => {
    const f = FIX(613);
    const red = f.checkRuns.map((c: { name: string }, i: number) =>
      i === 0 ? { ...c, conclusion: "failure" } : c,
    );
    expect(ciAtHead({ ...f, checkRuns: red }).status).toBe("RED");
    const pending = f.checkRuns.map((c: { name: string }, i: number) =>
      i === 0 ? { ...c, status: "in_progress", conclusion: null } : c,
    );
    expect(ciAtHead({ ...f, checkRuns: pending }).status).toBe("PENDING");
  });

  it("skipped lanes do not make a run red", () => {
    // A lane the classifier did not select reports skipped, by design.
    const f = FIX(613);
    const skipped = f.checkRuns.map((c: object, i: number) =>
      i < 3 ? { ...c, conclusion: "skipped" } : c,
    );
    expect(ciAtHead({ ...f, checkRuns: skipped }).status).toBe("GREEN");
  });
});

describe("5. acknowledgements and requests are never review completion", () => {
  it("#610's eleven acknowledgements are classified as such, not as findings", () => {
    const f = FIX(610);
    const all = findings(f);
    expect(all.filter((c: { kind: string }) => c.kind === "acknowledgement").length).toBe(11);
    expect(all.filter((c: { kind: string }) => c.kind === "finding").length).toBe(11);
  });

  it("a reply carrying no severity badge is not a finding, however it reads", () => {
    const ack = classifyInlineComment(
      projectInlineComment({
        id: 9,
        body: "**Fixed on current head `07fbd801`.** You were right, and the test I had written was vacuous.",
        commit_id: "07fbd801c5",
        original_commit_id: "07fbd801c5",
      }),
      "07fbd801c5305d988b8ff957c6202c70a779cde7",
    );
    expect(ack.kind).toBe("acknowledgement");
    expect(ack.severity).toBeNull();
  });

  it("a requested review with no verdict for that head is REQUESTED_UNANSWERED, not complete", () => {
    const f = FIX(613);
    const noVerdict = {
      ...f,
      reviews: [],
      issueComments: [{ id: 1, author: "op", createdAt: null, isVerdict: false, verdictCommit: null, verdictClean: null, isReviewRequest: true, requestedCommit: null }],
      inlineComments: [],
    };
    const r = reviewCompletionAtHead(noVerdict);
    expect(r.status).toBe("REQUESTED_UNANSWERED");
    expect(r.status).not.toBe("COMPLETE_CLEAN");
  });

  it("reactions are not evidence: they carry no severity and no verdict", () => {
    const reacted = projectInlineComment({ id: 3, body: "looks right to me", reactions: { total_count: 4 } });
    expect(reacted.severity).toBeNull();
    expect(reacted.reactionCount).toBe(4);
    expect(classifyInlineComment(reacted, "abc1234def").kind).toBe("acknowledgement");
  });
});

describe("6. stale evidence is represented as stale, never as current", () => {
  it("#610 reports one verdict at the head and twenty-two stale evidence objects", () => {
    const f = FIX(610);
    const r = reviewCompletionAtHead(f);
    expect(r.status).toBe("COMPLETE_CLEAN");
    expect(r.evidence.length).toBe(1);
    expect(r.staleEvidence.length).toBe(22);
    // Stale evidence is retained and attributed, not discarded.
    expect(r.staleEvidence.every((e: { head: string }) => e.head !== f.head)).toBe(true);
  });

  it("a clean verdict for an EARLIER head does not make the current head clean", () => {
    const f = FIX(613);
    const onlyOldVerdict = {
      ...f,
      reviews: [],
      inlineComments: [],
      issueComments: [{ id: 1, author: "bot", createdAt: null, isVerdict: true, verdictCommit: "deadbeef12", verdictClean: true, isReviewRequest: false, requestedCommit: null }],
    };
    const r = reviewCompletionAtHead(onlyOldVerdict);
    expect(r.status).toBe("NONE");
    expect(r.staleEvidence.length).toBe(1);
  });
});

describe("7. unknown stays UNKNOWN and never becomes clean", () => {
  it("an unreadable surface degrades that surface, and is named", () => {
    const failing = () => ({ ok: false, reason: "gh: command not found" });
    const facts = collectFacts({ pr: 613, fetcher: failing });
    expect(facts.head).toBe(UNKNOWN);
    expect(facts.reviews).toBe(UNKNOWN);
    expect(facts.checkRuns).toBe(UNKNOWN);
    expect(facts.unavailable.length).toBeGreaterThan(0);
    expect(facts.unavailable[0].reason).toMatch(/gh: command not found/);
  });

  it("with nothing readable, review status is UNKNOWN and CI is UNKNOWN", () => {
    const facts = collectFacts({ pr: 613, fetcher: () => ({ ok: false, reason: "not authenticated" }) });
    expect(reviewCompletionAtHead(facts).status).toBe(UNKNOWN);
    expect(ciAtHead(facts).status).toBe(UNKNOWN);
    for (const bad of ["NONE", "COMPLETE_CLEAN", "GREEN"]) {
      expect(reviewCompletionAtHead(facts).status).not.toBe(bad);
      expect(ciAtHead(facts).status).not.toBe(bad);
    }
  });

  it("an EMPTY-BODY review at the head is UNKNOWN, not a clean verdict", () => {
    // Observed on #615 at 0bee1350: a review object with no body at all.
    const f = FIX(613);
    const emptyOnly = {
      ...f,
      reviews: [{ id: 1, author: "bot", state: "COMMENTED", commitId: f.head, submittedAt: null, hasBody: false, declaresReviewedCommit: null }],
      issueComments: [],
      inlineComments: [],
    };
    const r = reviewCompletionAtHead(emptyOnly);
    expect(r.status).toBe(UNKNOWN);
    expect(r.status).not.toBe("COMPLETE_CLEAN");
    expect(r.reason).toMatch(/no body/i);
  });

  it("a verdict at the head that states neither clean nor findings is UNKNOWN", () => {
    const f = FIX(613);
    const ambiguous = {
      ...f,
      reviews: [],
      inlineComments: [],
      issueComments: [{ id: 1, author: "bot", createdAt: null, isVerdict: true, verdictCommit: f.head, verdictClean: false, isReviewRequest: false, requestedCommit: null }],
    };
    expect(reviewCompletionAtHead(ambiguous).status).toBe(UNKNOWN);
  });
});

describe("8. the report is deterministic and machine-readable", () => {
  it("serialization is byte-identical across repeated runs", () => {
    for (const pr of [610, 612, 613, 615]) {
      const raw = readFileSync(path.resolve(__dirname, `fixtures/pr-${pr}.json`), "utf8").trim();
      expect(serializeFacts(JSON.parse(raw))).toBe(raw);
      expect(serializeFacts(JSON.parse(raw))).toBe(serializeFacts(JSON.parse(raw)));
    }
  });

  it("summarize() is stable and JSON-round-trips", () => {
    for (const pr of [610, 612, 613, 615]) {
      const s = summarize(FIX(pr));
      expect(JSON.stringify(s)).toBe(JSON.stringify(summarize(FIX(pr))));
      expect(JSON.parse(JSON.stringify(s)).pr).toBe(pr);
    }
  });

  it("carries no secrets, tokens or provider keys", () => {
    for (const pr of [610, 612, 613, 615]) {
      const raw = readFileSync(path.resolve(__dirname, `fixtures/pr-${pr}.json`), "utf8");
      expect(raw).not.toMatch(/sk_live_|whsec_|ghp_|gho_|Bearer\s+[A-Za-z0-9]/);
    }
  });
});

describe("9. the real fixture histories are reported correctly", () => {
  it("#613: CI green at the exact head AND seven exact-head P1s", () => {
    const f = FIX(613);
    const s = summarize(f);
    expect(s.ci.status).toBe("GREEN");
    expect(s.review.status).toBe("COMPLETE_WITH_FINDINGS");
    expect(s.findings.fresh).toBe(7);
    expect(s.findings.bySeverity).toEqual({ P1: 7 });
    // Green CI and fresh P1s coexist. Reconciling them is CP-005c's job.
  });

  it("#612: twenty-nine findings, every one carried, none fresh at the merged head", () => {
    const f = FIX(612);
    const s = summarize(f);
    expect(s.findings.carried).toBe(29);
    expect(s.findings.fresh).toBe(0);
    expect(s.findings.reAnchored).toBeGreaterThan(0);
  });

  it("#610: clean at the head, yet eleven carried findings and eleven acknowledgements", () => {
    const s = summarize(FIX(610));
    expect(s.review.status).toBe("COMPLETE_CLEAN");
    expect(s.findings.fresh).toBe(0);
    expect(s.findings.carried).toBe(11);
    expect(s.findings.acknowledgements).toBe(11);
    expect(s.review.staleEvidenceCount).toBe(22);
  });
});

describe("10. this vehicle has no authority beyond reporting", () => {
  it("exposes no merge, no persistence, no state transition and no stop law", () => {
    const src = ["github-facts.mjs", "review-provenance.mjs", "cli.mjs"]
      .map((f) => readFileSync(path.resolve(__dirname, "../../scripts/eng", f), "utf8"))
      .join("\n");
    const code = src.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    // No merge capability.
    expect(code).not.toMatch(/pr\s+merge|--merge\b|mergePullRequest|squash/);
    // No writes: this vehicle reads GitHub and writes nothing anywhere.
    expect(code).not.toMatch(/writeFileSync|appendFileSync|-X\s*(POST|PATCH|PUT|DELETE)|--method/);
    // No findings-state transitions (CP-005b).
    expect(code).not.toMatch(/REPAIRED@|VERIFIED@|ACCEPTED_RISK|repairRound/);
    // No stop laws or release decisions (CP-005c).
    expect(code).not.toMatch(/RELEASE_READY|ARCHITECTURE_REVIEW|TEST_AUTHORITY_STOP|WAIT_FOR_OPERATOR_GO|root_cause_family/);
    // No watcher daemon.
    expect(code).not.toMatch(/setInterval|setTimeout|while\s*\(true\)|daemon/);
  });

  it("the fetcher is injectable, so the suite needs no network or credentials", () => {
    let asked = 0;
    collectFacts({ pr: 1, fetcher: () => { asked += 1; return { ok: false, reason: "stub" }; } });
    expect(asked).toBeGreaterThan(0);
  });
});
