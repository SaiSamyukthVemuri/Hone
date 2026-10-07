/* eslint-disable @typescript-eslint/no-explicit-any -- the properties drive functions under test with untyped values on purpose */
// Independent verifier support: row-1 properties as functions of the
// implementation, returning a list of violations. The real functions must give
// an empty list; every unsafe mutant must give a non-empty one.

import {
  OverRead,
  genPlan,
  modelCollect,
  modelConfirm,
  modelEq,
  plannedReads,
  scripted,
  type PassPlan,
} from "./coherence-model";
import { canon, clone, deepFreeze, noThrow, permuteKeys } from "./deep";
import { NINE, genRaw, oracleKey, rawKey } from "./key-oracle";
import { rng } from "./prng";

type Parse = (raw: unknown, p: { expectedNumber: number }) => any;
type KeysEqual = (a: any, b: any) => boolean;

const MAX = 25; // keep failure output readable
const push = (v: string[], s: string) => {
  if (v.length < MAX) v.push(s);
};

// ---------------------------------------------------------------------------
// parsePrKey over the verifier's own generative corpus
// ---------------------------------------------------------------------------
export function keyCorpusViolations(parse: Parse, opts: { n?: number; seed?: number } = {}): string[] {
  const { n = 4000, seed = 0x5a5eed } = opts;
  const r = rng(seed);
  const v: string[] = [];
  for (let i = 0; i < n; i++) {
    const g = genRaw(r);
    const verdict = oracleKey(g.raw, g.expectedNumber);
    const before = canon(g.raw);
    const out = noThrow(() => parse(g.raw, { expectedNumber: g.expectedNumber }));
    if (out.threw) {
      push(v, `#${i} threw ${String(out.error)} [${g.note.join(", ")}]`);
      continue;
    }
    const res = out.value;
    if (canon(g.raw) !== before) push(v, `#${i} mutated its input`);
    if (typeof res?.ok !== "boolean") {
      push(v, `#${i} result has no boolean ok`);
      continue;
    }
    if (verdict.valid) {
      if (!res.ok) {
        push(v, `#${i} rejected a valid answer with ${res.reason} [${g.note.join(", ")}]`);
        continue;
      }
      for (const f of NINE)
        if (!Object.is(res.key?.[f], verdict.key[f]))
          push(v, `#${i} key.${f} = ${JSON.stringify(res.key?.[f])}, required ${JSON.stringify(verdict.key[f])}`);
      if (Object.keys(res.key ?? {}).sort().join() !== [...NINE].sort().join())
        push(v, `#${i} key carries ${Object.keys(res.key ?? {}).join(",")}, not exactly the nine fields`);
      if (!Object.isFrozen(res.key)) push(v, `#${i} key is not frozen`);
    } else {
      if (res.ok) push(v, `#${i} accepted an invalid answer: ${verdict.why.join("; ")} [${g.note.join(", ")}]`);
      else if (!verdict.reasons.includes(res.reason))
        push(v, `#${i} reason ${res.reason}, required one of ${verdict.reasons.join("/")} (${verdict.why.join("; ")})`);
    }
  }
  return v;
}

/** Purity: the same answer twice, and a deep-frozen copy, give the same result without throwing. */
export function keyPurityViolations(parse: Parse, opts: { n?: number; seed?: number } = {}): string[] {
  const { n = 600, seed = 0xf00d } = opts;
  const r = rng(seed);
  const v: string[] = [];
  for (let i = 0; i < n; i++) {
    const g = genRaw(r);
    const a = noThrow(() => parse(g.raw, { expectedNumber: g.expectedNumber }));
    const b = noThrow(() => parse(clone(g.raw), { expectedNumber: g.expectedNumber }));
    const frozen = deepFreeze(clone(g.raw));
    const c = noThrow(() => parse(frozen, { expectedNumber: g.expectedNumber }));
    if (a.threw || b.threw || c.threw) {
      push(v, `#${i} threw (plain ${a.threw}, copy ${b.threw}, frozen ${c.threw})`);
      continue;
    }
    if (canon(a.value) !== canon(b.value)) push(v, `#${i} not deterministic: ${canon(a.value)} vs ${canon(b.value)}`);
    if (canon(a.value) !== canon(c.value)) push(v, `#${i} differs on a deep-frozen input: ${canon(c.value)}`);
  }
  return v;
}

// ---------------------------------------------------------------------------
// keysEqual: reflexive, symmetric, transitive, structural, and agreeing with
// nine-field equality (PR-SNAPSHOT-01 §2 "Equality is structural over all nine
// fields; null equals only null").
// ---------------------------------------------------------------------------
export function keysEqualViolations(keysEqual: KeysEqual, parse: Parse, opts: { seed?: number } = {}): string[] {
  const r = rng(opts.seed ?? 0xe0a1);
  const v: string[] = [];
  const valid: { raw: any; n: number }[] = [];
  while (valid.length < 160) {
    const g = genRaw(r);
    if (oracleKey(g.raw, g.expectedNumber).valid) valid.push({ raw: g.raw, n: g.expectedNumber });
  }
  const keyOf = (x: { raw: any; n: number }) => parse(x.raw, { expectedNumber: x.n }).key;
  const keys = valid.map(keyOf);
  keys.forEach((k, i) => {
    if (keysEqual(k, k) !== true) push(v, `reflexivity fails for key ${i}`);
    const twin = keyOf({ raw: permuteKeys(clone(valid[i].raw), r), n: valid[i].n });
    if (twin === k) push(v, `parse returned a shared key object for key ${i}; structural equality is untested`);
    if (keysEqual(k, twin) !== true) push(v, `two parses of one answer (keys reordered) are unequal for key ${i}`);
  });
  for (let t = 0; t < 2000; t++) {
    const a = r.pick(keys);
    const b = r.pick(keys);
    const ab = keysEqual(a, b);
    if (ab !== keysEqual(b, a)) push(v, "symmetry fails");
    if (ab !== modelEq(a, b)) push(v, `disagrees with nine-field equality: ${canon(a)} vs ${canon(b)} gave ${ab}`);
  }
  // transitivity over equal classes: three independent parses of one answer
  for (let i = 0; i < 40; i++) {
    const x = valid[i];
    const [a, b, c] = [x, x, x].map((y) => keyOf({ raw: permuteKeys(clone(y.raw), r), n: y.n }));
    if (keysEqual(a, b) && keysEqual(b, c) && !keysEqual(a, c)) push(v, "transitivity fails");
  }
  // every single field matters, including isDraft (§15) and null-vs-value
  const base = {
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
  const variants: Array<[string, Partial<typeof base>]> = [
    ["prNumber", { number: 801 }],
    ["state OPEN->CLOSED", { state: "CLOSED" as any, baseTip: null }],
    ["isDraft", { isDraft: false }],
    ["headSha", { headSha: "0".repeat(39) + "1" }],
    ["headRef", { headRef: "docs/arch-01-eng-loop-v3" }],
    ["headRepoId", { headRepoId: 1240764107 }],
    ["baseRef", { baseRef: "main" }],
    ["baseRepoId", { baseRepoId: 1240764107 }],
    ["baseSha", { baseTip: "1".repeat(40) }],
  ];
  const k0 = parse(rawKey(base), { expectedNumber: 800 }).key;
  for (const [label, over] of variants) {
    const raw = rawKey({ ...base, ...over });
    const k1 = parse(raw, { expectedNumber: (over.number as number) ?? 800 }).key;
    if (!k1) push(v, `variant ${label} did not parse`);
    else if (keysEqual(k0, k1) || keysEqual(k1, k0)) push(v, `a change of ${label} alone is not a key change`);
  }
  // null equals only null: two terminal keys that differ only by a deleted head repository
  const closed = { ...base, state: "CLOSED" as any, baseTip: null };
  const withRepo = parse(rawKey(closed), { expectedNumber: 800 }).key;
  const noRepo = parse(rawKey({ ...closed, headRepoId: null }), { expectedNumber: 800 }).key;
  if (!withRepo || !noRepo) push(v, "terminal keys did not parse");
  else if (keysEqual(withRepo, noRepo)) push(v, "a null headRepoId equals a non-null one");
  return v;
}

// ---------------------------------------------------------------------------
// collectCoherent against the pass-boundary model, over random scripts
// ---------------------------------------------------------------------------
export function keyPool(parse: Parse): any[][] {
  const base = {
    number: 800,
    state: "OPEN" as const,
    isDraft: false,
    headSha: "fe62f51f0fd95fc97d2e21eef71d179e2e701358",
    headRef: "docs/arch-01-eng-loop-v2",
    headRepoId: 1240764106 as number | null,
    baseRef: "claude/build-hone-saas-hOex7",
    baseRepoId: 1240764106,
    baseTip: "6cdd830b0bcc5e3532016bc612bd0298db3533fb" as string | null,
  };
  const variants: Array<Partial<typeof base>> = [
    {},
    { isDraft: true },
    { headSha: "2".repeat(40) },
    { headRef: "docs/renamed" },
    { headRepoId: 99 },
    { baseRef: "release/x" },
    { baseRepoId: 98 },
    { baseTip: "3".repeat(40) },
    { state: "CLOSED" as any, baseTip: null },
    { state: "MERGED" as any, baseTip: null },
    { state: "CLOSED" as any, baseTip: null, headRepoId: null },
  ];
  return variants.map((over) => {
    const raw = rawKey({ ...base, ...over });
    // three structurally equal, distinct objects per group
    return [0, 1, 2].map(() => {
      const r = parse(clone(raw), { expectedNumber: 800 });
      if (!r.ok) throw new Error(`key pool raw did not parse: ${r.reason}`);
      return r.key;
    });
  });
}

type Collect = (a: { readKey: () => any; readBody: (k: any) => any }) => any;

export function coherenceViolations(collect: Collect, parse: Parse, opts: { n?: number; seed?: number } = {}): string[] {
  const { n = 1500, seed = 0xc0de } = opts;
  const r = rng(seed);
  const pool = keyPool(parse);
  const v: string[] = [];
  for (let i = 0; i < n; i++) {
    const plan = genPlan(r, pool);
    const want = modelCollect(plan);
    const s = scripted(plan);
    const out = noThrow(() => collect({ readKey: s.readKey, readBody: s.readBody }));
    const tag = `#${i} ${describePlan(plan)}`;
    if (out.threw) {
      push(v, `${tag}: threw ${String(out.error)}`);
      continue;
    }
    const got = out.value;
    if (s.log.overRead) push(v, `${tag}: read beyond the plan (keyCalls ${s.log.keyCalls}, bodyCalls ${s.log.bodyCalls})`);
    if (want.ok) {
      if (got?.ok !== true) push(v, `${tag}: required ok, got ${canon(got)}`);
      else {
        if (!modelEq(got.key, want.key)) push(v, `${tag}: returned key is not the coherent pass's key`);
        if (got.body !== want.body) push(v, `${tag}: returned body ${canon(got.body)} is not the coherent pass's body ${canon(want.body)}`);
      }
    } else if (got?.ok !== false || got.reason !== want.reason) {
      push(v, `${tag}: required ${want.reason} (pass ${want.pass}, ${want.failedAt}), got ${canon(got)}`);
    }
    const reads = plannedReads(plan, want);
    if (s.log.keyCalls < reads.keyCallsMin || s.log.keyCalls > reads.keyCallsMax)
      push(v, `${tag}: readKey called ${s.log.keyCalls}x, required ${reads.keyCallsMin}..${reads.keyCallsMax}`);
    if (s.log.bodyCalls !== reads.bodyCalls) push(v, `${tag}: readBody called ${s.log.bodyCalls}x, required ${reads.bodyCalls}`);
    // every body read is bound to its own pass's K0, never to a stale or later key
    const k0s = plan.filter((p) => p.k0.kind === "key" && p.k0.key.state === "OPEN").map((p) => (p.k0 as any).key);
    s.log.bodyKeys.forEach((k, j) => {
      if (!modelEq(k, k0s[j])) push(v, `${tag}: body read ${j} was given a key other than its pass's K0`);
    });
  }
  return v;
}

function describePlan(plan: PassPlan[]): string {
  const k = (s?: any) =>
    !s ? "-" : s.kind === "key" ? `${s.key.state[0]}${s.key.isDraft ? "d" : ""}:${s.key.headSha.slice(0, 2)}${s.key.baseSha?.slice(0, 2) ?? "nn"}` : s.kind;
  const b = (s?: any) => (!s ? "" : s.kind === "body" ? "+B" : `+B!${s.kind === "throw" ? "throw" : s.reason}`);
  return plan.map((p) => `[${k(p.k0)}${b(p.body)}..${k(p.k1)}]`).join(" ");
}

// ---------------------------------------------------------------------------
// confirmPass against the model: no retry; a key change is pr_key_moved before
// any evidence rule; the evidence rule is the consumer's (sameEvidence) alone.
// ---------------------------------------------------------------------------
type Confirm = (a: {
  first: { key: any; body: unknown };
  readKey: () => any;
  readBody: (k: any) => any;
  sameEvidence: (a: unknown, b: unknown) => boolean;
}) => any;

export function confirmViolations(confirm: Confirm, parse: Parse, opts: { n?: number; seed?: number } = {}): string[] {
  const { n = 1500, seed = 0xc0f1 } = opts;
  const r = rng(seed);
  const pool = keyPool(parse);
  const v: string[] = [];
  for (let i = 0; i < n; i++) {
    const firstKey = r.pick(r.pick(pool));
    const first = { key: firstKey, body: firstKey.state === "OPEN" ? { reviews: r.int(3) } : null };
    const sameGroup = pool.find((g) => g.includes(firstKey))!;
    // K0': usually the first key (a fresh equal object), sometimes another key
    const k0Key = r.bool(0.7) ? r.pick(sameGroup) : r.pick(r.pick(pool));
    const keyMoved = !modelEq(k0Key, firstKey);
    const plan: PassPlan = { k0: r.bool(0.06) && !keyMoved ? { kind: "fail", reason: r.pick(["read_failed", "malformed"] as const) } : { kind: "key", key: k0Key } };
    if (plan.k0.kind === "key") {
      if (k0Key.state === "OPEN")
        plan.body =
          r.bool(0.06) && !keyMoved
            ? { kind: "fail", reason: r.pick(["review_evidence_too_large", "read_failed"]) }
            : { kind: "body", value: r.bool(0.6) && first.body ? clone(first.body) : { reviews: 3 + r.int(3) } };
      const groupOfK0 = pool.find((g) => g.includes(k0Key))!;
      plan.k1 =
        r.bool(0.06) && !keyMoved
          ? { kind: "fail", reason: "read_failed" }
          : { kind: "key", key: r.bool(0.75) ? r.pick(groupOfK0) : r.pick(r.pick(pool)) };
    }
    // The consumer's evidence rule, sometimes deliberately disagreeing with plain
    // equality (open passes only: a terminal pass's evidence is its key, §7).
    const mode = firstKey.state === "OPEN" ? r.pick(["equal", "always", "never"] as const) : "equal";
    const same = (a: unknown, b: unknown) => (mode === "equal" ? canon(a) === canon(b) : mode === "always");
    const want = modelConfirm(first, plan, same);
    const s = scripted([plan]);
    const out = noThrow(() => confirm({ first, readKey: s.readKey, readBody: s.readBody, sameEvidence: same }));
    const tag = `#${i} first=${firstKey.state}${firstKey.isDraft ? "d" : ""} ${describePlan([plan])} sameEvidence=${mode}`;
    if (out.threw) {
      push(v, `${tag}: threw ${String(out.error instanceof OverRead ? "over-read" : out.error)}`);
      continue;
    }
    const got = out.value;
    if (s.log.keyCalls > 2) push(v, `${tag}: a confirming pass was retried (${s.log.keyCalls} key reads)`);
    if (want.ok ? got?.ok !== true : got?.ok !== false || got.reason !== want.reason)
      push(v, `${tag}: required ${canon(want)}, got ${canon(got)}`);
  }
  return v;
}
