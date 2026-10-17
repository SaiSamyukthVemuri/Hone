/* eslint-disable @typescript-eslint/no-explicit-any -- scripted readers return raw, untyped keys on purpose */
// Independent verifier support: an executable model of the pass boundary, written
// ONLY from PR-SNAPSHOT-01 §3 (K0, every other read bound to K0, K1; coherent iff
// K1 == K0), §4 (one bounded retry; pr_key_moved; a failed key read is not a key
// change; a confirming pass gets no retry), §7 (a terminal pass reads nothing
// else) and §15 (isDraft is a key field).
//
// Structural key equality here is the model's own (nine fields, Object.is), never
// the implementation's keysEqual.

import { NINE } from "./key-oracle";
import type { Rng } from "./prng";

export const modelEq = (a: any, b: any) => NINE.every((f) => Object.is(a?.[f], b?.[f]));

export type KeyStep = { kind: "key"; key: any } | { kind: "fail"; reason: "read_failed" | "malformed" } | { kind: "throw" };
export type BodyStep = { kind: "body"; value: unknown } | { kind: "fail"; reason: string } | { kind: "throw" };
export interface PassPlan {
  k0: KeyStep;
  body?: BodyStep;
  k1?: KeyStep;
}

export type Expected =
  | { ok: true; key: any; body: unknown; pass: number }
  | { ok: false; reason: string; pass: number; failedAt: "k0" | "body" | "k1" | "moved" };

const stepReason = (s: KeyStep | BodyStep) => (s.kind === "throw" ? "read_failed" : (s as any).reason);

/** collectCoherent per the records. `pass` is 0 or 1; the result names the pass that decided. */
export function modelCollect(passes: PassPlan[]): Expected {
  for (let i = 0; i < 2; i++) {
    const p = passes[i];
    if (!p) throw new Error("model: script ended before a decision");
    if (p.k0.kind !== "key") return { ok: false, reason: stepReason(p.k0), pass: i, failedAt: "k0" };
    let body: unknown = null;
    if (p.k0.key.state === "OPEN") {
      if (!p.body) throw new Error("model: OPEN pass without a planned body");
      if (p.body.kind !== "body") return { ok: false, reason: stepReason(p.body), pass: i, failedAt: "body" };
      body = p.body.value;
    }
    if (!p.k1) throw new Error("model: pass without a planned K1");
    if (p.k1.kind !== "key") return { ok: false, reason: stepReason(p.k1), pass: i, failedAt: "k1" };
    if (modelEq(p.k0.key, p.k1.key)) return { ok: true, key: p.k0.key, body, pass: i };
  }
  return { ok: false, reason: "pr_key_moved", pass: 1, failedAt: "moved" };
}

/** confirmPass per the records: no retry; a key difference is pr_key_moved before any evidence rule. */
export function modelConfirm(
  first: { key: any; body: unknown },
  p: PassPlan,
  same: (a: unknown, b: unknown) => boolean,
): { ok: true } | { ok: false; reason: string } {
  if (p.k0.kind !== "key") return { ok: false, reason: stepReason(p.k0) };
  const open = p.k0.key.state === "OPEN";
  let body: unknown = null;
  if (open) {
    if (!p.body) throw new Error("model: OPEN confirming pass without a planned body");
    if (p.body.kind !== "body") return { ok: false, reason: stepReason(p.body) };
    body = p.body.value;
  }
  if (!p.k1) throw new Error("model: confirming pass without a planned K1");
  if (p.k1.kind !== "key") return { ok: false, reason: stepReason(p.k1) };
  if (!modelEq(p.k0.key, p.k1.key) || !modelEq(p.k0.key, first.key)) return { ok: false, reason: "pr_key_moved" };
  if (open && !same(first.body, body)) return { ok: false, reason: "unstable_snapshot" };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Scripted readers that replay a plan, record what they were given, and turn any
// read beyond the plan into a recorded over-read (a test failure), never a guess.
// ---------------------------------------------------------------------------

export class OverRead extends Error {}

export function scripted(passes: PassPlan[]) {
  const keySteps: KeyStep[] = passes.flatMap((p) => [p.k0, ...(p.k1 ? [p.k1] : [])]);
  const bodySteps: BodyStep[] = passes.flatMap((p) => (p.body ? [p.body] : []));
  const log = { keyCalls: 0, bodyCalls: 0, bodyKeys: [] as any[], overRead: false };
  const readKey = () => {
    const s = keySteps[log.keyCalls++];
    if (!s) {
      log.overRead = true;
      throw new OverRead("readKey called beyond the plan");
    }
    if (s.kind === "throw") throw new Error("transport failure (scripted)");
    return s.kind === "key" ? { ok: true, key: s.key } : { ok: false, reason: s.reason };
  };
  const readBody = (key: any) => {
    log.bodyKeys.push(key);
    const s = bodySteps[log.bodyCalls++];
    if (!s) {
      log.overRead = true;
      throw new OverRead("readBody called beyond the plan");
    }
    if (s.kind === "throw") throw new Error("transport failure (scripted)");
    return s.kind === "body" ? { ok: true, value: s.value } : { ok: false, reason: s.reason };
  };
  return { readKey, readBody, log };
}

/**
 * Reads the records require up to and including the deciding read. After a body
 * failure the closing key read is neither required nor forbidden, so the key-call
 * count is a range there.
 */
export function plannedReads(passes: PassPlan[], decided: Expected) {
  let keyCalls = 0;
  let bodyCalls = 0;
  let slack = 0;
  for (let i = 0; i <= decided.pass; i++) {
    const p = passes[i];
    keyCalls += 1;
    if (p.k0.kind !== "key") break;
    if (p.body) {
      bodyCalls += 1;
      if (p.body.kind !== "body") {
        slack = 1;
        break;
      }
    }
    if (p.k1) keyCalls += 1;
  }
  return { keyCallsMin: keyCalls, keyCallsMax: keyCalls + slack, bodyCalls };
}

// ---------------------------------------------------------------------------
// Random scripts over a pool of keys.
// ---------------------------------------------------------------------------

const BODY_FAIL_REASONS = ["review_evidence_too_large", "external_contexts_too_large", "malformed", "read_failed"];

/**
 * `pool` holds groups of structurally equal but distinct key objects; picking a
 * fresh member of the same group exercises structural (not identity) equality.
 */
export function genPlan(r: Rng, pool: any[][], opts: { confirming?: boolean } = {}): PassPlan[] {
  const pickKey = () => r.pick(r.pick(pool));
  const failStep = (): KeyStep => (r.bool(0.3) ? { kind: "throw" } : { kind: "fail", reason: r.pick(["read_failed", "malformed"] as const) });
  const passes: PassPlan[] = [];
  const nPasses = opts.confirming ? 1 : 2;
  for (let i = 0; i < nPasses; i++) {
    const k0: KeyStep = r.bool(0.08) ? failStep() : { kind: "key", key: pickKey() };
    const plan: PassPlan = { k0 };
    passes.push(plan);
    if (k0.kind !== "key") break;
    const group = pool.find((g) => g.includes(k0.key))!;
    if (k0.key.state === "OPEN") {
      plan.body = r.bool(0.08)
        ? r.bool(0.3)
          ? { kind: "throw" }
          : { kind: "fail", reason: r.pick(BODY_FAIL_REASONS) }
        : { kind: "body", value: { pass: i, nonce: r.int(1_000_000) } };
      if (plan.body.kind !== "body") {
        // The pass is already decided. A benign closing key is planned so an
        // implementation that still reads K1 is not punished with an over-read.
        plan.k1 = { kind: "key", key: r.pick(group) };
        break;
      }
    }
    let k1: KeyStep;
    if (r.bool(0.08)) k1 = failStep();
    else if (r.bool(0.55)) k1 = { kind: "key", key: r.pick(group) };
    else k1 = { kind: "key", key: pickKey() };
    plan.k1 = k1;
    if (k1.kind !== "key" || modelEq(k0.key, k1.key)) break;
  }
  return passes;
}
