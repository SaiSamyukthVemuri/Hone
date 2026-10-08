/* eslint-disable @typescript-eslint/no-explicit-any -- these helpers walk arbitrary, untyped JSON on purpose */
// Independent verifier support: deep-value helpers for purity, immutability and
// key-order metamorphic checks.

import type { Rng } from "./prng";

export const clone = <T>(x: T): T => (x === undefined ? x : (structuredClone(x) as T));

export function deepFreeze<T>(x: T): T {
  if (x && typeof x === "object" && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const k of Reflect.ownKeys(x as object)) deepFreeze((x as any)[k]);
  }
  return x;
}

/** Every object reachable from `x` is frozen (primitives trivially are). */
export function isDeepFrozen(x: unknown, seen = new Set<unknown>()): boolean {
  if (!x || typeof x !== "object") return true;
  if (seen.has(x)) return true;
  seen.add(x);
  if (!Object.isFrozen(x)) return false;
  return Reflect.ownKeys(x as object).every((k) => isDeepFrozen((x as any)[k], seen));
}

/** A canonical string: object keys sorted, so it compares values, not insertion order. */
export function canon(x: unknown): string {
  return JSON.stringify(x, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
      : v,
  );
}

/** The same value with every object's own keys re-inserted in a random order. Arrays keep their order. */
export function permuteKeys<T>(x: T, r: Rng): T {
  if (Array.isArray(x)) return x.map((e) => permuteKeys(e, r)) as any;
  if (x && typeof x === "object") {
    const out: any = {};
    for (const k of r.shuffle(Object.keys(x))) out[k] = permuteKeys((x as any)[k], r);
    return out;
  }
  return x;
}

/** Calls f and reports a thrown exception as a value, so "nothing throws" is assertable. */
export function noThrow<T>(f: () => T): { threw: false; value: T } | { threw: true; error: unknown } {
  try {
    return { threw: false, value: f() };
  } catch (error) {
    return { threw: true, error };
  }
}
