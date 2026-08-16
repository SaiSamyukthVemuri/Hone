import { describe, expect, it } from "vitest";
import {
  ADJUSTMENT_REASON_REQUIRED_ERROR,
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
