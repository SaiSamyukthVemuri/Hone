// ---------------------------------------------------------------------------
// ENG-LOOP V1: strict-validation helpers shared by every parser and binder.
//
// Positive checks only: a value is accepted when it is exactly the expected
// type and shape, never coerced. Results are frozen all the way down, so no
// consumer can turn evidence into something else after it was validated.
// ---------------------------------------------------------------------------

const SHA40 = /^[0-9a-f]{40}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

export const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export const hasExactly = (o, keys) => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(o, k));
};
export const isPosInt = (v) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
export const isNonNegInt = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export const isNonEmptyString = (v) => typeof v === "string" && v.length > 0;
export const isSha40 = (v) => typeof v === "string" && SHA40.test(v);
export const isIsoUtc = (v) => typeof v === "string" && ISO_UTC.test(v) && Number.isFinite(Date.parse(v));

/** Freeze a plain value and everything inside it. */
export function deepFreeze(v) {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
    for (const k of Object.keys(v)) deepFreeze(v[k]);
    Object.freeze(v);
  }
  return v;
}

export const fail = (reason, detail) => Object.freeze({ ok: false, reason, detail });
export const okRecord = (record) => Object.freeze({ ok: true, record: deepFreeze(record) });
export const okValue = (value) => Object.freeze({ ok: true, value: deepFreeze(value) });

/**
 * The GraphQL envelope, checked once: `{ data }` or `{ data, errors }`. Returns
 * the `data` object, or a closed failure. A GitHub error is `read_failed`.
 */
export function graphqlData(raw) {
  if (!isObject(raw)) return { failure: fail("malformed", "the answer is not a JSON object") };
  if (!Object.keys(raw).every((k) => k === "data" || k === "errors")) {
    return { failure: fail("malformed", "the answer has a top-level field other than data and errors") };
  }
  if (Object.hasOwn(raw, "errors")) {
    if (!Array.isArray(raw.errors) || raw.errors.length === 0) {
      return { failure: fail("malformed", "errors is present but is not a non-empty list") };
    }
    return { failure: fail("read_failed", "GitHub reported an error") };
  }
  if (!isObject(raw.data)) return { failure: fail("malformed", "the answer has no data object") };
  return { data: raw.data };
}
