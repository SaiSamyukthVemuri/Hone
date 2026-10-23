/* eslint-disable @typescript-eslint/no-explicit-any -- the helpers walk and rebuild raw, untyped GitHub JSON on purpose */
// Independent verifier support: generic parser properties from SPEC-05A §0.
//   - pure: deterministic; never mutates its input; same result on a deep-frozen input
//   - every returned record is frozen (checked deeply: an inner array left mutable is not frozen evidence)
//   - nothing throws; every reason is a member of the closed set
//   - GraphQL: exactly the requested fields (every object inside `data`: a missing key or an extra key fails)
//   - REST: each consumed field with the right type; every other field ignored

import { canon, clone, deepFreeze, isDeepFrozen, noThrow } from "./deep";

export type Parser = (raw: unknown, params?: any) => any;

export function purityViolations(parse: Parser, raw: unknown, params?: unknown): string[] {
  const v: string[] = [];
  const before = canon(raw);
  const a = noThrow(() => parse(raw, params));
  if (a.threw) return [`threw: ${String(a.error)}`];
  if (canon(raw) !== before) v.push("mutated its input");
  const b = noThrow(() => parse(clone(raw), params));
  const c = noThrow(() => parse(deepFreeze(clone(raw)), params));
  if (b.threw || c.threw) return [...v, "threw on a copy or a deep-frozen copy"];
  if (canon(a.value) !== canon(b.value)) v.push("not deterministic");
  if (canon(a.value) !== canon(c.value)) v.push(`differs on a deep-frozen input: ${canon(c.value).slice(0, 200)}`);
  if (a.value?.ok && !isDeepFrozen(a.value.record ?? a.value.value)) v.push("returned record is not (deeply) frozen");
  return v;
}

/** Every object path inside `root` (arrays are traversed, not reported). */
export function objectPaths(x: any, path: (string | number)[] = []): (string | number)[][] {
  if (!x || typeof x !== "object") return [];
  const own = Array.isArray(x) ? [] : [path];
  const kids = Array.isArray(x) ? x.map((e, i) => objectPaths(e, [...path, i])) : Object.keys(x).map((k) => objectPaths(x[k], [...path, k]));
  return [...own, ...kids.flat()];
}

export const at = (x: any, path: (string | number)[]) => path.reduce((o, k) => o?.[k], x);

/**
 * GraphQL exact-field mutations inside `data`: for each object, every key deleted
 * once, and one unrequested key added once.
 */
export function exactFieldMutations(raw: any): Array<{ label: string; raw: any; deletedKey?: string }> {
  const out: Array<{ label: string; raw: any; deletedKey?: string }> = [];
  for (const p of objectPaths(raw.data, ["data"])) {
    const obj = at(raw, p);
    for (const k of Object.keys(obj)) {
      const r = clone(raw);
      delete at(r, p)[k];
      out.push({ label: `missing ${[...p, k].join(".")}`, raw: r, deletedKey: k });
    }
    const r = clone(raw);
    at(r, p).unrequestedField = 1;
    out.push({ label: `extra field at ${p.join(".")}`, raw: r });
  }
  return out;
}

/** Keep only the consumed fields, described as a shape: true keeps a value; an object recurses; [shape] maps arrays. */
export function pick(x: any, shape: any): any {
  if (shape === true) return clone(x);
  if (Array.isArray(shape)) return Array.isArray(x) ? x.map((e) => pick(e, shape[0])) : x;
  if (x === null || typeof x !== "object") return x;
  const out: any = {};
  for (const k of Object.keys(shape)) if (k in x) out[k] = pick(x[k], shape[k]);
  return out;
}

/** Add an unconsumed field to every object of a REST answer. */
export function sprinkle(x: any): any {
  if (Array.isArray(x)) return x.map(sprinkle);
  if (x && typeof x === "object") {
    const out: any = { zz_new_github_field: { nested: [1, "two"] } };
    for (const k of Object.keys(x)) out[k] = sprinkle(x[k]);
    return out;
  }
  return x;
}
