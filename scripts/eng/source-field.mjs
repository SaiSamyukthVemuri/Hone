#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CP-005 FOUNDATION-A: structural source presence.
//
// Answers exactly one question: WAS THIS SOURCE PROPERTY PRESENT, AND IF SO,
// WHAT EXACT VALUE DID IT CARRY? It decides nothing about authority, provenance,
// reply status, cleanliness or trust - all of that is Foundation-B.
//
// WHY IT IS STRUCTURAL RATHER THAN A SENTINEL. Two retired vehicles encoded
// absence as a value inside the field: first `?? null`, then the string
// "UNKNOWN". Both are readable as data by ordinary consumer code, and
// production carries roughly fourteen sites that null-check, truthy-check or
// `??`-coalesce a projected field. A sentinel is therefore silently
// reinterpreted at every one of them:
//
//     Boolean("UNKNOWN") === true
//     "UNKNOWN" != null  === true
//
// so absence reads as a proven value and a positive fact is manufactured. That
// defect shipped four times in one vehicle and twice more in its successor,
// because remembering a rule at fourteen call sites is not a mechanism.
//
// A DESCRIPTOR CANNOT BE MISREAD THE SAME WAY. `{ kind: "ABSENT" }` is an
// object, so `Boolean(d)` and `d != null` are true for absence AND presence
// alike - the old patterns stop discriminating anything, which makes them
// visibly wrong rather than quietly wrong. A consumer must look at `kind`.
// ---------------------------------------------------------------------------

export const ABSENT = "ABSENT";
export const PRESENT = "PRESENT";

/**
 * The absence descriptor. It deliberately carries NO `value` property at all -
 * not null, not undefined-by-default, not "" or 0 or "UNKNOWN". `"value" in d`
 * is false, so there is nothing for a consumer to mistake for data.
 */
export function absent() {
  return Object.freeze({ kind: ABSENT });
}

/**
 * The presence descriptor, carrying the source value EXACTLY. No coercion: a
 * boolean stays a boolean, `null` stays `null`, an object is not cloned or
 * normalized. This primitive represents presence, never meaning.
 */
export function present(value) {
  return Object.freeze({ kind: PRESENT, value });
}

/**
 * Read one property, preserving presence information.
 *
 * OWN-PROPERTY SEMANTICS. Presence means the SOURCE carried the property.
 * Something inherited from a prototype was never in the payload, so it is
 * ABSENT - `hasOwnProperty` rather than `in` or a truthiness read.
 *
 * A non-object input is ABSENT rather than an error: a caller handed nothing to
 * read, which is a statement about the source, not a program fault.
 */
export function sourceField(raw, key) {
  if (raw === null || typeof raw !== "object") return absent();
  if (!Object.prototype.hasOwnProperty.call(raw, key)) return absent();
  return present(raw[key]);
}

/** Discriminator predicates. A consumer must pass through one of these. */
export const isPresent = (d) => d?.kind === PRESENT;
export const isAbsent = (d) => d?.kind === ABSENT;

// DELIBERATELY NOT PROVIDED: any `valueOr(d, fallback)` / `unwrap(d)` helper
// that turns ABSENT into null, undefined or a default. That would rebuild the
// exact defect behind a friendlier name - the whole point is that a consumer
// cannot reach a value without first acknowledging the discriminator.

/**
 * JSON DURABILITY, and its one honest limit.
 *
 * `{kind:"ABSENT"}` and `{kind:"PRESENT",value:null}` round-trip intact and
 * remain distinguishable, which is the load-bearing property.
 *
 * `PRESENT(undefined)` is the exception and it is called out rather than hidden.
 * JSON has no `undefined`, so `JSON.stringify` drops the key and the value does
 * not survive. The DISCRIMINATOR does: it round-trips as PRESENT, never as
 * ABSENT, so absence is never manufactured from it. A JSON source can never
 * produce this shape - only a hand-built object can - and it is left
 * representable rather than rejected so the primitive stays a pure reader.
 * `isValueDurable` states the limit explicitly for anyone serializing.
 */
export const isValueDurable = (d) => !(isPresent(d) && d.value === undefined);
