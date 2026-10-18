import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, closePool } from "./helpers/harness";
import { normalizePhoneForSms } from "../../lib/sms/twilio";

// WAIT S3 — TS/DB PARITY FOR THE CANONICAL SMS DESTINATION FACT.
//
// 0199 made "can this client be sent an SMS at all" a fact the database owns:
// public.sms_normalized_phone(text), applied by a generated column
// clients.sms_phone. The sender still normalises in TypeScript, because it
// needs the E.164 string to hand the provider and runs without a database
// round-trip. Two implementations of one rule is exactly the drift this suite
// exists to forbid.
//
// WHY DRIFT IS NOT COSMETIC. The two disagree in only two directions, and both
// are defects with teeth:
//
//   DB says sendable, TS says null  -> the row is selected, occupies a page
//                                      slot, is refused at the send with no
//                                      claim and no state change, and returns
//                                      to the same slot on every later pass.
//                                      That is the batch starvation 0199 was
//                                      written to remove, reproduced one layer
//                                      down and invisible because nothing
//                                      errors.
//   DB says null, TS says sendable  -> a client who could have been reminded
//                                      is silently never selected at all.
//
// So this compares OUTPUTS, row by row, and fails on a single disagreement.
//
// ANTI-VACUITY. A corpus of well-formed numbers would pass against almost any
// implementation. The cases below were chosen because they SEPARATE candidate
// implementations: an earlier draft of the SQL trimmed `[^!-~]` (every
// non-printable-ASCII character) instead of the ECMAScript whitespace set, and
// the five "invisible or letter before a plus" rows below are precisely the
// ones that caught it. Deleting them would make this suite green against a
// formulation that silently starves rows.

const c = (n: number) => String.fromCharCode(n);
const UK = "+441234567890";

// [label, input]. Built with fromCharCode so no invisible character can be
// eaten by an editor, normalised by a formatter, or misread in review.
const CORPUS: ReadonlyArray<readonly [string, string]> = [
  ["empty", ""],
  ["spaces-only", "   "],
  ["tab-only", c(9)],
  ["newline-only", c(10)],
  ["nbsp-only", c(160)],

  // In the ECMAScript trim set: trimmed on BOTH sides, so the '+' is seen.
  ["tab-before-plus", c(9) + UK],
  ["nbsp-before-plus", c(160) + UK],
  ["bom-before-plus", c(0xfeff) + UK],
  ["ideographic-space-before-plus", c(0x3000) + UK],
  ["line-separator-before-plus", c(0x2028) + UK],
  ["para-separator-before-plus", c(0x2029) + UK],
  ["narrow-nbsp-before-plus", c(0x202f) + UK],
  ["medium-math-space-before-plus", c(0x205f) + UK],
  ["ogham-space-before-plus", c(0x1680) + UK],
  ["enquad-before-plus", c(0x2000) + UK],
  ["hairspace-before-plus", c(0x200a) + UK],
  ["trailing-nbsp", UK + c(160)],
  ["trailing-bom", UK + c(0xfeff)],

  // NOT in the ECMAScript trim set. These must NOT be trimmed on either side,
  // so the '+' is not leading, the NANP branch applies, and 12 digits is
  // neither 10 nor 11-leading-1 => null. These five rows are the ones that
  // caught the rejected `[^!-~]` formulation.
  ["zwsp-before-plus", c(0x200b) + UK],
  ["zwnj-before-plus", c(0x200c) + UK],
  ["accented-letter-before-plus", c(0xe9) + UK],
  ["cyrillic-letter-before-plus", c(0x0416) + UK],
  ["emoji-before-plus", c(0xd83d) + c(0xde00) + UK],

  // Ordinary shapes.
  ["spaces-punct-plus", "  +1 (415) 555-0132  "],
  ["nanp-punct", "(415) 555-0132"],
  ["nanp-bare-10", "4155550132"],
  ["nanp-11-leading-1", "14155550132"],
  ["11-not-leading-1", "24155550132"],
  ["already-plus-1", "+14155550132"],
  ["valid-e164-uk", UK],
  ["letters-only", "abc"],
  ["plus-no-digits", "+abc"],
  ["plus-alone", "+"],

  // Digit-count boundaries, both sides of each edge.
  ["too-short-5", "12345"],
  ["plus-7-below-min", "+1234567"],
  ["plus-8-at-min", "+12345678"],
  ["plus-15-at-max", "+123456789012345"],
  ["plus-16-above-max", "+1234567890123456"],
  ["seven-digits", "555-0132"],

  // The malformed classes from the P1: non-null, non-blank, unsendable.
  ["punct-only", "()- "],
  ["partial-nanp", "(415) 555"],
  ["digits-with-ext", "4155550132 x22"],
  ["letters-then-10-digits", "phone: 415 555 0132"],
  ["inner-plus-after-digits", "(415) +555-0132"],
  ["letters-before-plus", "abc+1234567890"],
  ["double-plus", "++441234567890"],
  ["fullwidth-plus-11", c(0xff0b) + "14155550132"],
  ["leading-zero-10", "0155550132"],
  ["newlines-around-10", c(10) + "4155550132" + c(10)],
  ["crlf-around-plus", c(13) + c(10) + UK + c(13) + c(10)],
  ["arabic-indic-digits", c(0x0661) + c(0x0662) + c(0x0663)],
];

afterAll(async () => {
  await closePool();
});

describe("0199 — sms_normalized_phone matches normalizePhoneForSms", () => {
  it("agrees with the shipped TypeScript on every corpus row", async () => {
    // One round trip: the whole corpus is compared inside the database so a
    // per-row await cannot mask a failure by timing out first.
    const labels = CORPUS.map(([label]) => label);
    const inputs = CORPUS.map(([, input]) => input);
    const expected = inputs.map((input) => normalizePhoneForSms(input));

    const res = await adminQuery(
      `select t.label,
              t.expected,
              public.sms_normalized_phone(t.input) as actual
         from unnest($1::text[], $2::text[], $3::text[]) as t(label, input, expected)
        where public.sms_normalized_phone(t.input) is distinct from t.expected`,
      [labels, inputs, expected],
    );

    const disagreements = res.rows.map(
      (r: { label: string; expected: string | null; actual: string | null }) =>
        `${r.label}: ts=${r.expected ?? "<null>"} db=${r.actual ?? "<null>"}`,
    );
    expect(disagreements).toEqual([]);
  });

  it("agrees on NULL, which the generated column sees for every client without a phone", async () => {
    const res = await adminQuery(
      `select public.sms_normalized_phone(null) as actual`,
    );
    expect(res.rows[0].actual).toBeNull();
    expect(normalizePhoneForSms(null)).toBeNull();
  });

  it("covers both outcomes, so the comparison cannot pass by returning null throughout", async () => {
    // A corpus of only-unsendable inputs would agree with an implementation
    // that returns null unconditionally. Both classes must be represented.
    const sendable = CORPUS.filter(([, i]) => normalizePhoneForSms(i) !== null);
    const unsendable = CORPUS.filter(([, i]) => normalizePhoneForSms(i) === null);
    expect(sendable.length).toBeGreaterThanOrEqual(10);
    expect(unsendable.length).toBeGreaterThanOrEqual(10);
  });

  it("the stored column equals the function for every existing client row", async () => {
    // The column is GENERATED, so this can only fail if a value was written
    // under a different definition of the function than the one now installed
    // — the staleness hazard of using a user-defined function in a generated
    // expression. This is the detector for it.
    const res = await adminQuery(
      `select count(*)::int as mismatches
         from public.clients
        where sms_phone is distinct from public.sms_normalized_phone(phone)`,
    );
    expect(res.rows[0].mismatches).toBe(0);
  });

  it("refuses a direct write to the generated column", async () => {
    // Proves the fact cannot be set out of band — the property that makes it
    // impossible for an application write path to "forget" to maintain it.
    await expect(
      adminQuery(
        `update public.clients set sms_phone = '+15550000000' where false`,
      ),
    ).rejects.toThrow(/can only be updated to DEFAULT/i);
  });
});
