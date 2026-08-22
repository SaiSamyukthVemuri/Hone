import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs boundary ships without type declarations
import { AUTHORIZED, CLEAN, COMPLETE, INCOMPLETE, KNOWN_TRUSTED, KNOWN_UNTRUSTED, NOT_FINDING, PROVEN, REPLY, TOP_LEVEL, UNAUTHORIZED, UNKNOWN, WITH_FINDINGS, decodeActorIdentity, decodeCheckCollection, decodeFindingIdentity, decodeFindingShape, decodeReplyStatus, decodeReviewProvenance, decodeVerdictAuthority, decodeVerdictOutcome, mayAssertPositive } from "../../scripts/eng/evidence.mjs";
// prettier-ignore
// @ts-expect-error - .mjs boundary ships without type declarations
import { collectFacts, flattenCheckRunPages, projectCheckRun, projectInlineComment, projectIssueComment, projectReview, serializeFacts } from "../../scripts/eng/github-facts.mjs";
// prettier-ignore
// @ts-expect-error - .mjs boundary ships without type declarations
import { ciAtHead, classifyInlineComment, collectVerdicts, reviewCompletionAtHead, shaMatches, summarize } from "../../scripts/eng/review-provenance.mjs";

// ===========================================================================
// CP-005 NORMALIZED EVIDENCE — acceptance.
// ===========================================================================
//
// THE INVARIANT: no positive engineering assertion — CI GREEN, REVIEW CLEAN,
// TRUSTED FINDING — may rest on evidence that is UNKNOWN, invalid or
// incomplete.
//
// Four vehicles were retired unmerged for breaking it (#617, #618, #619, #620),
// each time inside the machinery built to prove things. Every one of those
// defects is carried below as a fixture.
//
// FIXTURE LAW: every case enters through a RAW GitHub-shaped payload and the
// production decoders. No field is deleted after projection, and no shape is
// constructed that GitHub could not deliver — both patterns certify branches
// production cannot reach, which is how #619 passed its own tests.

const FIXTURES = path.resolve(__dirname, "fixtures");
const FIX = (pr: number) => JSON.parse(readFileSync(path.join(FIXTURES, `pr-${pr}.json`), "utf8"));
const RAW = (name: string) => JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
type Raw = Record<string, unknown>;

const CODEX = { login: "chatgpt-codex-connector[bot]", id: 199175422, type: "Bot" };
const HUMAN = { login: "ordinary-contributor", id: 26781116, type: "User" };
const BADGE = (sev = "P1", title = "A real finding") =>
  `**<sub><sub>![${sev} Badge](https://img.shields.io/badge/${sev}-orange)</sub></sub>  ${title}**\n\nDetail.`;

/** RAW top-level review comment. GitHub OMITS in_reply_to_id on these. */
const rawInline = (over: Raw = {}): Raw => ({
  id: 9, pull_request_review_id: 77, user: CODEX, commit_id: HEAD, original_commit_id: HEAD,
  path: "lib/x.ts", line: 3, original_line: 3, body: BADGE(), ...over,
});
const rawIssue = (over: Raw = {}): Raw => ({
  id: 1, user: CODEX,
  body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `aaaaaaaaaa`", ...over,
});
const rawReview = (over: Raw = {}): Raw => ({
  id: 5, user: CODEX, state: "COMMENTED", commit_id: HEAD,
  body: "### Codex Review\n\nDidn't find any major issues.\n\n**Reviewed commit:** `aaaaaaaaaa`", ...over,
});
const rawCheck = (over: Raw = {}): Raw => ({
  name: "validate", status: "completed", conclusion: "success", head_sha: HEAD, ...over,
});
/** Remove a key from a RAW payload before decoding — never after. */
const omit = (o: Raw, k: string): Raw => { const c = { ...o }; delete c[k]; return c; };

const facts = ({ issues = [] as Raw[], reviews = [] as Raw[], inline = [] as Raw[], head = HEAD } = {}) => ({
  head,
  issueComments: decodeCheckCollection(issues.map(projectIssueComment)),
  reviews: decodeCheckCollection(reviews.map(projectReview)),
  inlineComments: decodeCheckCollection(inline.map(projectInlineComment)),
});
/** Status with a trusted clean verdict present, so the inline comment decides. */
const statusWith = (inline: Raw[]) => reviewCompletionAtHead(facts({ issues: [rawIssue()], inline })).status;
const classify = (raw: Raw, head = HEAD) => classifyInlineComment(projectInlineComment(raw), head);

// ---------------------------------------------------------------------------
// THE GATE
// ---------------------------------------------------------------------------

describe("the invariant: no positive assertion rests on an UNKNOWN state", () => {
  it("any UNKNOWN among the inputs fails the gate", () => {
    expect(mayAssertPositive({ kind: COMPLETE })).toBe(true);
    expect(mayAssertPositive({ kind: COMPLETE }, { kind: AUTHORIZED })).toBe(true);
    expect(mayAssertPositive({ kind: COMPLETE }, { kind: UNKNOWN, reason: "x" })).toBe(false);
    expect(mayAssertPositive({ kind: UNKNOWN, reason: "x" })).toBe(false);
    expect(mayAssertPositive()).toBe(false);
    expect(mayAssertPositive(null)).toBe(false);
    expect(mayAssertPositive(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DECODERS — one per fact, each entered from raw
// ---------------------------------------------------------------------------

describe("decodeActorIdentity", () => {
  it("#620 F1: a trusted id with an INVALID type is UNKNOWN, never UNTRUSTED", () => {
    // The exact retirement trigger. `type: null` is PRESENT, so a presence
    // check passes it; it is not VALID, so it can authorize nothing.
    for (const type of [null, 0, {}, [], true, ""]) {
      const a = decodeActorIdentity({ ...CODEX, type });
      expect(a.kind).toBe(UNKNOWN);
      expect(a.reason).toMatch(/account type/);
    }
    expect(decodeActorIdentity(omit(CODEX, "type")).kind).toBe(UNKNOWN);
  });

  it("an invalid id is UNKNOWN, whatever the type says", () => {
    for (const id of [null, 0, -1, 1.5, "199175422", {}]) {
      expect(decodeActorIdentity({ ...CODEX, id }).kind).toBe(UNKNOWN);
    }
    expect(decodeActorIdentity(omit(CODEX, "id")).kind).toBe(UNKNOWN);
    expect(decodeActorIdentity(undefined).kind).toBe(UNKNOWN);
    expect(decodeActorIdentity(null).kind).toBe(UNKNOWN);
  });

  it("only the exact trusted id AND type is trusted", () => {
    expect(decodeActorIdentity(CODEX).kind).toBe(KNOWN_TRUSTED);
    expect(decodeActorIdentity(HUMAN).kind).toBe(KNOWN_UNTRUSTED);
    // A look-alike bot reusing the login but not the immutable id.
    expect(decodeActorIdentity({ ...CODEX, id: 999 }).kind).toBe(KNOWN_UNTRUSTED);
    // The trusted id with a human account type is a contradiction, not trust.
    expect(decodeActorIdentity({ ...CODEX, type: "User" }).kind).toBe(KNOWN_UNTRUSTED);
  });

  it("authority never comes from login or author_association, which grade the wrong thing", () => {
    // Codex reports author_association NONE while the human owner reports OWNER.
    const impostor = { login: CODEX.login, id: 123, type: "Bot", author_association: "OWNER" };
    expect(decodeActorIdentity(impostor).kind).toBe(KNOWN_UNTRUSTED);
    const src = readFileSync(path.resolve(__dirname, "../../scripts/eng/evidence.mjs"), "utf8");
    expect(src).not.toMatch(/author_association\s*===/);
  });
});

describe("decodeReviewProvenance", () => {
  it("only a valid review id proves it", () => {
    expect(decodeReviewProvenance(rawInline()).kind).toBe(PROVEN);
    expect(decodeReviewProvenance(rawInline()).reviewId).toBe(77);
    for (const v of [null, 0, -3, "77", 1.5]) {
      expect(decodeReviewProvenance({ ...rawInline(), pull_request_review_id: v }).kind).toBe(UNKNOWN);
    }
    expect(decodeReviewProvenance(omit(rawInline(), "pull_request_review_id")).kind).toBe(UNKNOWN);
  });
});

describe("decodeReplyStatus — the one field where ABSENCE is the value", () => {
  it("#618: omission proves TOP_LEVEL, but only after provenance is proven", () => {
    expect(decodeReplyStatus(rawInline()).kind).toBe(TOP_LEVEL);
    expect(decodeReplyStatus({ ...rawInline(), in_reply_to_id: 42 })).toEqual({ kind: REPLY, inReplyToId: 42 });
    // Without provenance the omission means nothing at all.
    expect(decodeReplyStatus(omit(rawInline(), "pull_request_review_id")).kind).toBe(UNKNOWN);
  });

  it("present-but-invalid proves nothing", () => {
    for (const v of [null, 0, "42", -1]) {
      expect(decodeReplyStatus({ ...rawInline(), in_reply_to_id: v }).kind).toBe(UNKNOWN);
    }
  });

  it("the omission contract holds across every captured real PR", () => {
    // 97 comments across five real PRs: 52 absent (all top-level), 45 present
    // (all real ids), ZERO present-null. This is measurement, not assumption.
    let total = 0;
    for (const pr of [610, 612, 613, 615, 616]) {
      for (const c of FIX(pr).inlineComments.items) {
        total += 1;
        expect(c.provenance ?? c.identity).toBeDefined();
        expect([TOP_LEVEL, REPLY]).toContain(c.replyStatus.kind);
      }
    }
    expect(total).toBeGreaterThanOrEqual(90);
  });
});

describe("decodeFindingIdentity — only provenance GitHub does not rewrite", () => {
  it("all four parts must be valid", () => {
    expect(decodeFindingIdentity(rawInline()).kind).toBe(PROVEN);
    expect(decodeFindingIdentity(rawInline()).key).toBe(`gh:9@${HEAD}:lib/x.ts:3`);
    for (const f of ["id", "original_commit_id", "path", "original_line"]) {
      expect(decodeFindingIdentity(omit(rawInline(), f)).kind).toBe(UNKNOWN);
      expect(decodeFindingIdentity({ ...rawInline(), [f]: null }).kind).toBe(UNKNOWN);
    }
    // A malformed sha is not a sha.
    expect(decodeFindingIdentity({ ...rawInline(), original_commit_id: "zzz" }).kind).toBe(UNKNOWN);
  });

  it("the key ignores the display line and display commit, which GitHub rewrites", () => {
    const moved = decodeFindingIdentity({ ...rawInline(), commit_id: OTHER, line: 552 });
    expect(moved.key).toBe(decodeFindingIdentity(rawInline()).key);
  });
});

describe("decodeFindingShape and decodeVerdictOutcome", () => {
  it("shape is markup only — it is not trust", () => {
    expect(decodeFindingShape(BADGE("P2", "Title here"))).toEqual({ kind: "FINDING", severity: "P2", title: "Title here" });
    expect(decodeFindingShape("just a note").kind).toBe(NOT_FINDING);
    expect(decodeFindingShape(null).kind).toBe(NOT_FINDING);
  });

  it("an empty review body states NO outcome — that is UNKNOWN, not clean", () => {
    expect(decodeVerdictOutcome("Didn't find any major issues").kind).toBe(CLEAN);
    expect(decodeVerdictOutcome("Here are some suggestions").kind).toBe(WITH_FINDINGS);
    for (const b of ["", "   ", null, undefined, 0]) {
      expect(decodeVerdictOutcome(b).kind).toBe(UNKNOWN);
    }
  });

  it("authority is derived from ActorIdentity, so the two can never disagree", () => {
    expect(decodeVerdictAuthority(CODEX).kind).toBe(AUTHORIZED);
    expect(decodeVerdictAuthority(HUMAN).kind).toBe(UNAUTHORIZED);
    expect(decodeVerdictAuthority({ ...CODEX, type: null }).kind).toBe(UNKNOWN);
    expect(decodeVerdictAuthority(undefined).kind).toBe(UNKNOWN);
  });
});

// ---------------------------------------------------------------------------
// CHECK-RUN COLLECTION COMPLETENESS
// ---------------------------------------------------------------------------

describe("check-run collection completeness", () => {
  const ci = (items: unknown[], meta: object = {}) =>
    ciAtHead({ head: HEAD, checkRuns: decodeCheckCollection(items, meta) });

  it("1. a failure on a LATER page is seen, and the run is not green", () => {
    const pages = RAW("check-runs-paginated");
    const { items, totalCount } = flattenCheckRunPages(pages);
    expect(ci(items, { totalCount }).status).toBe("RED");
  });

  it("1b. reading only the FIRST page cannot report green — the original defect", () => {
    const pages = RAW("check-runs-paginated");
    const first = flattenCheckRunPages([pages[0]]);
    expect(first.items.every((c: { conclusion: string }) => c.conclusion === "success")).toBe(true);
    expect(ci(first.items, { totalCount: first.totalCount }).status).toBe(UNKNOWN);
  });

  it("2. total_count greater than collected is INCOMPLETE, so never green", () => {
    const r = ci([projectCheckRun(rawCheck())], { totalCount: 12 });
    expect(r.completeness).toBe(INCOMPLETE);
    expect(r.status).toBe(UNKNOWN);
  });

  it("2b. collected equal to total_count is COMPLETE and may be green", () => {
    const r = ci([projectCheckRun(rawCheck())], { totalCount: 1 });
    expect(r.completeness).toBe(COMPLETE);
    expect(r.status).toBe("GREEN");
  });

  it("3. a pagination request that failed is UNKNOWN, never green", () => {
    expect(ci(null as never, { error: "gh api failed" }).status).toBe(UNKNOWN);
  });

  it("4. zero check runs is UNKNOWN — nothing ran is not nothing failed", () => {
    expect(ci([], { totalCount: 0 }).status).toBe(UNKNOWN);
  });

  it("runs belonging to another commit are not counted for this head", () => {
    const r = ci([rawCheck(), rawCheck({ name: "other", head_sha: OTHER })].map(projectCheckRun), { totalCount: 2 });
    expect(r.atHead).toBe(1);
    expect(r.foreign).toBe(1);
  });

  it("a run with NO head_sha binds to nothing — absence is not a match", () => {
    const runs = [rawCheck(), omit(rawCheck({ name: "orphan" }), "head_sha")].map(projectCheckRun);
    expect((runs[1] as { headSha: string }).headSha).toBe(UNKNOWN);
    const r = ci(runs, { totalCount: 2 });
    expect(r.atHead).toBe(1);
    expect(r.foreign).toBe(1);
  });

  it("a confirmed failure is RED even when the collection is incomplete", () => {
    // A negative fact stands on its own; only positives need a whole collection.
    const r = ci([rawCheck({ conclusion: "failure" })].map(projectCheckRun), { totalCount: 9 });
    expect(r.status).toBe("RED");
  });

  it("skipped and neutral lanes do not make a complete run red", () => {
    const runs = [
      rawCheck(),
      rawCheck({ name: "db", conclusion: "skipped" }),
      rawCheck({ name: "n", conclusion: "neutral" }),
    ].map(projectCheckRun);
    expect(ci(runs, { totalCount: 3 }).status).toBe("GREEN");
  });

  it("a completed run with NO conclusion is not a pass", () => {
    const r = ci([omit(rawCheck(), "conclusion")].map(projectCheckRun), { totalCount: 1 });
    expect(r.status).toBe("RED");
  });

  it("a still-running check is PENDING, never GREEN", () => {
    const runs = [rawCheck({ status: "in_progress", conclusion: null })].map(projectCheckRun);
    expect(ci(runs, { totalCount: 1 }).status).toBe("PENDING");
  });
});

// ---------------------------------------------------------------------------
// VERDICT AUTHORITY
// ---------------------------------------------------------------------------

describe("verdict authority", () => {
  const SPOOF = RAW("spoofed-verdict");

  it("the spoof fixture is real and byte-identical to the trusted one but for its actor", () => {
    // Guards the cases below from passing vacuously: if the bodies ever drift
    // apart, the spoof stops testing authority and starts testing wording.
    expect(SPOOF.spoofed_issue_comment.body).toBe(SPOOF.trusted_issue_comment.body);
    expect(SPOOF.spoofed_by_lookalike_bot.user.login).toBe(SPOOF.trusted_issue_comment.user.login);
    expect(SPOOF.spoofed_by_lookalike_bot.user.id).not.toBe(SPOOF.trusted_issue_comment.user.id);
  });

  it("5. an ordinary contributor's exact look-alike verdict is never CLEAN", () => {
    const trusted = reviewCompletionAtHead(facts({ issues: [SPOOF.trusted_issue_comment] }));
    const spoofed = reviewCompletionAtHead(facts({ issues: [SPOOF.spoofed_issue_comment] }));
    expect(trusted.status).toBe("COMPLETE_CLEAN"); // same body...
    expect(spoofed.status).not.toBe("COMPLETE_CLEAN"); // ...different actor
    expect(spoofed.unauthorizedEvidence.length).toBe(1);
  });

  it("5b. a look-alike BOT reusing the trusted login but a different id is not authorized", () => {
    const st = reviewCompletionAtHead(facts({ issues: [SPOOF.spoofed_by_lookalike_bot] }));
    expect(st.status).not.toBe("COMPLETE_CLEAN");
    expect(st.unauthorizedEvidence.length).toBe(1);
  });

  it("the remaining spoof fixtures each land on their own state", () => {
    const st = (k: string) => reviewCompletionAtHead(facts({ issues: [SPOOF[k]] })).status;
    expect(reviewCompletionAtHead(facts({ reviews: [SPOOF.trusted_review_clean] })).status).toBe("COMPLETE_CLEAN");
    expect(reviewCompletionAtHead(facts({ reviews: [SPOOF.trusted_review_empty_body] })).status).toBe(UNKNOWN);
    expect(st("trusted_verdict_stale_head")).toBe("NONE");
    expect(st("verdict_missing_actor")).toBe(UNKNOWN);
  });

  it("6. a trusted ISSUE-COMMENT clean verdict at the head is CLEAN", () => {
    expect(reviewCompletionAtHead(facts({ issues: [rawIssue()] })).status).toBe("COMPLETE_CLEAN");
  });

  it("7. a trusted SUBMITTED-REVIEW clean verdict at the head is CLEAN", () => {
    expect(reviewCompletionAtHead(facts({ reviews: [rawReview()] })).status).toBe("COMPLETE_CLEAN");
  });

  it("8. a trusted verdict for a DIFFERENT head is stale, not current", () => {
    const st = reviewCompletionAtHead(facts({ issues: [rawIssue({ body: "Didn't find any major issues.\n\n**Reviewed commit:** `bbbbbbbbbb`" })] }));
    expect(st.status).toBe("NONE");
    expect(st.staleEvidence.length).toBe(1);
  });

  it("9. an EMPTY-BODY review from the trusted actor at the head is UNKNOWN", () => {
    const st = reviewCompletionAtHead(facts({ reviews: [rawReview({ body: "" })] }));
    expect(st.status).toBe(UNKNOWN);
  });

  it("11. a verdict whose actor identity is UNKNOWN is UNKNOWN, not accidentally-not-clean", () => {
    const st = reviewCompletionAtHead(facts({ issues: [rawIssue({ user: omit(CODEX, "id") })] }));
    expect(st.status).toBe(UNKNOWN);
    expect(st.reason).toMatch(/could not be identified/);
  });

  it("both surfaces normalize into ONE verdict shape", () => {
    const vs = collectVerdicts(facts({ issues: [rawIssue()], reviews: [rawReview()] }));
    expect(vs.length).toBe(2);
    expect(new Set(vs.map((v: { sourceType: string }) => v.sourceType))).toEqual(
      new Set(["issue_comment", "review_object"]),
    );
    for (const v of vs) expect(Object.keys(v).sort()).toEqual(
      ["atHead", "authority", "outcome", "reviewedCommit", "sourceId", "sourceType"],
    );
  });

  it("an abbreviated sha matches its full head; a different one does not", () => {
    expect(shaMatches("aaaaaaaaaa", HEAD)).toBe(true);
    expect(shaMatches("bbbbbbbbbb", HEAD)).toBe(false);
    expect(shaMatches("aaa", HEAD)).toBe(false);
    expect(shaMatches(UNKNOWN, HEAD)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FINDING FRESHNESS AND RE-ANCHORING
// ---------------------------------------------------------------------------

describe("10. inline finding freshness keys to the RAISED-at sha", () => {
  it("re-anchoring moves the display commit but not the identity", () => {
    const f = classify(rawInline({ commit_id: OTHER }));
    expect(f.freshness).toBe("fresh");
    expect(f.raisedAt).toBe(HEAD);
    expect(f.displayedAt).toBe(OTHER);
    expect(f.reAnchored).toBe(true);
  });

  it("a finding raised at an earlier head is carried, not fresh", () => {
    expect(classify(rawInline({ original_commit_id: OTHER })).freshness).toBe("carried");
  });

  it("ANTI-VACUITY: moving the raised-at sha flips carried to fresh", () => {
    expect(classify(rawInline({ original_commit_id: OTHER }), OTHER).freshness).toBe("fresh");
  });

  it("#615's finding was raised at the previous head and is carried, not fresh", () => {
    const r = reviewCompletionAtHead(FIX(615));
    expect(r.carriedFindings.length).toBeGreaterThan(0);
  });

  it("#610 carries re-anchored comments, none of them fresh", () => {
    const r = reviewCompletionAtHead(FIX(610));
    expect(r.reAnchored).toBeGreaterThan(0);
    expect(r.freshFindings.length).toBe(0);
  });

  it("a comment with no raised-at sha is UNKNOWN, not fresh", () => {
    const f = classify(omit(rawInline(), "original_commit_id"));
    expect(f.freshness).toBe(UNKNOWN);
    expect(f.blocking).toBe(true);
  });

  it("acknowledgements are split from findings by the severity badge", () => {
    expect(classify(rawInline({ body: "thanks, fixed" })).kind).toBe("acknowledgement");
    expect(classify(rawInline()).kind).toBe("finding");
  });
});

// ---------------------------------------------------------------------------
// REQUIRED ACCEPTANCE MATRIX — #617 through #620
// ---------------------------------------------------------------------------

describe("required acceptance matrix", () => {
  it("trusted id + type null -> UNKNOWN, blocks CLEAN, is NOT proven-negative", () => {
    const raw = rawInline({ user: { ...CODEX, type: null } });
    const f = classify(raw);
    expect(f.kind).toBe("raw_evidence");
    expect(f.blocking).toBe(true); // <- the #620 defect: was nonblocking
    expect(statusWith([raw])).toBe(UNKNOWN);
  });

  it("type absent / non-string -> UNKNOWN and blocks", () => {
    for (const u of [omit(CODEX, "type"), { ...CODEX, type: 7 }, { ...CODEX, type: {} }]) {
      expect(classify(rawInline({ user: u })).blocking).toBe(true);
      expect(statusWith([rawInline({ user: u })])).toBe(UNKNOWN);
    }
  });

  it("null review id -> UNKNOWN provenance, blocks CLEAN", () => {
    const raw = rawInline({ pull_request_review_id: null });
    expect(classify(raw).blocking).toBe(true);
    expect(statusWith([raw])).toBe(UNKNOWN);
  });

  it("a real reply is ONE canonical REPLY, non-blocking, and not a finding", () => {
    const raw = rawInline({ in_reply_to_id: 1234 });
    const f = classify(raw);
    expect(f.kind).toBe("raw_evidence");
    expect(f.blocking).toBe(false);
    expect(statusWith([raw])).toBe("COMPLETE_CLEAN");
  });

  it("top-level omission after proven provenance IS a finding", () => {
    expect(classify(rawInline()).kind).toBe("finding");
    expect(statusWith([rawInline()])).toBe("COMPLETE_WITH_FINDINGS");
  });

  it("a human badge spoof is KNOWN_UNTRUSTED and non-blocking", () => {
    const raw = rawInline({ user: HUMAN });
    const f = classify(raw);
    expect(f.blocking).toBe(false);
    expect(f.kind).toBe("raw_evidence");
    expect(f.reason).toMatch(/not the trusted reviewer/);
    expect(statusWith([raw])).toBe("COMPLETE_CLEAN");
  });

  it("a re-anchored finding uses the original raised-at identity", () => {
    const f = classify(rawInline({ commit_id: OTHER, line: 552 }));
    expect(f.originalLine).toBe(3);
    expect(f.identityKey).toBe(`gh:9@${HEAD}:lib/x.ts:3`);
  });

  it("incomplete paginated checks never become GREEN", () => {
    const pages = RAW("check-runs-paginated");
    const first = flattenCheckRunPages([pages[0]]);
    const r = ciAtHead({ head: HEAD, checkRuns: decodeCheckCollection(first.items, { totalCount: first.totalCount }) });
    expect(r.status).not.toBe("GREEN");
  });

  it("an invalid-present value never becomes a proven negative merely by being present", () => {
    // The generalized #620 lesson, stated as a property across every decoder.
    expect(decodeActorIdentity({ ...CODEX, type: null }).kind).toBe(UNKNOWN);
    expect(decodeReviewProvenance({ ...rawInline(), pull_request_review_id: null }).kind).toBe(UNKNOWN);
    expect(decodeReplyStatus({ ...rawInline(), in_reply_to_id: null }).kind).toBe(UNKNOWN);
    expect(decodeFindingIdentity({ ...rawInline(), original_line: null }).kind).toBe(UNKNOWN);
    expect(decodeVerdictOutcome("").kind).toBe(UNKNOWN);
    expect(decodeCheckCollection([], { totalCount: 3 }).kind).toBe(INCOMPLETE);
  });

  it("undecidable evidence blocks CLEAN even when a trusted clean verdict exists", () => {
    const r = reviewCompletionAtHead(facts({ issues: [rawIssue()], inline: [rawInline({ user: { ...CODEX, type: null } })] }));
    expect(r.status).toBe(UNKNOWN);
    expect(r.blockingEvidence.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ONE SOURCE OF TRUTH
// ---------------------------------------------------------------------------

describe("duplicate truth is gone", () => {
  it("#620 F2: there is no isReply beside replyStatus", () => {
    const p = projectInlineComment(rawInline({ in_reply_to_id: 1234 }));
    expect(p.replyStatus).toEqual({ kind: REPLY, inReplyToId: 1234 });
    expect("isReply" in p).toBe(false);
    expect("inReplyToId" in p).toBe(false);
    expect("isReply" in classify(rawInline({ in_reply_to_id: 1234 }))).toBe(false);
  });

  it("no cached usable/isTrusted/isVerdictCandidate flag exists beside a canonical state", () => {
    const v = collectVerdicts(facts({ issues: [rawIssue()] }))[0];
    for (const dead of ["usable", "isTrusted", "clean", "hasBody", "completeness"]) {
      expect(dead in v).toBe(false);
    }
    const ic = projectIssueComment(rawIssue());
    expect("isVerdictCandidate" in ic).toBe(false);
    expect("isReviewRequest" in ic).toBe(false);
  });

  it("the display line never falls back to the original line", () => {
    // One field held two different facts in production; that is why a finding
    // could be keyed to a position that moves.
    const p = projectInlineComment(omit(rawInline(), "line"));
    expect(p.displayLine).toBe(UNKNOWN);
    expect(decodeFindingIdentity(omit(rawInline(), "line")).originalLine).toBe(3);
  });

  it("no module re-derives the trust decision or reads a raw actor field", () => {
    for (const f of ["github-facts.mjs", "review-provenance.mjs", "cli.mjs"]) {
      const code = readFileSync(path.resolve(__dirname, "../../scripts/eng", f), "utf8")
        .replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
      expect(code).not.toMatch(/199175422/);
      expect(code).not.toMatch(/\.user\?\.(id|type)\b/);
      expect(code).not.toMatch(/in_reply_to_id/);
    }
  });
});

// ---------------------------------------------------------------------------
// UNREADABLE SURFACES, REAL HISTORIES, AND SCOPE
// ---------------------------------------------------------------------------

describe("12. an unreadable surface stays UNKNOWN", () => {
  it("names what could not be read and reports no positive state", () => {
    const f = collectFacts({ pr: 1, fetcher: () => ({ ok: false, reason: "gh: not found" }) });
    expect(f.head).toBe(UNKNOWN);
    expect(ciAtHead(f).status).toBe(UNKNOWN);
    expect(reviewCompletionAtHead(f).status).toBe(UNKNOWN);
    expect(f.unavailable.length).toBeGreaterThan(0);
  });

  it("the fetcher is injectable, so the suite needs no network or credentials", () => {
    const calls: string[] = [];
    collectFacts({ pr: 7, fetcher: (p: string) => { calls.push(p); return { ok: false, reason: "stub" }; } });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.includes("7"))).toBe(true);
  });
});

describe("the real fixture histories are still reported correctly", () => {
  it("#613: complete green CI at the exact head AND seven exact-head P1s", () => {
    expect(ciAtHead(FIX(613)).status).toBe("GREEN");
    expect(reviewCompletionAtHead(FIX(613)).freshFindings.length).toBe(7);
  });

  it("#610: carried findings and stale evidence are retained, not discarded", () => {
    const r = reviewCompletionAtHead(FIX(610));
    expect(r.carriedFindings.length).toBeGreaterThan(0);
    expect(r.freshFindings.length).toBe(0);
  });

  it("#612: findings are carried, none fresh", () => {
    const r = reviewCompletionAtHead(FIX(612));
    expect(r.freshFindings.length).toBe(0);
    expect(r.carriedFindings.length).toBeGreaterThan(0);
  });

  it("#616: this PR's own findings are reported at its head", () => {
    expect(reviewCompletionAtHead(FIX(616)).freshFindings.length).toBeGreaterThan(0);
  });

  it("every captured fixture's check-run collection is COMPLETE", () => {
    for (const pr of [610, 612, 613, 615, 616]) expect(FIX(pr).checkRuns.kind).toBe(COMPLETE);
  });

  it("no real fixture comment is undecidable — the model reads live data cleanly", () => {
    for (const pr of [610, 612, 613, 615, 616]) {
      expect(reviewCompletionAtHead(FIX(pr)).blockingEvidence.length).toBe(0);
    }
  });

  it("serialization is byte-identical across repeated runs, and carries no secrets", () => {
    const a = serializeFacts(FIX(613));
    const b = serializeFacts(FIX(613));
    expect(a).toBe(b);
    expect(a).not.toMatch(/gh[pousr]_[A-Za-z0-9]{16,}/);
  });
});

describe("this vehicle has no authority beyond reporting", () => {
  it("exposes no merge, no writes, no findings state and no stop law", () => {
    const src = ["evidence.mjs", "github-facts.mjs", "review-provenance.mjs", "cli.mjs"]
      .map((f) => readFileSync(path.resolve(__dirname, "../../scripts/eng", f), "utf8"))
      .join("\n")
      .replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    for (const forbidden of ["pr merge", "--merge", "gh pr close", "REPAIR_", "ACCEPTED_RISK", "release_ready"]) {
      expect(src).not.toContain(forbidden);
    }
    const s = summarize(FIX(613));
    expect(Object.keys(s)).not.toContain("decision");
    expect(Object.keys(s)).not.toContain("releaseReady");
  });
});
