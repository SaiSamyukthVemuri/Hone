import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { UNKNOWN } from "../../scripts/eng/evidence.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { projectInlineComment } from "../../scripts/eng/github-facts.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { ACCEPTED_RISK, LEDGER_VERSION, OPEN, REPAIRED, VERIFIED, currentEntry, emptyLedger, enrol, findingId, forStopLaws, mark, repairRound, serializeLedger, stateAt } from "../../scripts/eng/ledger.mjs";

// ===========================================================================
// CP-005b: the OPERATOR-ENROLLED monotonic finding ledger.
// ===========================================================================
//
// THE DESIGN LAW UNDER TEST: a finding enters durable state ONLY through
// explicit operator enrolment, and every semantic field - severity, root-cause
// family, runtime-vs-evidence - is supplied by the operator. Nothing is read
// off a badge. Nothing is inferred from prose.
//
// Six vehicles (#617-#622) established why. This module is the part of the job
// automation is actually reliable at: preserving identity, binding to an exact
// SHA, and counting transitions.
//
// FIXTURE LAW: enrolment cases enter through RAW GitHub-shaped payloads and the
// production projection, captured from the program's own histories - #613 and
// #617 through #622, 31 real findings across 11 distinct raised-at heads.

const FIXTURES = path.resolve(__dirname, "fixtures");
const RAW = (n: string) => JSON.parse(readFileSync(path.join(FIXTURES, `${n}.json`), "utf8"));
const SOURCES = RAW("enrolment-sources");

const AT = "2026-08-22T12:00:00Z";
const BY = "sam";
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

/** Build an enrolment source the way the CLI does: raw -> projection -> facts. */
const sourceFrom = (pr: number, index = 0) => {
  const c = projectInlineComment(SOURCES[String(pr)][index]);
  return {
    pr, commentId: c.id, raisedAtSha: c.originalCommitId, path: c.path,
    originalLine: c.originalLine, actorId: c.authorId, inReplyToId: c.inReplyToId,
  };
};
const enrolled = (pr = 622, index = 0, over: Record<string, unknown> = {}) =>
  enrol(emptyLedger(), {
    source: sourceFrom(pr, index), severity: "P2", rootCauseFamily: "evidence-collapse",
    runtimeOrEvidence: "evidence", by: BY, at: AT, ...over,
  });

// ---------------------------------------------------------------------------
// THE DESIGN LAW
// ---------------------------------------------------------------------------

describe("a finding enters ONLY through explicit operator enrolment", () => {
  it("every semantic field is required - a missing one is an error, never a guess", () => {
    for (const missing of ["severity", "rootCauseFamily", "runtimeOrEvidence", "by", "at"]) {
      expect(() => enrolled(622, 0, { [missing]: undefined })).toThrow(/supplied explicitly by the operator|must be supplied/);
      expect(() => enrolled(622, 0, { [missing]: "  " })).toThrow();
    }
  });

  it("severity is NEVER read off the badge, even though the badge is right there", () => {
    // The raw body carries "![P1 Badge]" and the operator enrols it as P2. The
    // ledger records what the operator said, not what the markup claimed.
    const raw = SOURCES["613"][0];
    expect(raw.body).toMatch(/!\[P[0-3] Badge\]/);
    const l = enrolled(613, 0, { severity: "P2" });
    expect(l.findings[0].severity).toBe("P2");
    // ...and no module parses severity for the ledger's benefit.
    const src = readFileSync(path.resolve(__dirname, "../../scripts/eng/ledger.mjs"), "utf8");
    expect(src).not.toMatch(/Badge/);
    expect(src).not.toMatch(/P[0-3]/);
  });

  it("the machine proposes nothing - there is no candidate listing at all", () => {
    // A list of machine-selected "probable findings" is how convenience becomes
    // inference. The operator names the comment id.
    const cli = readFileSync(path.resolve(__dirname, "../../scripts/eng/cli.mjs"), "utf8")
      .replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    expect(cli).not.toMatch(/\bpropose\b/);
    expect(cli).not.toMatch(/candidates/);
  });
});

// ---------------------------------------------------------------------------
// IDENTITY
// ---------------------------------------------------------------------------

describe("identity uses only provenance GitHub does not rewrite", () => {
  it("the key is comment id, raised-at sha, path and ORIGINAL line", () => {
    const s = sourceFrom(622, 0);
    expect(findingId({ commentId: s.commentId, raisedAtSha: s.raisedAtSha, filePath: s.path, originalLine: s.originalLine }))
      .toBe(`gh:${s.commentId}@${s.raisedAtSha}:${s.path}:${s.originalLine}`);
  });

  it("a record that cannot be NAMED is never created", () => {
    for (const bad of [
      { commentId: 0 }, { commentId: null }, { raisedAtSha: null }, { raisedAtSha: "zzz" },
      { filePath: "" }, { originalLine: null }, { originalLine: 0 },
    ]) {
      const s = sourceFrom(622, 0);
      expect(() => findingId({ commentId: s.commentId, raisedAtSha: s.raisedAtSha, filePath: s.path, originalLine: s.originalLine, ...bad }))
        .toThrow(/stable identity is incomplete/);
    }
  });

  it("re-anchoring does not change identity - measured across the real corpus", () => {
    // 8 of 34 comments on #610/#617/#619/#622 were re-anchored onto a later
    // head; original_commit_id never moved for any of them.
    let reAnchored = 0;
    for (const [pr, cs] of Object.entries(SOURCES) as [string, Record<string, unknown>[]][]) {
      for (const c of cs) {
        const p = projectInlineComment(c);
        if (p.commitId !== p.originalCommitId) reAnchored += 1;
        // Whatever the display fields do, the key components are all present.
        expect(() => findingId({ commentId: p.id, raisedAtSha: p.originalCommitId, filePath: p.path, originalLine: p.originalLine }))
          .not.toThrow();
        expect(pr).toBeTruthy();
      }
    }
    expect(reAnchored).toBeGreaterThan(0);
  });

  it("the DISPLAY line is never part of identity, and is null for many real comments", () => {
    const all = Object.values(SOURCES).flat() as Record<string, unknown>[];
    const nullDisplay = all.filter((c) => projectInlineComment(c).line === null).length;
    const nullOriginal = all.filter((c) => projectInlineComment(c).originalLine === null).length;
    expect(nullDisplay).toBeGreaterThan(0); // display line goes away...
    expect(nullOriginal).toBe(0); // ...the stable one does not
  });

  it("the same comment cannot be enrolled twice", () => {
    const once = enrolled(622, 0);
    expect(() => enrol(once, { source: sourceFrom(622, 0), severity: "P1", rootCauseFamily: "x", runtimeOrEvidence: "runtime", by: BY, at: AT }))
      .toThrow(/already enrolled/);
  });

  it("the same finding re-raised at a LATER head is a distinct record", () => {
    // #617 raised findings at three different heads; #622 at two.
    const heads = new Set((SOURCES["617"] as { original_commit_id: string }[]).map((c) => c.original_commit_id));
    expect(heads.size).toBeGreaterThan(1);
    let ledger = emptyLedger();
    for (let i = 0; i < SOURCES["617"].length; i += 1) {
      ledger = enrol(ledger, { source: sourceFrom(617, i), severity: "P1", rootCauseFamily: "f", runtimeOrEvidence: "evidence", by: BY, at: AT });
    }
    expect(new Set(ledger.findings.map((f: { id: string }) => f.id)).size).toBe(SOURCES["617"].length);
  });

  it("structural facts about the source are RECORDED, not used to refuse", () => {
    // Refusing would put the machine's judgement above the operator's, which is
    // the inversion this design exists to prevent. Hiding them would be its own
    // defect, so they travel with the record.
    const f = enrolled(622, 0).findings[0];
    expect(f.source.actorId).toBe(199175422);
    expect("inReplyToId" in f.source).toBe(true);
    expect(f.source.pr).toBe(622);
  });
});

// ---------------------------------------------------------------------------
// MONOTONIC TRANSITIONS
// ---------------------------------------------------------------------------

describe("transitions are monotonic and append-only", () => {
  const id = (l: { findings: { id: string }[] }) => l.findings[0].id;

  it("OPEN -> REPAIRED -> REPAIRED -> VERIFIED, counting repair rounds", () => {
    let l = enrolled();
    expect(repairRound(l.findings[0])).toBe(0);
    l = mark(l, id(l), REPAIRED, { sha: SHA_B, by: BY, at: AT });
    expect(repairRound(l.findings[0])).toBe(1);
    l = mark(l, id(l), REPAIRED, { sha: SHA_C, by: BY, at: AT });
    expect(repairRound(l.findings[0])).toBe(2);
    l = mark(l, id(l), VERIFIED, { sha: SHA_C, by: BY, at: AT });
    expect(currentEntry(l.findings[0]).state).toBe(VERIFIED);
  });

  it("a state never moves backwards", () => {
    const l = enrolled();
    expect(() => mark(l, id(l), VERIFIED, { sha: SHA_B, by: BY, at: AT })).toThrow(/not a monotonic transition/);
    const repaired = mark(l, id(l), REPAIRED, { sha: SHA_B, by: BY, at: AT });
    expect(() => mark(repaired, id(l), OPEN, { sha: SHA_B, by: BY, at: AT })).toThrow(/not a monotonic transition/);
  });

  it("VERIFIED and ACCEPTED_RISK are terminal", () => {
    let l = mark(enrolled(), id(enrolled()), REPAIRED, { sha: SHA_B, by: BY, at: AT });
    l = mark(l, id(l), VERIFIED, { sha: SHA_B, by: BY, at: AT });
    expect(() => mark(l, id(l), REPAIRED, { sha: SHA_C, by: BY, at: AT })).toThrow(/terminal/);
    const risk = mark(enrolled(), id(enrolled()), ACCEPTED_RISK, { sha: SHA_B, by: BY, at: AT, reason: "known" });
    expect(() => mark(risk, id(risk), REPAIRED, { sha: SHA_C, by: BY, at: AT })).toThrow(/terminal/);
  });

  it("every transition must name the sha it happened at, and who made it", () => {
    const l = enrolled();
    expect(() => mark(l, id(l), REPAIRED, { sha: null, by: BY, at: AT })).toThrow(/must name the sha/);
    expect(() => mark(l, id(l), REPAIRED, { sha: "nope", by: BY, at: AT })).toThrow(/must name the sha/);
    expect(() => mark(l, id(l), REPAIRED, { sha: SHA_B, by: "", at: AT })).toThrow(/who made it/);
  });

  it("ACCEPTED_RISK is operator-only and requires an explicit reason", () => {
    const l = enrolled();
    expect(() => mark(l, id(l), ACCEPTED_RISK, { sha: SHA_B, by: BY, at: AT })).toThrow(/explicit operator reason/);
    const accepted = mark(l, id(l), ACCEPTED_RISK, { sha: SHA_B, by: BY, at: AT, reason: "known limitation" });
    expect(accepted.findings[0].acceptedRisk).toMatchObject({ by: BY, reason: "known limitation" });
  });

  it("history is APPEND-ONLY - nothing is rewritten", () => {
    let l = enrolled();
    const first = l.findings[0].history[0];
    l = mark(l, id(l), REPAIRED, { sha: SHA_B, by: BY, at: AT });
    l = mark(l, id(l), VERIFIED, { sha: SHA_B, by: BY, at: AT });
    expect(l.findings[0].history[0]).toEqual(first);
    expect(l.findings[0].history.map((h: { state: string }) => h.state)).toEqual([OPEN, REPAIRED, VERIFIED]);
  });

  it("marking an unenrolled id fails rather than creating one", () => {
    expect(() => mark(emptyLedger(), "gh:1@" + SHA_B + ":a.ts:1", REPAIRED, { sha: SHA_B, by: BY, at: AT }))
      .toThrow(/not enrolled/);
  });
});

// ---------------------------------------------------------------------------
// CURRENCY IS A QUERY, NEVER A STORED FLAG
// ---------------------------------------------------------------------------

describe("HEAD-change behaviour", () => {
  const id = (l: { findings: { id: string }[] }) => l.findings[0].id;

  it("a state recorded at another sha is UNKNOWN here - not OPEN, not carried over", () => {
    let l = mark(enrolled(), id(enrolled()), REPAIRED, { sha: SHA_B, by: BY, at: AT });
    l = mark(l, id(l), VERIFIED, { sha: SHA_B, by: BY, at: AT });
    expect(stateAt(l.findings[0], SHA_B).state).toBe(VERIFIED);
    const elsewhere = stateAt(l.findings[0], SHA_C);
    expect(elsewhere.state).toBe(UNKNOWN);
    expect(elsewhere.state).not.toBe(OPEN); // does not invent a regression
    expect(elsewhere.reason).toMatch(/not this head/);
  });

  it("an abbreviated head still binds; an unrelated one does not", () => {
    const l = enrolled();
    const raised = l.findings[0].source.raisedAtSha;
    expect(stateAt(l.findings[0], raised.slice(0, 10)).state).toBe(OPEN);
    expect(stateAt(l.findings[0], SHA_C).state).toBe(UNKNOWN);
  });

  it("with no head to bind against, the answer is UNKNOWN", () => {
    expect(stateAt(enrolled().findings[0], null).state).toBe(UNKNOWN);
    expect(stateAt(enrolled().findings[0], undefined).state).toBe(UNKNOWN);
  });

  it("ACCEPTED_RISK holds at every head, because it was accepted for the FINDING", () => {
    const l = mark(enrolled(), id(enrolled()), ACCEPTED_RISK, { sha: SHA_B, by: BY, at: AT, reason: "known" });
    expect(stateAt(l.findings[0], SHA_C).state).toBe(ACCEPTED_RISK);
    expect(stateAt(l.findings[0], null).state).toBe(ACCEPTED_RISK);
  });
});

// ---------------------------------------------------------------------------
// WHAT CP-007 CAN CONSUME, AND WHAT THE LEDGER REFUSES TO DECIDE
// ---------------------------------------------------------------------------

describe("the ledger tracks state and decides nothing", () => {
  it("exposes exactly the deterministic fields CP-007 needs", () => {
    let l = enrolled();
    l = mark(l, l.findings[0].id, REPAIRED, { sha: SHA_B, by: BY, at: AT });
    const row = forStopLaws(l, SHA_B)[0];
    expect(Object.keys(row).sort()).toEqual([
      "acceptedRiskBy", "id", "pr", "raisedAtSha", "recordedState", "repairRound",
      "repairedShas", "rootCauseFamily", "runtimeOrEvidence", "severity", "state", "verifiedSha",
    ]);
    expect(row.repairRound).toBe(1);
    expect(row.repairedShas).toEqual([SHA_B]);
    expect(row.verifiedSha).toBe(null);
  });

  it("emits no readiness conclusion, no stop law and no merge", () => {
    const src = readFileSync(path.resolve(__dirname, "../../scripts/eng/ledger.mjs"), "utf8")
      .replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    for (const forbidden of ["RELEASE_READY", "GREEN", "CLEAN", "TRUSTED", "ARCHITECTURE_REVIEW", "REPAIR_ALLOWED", "pr merge"]) {
      expect(src).not.toContain(forbidden);
    }
  });

  it("counting a root-cause family is left to the caller, with operator-set values", () => {
    let l = emptyLedger();
    for (let i = 0; i < 2; i += 1) {
      l = enrol(l, { source: sourceFrom(619, i), severity: "P2", rootCauseFamily: "evidence-collapse", runtimeOrEvidence: "evidence", by: BY, at: AT });
    }
    const rows = forStopLaws(l, null);
    expect(rows.every((r: { rootCauseFamily: string }) => r.rootCauseFamily === "evidence-collapse")).toBe(true);
    expect(rows.length).toBe(2);
  });

  it("serialization is deterministic and version-stamped", () => {
    let l = emptyLedger();
    for (const pr of [622, 621]) l = enrol(l, { source: sourceFrom(pr, 0), severity: "P2", rootCauseFamily: "f", runtimeOrEvidence: "evidence", by: BY, at: AT });
    const a = serializeLedger(l);
    const reversed = { ...l, findings: [...l.findings].reverse() };
    expect(serializeLedger(reversed)).toBe(a); // order-independent
    expect(JSON.parse(a).version).toBe(LEDGER_VERSION);
    expect(a.endsWith("\n")).toBe(true);
  });

  it("the shipped ledger starts empty", () => {
    const shipped = JSON.parse(readFileSync(path.resolve(__dirname, "../../docs/engineering/findings-ledger.json"), "utf8"));
    expect(shipped).toEqual({ version: LEDGER_VERSION, findings: [] });
  });
});
