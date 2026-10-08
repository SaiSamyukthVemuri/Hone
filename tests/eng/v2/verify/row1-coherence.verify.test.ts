/* eslint-disable @typescript-eslint/no-explicit-any -- scripted readers deliberately return out-of-contract, untyped values */
import { describe, expect, it } from "vitest";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { parsePrKey } from "../../../../scripts/eng/v2/contract/pr-key.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { isUnknownReason } from "../../../../scripts/eng/v2/contract/reasons.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { collectCoherent, confirmPass } from "../../../../scripts/eng/v2/adapter/internal/coherence.mjs";
import { modelEq, scripted, type PassPlan } from "./support/coherence-model";
import { canon, noThrow } from "./support/deep";
import { NINE } from "./support/key-oracle";
import { coherenceViolations, confirmViolations, keyPool } from "./support/row1-properties";

// ===========================================================================
// INDEPENDENT VERIFIER — ENG-LOOP V1 05A row 1, one coherent key per pass.
// Oracle: PR-SNAPSHOT-01 §3 (K0 / bound reads / K1, coherent iff equal), §4 (one
// bounded retry, pr_key_moved, a failed key read is not a key change, a confirming
// pass gets no retry and a key difference is pr_key_moved, never unstable_snapshot),
// §7 (a terminal pass reads nothing else), §15 (isDraft) and SPEC-05A §0.
// ===========================================================================

const pool = keyPool(parsePrKey);
const BASE = pool[0]; // open, non-draft #800-like key (three equal objects)
const FIELD_GROUPS = pool.slice(1); // each differs from BASE in one key field (or state)

describe("row 1 verify: collectCoherent against the pass-boundary model", () => {
  it("matches the model on 1500 random scripts with moves at random points, read failures and exceptions", () => {
    expect(coherenceViolations(collectCoherent, parsePrKey, { n: 1500, seed: 0x0c01 })).toEqual([]);
  });

  it("matches the model on an independent seed", () => {
    expect(coherenceViolations(collectCoherent, parsePrKey, { n: 1500, seed: 0x7357 })).toEqual([]);
  });

  it("a move of ANY key field mid-pass discards that pass whole: the retry's key and body are used, its body bound to its own K0", () => {
    for (const group of FIELD_GROUPS) {
      const moved = group[0];
      const plan: PassPlan[] = [
        { k0: { kind: "key", key: BASE[0] }, body: { kind: "body", value: { from: "first pass" } }, k1: { kind: "key", key: moved } },
        {
          k0: { kind: "key", key: group[1] },
          ...(moved.state === "OPEN" ? { body: { kind: "body" as const, value: { from: "retry" } } } : {}),
          k1: { kind: "key", key: group[2] },
        },
      ];
      const s = scripted(plan);
      const r = collectCoherent({ readKey: s.readKey, readBody: s.readBody });
      const label = NINE.filter((f) => !Object.is(moved[f], BASE[0][f])).join("+");
      expect(r.ok, label).toBe(true);
      expect(modelEq(r.key, moved), label).toBe(true);
      expect(r.body, label).toEqual(moved.state === "OPEN" ? { from: "retry" } : null);
      expect(s.log.bodyKeys.map((k) => modelEq(k, BASE[0])), label).toEqual(moved.state === "OPEN" ? [true, false] : [true]);
      expect(s.log.keyCalls, label).toBe(4);
      expect(s.log.overRead, label).toBe(false);
    }
  });

  it("two incoherent passes are pr_key_moved for every pairing of moved fields, and never read a third time", () => {
    for (const g1 of FIELD_GROUPS)
      for (const g2 of FIELD_GROUPS) {
        const open = (k: any) => k.state === "OPEN";
        const plan: PassPlan[] = [
          { k0: { kind: "key", key: BASE[0] }, body: { kind: "body", value: 1 }, k1: { kind: "key", key: g1[0] } },
          { k0: { kind: "key", key: g1[1] }, ...(open(g1[1]) ? { body: { kind: "body" as const, value: 2 } } : {}), k1: { kind: "key", key: modelEq(g1[1], g2[0]) ? BASE[1] : g2[0] } },
        ];
        const s = scripted(plan);
        const r = collectCoherent({ readKey: s.readKey, readBody: s.readBody });
        expect(r.ok).toBe(false);
        expect(r.reason).toBe("pr_key_moved");
        expect(s.log.keyCalls).toBe(4);
        expect(s.log.overRead).toBe(false);
      }
  });

  it("is deterministic over the random corpus", () => {
    const a = coherenceViolations(collectCoherent, parsePrKey, { n: 300, seed: 0xd0d0 });
    const b = coherenceViolations(collectCoherent, parsePrKey, { n: 300, seed: 0xd0d0 });
    expect(a).toEqual(b);
  });
});

describe("row 1 verify: every reader result is re-checked (§1 as amended; §0 nothing throws)", () => {
  // [label, answer, reason when returned by readKey, reason when returned by readBody]
  // §1: a key result whose key fails isPrKey -> malformed, even repeated; a body result
  // without an own, defined value -> read_failed; a failure naming a reason outside the
  // closed set, or anything that is not a result -> read_failed.
  const inherited = Object.assign(Object.create({ value: 1 }), { ok: true });
  const CASES: Array<[string, unknown, string, string]> = [
    ["undefined", undefined, "read_failed", "read_failed"],
    ["null", null, "read_failed", "read_failed"],
    ["{}", {}, "read_failed", "read_failed"],
    ["{ ok: true } with no key or value", { ok: true }, "malformed", "read_failed"],
    ["{ ok: true, key: null }", { ok: true, key: null }, "malformed", "read_failed"],
    ["{ ok: true, value: undefined }", { ok: true, value: undefined }, "malformed", "read_failed"],
    ["{ ok: true } with an inherited value", inherited, "malformed", "read_failed"],
    ['{ ok: "true" }', { ok: "true", key: null, value: 1 }, "read_failed", "read_failed"],
    ["{ ok: false } without a reason", { ok: false }, "read_failed", "read_failed"],
    ['{ ok: false, reason: "banana" }', { ok: false, reason: "banana" }, "read_failed", "read_failed"],
    ["a Promise", Promise.resolve({ ok: true, key: null }), "read_failed", "read_failed"],
    ["a number", 42, "read_failed", "read_failed"],
  ];

  it("readKey: each out-of-contract answer gives exactly the §1 reason, and nothing throws", () => {
    for (const [label, bad, asKey] of CASES) {
      const out = noThrow(() => collectCoherent({ readKey: () => bad, readBody: () => ({ ok: true, value: 1 }) }));
      expect(out.threw, `${label}: ${(out as any).error}`).toBe(false);
      const r = (out as any).value;
      expect(r?.ok, label).toBe(false);
      expect(r?.reason, label).toBe(asKey);
    }
  });

  it("readBody: each out-of-contract answer gives exactly the §1 reason, and nothing throws", () => {
    for (const [label, bad, , asBody] of CASES) {
      let k = 0;
      const out = noThrow(() => collectCoherent({ readKey: () => ({ ok: true, key: BASE[k++ % 3] }), readBody: () => bad }));
      expect(out.threw, `${label}: ${(out as any).error}`).toBe(false);
      const r = (out as any).value;
      expect(r?.ok, label).toBe(false);
      expect(r?.reason, label).toBe(asBody);
    }
  });

  it("a closed failure reason from a reader passes through unchanged", () => {
    for (const reason of ["malformed", "review_evidence_too_large", "external_contexts_too_large", "read_failed"]) {
      let k = 0;
      const r = collectCoherent({ readKey: () => ({ ok: true, key: BASE[k++ % 3] }), readBody: () => ({ ok: false, reason }) });
      expect(r).toMatchObject({ ok: false, reason });
    }
  });

  it("a NON-key returned twice is malformed, never a coherent pass", () => {
    for (const [label, junk] of [
      ["{ prNumber: 800 }", { prNumber: 800 }],
      ["{}", {}],
      ["an OPEN key missing headSha", { ...BASE[0], headSha: undefined }],
      ["a key with an extra field", { ...BASE[0], extra: true }],
      ["an OPEN key with a null baseSha", { ...BASE[0], baseSha: null }],
    ] as const) {
      const out = noThrow(() =>
        collectCoherent({ readKey: () => ({ ok: true, key: junk }), readBody: () => ({ ok: true, value: "evidence" }) }),
      );
      expect(out.threw, label).toBe(false);
      expect((out as any).value, `${label}: ${canon((out as any).value)}`).toMatchObject({ ok: false, reason: "malformed" });
    }
  });

  it("a valid K0 followed by a non-key K1 is malformed, not pr_key_moved", () => {
    const keys = [{ ok: true, key: BASE[0] }, { ok: true, key: { prNumber: 800 } }];
    let i = 0;
    const r = collectCoherent({ readKey: () => keys[Math.min(i++, 1)], readBody: () => ({ ok: true, value: 1 }) });
    expect(r).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("the confirming pass re-checks its readers too", () => {
    const first = { key: BASE[0], body: { reviews: 1 } };
    const same = (a: unknown, b: unknown) => canon(a) === canon(b);
    expect(confirmPass({ first, readKey: () => ({ ok: true, key: { prNumber: 800 } }), readBody: () => ({ ok: true, value: { reviews: 1 } }), sameEvidence: same })).toMatchObject({ ok: false, reason: "malformed" });
    let k = 0;
    expect(confirmPass({ first, readKey: () => ({ ok: true, key: BASE[k++ % 3] }), readBody: () => ({ ok: true }), sameEvidence: same })).toMatchObject({ ok: false, reason: "read_failed" });
    expect(confirmPass({ first, readKey: () => ({ ok: false, reason: "banana" }), readBody: () => ({ ok: true, value: 1 }), sameEvidence: same })).toMatchObject({ ok: false, reason: "read_failed" });
  });
});

describe("row 1 verify: confirmPass, the bounded confirming re-read", () => {
  const same = (a: unknown, b: unknown) => canon(a) === canon(b);

  it("matches the model on 1500 random confirming passes", () => {
    expect(confirmViolations(confirmPass, parsePrKey, { n: 1500, seed: 0x0c0f })).toEqual([]);
  });

  it("a key change is pr_key_moved for every field, whatever the evidence and whatever the consumer's rule says", () => {
    const first = { key: BASE[0], body: { reviews: 1 } };
    for (const group of FIELD_GROUPS) {
      for (const evidence of [{ reviews: 1 }, { reviews: 99 }]) {
        for (const rule of [() => true, () => false, same]) {
          const moved = group[0];
          const plan: PassPlan = {
            k0: { kind: "key", key: moved },
            ...(moved.state === "OPEN" ? { body: { kind: "body" as const, value: evidence } } : {}),
            k1: { kind: "key", key: group[1] },
          };
          const s = scripted([plan]);
          const r = confirmPass({ first, readKey: s.readKey, readBody: s.readBody, sameEvidence: rule });
          expect(r, `${NINE.filter((f) => !Object.is(moved[f], BASE[0][f])).join("+")} / ${canon(evidence)}`).toEqual({
            ok: false,
            reason: "pr_key_moved",
          });
          expect(s.log.keyCalls).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it("an incoherent confirming pass is pr_key_moved even when its evidence also differs and the rule rejects it", () => {
    for (const group of FIELD_GROUPS) {
      const s = scripted([{ k0: { kind: "key", key: BASE[1] }, body: { kind: "body", value: { reviews: 7 } }, k1: { kind: "key", key: group[0] } }]);
      const r = confirmPass({ first: { key: BASE[0], body: { reviews: 1 } }, readKey: s.readKey, readBody: s.readBody, sameEvidence: () => false });
      expect(r).toEqual({ ok: false, reason: "pr_key_moved" });
      expect(s.log.keyCalls).toBe(2);
    }
  });

  it("evidence equality is the consumer's rule alone: equal bodies + a rejecting rule is unstable_snapshot; different bodies + an accepting rule confirms", () => {
    const first = { key: BASE[0], body: { reviews: 1 } };
    const run = (body: unknown, rule: (a: unknown, b: unknown) => boolean) => {
      const s = scripted([{ k0: { kind: "key", key: BASE[1] }, body: { kind: "body", value: body }, k1: { kind: "key", key: BASE[2] } }]);
      return confirmPass({ first, readKey: s.readKey, readBody: s.readBody, sameEvidence: rule });
    };
    expect(run({ reviews: 1 }, () => false)).toEqual({ ok: false, reason: "unstable_snapshot" });
    expect(run({ reviews: 2 }, () => true)).toEqual({ ok: true });
  });

  it("a failed key read at either end of the confirming pass is that failure, never pr_key_moved", () => {
    const first = { key: BASE[0], body: { reviews: 1 } };
    for (const reason of ["read_failed", "malformed"] as const) {
      const atK0 = scripted([{ k0: { kind: "fail", reason } }]);
      expect(confirmPass({ first, readKey: atK0.readKey, readBody: atK0.readBody, sameEvidence: same })).toEqual({ ok: false, reason });
      expect(atK0.log.bodyCalls).toBe(0);
      const atK1 = scripted([{ k0: { kind: "key", key: BASE[1] }, body: { kind: "body", value: { reviews: 1 } }, k1: { kind: "fail", reason } }]);
      expect(confirmPass({ first, readKey: atK1.readKey, readBody: atK1.readBody, sameEvidence: same })).toEqual({ ok: false, reason });
    }
  });

  it("a throwing sameEvidence fails closed with a closed reason and does not throw", () => {
    const s = scripted([{ k0: { kind: "key", key: BASE[1] }, body: { kind: "body", value: { reviews: 1 } }, k1: { kind: "key", key: BASE[2] } }]);
    const out = noThrow(() =>
      confirmPass({
        first: { key: BASE[0], body: { reviews: 1 } },
        readKey: s.readKey,
        readBody: s.readBody,
        sameEvidence: () => {
          throw new Error("consumer rule exploded");
        },
      }),
    );
    expect(out.threw, String((out as any).error)).toBe(false);
    expect((out as any).value?.ok).toBe(false);
    expect(isUnknownReason((out as any).value?.reason)).toBe(true);
  });
});
