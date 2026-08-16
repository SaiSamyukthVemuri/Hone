import { describe, expect, it } from "vitest";
import {
  ADJUSTMENT_REASON_REQUIRED_ERROR,
  hasMeaningfulAdjustmentReason,
  ADJUSTMENT_REASON_TOO_LONG_ERROR,
  NOTE_AND_REASON_TOO_LONG_ERROR,
  NO_CHARGE_REQUIRED_MESSAGE,
  OWNER_ONLY_AMOUNT_ERROR,
  REFERENCE_CHANGED_ERROR,
  decideCheckoutFinalAmount,
  type CheckoutFinalAmountDecision,
} from "@/lib/billing/checkout-final-amount";
import {
  SESSION_PAYMENT_ADJUSTMENT_REASON_MAX_LENGTH,
  SESSION_PAYMENT_AMOUNT_CEILING_CENTS,
  SESSION_PAYMENT_INTERNAL_NOTE_MAX_LENGTH,
} from "@/lib/billing/session-payment-types";

// F-PAY-002. THE checkout amount decision, exercised directly.
//
// The prepare action's behavioural test (tests/app/sessions/prepare-final-
// amount-authority.test.ts) proves the ROW that lands in the database. This
// file proves the decision itself, including the branches that are awkward to
// reach through the action: reason-length boundaries, note composition
// boundaries, and the exact ordering between the stale check and everything
// else.

const REFERENCE = 12_000;

function decide(
  over: Partial<Parameters<typeof decideCheckoutFinalAmount>[0]> = {},
): CheckoutFinalAmountDecision {
  return decideCheckoutFinalAmount({
    referenceCents: REFERENCE,
    ceilingCents: SESSION_PAYMENT_AMOUNT_CEILING_CENTS,
    expectedReferenceRaw: String(REFERENCE),
    requestedFinalRaw: "120.00",
    adjustmentReasonRaw: "",
    internalNoteRaw: "",
    actorIsOwner: true,
    ...over,
  });
}

describe("charging exactly the booked price", () => {
  it("prepares at the reference with no reason and no owner requirement", () => {
    expect(decide({ actorIsOwner: false })).toEqual({
      kind: "prepare",
      amountCents: 12_000,
      internalNote: null,
    });
  });

  it("accepts any spelling of the same amount", () => {
    for (const raw of ["120", "120.0", "120.00", "$120.00", " 120.00 "]) {
      expect(decide({ requestedFinalRaw: raw })).toMatchObject({
        kind: "prepare",
        amountCents: 12_000,
      });
    }
  });

  it("keeps an unrelated internal note verbatim", () => {
    expect(decide({ internalNoteRaw: "  Client ran late.  " })).toEqual({
      kind: "prepare",
      amountCents: 12_000,
      internalNote: "Client ran late.",
    });
  });

  it("ignores an adjustment reason nobody asked for", () => {
    // The reason is audit context for a CHANGED total. Writing one for an
    // unchanged total would record an adjustment that did not happen.
    expect(decide({ adjustmentReasonRaw: "Client discount" })).toEqual({
      kind: "prepare",
      amountCents: 12_000,
      internalNote: null,
    });
  });
});

describe("an owner-authored total", () => {
  it("prepares a discount at the authored amount", () => {
    expect(
      decide({ requestedFinalRaw: "100.00", adjustmentReasonRaw: "Client discount" }),
    ).toMatchObject({ kind: "prepare", amountCents: 10_000 });
  });

  it("prepares an add-on at the authored amount", () => {
    expect(
      decide({
        requestedFinalRaw: "145.00",
        adjustmentReasonRaw: "Aftercare product",
      }),
    ).toMatchObject({ kind: "prepare", amountCents: 14_500 });
  });

  it("records the reference, the final amount and the reason as prose", () => {
    const d = decide({
      requestedFinalRaw: "100.00",
      adjustmentReasonRaw: "Client discount",
    });
    expect(d).toMatchObject({
      kind: "prepare",
      internalNote: "Checkout adjusted from $120.00 to $100.00. Reason: Client discount",
    });
  });

  it("preserves an independent note AND the adjustment context", () => {
    const d = decide({
      requestedFinalRaw: "100.00",
      adjustmentReasonRaw: "Client discount",
      internalNoteRaw: "Client mentioned skin sensitivity.",
    });
    expect(d).toMatchObject({
      kind: "prepare",
      internalNote:
        "Client mentioned skin sensitivity.\n\nCheckout adjusted from $120.00 to $100.00. Reason: Client discount",
    });
  });

  it("does not claim a product, a discount rate, or a line item", () => {
    const d = decide({
      requestedFinalRaw: "145.00",
      adjustmentReasonRaw: "Aftercare product",
    });
    const note = (d as { internalNote: string }).internalNote;
    // Prose, not a machine-readable claim. Nothing downstream may parse this
    // back into an itemisation this change does not build.
    expect(note).not.toMatch(/\bqty\b|\bsku\b|\bline_item\b|%/);
  });

  it("charges to the cent, without rounding the operator's number", () => {
    expect(
      decide({ requestedFinalRaw: "99.99", adjustmentReasonRaw: "Discount" }),
    ).toMatchObject({ kind: "prepare", amountCents: 9_999 });
    expect(
      decide({ requestedFinalRaw: "0.01", adjustmentReasonRaw: "Discount" }),
    ).toMatchObject({ kind: "prepare", amountCents: 1 });
  });
});

describe("a changed total is owner-only", () => {
  it("refuses a non-owner downward adjustment", () => {
    expect(
      decide({
        actorIsOwner: false,
        requestedFinalRaw: "100.00",
        adjustmentReasonRaw: "Client discount",
      }),
    ).toEqual({ kind: "reject", error: OWNER_ONLY_AMOUNT_ERROR });
  });

  it("refuses a non-owner upward adjustment", () => {
    expect(
      decide({
        actorIsOwner: false,
        requestedFinalRaw: "145.00",
        adjustmentReasonRaw: "Aftercare product",
      }),
    ).toEqual({ kind: "reject", error: OWNER_ONLY_AMOUNT_ERROR });
  });

  it("refuses a one-cent non-owner adjustment", () => {
    // The gate is on "differs", not on "differs by enough to notice".
    expect(
      decide({
        actorIsOwner: false,
        requestedFinalRaw: "119.99",
        adjustmentReasonRaw: "Discount",
      }),
    ).toEqual({ kind: "reject", error: OWNER_ONLY_AMOUNT_ERROR });
  });

  it("checks ownership BEFORE the reason, so a non-owner learns the real blocker", () => {
    expect(
      decide({ actorIsOwner: false, requestedFinalRaw: "100.00" }),
    ).toEqual({ kind: "reject", error: OWNER_ONLY_AMOUNT_ERROR });
  });
});

describe("a changed total needs an explanation", () => {
  it("refuses a blank reason", () => {
    expect(decide({ requestedFinalRaw: "100.00" })).toEqual({
      kind: "reject",
      error: ADJUSTMENT_REASON_REQUIRED_ERROR,
    });
  });

  it("refuses a whitespace-only reason", () => {
    expect(
      decide({ requestedFinalRaw: "100.00", adjustmentReasonRaw: "   \n\t " }),
    ).toEqual({ kind: "reject", error: ADJUSTMENT_REASON_REQUIRED_ERROR });
  });

  // -------------------------------------------------------------------------
  // F-PAY-002 / Codex P2 "Reject visually empty adjustment reasons".
  //
  // `trim()` and `\s` are NOT a visibility test. Neither covers the zero-width
  // and format characters, so a reason built only from them had a positive
  // length, passed the non-empty check, and produced an audit line reading
  // "Reason: " with nothing visible after it — defeating the one control that
  // justifies letting an owner author an amount at all.
  //
  // Measured on the pre-fix rule: 16 distinct invisible-only inputs were
  // accepted, spanning Cf (format), Cc (control) and Mn (combining marks).
  // U+FEFF was the sole accident that already failed, because `\s` happens to
  // include it. So the rule is a POSITIVE visible-content test, not a longer
  // blocklist of the characters someone happened to name.
  // -------------------------------------------------------------------------
  const INVISIBLE_ONLY: Array<[string, string]> = [
    ["U+200B zero width space", "\u200B"],
    ["U+200B repeated", "\u200B\u200B\u200B"],
    ["U+200C zero width non-joiner", "\u200C\u200C"],
    ["U+200D zero width joiner", "\u200D"],
    ["U+2060 word joiner", "\u2060"],
    ["U+200C + U+200D", "\u200C\u200D"],
    ["spaces around zero-width", "   \u200B \u200B  "],
    ["U+00AD soft hyphen", "\u00AD"],
    ["U+180E Mongolian vowel separator", "\u180E"],
    ["U+061C Arabic letter mark", "\u061C"],
    ["U+202A/U+202C bidi embedding", "\u202A\u202C"],
    ["U+2066/U+2069 bidi isolate", "\u2066\u2069"],
    ["U+034F combining grapheme joiner", "\u034F"],
    ["U+0000 NUL", "\u0000"],
    ["U+0007 BEL", "\u0007"],
    ["U+001B ESC", "\u001B"],
    ["combining marks only", "\u0301\u0308"],
    ["tab + newline + zero-width", "\t\n\u200B"],
  ];

  for (const [label, reason] of INVISIBLE_ONLY) {
    it(`refuses a reason that is only ${label}`, () => {
      expect(
        decide({ requestedFinalRaw: "100.00", adjustmentReasonRaw: reason }),
      ).toEqual({ kind: "reject", error: ADJUSTMENT_REASON_REQUIRED_ERROR });
    });
  }

  // The rule must not become an ASCII validator. Every one of these is a real
  // thing a practitioner might type, and each must still be accepted.
  const VISIBLE_REASONS: Array<[string, string]> = [
    ["plain English", "Client discount"],
    ["product", "Aftercare product"],
    ["package", "Package adjustment"],
    ["percent sign", "50% promo"],
    ["hyphenated", "Adjustment - consultation"],
    ["emoji", "Courtesy \u{1F642}"],
    ["accented French", "R\u00E9duction client"],
    ["Japanese", "\u5024\u5f15\u304d"],
    ["Arabic", "\u062E\u0635\u0645"],
    ["digits only", "10"],
    // A BARE ZWJ emoji used to be a positive control here. The round-2
    // contract narrowed deliberately — emoji alone is not an explanation —
    // so it now lives in VISIBLE_BUT_MEANINGLESS below, and "Courtesy <emoji>"
    // covers the case that actually matters: words plus an emoji.
    ["visible text with leading zero-width", "\u200B\u200BClient discount"],
    ["visible text with trailing zero-width", "Client discount\u200B"],
  ];

  for (const [label, reason] of VISIBLE_REASONS) {
    it(`accepts a ${label} reason`, () => {
      const d = decide({
        requestedFinalRaw: "100.00",
        adjustmentReasonRaw: reason,
      });
      expect(d.kind).toBe("prepare");
    });
  }

  it("keeps a legitimate ZWJ emoji sequence intact in the audit line", () => {
    // The fix must not strip U+200D to defeat the bypass: that would silently
    // shatter a family emoji into three unrelated people.
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const d = decide({
      requestedFinalRaw: "100.00",
      adjustmentReasonRaw: `Courtesy ${family}`,
    });
    expect(d.kind).toBe("prepare");
    expect((d as { internalNote: string }).internalNote).toContain(family);
  });

  it("does not require a reason at all when the amount is unchanged", () => {
    // The visible-content rule must not leak into the ordinary checkout.
    for (const reason of ["", "\u200B", "\u0000", "   "]) {
      expect(
        decide({ requestedFinalRaw: "120.00", adjustmentReasonRaw: reason }),
      ).toMatchObject({ kind: "prepare", amountCents: 12_000 });
    }
  });

  // -------------------------------------------------------------------------
  // F-PAY-002 / Codex P2 round 2: "Reject blank letters and symbols too".
  //
  // The first repair required one character from \p{L}\p{N}\p{P}\p{S}. That
  // closed the Cf/Cc/Mn hole and opened a narrower one, because General_Category
  // is a proxy for "renders as content" and an unfaithful one in BOTH
  // directions: U+2800 BRAILLE PATTERN BLANK is a Symbol, and U+115F, U+1160,
  // U+3164, U+FFA0 are Letters, yet all five render blank. Measured: all five
  // were accepted.
  //
  // Chasing that with a longer allow-list of categories is what produced two
  // rounds of residuals, so the CONTRACT changed rather than the blocklist. A
  // payment adjustment reason must now carry at least one Unicode LETTER or
  // NUMBER after classification. Punctuation, symbols and emoji ALONE are
  // deliberately insufficient: "🙂" is not a justification for changing what a
  // client is charged. This is a narrowing, and it is intentional.
  // -------------------------------------------------------------------------
  const BLANK_FILLERS: Array<[string, string]> = [
    ["U+2800 braille pattern blank", "\u2800"],
    ["U+3164 hangul filler", "\u3164"],
    ["U+FFA0 halfwidth hangul filler", "\uFFA0"],
    ["U+115F hangul choseong filler", "\u115F"],
    ["U+1160 hangul jungseong filler", "\u1160"],
    ["U+2800 repeated", "\u2800\u2800\u2800"],
    ["fillers mixed together", "\u2800\u3164\uFFA0\u115F\u1160"],
    ["fillers padded with spaces", "  \u2800 \u3164  "],
    ["fillers plus zero-width", "\u200B\u2800\u200D"],
    ["fillers plus combining marks", "\u3164\u0301"],
    ["fillers plus punctuation", "\u2800-\u2800"],
    ["fillers plus emoji", "\u2800\u{1F642}"],
  ];

  for (const [label, reason] of BLANK_FILLERS) {
    it(`refuses a reason that is only ${label}`, () => {
      expect(
        decide({ requestedFinalRaw: "100.00", adjustmentReasonRaw: reason }),
      ).toEqual({ kind: "reject", error: ADJUSTMENT_REASON_REQUIRED_ERROR });
    });
  }

  // The deliberate narrowing. Each of these is VISIBLE and still insufficient,
  // because none of them says anything about why a charge changed.
  const VISIBLE_BUT_MEANINGLESS: Array<[string, string]> = [
    ["a bare smiley", "\u{1F642}"],
    ["a bare money emoji", "\u{1F4B0}"],
    ["a ZWJ family emoji alone", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}"],
    ["a bare hyphen", "-"],
    ["three hyphens", "---"],
    ["an ellipsis", "..."],
    ["a bare plus sign", "+"],
    ["punctuation and symbols only", "-.!?$%"],
  ];

  for (const [label, reason] of VISIBLE_BUT_MEANINGLESS) {
    it(`refuses ${label} as an adjustment reason`, () => {
      expect(
        decide({ requestedFinalRaw: "100.00", adjustmentReasonRaw: reason }),
      ).toEqual({ kind: "reject", error: ADJUSTMENT_REASON_REQUIRED_ERROR });
    });
  }

  // Real reasons in real writing systems. The rule must never become
  // ASCII-only or English-only, and an emoji BESIDE real words is fine — the
  // words carry the meaning.
  const REAL_REASONS: Array<[string, string]> = [
    ["English", "Client discount"],
    ["percent", "50% promo"],
    ["English + emoji", "Courtesy \u{1F642}"],
    ["English + ZWJ family emoji", "Courtesy \u{1F468}\u200D\u{1F469}\u200D\u{1F467}"],
    ["French", "R\u00E9duction client"],
    ["German + number", "Rabatt 10%"],
    ["Arabic", "\u062E\u0635\u0645 \u0644\u0644\u0639\u0645\u064A\u0644"],
    ["Chinese", "\u5BA2\u6237\u6298\u6263"],
    ["Korean", "\uACE0\uAC1D \uD560\uC778"],
    ["Japanese", "\u5024\u5F15\u304D"],
    ["Hindi", "\u0917\u094D\u0930\u093E\u0939\u0915 \u091B\u0942\u091F"],
    ["digits only", "10"],
    ["words after a stray filler", "\u2800Client discount"],
  ];

  for (const [label, reason] of REAL_REASONS) {
    it(`accepts a ${label} reason`, () => {
      expect(
        decide({ requestedFinalRaw: "100.00", adjustmentReasonRaw: reason }),
      ).toMatchObject({ kind: "prepare", amountCents: 10_000 });
    });
  }

  it("stores the legitimate reason unchanged, emoji and all", () => {
    // Classification normalization and the STORED value are separate concerns.
    // NFKC and the ignorable-stripping exist only to decide sufficiency; they
    // must not reach the audit note and shatter a family emoji into three
    // unrelated people.
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const d = decide({
      requestedFinalRaw: "100.00",
      adjustmentReasonRaw: `Courtesy ${family}`,
    });
    expect(d.kind).toBe("prepare");
    const note = (d as { internalNote: string }).internalNote;
    expect(note).toContain(family);
    expect(note).toContain("Courtesy");
  });

  it("does not NFKC-fold the stored reason", () => {
    // A fullwidth-typed reason is the practitioner's text; classification may
    // fold it, storage may not.
    const fullwidth = "\uFF23\uFF4C\uFF49\uFF45\uFF4E\uFF54"; // "Client" fullwidth
    const d = decide({
      requestedFinalRaw: "100.00",
      adjustmentReasonRaw: fullwidth,
    });
    expect(d.kind).toBe("prepare");
    expect((d as { internalNote: string }).internalNote).toContain(fullwidth);
  });

  it("leaves the unchanged-amount path free of the meaningful-content rule", () => {
    for (const reason of ["", "\u2800", "\u3164", "\u{1F642}", "-", "   "]) {
      expect(
        decide({ requestedFinalRaw: "120.00", adjustmentReasonRaw: reason }),
      ).toMatchObject({ kind: "prepare", amountCents: 12_000 });
    }
  });

  it("accepts a reason at exactly the length bound", () => {
    expect(
      decide({
        requestedFinalRaw: "100.00",
        adjustmentReasonRaw: "r".repeat(SESSION_PAYMENT_ADJUSTMENT_REASON_MAX_LENGTH),
      }),
    ).toMatchObject({ kind: "prepare" });
  });

  it("refuses a reason one character over the bound", () => {
    expect(
      decide({
        requestedFinalRaw: "100.00",
        adjustmentReasonRaw: "r".repeat(
          SESSION_PAYMENT_ADJUSTMENT_REASON_MAX_LENGTH + 1,
        ),
      }),
    ).toEqual({ kind: "reject", error: ADJUSTMENT_REASON_TOO_LONG_ERROR });
  });
});

describe("the note and the adjustment context must BOTH fit", () => {
  const AUDIT_LINE_LENGTH =
    "Checkout adjusted from $120.00 to $100.00. Reason: Client discount".length;

  it("accepts a note that exactly fills the remaining room", () => {
    const room =
      SESSION_PAYMENT_INTERNAL_NOTE_MAX_LENGTH - AUDIT_LINE_LENGTH - 2;
    const d = decide({
      requestedFinalRaw: "100.00",
      adjustmentReasonRaw: "Client discount",
      internalNoteRaw: "n".repeat(room),
    });
    expect(d.kind).toBe("prepare");
    expect((d as { internalNote: string }).internalNote).toHaveLength(
      SESSION_PAYMENT_INTERNAL_NOTE_MAX_LENGTH,
    );
  });

  it("refuses one character more, rather than truncating either half", () => {
    const room =
      SESSION_PAYMENT_INTERNAL_NOTE_MAX_LENGTH - AUDIT_LINE_LENGTH - 1;
    expect(
      decide({
        requestedFinalRaw: "100.00",
        adjustmentReasonRaw: "Client discount",
        internalNoteRaw: "n".repeat(room),
      }),
    ).toEqual({ kind: "reject", error: NOTE_AND_REASON_TOO_LONG_ERROR });
  });

  it("never emits a note over the column bound on any accepted path", () => {
    for (const noteLen of [0, 1, 500, 900, 930, 931, 999, 1000]) {
      const d = decide({
        requestedFinalRaw: "100.00",
        adjustmentReasonRaw: "Client discount",
        internalNoteRaw: "n".repeat(noteLen),
      });
      if (d.kind === "prepare" && d.internalNote) {
        expect(d.internalNote.length).toBeLessThanOrEqual(
          SESSION_PAYMENT_INTERNAL_NOTE_MAX_LENGTH,
        );
      }
    }
  });

  it("bounds an unchanged-amount note too", () => {
    expect(
      decide({
        internalNoteRaw: "n".repeat(SESSION_PAYMENT_INTERNAL_NOTE_MAX_LENGTH + 1),
      }),
    ).toEqual({ kind: "reject", error: NOTE_AND_REASON_TOO_LONG_ERROR });
  });
});

describe("$0.00 is a calm outcome, not a charge and not an error", () => {
  for (const raw of ["0", "0.0", "0.00", "$0.00", " 0 "]) {
    it(`${JSON.stringify(raw)} prepares nothing and says so`, () => {
      expect(decide({ requestedFinalRaw: raw })).toEqual({
        kind: "no_charge_required",
        message: NO_CHARGE_REQUIRED_MESSAGE,
      });
    });
  }

  it("does not require owner or reason to reach the zero outcome", () => {
    // It authorises nothing: no row, no Stripe call, no money fact. Gating it
    // behind the owner check would tell a practitioner she lacks permission to
    // do something that has no effect.
    expect(
      decide({ actorIsOwner: false, requestedFinalRaw: "0.00" }),
    ).toMatchObject({ kind: "no_charge_required" });
  });

  it("is still refused when the page was stale", () => {
    expect(
      decide({ requestedFinalRaw: "0.00", expectedReferenceRaw: "11900" }),
    ).toEqual({ kind: "reject", error: REFERENCE_CHANGED_ERROR });
  });
});

describe("the stale-display check runs first and cannot be bypassed", () => {
  const STALE_EXPECTED = ["11900", "13000", "1", "999999"];

  for (const expected of STALE_EXPECTED) {
    it(`refuses an unchanged total against expected=${expected}`, () => {
      expect(
        decide({ expectedReferenceRaw: expected, requestedFinalRaw: "120.00" }),
      ).toEqual({ kind: "reject", error: REFERENCE_CHANGED_ERROR });
    });

    it(`refuses a custom total against expected=${expected}`, () => {
      expect(
        decide({
          expectedReferenceRaw: expected,
          requestedFinalRaw: "100.00",
          adjustmentReasonRaw: "Client discount",
        }),
      ).toEqual({ kind: "reject", error: REFERENCE_CHANGED_ERROR });
    });
  }

  const UNUSABLE_EXPECTED = ["", "  ", "abc", "-1", "12000.5", "1e4", "0", "0x2ee0", "+12000"];

  for (const expected of UNUSABLE_EXPECTED) {
    it(`refuses a request that cannot say what it showed (${JSON.stringify(expected)})`, () => {
      expect(decide({ expectedReferenceRaw: expected })).toEqual({
        kind: "reject",
        error: REFERENCE_CHANGED_ERROR,
      });
    });
  }

  it("is checked before the amount is even parsed", () => {
    // A stale page with a malformed amount is told to refresh, not to fix a
    // number that is about to change anyway.
    expect(
      decide({ expectedReferenceRaw: "13000", requestedFinalRaw: "!!!" }),
    ).toEqual({ kind: "reject", error: REFERENCE_CHANGED_ERROR });
  });
});

describe("strict money parsing is enforced at the decision boundary", () => {
  const REJECTED = [
    "",
    "   ",
    "-100",
    "NaN",
    "Infinity",
    "1e2",
    "0x64",
    "12.345",
    "10.999",
    "120.",
    ".50",
    "1,20.00",
    "100 dollars",
    "2000.01",
    "9007199254740993",
  ];

  for (const raw of REJECTED) {
    it(`refuses ${JSON.stringify(raw)}`, () => {
      const d = decide({
        requestedFinalRaw: raw,
        adjustmentReasonRaw: "Client discount",
      });
      expect(d.kind).toBe("reject");
    });
  }

  it("accepts exactly the ceiling when it is also the reference", () => {
    expect(
      decideCheckoutFinalAmount({
        referenceCents: SESSION_PAYMENT_AMOUNT_CEILING_CENTS,
        ceilingCents: SESSION_PAYMENT_AMOUNT_CEILING_CENTS,
        expectedReferenceRaw: String(SESSION_PAYMENT_AMOUNT_CEILING_CENTS),
        requestedFinalRaw: "2000.00",
        adjustmentReasonRaw: "",
        internalNoteRaw: "",
        actorIsOwner: true,
      }),
    ).toMatchObject({ kind: "prepare", amountCents: 200_000 });
  });

  it("refuses an authored total above the ceiling instead of clamping", () => {
    const d = decide({
      requestedFinalRaw: "2500.00",
      adjustmentReasonRaw: "Aftercare product",
    });
    expect(d.kind).toBe("reject");
    expect(d).not.toHaveProperty("amountCents");
  });
});

describe("no decision path can emit an unchargeable amount", () => {
  it("every `prepare` carries a positive amount inside the ceiling", () => {
    const AMOUNTS = [
      "0", "0.01", "1", "119.99", "120", "120.01", "145", "1999.99", "2000",
      "2000.01", "-1", "abc", "", "1e2", "12.345",
    ];
    for (const raw of AMOUNTS) {
      for (const owner of [true, false]) {
        for (const reason of ["", "Client discount"]) {
          const d = decide({
            requestedFinalRaw: raw,
            adjustmentReasonRaw: reason,
            actorIsOwner: owner,
          });
          if (d.kind !== "prepare") continue;
          expect(d.amountCents).toBeGreaterThan(0);
          expect(d.amountCents).toBeLessThanOrEqual(
            SESSION_PAYMENT_AMOUNT_CEILING_CENTS,
          );
          expect(Number.isSafeInteger(d.amountCents)).toBe(true);
        }
      }
    }
  });

  it("a non-owner can only ever reach the reference amount", () => {
    const AMOUNTS = ["0.01", "100", "119.99", "120", "120.00", "145", "2000"];
    for (const raw of AMOUNTS) {
      const d = decide({ requestedFinalRaw: raw, actorIsOwner: false, adjustmentReasonRaw: "Discount" });
      if (d.kind === "prepare") expect(d.amountCents).toBe(REFERENCE);
    }
  });
});

// ---------------------------------------------------------------------------
// WHY THE GUARD HAS BELT *AND* BRACES, and how we know which is which.
//
// The mutation harness reports something worth writing down: deleting the
// explicit BLANK_FILLERS list, or deleting the NFKC normalization, changes NO
// behaviour today. Both are redundant against the CURRENT Unicode data, for two
// separate reasons:
//
//   * U+2800 BRAILLE PATTERN BLANK is category So. The narrowing to L-or-N
//     rejects it without any list.
//   * U+115F, U+1160, U+3164 and U+FFA0 are Default_Ignorable_Code_Point, so
//     the ignorable sweep removes them without any list, and NFKC folding
//     U+3164/U+FFA0 into U+1160 is not needed to get there.
//
// That redundancy is deliberate defence in depth, but code no test can falsify
// is exactly what these reviews keep catching. So this block pins the UNICODE
// FACTS the redundancy rests on instead. If a future ICU update moves any of
// them, these fail loudly — and that is precisely the moment the explicit list
// stops being belt and starts being the only thing holding.
// ---------------------------------------------------------------------------
describe("the assumptions that make the filler list redundant today", () => {
  const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
  const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

  it("U+2800 is NOT default-ignorable, and is caught only by the L/N narrowing", () => {
    expect(DEFAULT_IGNORABLE.test("\u2800")).toBe(false);
    expect(LETTER_OR_NUMBER.test("\u2800")).toBe(false);
  });

  it("every Hangul filler IS default-ignorable, which is why the sweep catches them", () => {
    for (const c of ["\u115F", "\u1160", "\u3164", "\uFFA0"]) {
      expect(DEFAULT_IGNORABLE.test(c), c).toBe(true);
      // ...and each is ALSO a Letter, which is exactly why a category-only rule
      // let them through in the first place.
      expect(LETTER_OR_NUMBER.test(c), c).toBe(true);
    }
  });

  it("NFKC folds the halfwidth/compatibility fillers onto U+1160", () => {
    expect("\u3164".normalize("NFKC")).toBe("\u1160");
    expect("\uFFA0".normalize("NFKC")).toBe("\u1160");
  });

  it("the engine supports every Unicode property the classifier relies on", () => {
    for (const src of [
      "\\p{White_Space}",
      "\\p{Default_Ignorable_Code_Point}",
      "\\p{Cc}",
      "\\p{Cf}",
      "\\p{M}",
      "\\p{L}",
      "\\p{N}",
    ]) {
      expect(() => new RegExp(`[${src}]`, "u"), src).not.toThrow();
    }
  });
});

describe("hasMeaningfulAdjustmentReason, exercised directly", () => {
  it("rejects every blank or invisible form", () => {
    for (const s of [
      "", "   ", "\u200B", "\u200C\u200D", "\u2060", "\u0000", "\u0301\u0308",
      "\u2800", "\u3164", "\uFFA0", "\u115F", "\u1160", "\u2800\u3164\uFFA0",
    ]) {
      expect(hasMeaningfulAdjustmentReason(s), JSON.stringify(s)).toBe(false);
    }
  });

  it("rejects symbols and punctuation standing alone, by design", () => {
    for (const s of ["\u{1F642}", "-", "---", "...", "+", "$", "%"]) {
      expect(hasMeaningfulAdjustmentReason(s), JSON.stringify(s)).toBe(false);
    }
  });

  it("accepts one letter or number, in any writing system", () => {
    for (const s of [
      "a", "1", "Client discount", "R\u00E9duction", "\u5024\u5F15\u304D",
      "\u062E\u0635\u0645", "\uACE0\uAC1D \uD560\uC778", "\u5BA2\u6237\u6298\u6263",
      "\u0917\u094D\u0930\u093E\u0939\u0915", "50% promo", "Courtesy \u{1F642}",
    ]) {
      expect(hasMeaningfulAdjustmentReason(s), JSON.stringify(s)).toBe(true);
    }
  });

  it("is pure: it never mutates or returns its input", () => {
    const original = "Courtesy \u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const copy = String(original);
    hasMeaningfulAdjustmentReason(original);
    expect(original).toBe(copy);
  });
});
