/* eslint-disable @typescript-eslint/no-explicit-any -- scripted readers return raw, untyped keys on purpose */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { parsePrKey } from "../../../scripts/eng/v2/contract/pr-key.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { collectCoherent, confirmPass } from "../../../scripts/eng/v2/adapter/internal/coherence.mjs";

// ===========================================================================
// ENG-LOOP V1 05A, gap row 1: one coherent key per pass.
//
// Contract (PR-SNAPSHOT-01 §3, §4, §7; ARCH-01 §15):
//   K0 = readKey()  ->  every other read keyed by K0  ->  K1 = readKey()
//   coherent iff K1 == K0, structurally over nine fields (isDraft included)
//   incoherent first collection -> exactly one retry; a second move -> pr_key_moved
//   a confirming pass gets no retry; another key -> pr_key_moved, never unstable_snapshot
//   a read or parse failure is that failure, never a retry
//   a terminal pass reads nothing but the key
// ===========================================================================

const FIXTURES = path.join(__dirname, "fixtures", "pr-key");
const load = (f: string) => JSON.parse(readFileSync(path.join(FIXTURES, f), "utf8"));
const keyOf = (f: string, n: number, edit?: (p: any) => void) => {
  const raw = load(f);
  edit?.(raw.data.repository.pullRequest);
  const r = parsePrKey(raw, { expectedNumber: n });
  if (!r.ok) throw new Error(`fixture ${f} did not parse: ${r.reason}`);
  return r.key;
};

const OPEN = () => keyOf("pr-800-open-draft.json", 800);
const OPEN_READY = () => keyOf("pr-800-open-draft.json", 800, (p) => (p.isDraft = false));
const OPEN_ADVANCED = () =>
  keyOf("pr-800-open-draft.json", 800, (p) => (p.baseRef.target.oid = "1".repeat(40)));
const MERGED = () => keyOf("pr-809-merged.json", 809);

type KeyResult = { ok: true; key: any } | { ok: false; reason: string };

/** A key reader that replays a script, and counts calls. */
function scriptedKeys(script: Array<KeyResult | (() => never)>) {
  let i = 0;
  const reader = () => {
    const step = script[i++];
    if (step === undefined) throw new Error("readKey called more often than scripted");
    if (typeof step === "function") return step();
    return step;
  };
  return Object.assign(reader, { calls: () => i });
}

/** A body reader that records the key it was given and returns a scripted value. */
function scriptedBody(script: Array<{ ok: true; value: unknown } | { ok: false; reason: string } | (() => never)>) {
  const seen: any[] = [];
  let i = 0;
  const reader = (key: any) => {
    seen.push(key);
    const step = script[i++];
    if (step === undefined) throw new Error("readBody called more often than scripted");
    if (typeof step === "function") return step();
    return step;
  };
  return Object.assign(reader, { seen, calls: () => i });
}

const ok = (key: any): KeyResult => ({ ok: true, key });
const body = (value: unknown) => ({ ok: true as const, value });
const boom = () => {
  throw new Error("transport exploded");
};

describe("collectCoherent: one coherent pass", () => {
  it("K1 == K0 gives the pass's key and body, with the body keyed by K0", () => {
    const k = OPEN();
    const readKey = scriptedKeys([ok(k), ok(OPEN())]);
    const readBody = scriptedBody([body({ ci: "x" })]);
    const r = collectCoherent({ readKey, readBody });
    expect(r).toEqual({ ok: true, key: k, body: { ci: "x" }, attempts: 1 });
    expect(readBody.seen).toEqual([k]);
    expect(readKey.calls()).toBe(2);
  });

  it("a draft toggle between K0 and K1 discards the pass and uses the one retry", () => {
    const readKey = scriptedKeys([ok(OPEN()), ok(OPEN_READY()), ok(OPEN_READY()), ok(OPEN_READY())]);
    const readBody = scriptedBody([body("first"), body("second")]);
    const r = collectCoherent({ readKey, readBody });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
    expect(r.key.isDraft).toBe(false);
    expect(r.body).toBe("second");
  });

  it("a draft toggle back the other way is also a key change", () => {
    const readKey = scriptedKeys([ok(OPEN_READY()), ok(OPEN()), ok(OPEN()), ok(OPEN())]);
    const readBody = scriptedBody([body(1), body(2)]);
    const r = collectCoherent({ readKey, readBody });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
    expect(r.key.isDraft).toBe(true);
  });

  it("moving in both passes is pr_key_moved, never a key", () => {
    const readKey = scriptedKeys([ok(OPEN()), ok(OPEN_READY()), ok(OPEN_READY()), ok(OPEN_ADVANCED())]);
    const readBody = scriptedBody([body(1), body(2)]);
    expect(collectCoherent({ readKey, readBody })).toEqual({ ok: false, reason: "pr_key_moved", attempts: 2 });
    expect(readKey.calls()).toBe(4);
  });

  it("a failed key read is read_failed, with no retry and no other read", () => {
    const readKey = scriptedKeys([{ ok: false, reason: "read_failed" }]);
    const readBody = scriptedBody([]);
    expect(collectCoherent({ readKey, readBody })).toEqual({ ok: false, reason: "read_failed", attempts: 1 });
    expect(readBody.calls()).toBe(0);
  });

  it("a malformed closing key is malformed, never a retry", () => {
    const readKey = scriptedKeys([ok(OPEN()), { ok: false, reason: "malformed" }]);
    const readBody = scriptedBody([body(1)]);
    expect(collectCoherent({ readKey, readBody })).toEqual({ ok: false, reason: "malformed", attempts: 1 });
    expect(readKey.calls()).toBe(2);
  });

  it("a body failure ends the pass with that reason; the closing key is not read", () => {
    const readKey = scriptedKeys([ok(OPEN())]);
    const readBody = scriptedBody([{ ok: false, reason: "review_evidence_too_large" }]);
    expect(collectCoherent({ readKey, readBody })).toEqual({
      ok: false,
      reason: "review_evidence_too_large",
      attempts: 1,
    });
    expect(readKey.calls()).toBe(1);
  });

  it("a terminal key reads nothing else: no CI, review or context read", () => {
    const readKey = scriptedKeys([ok(MERGED()), ok(MERGED())]);
    const readBody = scriptedBody([]);
    const r = collectCoherent({ readKey, readBody });
    expect(r).toEqual({ ok: true, key: MERGED(), body: null, attempts: 1 });
    expect(readBody.calls()).toBe(0);
  });

  it("an exception from either reader fails closed as read_failed", () => {
    expect(collectCoherent({ readKey: scriptedKeys([boom]), readBody: scriptedBody([]) })).toEqual({
      ok: false,
      reason: "read_failed",
      attempts: 1,
    });
    expect(
      collectCoherent({ readKey: scriptedKeys([ok(OPEN())]), readBody: scriptedBody([boom]) }),
    ).toEqual({ ok: false, reason: "read_failed", attempts: 1 });
  });

  it("is deterministic: the same script gives the same result", () => {
    const run = () =>
      collectCoherent({
        readKey: scriptedKeys([ok(OPEN()), ok(OPEN_READY()), ok(OPEN_READY()), ok(OPEN_READY())]),
        readBody: scriptedBody([body(1), body(2)]),
      });
    expect(run()).toEqual(run());
  });
});

describe("confirmPass: the bounded full confirming re-read", () => {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const first = () => ({ key: OPEN(), body: { reviews: 1 } });

  it("an identical confirming pass confirms", () => {
    const r = confirmPass({
      first: first(),
      readKey: scriptedKeys([ok(OPEN()), ok(OPEN())]),
      readBody: scriptedBody([body({ reviews: 1 })]),
      sameEvidence: same,
    });
    expect(r).toEqual({ ok: true });
  });

  it("same key, different non-key evidence is unstable_snapshot", () => {
    const r = confirmPass({
      first: first(),
      readKey: scriptedKeys([ok(OPEN()), ok(OPEN())]),
      readBody: scriptedBody([body({ reviews: 2 })]),
      sameEvidence: same,
    });
    expect(r).toEqual({ ok: false, reason: "unstable_snapshot" });
  });

  it("a draft toggle between the passes is pr_key_moved, even when the evidence also differs", () => {
    const r = confirmPass({
      first: first(),
      readKey: scriptedKeys([ok(OPEN_READY()), ok(OPEN_READY())]),
      readBody: scriptedBody([body({ reviews: 2 })]),
      sameEvidence: same,
    });
    expect(r).toEqual({ ok: false, reason: "pr_key_moved" });
  });

  it("an incoherent confirming pass is pr_key_moved, with no retry", () => {
    const readKey = scriptedKeys([ok(OPEN()), ok(OPEN_READY())]);
    const r = confirmPass({
      first: first(),
      readKey,
      readBody: scriptedBody([body({ reviews: 1 })]),
      sameEvidence: same,
    });
    expect(r).toEqual({ ok: false, reason: "pr_key_moved" });
    expect(readKey.calls()).toBe(2);
  });

  it("a read failure in the confirming pass is that failure", () => {
    const r = confirmPass({
      first: first(),
      readKey: scriptedKeys([ok(OPEN()), { ok: false, reason: "read_failed" }]),
      readBody: scriptedBody([body({ reviews: 1 })]),
      sameEvidence: same,
    });
    expect(r).toEqual({ ok: false, reason: "read_failed" });
  });

  it("a terminal confirming pass reads only the key, which must be equal", () => {
    const readBody = scriptedBody([]);
    expect(
      confirmPass({
        first: { key: MERGED(), body: null },
        readKey: scriptedKeys([ok(MERGED()), ok(MERGED())]),
        readBody,
        sameEvidence: same,
      }),
    ).toEqual({ ok: true });
    expect(readBody.calls()).toBe(0);
  });
});
