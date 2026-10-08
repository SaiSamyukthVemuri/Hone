/* eslint-disable @typescript-eslint/no-explicit-any -- the verifier drives the parser with raw, untyped and deliberately exotic values */
import { describe, expect, it } from "vitest";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { KEY_FIELDS, isPrKey, keysEqual, parsePrKey } from "../../../../scripts/eng/v2/contract/pr-key.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { UNKNOWN_REASONS, isUnknownReason } from "../../../../scripts/eng/v2/contract/reasons.mjs";
import { clone, noThrow, permuteKeys } from "./support/deep";
import { NINE, rawKey } from "./support/key-oracle";
import { exactFieldMutations } from "./support/parser-props";
import { rng } from "./support/prng";
import { isPrKeyViolations, keyCorpusViolations, keyPurityViolations, keysEqualViolations } from "./support/row1-properties";
import { REAL } from "./support/world";
import { budgetGuard, SLOW_ROW_MS } from "./support/budgets";

// ===========================================================================
// INDEPENDENT VERIFIER — ENG-LOOP V1 05A row 1, PrSnapshotKey.
// Oracle: PR-SNAPSHOT-01 §2 and §15 (nine fields, strict) and SPEC-05A §0 (exact
// GraphQL fields, closed reasons, frozen records, nothing throws). Expected
// outcomes come from support/key-oracle.ts, never from the implementation.
// ===========================================================================

const OPEN_800 = {
  number: 800,
  state: "OPEN" as const,
  isDraft: true,
  headSha: "fe62f51f0fd95fc97d2e21eef71d179e2e701358",
  headRef: "docs/arch-01-eng-loop-v2",
  headRepoId: 1240764106 as number | null,
  baseRef: "claude/build-hone-saas-hOex7",
  baseRepoId: 1240764106,
  baseTip: "6cdd830b0bcc5e3532016bc612bd0298db3533fb" as string | null,
};

describe("row 1 verify: parsePrKey against an independent oracle", { timeout: SLOW_ROW_MS }, () => {
  it("agrees with the §2 oracle on 4000 generated answers (valid, lookalike-invalid, extra/missing fields, envelopes)", () => {
    expect(keyCorpusViolations(parsePrKey, { n: 4000, seed: 0x05a1 })).toEqual([]);
  });

  it("agrees again on an independent seed (the corpus is not tuned to one sequence)", () => {
    expect(keyCorpusViolations(parsePrKey, { n: 2000, seed: 0xbeef })).toEqual([]);
  });

  it("is pure: deterministic, never mutates its input, and identical on a deep-frozen input", () => {
    expect(keyPurityViolations(parsePrKey, { n: 600 })).toEqual([]);
  });

  it("KEY_FIELDS is exactly the nine field names of PR-SNAPSHOT-01 §2 (isDraft included, §15)", () => {
    expect([...KEY_FIELDS].sort()).toEqual([...NINE].sort());
    expect(new Set(KEY_FIELDS).size).toBe(9);
  });

  it("never takes baseSha from baseRefOid: the stale recorded base is an extra field, so malformed", () => {
    const raw = rawKey(OPEN_800);
    raw.data.repository.pullRequest.baseRefOid = "7134239097908a8780aef7fd8fe9b3505d0f4ae0";
    const r = parsePrKey(raw, { expectedNumber: 800 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("malformed");
  });

  it("a terminal key's baseSha is null whatever baseRef carries (null, a null target, garbage, a live tip)", () => {
    for (const state of ["CLOSED", "MERGED"] as const) {
      for (const baseRef of [null, { target: null }, { target: { oid: "not-a-sha" } }, { target: { oid: "a".repeat(40) } }]) {
        const raw = rawKey({ ...OPEN_800, state, baseTip: null });
        raw.data.repository.pullRequest.baseRef = baseRef;
        const r = parsePrKey(raw, { expectedNumber: 800 });
        expect(r.ok, `${state} with baseRef ${JSON.stringify(baseRef)}`).toBe(true);
        expect(r.key.baseSha).toBeNull();
      }
    }
  });

  it("an OPEN PR with no head repository is malformed (PR-SNAPSHOT-01 fixture 5); a terminal one is a valid key", () => {
    const open = parsePrKey(rawKey({ ...OPEN_800, headRepoId: null }), { expectedNumber: 800 });
    expect(open).toMatchObject({ ok: false, reason: "malformed" });
    const merged = parsePrKey(rawKey({ ...OPEN_800, state: "MERGED", baseTip: null, headRepoId: null }), { expectedNumber: 800 });
    expect(merged.ok).toBe(true);
    expect(merged.key.headRepoId).toBeNull();
  });

  it("GraphQL exact fields at EVERY nesting level: each requested field deleted, or an unrequested one added, is malformed", () => {
    const muts = exactFieldMutations(rawKey(OPEN_800));
    expect(muts.length).toBeGreaterThan(15);
    for (const m of muts) {
      const out = noThrow(() => parsePrKey(m.raw, { expectedNumber: 800 }));
      expect(out.threw, `${m.label}: threw`).toBe(false);
      const r = (out as any).value;
      expect(r?.ok, m.label).toBe(false);
      const envelope = ["repository", "pullRequest"].includes(m.deletedKey ?? "");
      expect(envelope ? ["malformed", "read_failed"] : ["malformed"], `${m.label}: ${r?.reason}`).toContain(r?.reason);
    }
  });

  it("a missing or invalid expectedNumber is malformed, never an unchecked key (§0 request parameters are required; §1)", () => {
    for (const [label, params] of [
      ["no parameters", undefined],
      ["{}", {}],
      ["{ expectedNumber: undefined }", { expectedNumber: undefined }],
      ["null", null],
      ["{ expectedNumber: '800' }", { expectedNumber: "800" }],
      ["{ expectedNumber: 0 }", { expectedNumber: 0 }],
      ["{ expectedNumber: 800.5 }", { expectedNumber: 800.5 }],
    ] as const) {
      const out = noThrow(() => (params === undefined ? parsePrKey(rawKey(OPEN_800)) : parsePrKey(rawKey(OPEN_800), params)));
      expect(out.threw, `${label}: threw ${(out as any).error}`).toBe(false);
      expect((out as any).value?.ok, `${label}: accepted a key whose number was never checked`).toBe(false);
      expect((out as any).value?.reason, label).toBe("malformed");
    }
  });

  it("every recorded real answer, with its object keys shuffled 40 ways, yields one structurally equal key", () => {
    const r = rng(0x7ea1);
    for (const [file, n] of [
      ["pr-623-closed-unmerged.json", 623],
      ["pr-776-open-feature-base.json", 776],
      ["pr-800-open-draft.json", 800],
      ["pr-809-merged.json", 809],
    ] as const) {
      const raw = REAL.prKey(file);
      const k = parsePrKey(raw, { expectedNumber: n });
      expect(k.ok, file).toBe(true);
      for (let i = 0; i < 40; i++) {
        const k2 = parsePrKey(permuteKeys(clone(raw), r), { expectedNumber: n });
        expect(k2.ok).toBe(true);
        expect(keysEqual(k.key, k2.key)).toBe(true);
        expect(NINE.map((f) => k2.key[f])).toEqual(NINE.map((f) => k.key[f]));
      }
    }
  });

  it("nothing throws on hostile objects (§0 'Nothing throws'): a throwing getter, a throwing Proxy", () => {
    // Not reachable from JSON.parse output; recorded as a literal §0 check.
    const throwingGetter = Object.defineProperty({}, "data", {
      enumerable: true,
      get() {
        throw new Error("getter exploded");
      },
    });
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("proxy get");
        },
        has() {
          throw new Error("proxy has");
        },
        ownKeys() {
          throw new Error("proxy ownKeys");
        },
        getOwnPropertyDescriptor() {
          throw new Error("proxy descriptor");
        },
      },
    );
    for (const [label, raw] of [
      ["throwing getter", throwingGetter],
      ["hostile proxy", hostile],
    ] as const) {
      const out = noThrow(() => parsePrKey(raw, { expectedNumber: 800 }));
      expect(out.threw, `${label}: ${(out as any).error}`).toBe(false);
      expect((out as any).value?.ok, label).toBe(false);
      expect((out as any).value?.reason, `${label} (§0: exotic input is malformed)`).toBe("malformed");
    }
  });

  it("nothing throws on exotic values (§0): cycles, BigInt, undefined, functions, symbols, null prototypes", () => {
    const cyclic: any = rawKey(OPEN_800);
    cyclic.data.repository.pullRequest.self = cyclic.data.repository.pullRequest;
    const bigint: any = rawKey(OPEN_800);
    bigint.data.repository.pullRequest.number = BigInt(800);
    const nullProto = (o: any): any => {
      if (!o || typeof o !== "object") return o;
      const out = Object.create(null);
      for (const k of Object.keys(o)) out[k] = nullProto(o[k]);
      return out;
    };
    const cases: Array<[string, unknown]> = [
      ["cyclic extra field", cyclic],
      ["BigInt number", bigint],
      ["undefined", undefined],
      ["a function", () => 1],
      ["a symbol", Symbol("x")],
    ];
    for (const [label, raw] of cases) {
      const out = noThrow(() => parsePrKey(raw, { expectedNumber: 800 }));
      expect(out.threw, label).toBe(false);
      const res = (out as any).value;
      expect(res?.ok, label).toBe(false);
      expect(isUnknownReason(res?.reason), `${label}: ${res?.reason}`).toBe(true);
      expect(res?.reason, `${label} (§0: exotic input is malformed)`).toBe("malformed");
    }
    // A null-prototype copy of a valid answer carries the same values: it may parse or
    // fail closed, but it must not throw and must never yield a different key.
    const np = noThrow(() => parsePrKey(nullProto(rawKey(OPEN_800)), { expectedNumber: 800 }));
    expect(np.threw).toBe(false);
    const npv = (np as any).value;
    if (npv.ok) expect(NINE.map((f) => npv.key[f])).toEqual(NINE.map((f) => parsePrKey(rawKey(OPEN_800), { expectedNumber: 800 }).key[f]));
  });
});

describe("row 1 verify: isPrKey (§1, amended)", () => {
  it("is true exactly for values parsePrKey could return as a key: every field rule, OPEN and terminal, and nothing extra", () => {
    expect(isPrKeyViolations(isPrKey, parsePrKey, { n: 1500, seed: 0x15c0 })).toEqual([]);
  });
});

describe("row 1 verify: keysEqual is structural over exactly nine fields", () => {
  it("is reflexive, symmetric, transitive, structural, and equal to nine-field equality; every field and null matter", () => {
    expect(keysEqualViolations(keysEqual, parsePrKey)).toEqual([]);
  });
});

describe("row 1 verify: the closed reason set", () => {
  it("is frozen, duplicate-free, and recognizes exactly its own members (no prototype lookalikes)", () => {
    expect(Object.isFrozen(UNKNOWN_REASONS)).toBe(true);
    expect(new Set(UNKNOWN_REASONS).size).toBe(UNKNOWN_REASONS.length);
    for (const r of UNKNOWN_REASONS) expect(isUnknownReason(r)).toBe(true);
    for (const r of ["Malformed", "malformed ", "", "toString", "constructor", "__proto__", "hasOwnProperty", "length", "0"]) {
      expect(isUnknownReason(r), JSON.stringify(r)).toBe(false);
    }
    for (const r of [undefined, null, 0, {}, ["malformed"], new String("malformed")]) {
      expect(isUnknownReason(r as any), String(r)).toBe(false);
    }
  });

  it("holds every reason SPEC-05A and its records name for rows 1-3", () => {
    const needed = [
      "read_failed",
      "malformed",
      "pr_key_moved",
      "unstable_snapshot",
      // SPEC §5
      "fork_head",
      "diff_too_large",
      "ci_definition_changed",
      "base_ref",
      "base_ref_changed",
      "shared_head",
      "base_history_unverified",
      // SPEC §3, CAP-01 §4 / CI-ATTEST-01 §5
      "ci_candidate_listing_too_large",
      "unrecognized_ci_status",
      "unrecognized_ci_conclusion",
    ];
    for (const r of needed) expect(UNKNOWN_REASONS, r).toContain(r);
  });
});

budgetGuard("row1-key.verify.test.ts");
