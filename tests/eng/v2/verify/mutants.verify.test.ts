/* eslint-disable @typescript-eslint/no-explicit-any -- mutants wrap untyped functions under test */
import { describe, expect, it } from "vitest";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { keysEqual, parsePrKey } from "../../../../scripts/eng/v2/contract/pr-key.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { collectCoherent, confirmPass } from "../../../../scripts/eng/v2/adapter/internal/coherence.mjs";
import { NINE } from "./support/key-oracle";
import { coherenceViolations, confirmViolations, keyCorpusViolations, keysEqualViolations } from "./support/row1-properties";
import { ADVERSARIAL, SCENARIOS, matches, orderScenarios, show, type Scenario } from "./support/scenarios";
import { specModel, type Mutations } from "./support/spec-model";

// ===========================================================================
// INDEPENDENT VERIFIER — mutation detection.
//
// Part A (runs now): the hand-derived scenario table is checked against an
// executable reading of SPEC-05A (support/spec-model.ts). The unmutated reading
// must reproduce EVERY row (the table is self-consistent), and every
// intentionally UNSAFE deviation must break at least one row (the table has teeth).
//
// Part B (runs now): unsafe mutants of the row-1 functions are rejected by the
// same property checks the real row-1 functions pass.
//
// The real-pipeline mutants for rows 2-3 (wrappers around the builder's parsers
// and binders) live in mutants-pipeline.verify.test.ts, which needs those modules.
// ===========================================================================

const TABLE: Scenario[] = [...SCENARIOS, ...orderScenarios(), ...ADVERSARIAL];

function mismatches(m: Mutations): string[] {
  const out: string[] = [];
  for (const s of TABLE) {
    const got = specModel(s.world(), m);
    if (!matches(got, s.expect))
      out.push(`${s.id}: required ${show(s.expect)}, got ${got.ok ? `${got.outcome} ${JSON.stringify(got.runs)}` : `UNKNOWN(${got.reason})`}`);
  }
  return out;
}

describe("mutation detection A: the scenario table against the spec reading", () => {
  it(`the unmutated reading reproduces all ${TABLE.length} hand-derived rows (the table is self-consistent)`, () => {
    expect(mismatches({})).toEqual([]);
  });

  const MUTANTS: Array<[string, Mutations, string[]]> = [
    // [name, mutation, rows that MUST detect it — the spec-named negative controls]
    ["(a) any successful run at the head SHA counts, regardless of event/branch/workflow/repository", { anyRunAtHead: true }, ["NC3-push-run", "NC6-other-workflow", "NC1-other-branch"]],
    ["(b) the activity history is ignored (accepts after a force push or deletion)", { ignoreActivity: true }, ["NC2-force-push-after", "NC2-deletion-after"]],
    ["(c) base changes counted from the unfiltered timelineItems totalCount", { useTotalCount: true }, ["G-golden", "R4-totalcount-trap"]],
    ["timestamps compared as strings, not instants", { stringTimeCompare: true }, ["R8-tz-offset-event", "R8-fractional-event"]],
    ["'>' instead of '>=' against the earliest applicable run", { strictlyAfter: true }, ["R8-equal-instant"]],
    ["only the newest applicable run is aggregated", { newestRunOnly: true }, ["R10-failed-and-succeeded"]],
    ["a skipped required job counts as success", { skippedIsSuccess: true }, ["NC5-validate-skipped"]],
    ["rule 5 (shared head) omitted", { noSharedHead: true }, ["NC1-same-branch"]],
    ["rule 4 (base change) omitted", { noBaseRefChanged: true }, ["NC4-one-event"]],
    ["the 360-day window omitted", { noWindow: true }, ["R8-window-360-plus-1s"]],
    ["rule 3 (CI definition changed) omitted", { noCiDefinition: true }, ["R3-ci.yml"]],
    ["an unparseable timestamp is accepted and compared as NaN", { acceptInvalidTime: true }, ["R8-leap-second-event"]],
  ];

  for (const [name, m, mustDetect] of MUTANTS) {
    it(`detects the UNSAFE mutant: ${name}`, () => {
      const found = mismatches(m);
      expect(found.length, "the table does not detect this mutant").toBeGreaterThan(0);
      for (const id of mustDetect) expect(found.some((f) => f.startsWith(`${id}:`)), `row ${id} should detect it`).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Part B: row-1 mutants
// ---------------------------------------------------------------------------

/** (d) A coercing parsePrKey: "helpfully" repairs lookalike values, then parses. */
const coercingParsePrKey = (raw: any, params: any) => {
  const fix = (pr: any) => {
    if (!pr || typeof pr !== "object") return pr;
    const out = { ...pr };
    if (typeof out.number === "string" && /^\d+$/.test(out.number)) out.number = Number(out.number);
    if (typeof out.state === "string") out.state = out.state.trim().toUpperCase();
    if (out.isDraft === "true" || out.isDraft === 1) out.isDraft = true;
    if (out.isDraft === "false" || out.isDraft === 0) out.isDraft = false;
    if (typeof out.headRefOid === "string") out.headRefOid = out.headRefOid.trim().toLowerCase();
    for (const repo of ["headRepository", "baseRepository"]) {
      if (out[repo] && typeof out[repo].databaseId === "string") out[repo] = { databaseId: Number(out[repo].databaseId) };
    }
    if (out.baseRef?.target?.oid && typeof out.baseRef.target.oid === "string")
      out.baseRef = { target: { oid: out.baseRef.target.oid.toLowerCase() } };
    return out;
  };
  const pr = raw?.data?.repository?.pullRequest;
  const fixed = pr ? { ...raw, data: { ...raw.data, repository: { ...raw.data.repository, pullRequest: fix(pr) } } } : raw;
  return parsePrKey(fixed, params);
};

/** keysEqual that forgets the draft flag (the pre-§15 key). */
const keysEqualWithoutDraft = (a: any, b: any) => NINE.filter((f) => f !== "isDraft").every((f) => Object.is(a?.[f], b?.[f]));

/** A collector that keeps the FIRST pass's evidence after a retry: stale evidence under a fresh key. */
function staleBodyCollect({ readKey, readBody }: any) {
  let firstBody: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let k0: any;
    let k1: any;
    try {
      k0 = readKey();
    } catch {
      return { ok: false, reason: "read_failed" };
    }
    if (!k0.ok) return { ok: false, reason: k0.reason };
    let body: unknown = null;
    if (k0.key.state === "OPEN") {
      let b: any;
      try {
        b = readBody(k0.key);
      } catch {
        return { ok: false, reason: "read_failed" };
      }
      if (!b.ok) return { ok: false, reason: b.reason };
      body = b.value;
    }
    if (attempt === 1) firstBody = body;
    try {
      k1 = readKey();
    } catch {
      return { ok: false, reason: "read_failed" };
    }
    if (!k1.ok) return { ok: false, reason: k1.reason };
    if (keysEqual(k0.key, k1.key)) return { ok: true, key: k0.key, body: firstBody };
  }
  return { ok: false, reason: "pr_key_moved" };
}

/** A collector that never takes the closing read: no K1, so no coherence at all. */
function noClosingReadCollect({ readKey, readBody }: any) {
  let k0: any;
  try {
    k0 = readKey();
  } catch {
    return { ok: false, reason: "read_failed" };
  }
  if (!k0.ok) return { ok: false, reason: k0.reason };
  if (k0.key.state !== "OPEN") return { ok: true, key: k0.key, body: null };
  let b: any;
  try {
    b = readBody(k0.key);
  } catch {
    return { ok: false, reason: "read_failed" };
  }
  return b.ok ? { ok: true, key: k0.key, body: b.value } : { ok: false, reason: b.reason };
}

/** confirmPass that consults the evidence rule BEFORE the key: a key move reads as unstable_snapshot. */
function evidenceFirstConfirm({ first, readKey, readBody, sameEvidence }: any) {
  const k0 = readKey();
  if (!k0.ok) return { ok: false, reason: k0.reason };
  let body: unknown = null;
  if (k0.key.state === "OPEN") {
    const b = readBody(k0.key);
    if (!b.ok) return { ok: false, reason: b.reason };
    body = b.value;
  }
  const k1 = readKey();
  if (!k1.ok) return { ok: false, reason: k1.reason };
  if (k0.key.state === "OPEN" && first.key.state === "OPEN" && !sameEvidence(first.body, body))
    return { ok: false, reason: "unstable_snapshot" };
  if (!keysEqual(k0.key, k1.key) || !keysEqual(k0.key, first.key)) return { ok: false, reason: "pr_key_moved" };
  return { ok: true };
}

describe("mutation detection B: row-1 mutants are rejected by the row-1 properties", () => {
  it("baseline: the real row-1 functions give no violations on the mutant-detection seeds", () => {
    expect(keyCorpusViolations(parsePrKey, { n: 1500, seed: 0xa11 })).toEqual([]);
    expect(keysEqualViolations(keysEqual, parsePrKey, { seed: 0xa12 })).toEqual([]);
    expect(coherenceViolations(collectCoherent, parsePrKey, { n: 600, seed: 0xa13 })).toEqual([]);
    expect(confirmViolations(confirmPass, parsePrKey, { n: 600, seed: 0xa14 })).toEqual([]);
  });

  it("(d) detects a coercing parsePrKey", () => {
    expect(keyCorpusViolations(coercingParsePrKey, { n: 1500, seed: 0xa11 }).length).toBeGreaterThan(0);
  });

  it("detects a keysEqual that forgets isDraft (PR-SNAPSHOT-DRAFT-01)", () => {
    const v = keysEqualViolations(keysEqualWithoutDraft, parsePrKey, { seed: 0xa12 });
    expect(v.some((s) => s.includes("isDraft"))).toBe(true);
  });

  it("detects a collector that returns the first pass's evidence after a retry", () => {
    const v = coherenceViolations(staleBodyCollect, parsePrKey, { n: 600, seed: 0xa13 });
    expect(v.some((s) => s.includes("is not the coherent pass's body"))).toBe(true);
  });

  it("detects a collector that skips the closing key read", () => {
    expect(coherenceViolations(noClosingReadCollect, parsePrKey, { n: 600, seed: 0xa13 }).length).toBeGreaterThan(0);
  });

  it("detects a confirming pass that reports a key move as unstable_snapshot", () => {
    const v = confirmViolations(evidenceFirstConfirm, parsePrKey, { n: 600, seed: 0xa14 });
    expect(v.some((s) => s.includes('"reason":"pr_key_moved"'))).toBe(true);
  });
});
