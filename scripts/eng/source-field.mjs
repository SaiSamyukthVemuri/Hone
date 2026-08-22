#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CP-005 FOUNDATION: checked source presence.
//
// ONE exported function. It answers only: was this source property present, and
// if so what exact value did it carry? It knows nothing about GitHub,
// authority, provenance, reply status or cleanliness.
//
// WHY A MATCHER RATHER THAN A VALUE. Three retired vehicles tried to represent
// absence as something a consumer holds:
//
//   `?? null`            - absence became a real value, indistinguishable from
//                          a source null;
//   the string "UNKNOWN" - truthy and non-null, so roughly fourteen existing
//                          null/truthiness sites silently read it as data;
//   `{kind:"ABSENT"}`    - structurally distinct, but STILL an object, so
//                          `if (descriptor)` took the positive branch for
//                          absence every single time.
//
// Each was safer than the last and each still let absence be read as proof,
// because each handed the consumer something to forget to inspect.
//
// SO NOTHING IS HANDED OVER. The presence object does not exist as a public
// value; the source value exists only inside `present`, and absence is handled
// only inside `absent`. The old forms therefore have nothing to operate on:
//
//     if (field)          - there is no field
//     field != null       - there is no field
//     field ?? fallback   - a default must be written INSIDE `absent`, visibly
//     field.value         - nothing exposes `.value`
//
// LIMIT, STATED PLAINLY. JavaScript cannot enforce this at compile time in an
// untyped module. What it can do is leave the unsafe forms with no operand, and
// fail loudly on an incomplete call. That is enforcement by shape plus a
// runtime check - not by the type system.
// ---------------------------------------------------------------------------

/**
 * Read one property, dispatching on whether the SOURCE carried it.
 *
 * OWN-PROPERTY SEMANTICS. Something inherited from a prototype was never in the
 * payload, so it takes the `absent` branch - `hasOwnProperty`, never `in`.
 *
 * A non-object source takes `absent`: the caller handed nothing to read, which
 * is a statement about the source rather than a program fault.
 *
 * BOTH HANDLERS ARE REQUIRED. A partial migration throws at its first call
 * instead of silently defaulting to a branch, which is the failure mode a
 * half-migrated evidence model would otherwise have.
 */
export function matchSourceField(raw, key, handlers) {
  if (typeof handlers?.absent !== "function" || typeof handlers?.present !== "function") {
    throw new TypeError(
      "matchSourceField requires both an `absent` and a `present` handler; absence must never fall through to a default",
    );
  }
  if (raw === null || typeof raw !== "object") return handlers.absent();
  if (!Object.prototype.hasOwnProperty.call(raw, key)) return handlers.absent();
  return handlers.present(raw[key]);
}
