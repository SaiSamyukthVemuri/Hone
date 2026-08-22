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
 * JSON DURABILITY - of the DISCRIMINATOR, which is what this primitive promises.
 *
 * `{kind:"ABSENT"}` and `{kind:"PRESENT",value:null}` round-trip intact and stay
 * distinguishable. That is the load-bearing property: absence can never be
 * manufactured by serializing and re-reading.
 *
 * WHAT IS NOT PROMISED. This primitive does not claim that an arbitrary
 * JavaScript value survives JSON unchanged, because that is a different problem
 * and not this module's job:
 *
 *     JSON.stringify(NaN)       -> "null"
 *     JSON.stringify(Infinity)  -> "null"
 *     JSON.stringify(-0)        -> "0", losing negative-zero identity
 *     JSON.stringify(1n)        -> throws
 *     undefined                 -> the key is dropped entirely
 *
 * None of that makes ABSENT ambiguous with PRESENT. PRESENT(value) preserves the
 * source value exactly IN MEMORY, and that is the contract.
 *
 * There is deliberately NO durability predicate here. An earlier one answered
 * only for `undefined` while reporting "durable" for NaN, Infinity, -0 and
 * BigInt - a helper that lies about its own contract is worse than no helper.
 * The payloads Foundation-B consumes are JSON-origin data, so these cases
 * cannot arise from a real source; this stays a source-presence primitive
 * rather than becoming a generic serializer.
 */
