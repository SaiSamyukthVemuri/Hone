// THE strict CAD money parser for operator-authored amounts.
//
// F-PAY-002. The prepare action used to hold a `parseAmountCents` that did
// `Number(trimmed)` then `Math.round(asNumber * 100)`. That is coercion, not
// parsing, and it was silently generous in ways that matter when the result is
// what a real card is charged:
//
//   "1e2"        -> 10000  (scientific notation became $100)
//   "0x64"       -> 10000  (hexadecimal became $100)
//   "Infinity"   -> rejected only because of a separate isFinite guard
//   "10.999"     -> 1100   (a third decimal was ROUNDED UP into a real charge)
//   "10.10"      -> 1009.9999999999999 before Math.round rescued it
//
// The last two are the load-bearing ones. A practitioner typing a price with
// three decimals has made a mistake, and the safe answer is to say so, never to
// pick a number for her. And cents must not be reached through binary floating
// point at all: 10.10 * 100 is not 1010 in IEEE-754, and Math.round only
// happens to repair it for the magnitudes we have tested.
//
// So this module parses the DECIMAL STRING and computes cents with exact
// integer arithmetic. It NEVER normalises, NEVER clamps, and NEVER rounds: an
// input outside the accepted grammar is rejected with a reason.
//
// The grammar is ordinary CAD cash-register syntax and nothing else:
//
//   [$] digits [. 1-or-2 digits]
//   [$] well-formed thousands groups [. 1-or-2 digits]
//
// Accepted:   "120"  "120.5"  "120.50"  "$120.00"  "1,200.00"  "0"
// Rejected:   ""  "-100"  "+100"  "NaN"  "Infinity"  "1e2"  "0x64"  "12.345"
//             "120."  ".50"  "1.2.3"  "1,20.00"  ",100"  "100 dollars"
//
// Zero parses successfully and is returned as 0 cents. Whether $0.00 may become
// a payment is a PRODUCT decision, not a parsing one, and it is made in
// lib/billing/checkout-final-amount.ts. A parser that rejected zero would force
// that caller to read "malformed" and mean "comped", which is exactly the kind
// of conflation this file exists to remove.

export type CadAmountParseFailure =
  // Nothing was typed at all.
  | "blank"
  // Outside the grammar. Deliberately ONE reason: enumerating "you used
  // scientific notation" versus "you used three decimals" would multiply the
  // practitioner-facing copy without changing what she has to do, which is
  // type an ordinary dollar amount.
  | "malformed"
  // Well-formed, but larger than this payment surface supports.
  | "above_ceiling";

export type CadAmountParse =
  | { ok: true; cents: number }
  | { ok: false; reason: CadAmountParseFailure };

// A real amount is never long. Bounding the input BEFORE any numeric work
// keeps a hostile 100k-digit string from reaching BigInt at all.
const MAX_INPUT_LENGTH = 32;

// One optional leading $, then either well-formed thousands groups or a plain
// digit run, then an optional 1-or-2-digit fraction. Anchored at both ends, so
// a trailing "e5" or " dollars" cannot ride along.
const CAD_DECIMAL = /^\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parse a practitioner-typed CAD amount into exact integer cents.
 *
 * `ceilingCents` is passed in rather than imported so this module stays a pure
 * grammar-and-arithmetic helper with no opinion about which payment surface is
 * calling it.
 */
export function parseCadAmountToCents(
  raw: string,
  ceilingCents: number,
): CadAmountParse {
  // Surrounding whitespace is a typing artefact, not input. Whitespace INSIDE
  // the number is malformed and stays malformed: the regex has no \s in it.
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: "blank" };
  if (trimmed.length > MAX_INPUT_LENGTH) {
    return { ok: false, reason: "malformed" };
  }

  const match = CAD_DECIMAL.exec(trimmed);
  if (!match) return { ok: false, reason: "malformed" };

  const wholeDigits = match[1].replace(/,/g, "");
  // "5" means 50 cents, "50" means 50 cents, absent means 0 cents. Padded
  // rather than multiplied, so no floating point is involved at any point.
  const fractionDigits = (match[2] ?? "").padEnd(2, "0");

  // BigInt, not Number: `Number(wholeDigits) * 100` loses precision above
  // 2^53/100, and the whole point of this module is that the cents value is
  // exact for every input the grammar accepts.
  const cents = BigInt(wholeDigits) * 100n + BigInt(fractionDigits);
  if (cents > BigInt(ceilingCents)) {
    return { ok: false, reason: "above_ceiling" };
  }

  // Safe by construction: cents <= ceilingCents, and every ceiling this
  // codebase uses is far below Number.MAX_SAFE_INTEGER.
  return { ok: true, cents: Number(cents) };
}

/**
 * "$120.00". THE single money formatter for the session-payment surfaces, so
 * the amount in the audit note, the amount in the prepare form and the amount
 * in the charge confirmation cannot drift apart by a rounding style.
 */
export function formatCadFromCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * "120.00". The same number as `formatCadFromCents` without the currency
 * symbol, for prefilling an input whose value is re-parsed by
 * `parseCadAmountToCents`.
 *
 * Round-trips for every NON-NEGATIVE integer cents value, which is the whole
 * domain it is used over: the reference price it prefills is always > 0. A
 * negative or fractional input has no meaningful input representation — the
 * grammar has no sign and no sub-cent — so it is normalised to "0.00" rather
 * than being allowed to emit something like "-1.-50" that the parser would then
 * reject. Silently wrong output from a money helper is worse than a visibly
 * wrong zero.
 */
export function centsToAmountInputValue(cents: number): string {
  if (!Number.isFinite(cents) || cents <= 0) return "0.00";
  const whole = Math.trunc(cents / 100);
  const frac = Math.trunc(cents) % 100;
  return `${whole}.${String(frac).padStart(2, "0")}`;
}
