import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// F-PAY-002 (Chloe P1: "I can't do a custom price"). THE PREPARE-TIME AMOUNT
// AUTHORITY BOUNDARY, exercised for real.
//
// WHY THIS FILE IS BEHAVIOURAL AND NOT ANOTHER SOURCE PIN
// tests/app/sessions/prepare-session-payment-action.test.ts pins the prepare
// action by grepping its source. That could prove the old F-PAY-001 posture
// ("the browser amount is not read") only as text, and it cannot prove the
// property this change turns on:
//
//     the row that lands in payment_charge_attempts carries the
//     OPERATOR-CONFIRMED final amount, and NOTHING ELSE reaches it.
//
// So this file invokes the REAL server action against recording stubs and
// asserts on the insert payload it actually produced, plus the number of
// inserts it produced — zero is the only acceptable answer for every rejection.
//
// The mock shape mirrors tests/app/sessions/execute-pricing-permission.test.ts
// (the existing behavioural precedent for this action file) so there is one
// idiom for "run the real action against stubs", not two.

// ---------------------------------------------------------------------------
// Identity. `practitionerRole` is flipped per test; the action must derive the
// owner decision from THIS value (the authenticated practitioner) and never
// from anything in the FormData.
// ---------------------------------------------------------------------------
const identity = {
  practitioner: { id: "prac-1", role: "owner" as string, active: true },
  studio: { id: "studio-1", timezone: "America/Toronto" },
};

vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: identity.practitioner,
    studio: identity.studio,
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: async () => {} }));
vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => false }));

// PAY-SETTLE / 0187. Prepare now asks whether this visit already carries an
// attested outcome, so that a practitioner is told BEFORE a `ready` attempt is
// created rather than at Run charge. Default: nothing is settled, which is the
// shape every pre-existing case in this file assumes. `settlements` is
// overridden by the one case that exercises the refusal.
const settlements = vi.hoisted(() => ({
  load: { ok: true, byAppointmentId: new Map() } as unknown,
}));
vi.mock("@/lib/billing/appointment-settlement", () => ({
  getAppointmentSettlements: async () => settlements.load,
}));

// THE ORACLE. Every rejection must leave this at zero calls; every success
// must leave exactly one payload whose amount_cents is asserted explicitly.
const inserted: Array<Record<string, unknown>> = [];

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      q.insert = (payload: Record<string, unknown>) => {
        if (table === "payment_charge_attempts") inserted.push(payload);
        return {
          select: () => ({
            single: async () => ({ data: { id: "attempt-new" }, error: null }),
          }),
        };
      };
      // The execute path's attempt lookup; unused here but kept so the module
      // under test can never reach an undefined method by accident.
      const chain = () => q;
      q.select = chain;
      q.eq = chain;
      q.maybeSingle = async () => ({ data: null, error: null });
      return q;
    },
  }),
}));

// Eligibility: always eligible, with fixed server-resolved lineage. Every id
// here is one the browser must NOT be able to influence.
const ELIGIBLE = {
  eligible: true as const,
  session: {
    id: "sess-1",
    modality: "electrolysis",
    startedAt: null,
    endedAt: null,
    pricePaidCents: null,
  },
  appointment: { id: "appt-1", status: "completed", startsAt: null },
  client: { id: "client-SERVER", name: "Test Client" },
  card: { id: "card-SERVER", brand: "visa", last4: "4242", expMonth: 1, expYear: 2030 },
  cardAuthorization: {
    signatureId: "sig-SERVER",
    templateVersion: 1,
    signedAt: "2026-01-01T00:00:00.000Z",
  },
  stripeAccountId: "acct_SERVER",
  stripeCustomerId: "cus_SERVER",
  stripePaymentMethodId: "pm_SERVER",
  existingAttempts: [],
};

let eligibility: unknown = ELIGIBLE;

vi.mock("@/lib/billing/session-payment-eligibility", () => ({
  getSessionPaymentEligibility: async () => eligibility,
}));

// The authoritative re-resolve. This is the REFERENCE price, and the whole
// point of the change is that it is no longer the same thing as the amount
// that gets charged.
let referenceLoad: unknown = {
  ok: true,
  result: {
    kind: "resolved",
    amountCents: 12_000,
    source: "service_price",
    serviceName: "Electrolysis 60 min",
    durationMinutes: 60,
    customPricingNote: null,
  },
  appointmentId: "appt-1",
};

vi.mock("@/lib/billing/authoritative-session-payment", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getAuthoritativeSessionPaymentAmount: async () => referenceLoad,
  };
});

const { prepareSessionPaymentChargeAction } = await import(
  "@/app/(app)/clients/[id]/sessions/[sessionId]/payment-actions"
);

type FormFields = {
  expected?: string;
  final?: string;
  reason?: string;
  note?: string;
  session?: string;
};

function form(fields: FormFields = {}): FormData {
  const fd = new FormData();
  fd.set("session_id", fields.session ?? "sess-1");
  fd.set("expected_amount_cents", fields.expected ?? "12000");
  if (fields.final !== undefined) fd.set("final_amount_dollars", fields.final);
  if (fields.reason !== undefined) fd.set("adjustment_reason", fields.reason);
  if (fields.note !== undefined) fd.set("internal_note", fields.note);
  return fd;
}

beforeEach(() => {
  inserted.length = 0;
  identity.practitioner = { id: "prac-1", role: "owner", active: true };
  eligibility = ELIGIBLE;
  referenceLoad = {
    ok: true,
    result: {
      kind: "resolved",
      amountCents: 12_000,
      source: "service_price",
      serviceName: "Electrolysis 60 min",
      durationMinutes: 60,
      customPricingNote: null,
    },
    appointmentId: "appt-1",
  };
});
afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// A. NORMAL PRICE. The overwhelmingly common path must stay a two-tap.
// ---------------------------------------------------------------------------
describe("A · final equals the current reference", () => {
  it("prepares at the reference amount with no adjustment reason", async () => {
    const res = await prepareSessionPaymentChargeAction(
      form({ final: "120.00" }),
    );
    expect(res.ok).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].amount_cents).toBe(12_000);
    // No adjustment happened, so no adjustment audit context is fabricated.
    expect(inserted[0].internal_note).toBeNull();
  });

  it("leaves every payment lineage field server-derived", async () => {
    const res = await prepareSessionPaymentChargeAction(
      form({ final: "120.00" }),
    );
    expect(res.ok).toBe(true);
    expect(inserted[0]).toMatchObject({
      studio_id: "studio-1",
      client_id: "client-SERVER",
      created_by_practitioner_id: "prac-1",
      client_payment_method_id: "card-SERVER",
      card_authorization_signature_id: "sig-SERVER",
      stripe_account_id: "acct_SERVER",
      stripe_customer_id: "cus_SERVER",
      stripe_payment_method_id: "pm_SERVER",
      charge_reason: "session_payment",
      status: "ready",
      currency: "cad",
    });
  });

  it("a non-owner may still prepare at the unchanged reference price", async () => {
    identity.practitioner = { id: "prac-2", role: "practitioner", active: true };
    const res = await prepareSessionPaymentChargeAction(
      form({ final: "120.00" }),
    );
    expect(res.ok).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].amount_cents).toBe(12_000);
  });
});

// ---------------------------------------------------------------------------
// B + C. THE REGRESSION CHLOE REPORTED. A deliberately authored total must be
// the amount that lands on the row.
// ---------------------------------------------------------------------------
describe("B · owner-authored discount", () => {
  it("persists $100 against a $120 reference", async () => {
    const res = await prepareSessionPaymentChargeAction(
      form({ final: "100.00", reason: "Client discount" }),
    );
    expect(res.ok).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].amount_cents).toBe(10_000);
  });

  it("preserves the reference, the final and the reason as audit context", async () => {
    await prepareSessionPaymentChargeAction(
      form({ final: "100.00", reason: "Client discount" }),
    );
    const note = String(inserted[0].internal_note);
    expect(note).toContain("$120.00");
    expect(note).toContain("$100.00");
    expect(note).toContain("Client discount");
  });
});

describe("C · owner-authored add-on", () => {
  it("persists $145 against a $120 reference", async () => {
    const res = await prepareSessionPaymentChargeAction(
      form({ final: "145.00", reason: "Aftercare product" }),
    );
    expect(res.ok).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].amount_cents).toBe(14_500);
  });

  it("writes exactly the known columns — no itemisation is smuggled in", async () => {
    await prepareSessionPaymentChargeAction(
      form({ final: "145.00", reason: "Aftercare product" }),
    );
    expect(inserted).toHaveLength(1);
    // NOT `not.toContain("line_items")`: asserting the absence of columns that
    // never existed is a test that cannot fail. The meaningful claim is the
    // POSITIVE one — the insert payload is exactly this set — which does fail
    // if a later change starts writing a product/line-item/discount field, and
    // which is what "no itemisation is claimed" actually means.
    expect(Object.keys(inserted[0]).sort()).toEqual(
      [
        "amount_cents",
        "appointment_id",
        "card_authorization_signature_id",
        "charge_reason",
        "client_id",
        "client_payment_method_id",
        "created_by_practitioner_id",
        "currency",
        "internal_note",
        "session_id",
        "status",
        "stripe_account_id",
        "stripe_customer_id",
        "stripe_livemode",
        "stripe_payment_method_id",
        "studio_id",
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// D. A changed amount without an explanation is not an auditable money fact.
// ---------------------------------------------------------------------------
describe("D · changed amount with no reason", () => {
  it("rejects and inserts nothing", async () => {
    const res = await prepareSessionPaymentChargeAction(form({ final: "100.00" }));
    expect(res.ok).toBe(false);
    expect(inserted).toHaveLength(0);
  });

  it("rejects a whitespace-only reason", async () => {
    const res = await prepareSessionPaymentChargeAction(
      form({ final: "100.00", reason: "   " }),
    );
    expect(res.ok).toBe(false);
    expect(inserted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// E. OWNER-ONLY, SERVER-SIDE. The FormData cannot vote on this.
// ---------------------------------------------------------------------------
describe("E · non-owner direct post of a changed amount", () => {
  it("rejects and inserts nothing", async () => {
    identity.practitioner = { id: "prac-2", role: "practitioner", active: true };
    const res = await prepareSessionPaymentChargeAction(
      form({ final: "100.00", reason: "Client discount" }),
    );
    expect(res.ok).toBe(false);
    expect(inserted).toHaveLength(0);
  });

  it("cannot be unlocked by a forged is_owner field", async () => {
    identity.practitioner = { id: "prac-2", role: "practitioner", active: true };
    const fd = form({ final: "100.00", reason: "Client discount" });
    fd.set("is_owner", "true");
    fd.set("isOwner", "true");
    fd.set("practitioner_role", "owner");
    const res = await prepareSessionPaymentChargeAction(fd);
    expect(res.ok).toBe(false);
    expect(inserted).toHaveLength(0);
  });

  it("rejects an upward adjustment by a non-owner too", async () => {
    identity.practitioner = { id: "prac-2", role: "practitioner", active: true };
    const res = await prepareSessionPaymentChargeAction(
      form({ final: "145.00", reason: "Aftercare product" }),
    );
    expect(res.ok).toBe(false);
    expect(inserted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// F. STALE REFERENCE. A custom total does not buy a bypass.
// ---------------------------------------------------------------------------
describe("F · the displayed reference no longer matches the current one", () => {
  beforeEach(() => {
    referenceLoad = {
      ok: true,
      result: {
        kind: "resolved",
        amountCents: 13_000,
        source: "service_price",
        serviceName: "Electrolysis 60 min",
        durationMinutes: 60,
        customPricingNote: null,
      },
      appointmentId: "appt-1",
    };
  });

  it("rejects an unchanged final of $120 against a moved reference", async () => {
    const res = await prepareSessionPaymentChargeAction(
      form({ expected: "12000", final: "120.00" }),
    );
    expect(res.ok).toBe(false);
    expect(inserted).toHaveLength(0);
  });

  it("rejects a custom final of $100 against a moved reference", async () => {
    const res = await prepareSessionPaymentChargeAction(
      form({ expected: "12000", final: "100.00", reason: "Client discount" }),
    );
    expect(res.ok).toBe(false);
    expect(inserted).toHaveLength(0);
  });

  it("rejects a missing expected reference outright", async () => {
    const fd = form({ final: "130.00" });
    fd.delete("expected_amount_cents");
    const res = await prepareSessionPaymentChargeAction(fd);
    expect(res.ok).toBe(false);
    expect(inserted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// G. STRICT MONEY. Coercion is not parsing.
// ---------------------------------------------------------------------------
describe("G · strict final-amount parsing", () => {
  const REJECTED = [
    ["blank", ""],
    ["whitespace", "   "],
    ["negative", "-100"],
    ["negative decimal", "-0.01"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["-Infinity", "-Infinity"],
    ["scientific notation", "1e2"],
    ["uppercase scientific", "1E2"],
    ["hexadecimal", "0x64"],
    ["three decimals", "12.345"],
    ["rounding bait", "10.999"],
    ["trailing dot", "120."],
    ["leading dot", ".50"],
    ["double dot", "1.2.3"],
    ["stray comma", "1,20.00"],
    ["comma only", ",100"],
    ["letters", "one hundred"],
    ["units suffix", "100 dollars"],
    ["plus sign", "+100"],
    ["above ceiling", "2000.01"],
    ["far above ceiling", "999999999"],
    ["unsafe magnitude", "9007199254740993"],
  ] as const;

  for (const [label, raw] of REJECTED) {
    it(`rejects ${label} (${JSON.stringify(raw)}) and inserts nothing`, async () => {
      const res = await prepareSessionPaymentChargeAction(
        form({ final: raw, reason: "Client discount" }),
      );
      expect(res.ok).toBe(false);
      expect(inserted).toHaveLength(0);
    });
  }

  it("rejects a missing final_amount_dollars field outright", async () => {
    const res = await prepareSessionPaymentChargeAction(form({}));
    expect(res.ok).toBe(false);
    expect(inserted).toHaveLength(0);
  });

  const ACCEPTED: Array<[string, string, number]> = [
    ["bare integer", "120", 12_000],
    ["one decimal", "120.5", 12_050],
    ["two decimals", "120.50", 12_050],
    ["dollar sign", "$120.00", 12_000],
    ["exactly the ceiling", "2000.00", 200_000],
  ];

  for (const [label, raw, cents] of ACCEPTED) {
    it(`accepts ${label} (${JSON.stringify(raw)}) as ${cents} cents`, async () => {
      referenceLoad = {
        ok: true,
        result: {
          kind: "resolved",
          amountCents: cents,
          source: "service_price",
          serviceName: "Electrolysis 60 min",
          durationMinutes: 60,
          customPricingNote: null,
        },
        appointmentId: "appt-1",
      };
      const res = await prepareSessionPaymentChargeAction(
        form({ expected: String(cents), final: raw }),
      );
      expect(res.ok).toBe(true);
      expect(inserted[0].amount_cents).toBe(cents);
    });
  }

  it("never rounds a third decimal into an accepted amount", async () => {
    await prepareSessionPaymentChargeAction(
      form({ final: "10.999", reason: "Client discount" }),
    );
    expect(inserted).toHaveLength(0);
  });

  // NAMED for what it proves: the OUTPUT is exact. It does not prove the
  // implementation avoids floating point — a Math.round(Number(x) * 100) parser
  // returns 1010 here too. That property is pinned structurally in
  // tests/lib/billing/cad-amount.test.ts, for the reasons set out there.
  it("produces exactly 1010 cents for a float-hostile amount", async () => {
    referenceLoad = {
      ok: true,
      result: {
        kind: "resolved",
        amountCents: 1_010,
        source: "service_price",
        serviceName: "Electrolysis 60 min",
        durationMinutes: 60,
        customPricingNote: null,
      },
      appointmentId: "appt-1",
    };
    // 10.10 * 100 is 1009.9999999999999 in IEEE-754 doubles.
    const res = await prepareSessionPaymentChargeAction(
      form({ expected: "1010", final: "10.10" }),
    );
    expect(res.ok).toBe(true);
    expect(inserted[0].amount_cents).toBe(1_010);
  });
});

// ---------------------------------------------------------------------------
// ZERO. A comped visit is not a $0 chargeable row.
// ---------------------------------------------------------------------------
describe("zero final charge", () => {
  it("creates no attempt and says so calmly", async () => {
    const res = await prepareSessionPaymentChargeAction(
      form({ final: "0.00", reason: "Comped" }),
    );
    expect(res.ok).toBe(false);
    expect(inserted).toHaveLength(0);
    expect(res.ok === false && res.error).toMatch(/No charge is required/i);
  });

  it("treats a bare 0 the same way", async () => {
    const res = await prepareSessionPaymentChargeAction(
      form({ final: "0", reason: "Comped" }),
    );
    expect(res.ok).toBe(false);
    expect(inserted).toHaveLength(0);
    expect(res.ok === false && res.error).toMatch(/No charge is required/i);
  });
});

// ---------------------------------------------------------------------------
// H. TENANCY / LINEAGE. A custom total is a business decision, never a licence
// to name somebody else's records.
// ---------------------------------------------------------------------------
describe("H · lineage cannot be substituted through the form", () => {
  it("ignores forged studio, client, card, practitioner and stripe fields", async () => {
    const fd = form({ final: "100.00", reason: "Client discount" });
    fd.set("studio_id", "studio-ATTACKER");
    fd.set("client_id", "client-ATTACKER");
    fd.set("practitioner_id", "prac-ATTACKER");
    fd.set("created_by_practitioner_id", "prac-ATTACKER");
    fd.set("client_payment_method_id", "card-ATTACKER");
    fd.set("card_authorization_signature_id", "sig-ATTACKER");
    fd.set("stripe_account_id", "acct_ATTACKER");
    fd.set("stripe_customer_id", "cus_ATTACKER");
    fd.set("stripe_payment_method_id", "pm_ATTACKER");
    fd.set("appointment_id", "appt-ATTACKER");
    fd.set("currency", "usd");
    fd.set("status", "succeeded");
    fd.set("amount_cents", "1");

    const res = await prepareSessionPaymentChargeAction(fd);
    expect(res.ok).toBe(true);
    expect(inserted[0]).toMatchObject({
      studio_id: "studio-1",
      client_id: "client-SERVER",
      created_by_practitioner_id: "prac-1",
      client_payment_method_id: "card-SERVER",
      card_authorization_signature_id: "sig-SERVER",
      stripe_account_id: "acct_SERVER",
      stripe_customer_id: "cus_SERVER",
      stripe_payment_method_id: "pm_SERVER",
      appointment_id: "appt-1",
      currency: "cad",
      status: "ready",
      amount_cents: 10_000,
    });
  });
});

// ---------------------------------------------------------------------------
// Pricing states that were never chargeable stay unchargeable, whatever total
// the operator authored.
// ---------------------------------------------------------------------------
describe("a custom total does not unlock a non-chargeable session", () => {
  it("a free service still prepares nothing", async () => {
    referenceLoad = {
      ok: true,
      result: { kind: "free", serviceName: "Consultation", durationMinutes: 15 },
      appointmentId: "appt-1",
    };
    const res = await prepareSessionPaymentChargeAction(
      form({ final: "145.00", reason: "Aftercare product" }),
    );
    expect(res.ok).toBe(false);
    expect(inserted).toHaveLength(0);
  });

  it("an unresolved price still prepares nothing", async () => {
    referenceLoad = {
      ok: true,
      result: { kind: "missing_price", serviceName: "Electrolysis 60 min" },
      appointmentId: "appt-1",
    };
    const res = await prepareSessionPaymentChargeAction(
      form({ final: "145.00", reason: "Aftercare product" }),
    );
    expect(res.ok).toBe(false);
    expect(inserted).toHaveLength(0);
  });

  it("a failed pricing read still prepares nothing", async () => {
    referenceLoad = { ok: false, failure: { kind: "read_failed", stage: "session" } };
    const res = await prepareSessionPaymentChargeAction(
      form({ final: "145.00", reason: "Aftercare product" }),
    );
    expect(res.ok).toBe(false);
    expect(inserted).toHaveLength(0);
  });

  it("an ineligible session still prepares nothing", async () => {
    eligibility = {
      eligible: false,
      blockingReasons: ["No card on file."],
      session: null,
      appointment: null,
      client: null,
      card: null,
      cardAuthorization: null,
      existingAttempts: [],
    };
    const res = await prepareSessionPaymentChargeAction(
      form({ final: "145.00", reason: "Aftercare product" }),
    );
    expect(res.ok).toBe(false);
    expect(inserted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The audit note has to hold BOTH the practitioner's own note and the
// adjustment context, or fail loudly. It must never silently drop either.
// ---------------------------------------------------------------------------
describe("adjustment audit context and the internal note share one column", () => {
  it("preserves an independent note alongside the adjustment context", async () => {
    await prepareSessionPaymentChargeAction(
      form({
        final: "100.00",
        reason: "Client discount",
        note: "Client mentioned skin sensitivity.",
      }),
    );
    const note = String(inserted[0].internal_note);
    expect(note).toContain("Client mentioned skin sensitivity.");
    expect(note).toContain("$120.00");
    expect(note).toContain("$100.00");
    expect(note).toContain("Client discount");
  });

  it("rejects rather than truncating when the two cannot both fit", async () => {
    const res = await prepareSessionPaymentChargeAction(
      form({
        final: "100.00",
        reason: "Client discount",
        note: "x".repeat(1000),
      }),
    );
    expect(res.ok).toBe(false);
    expect(inserted).toHaveLength(0);
  });

  // F-PAY-002 / Codex P2. THE SERVER is the authority on "a reason was given".
  //
  // The form's `required` attribute is satisfied by a zero-width character, so
  // this is not merely a crafted-POST concern — pasting one into the real field
  // reaches the action too. These run the REAL action and assert the oracle
  // that matters: zero rows.
  const INVISIBLE_ONLY_REASONS: Array<[string, string]> = [
    ["U+200B zero width space", "\u200B"],
    ["U+200C + U+200D", "\u200C\u200D"],
    ["U+2060 word joiner", "\u2060"],
    ["spaces around zero-width", "  \u200B  "],
    ["U+0000 NUL", "\u0000"],
    ["combining marks only", "\u0301\u0308"],
    ["bidi isolate only", "\u2066\u2069"],
  ];

  for (const [label, reason] of INVISIBLE_ONLY_REASONS) {
    it(`refuses a direct post whose reason is only ${label}`, async () => {
      const res = await prepareSessionPaymentChargeAction(
        form({ final: "100.00", reason }),
      );
      expect(res.ok).toBe(false);
      expect(inserted).toHaveLength(0);
    });
  }

  it("still accepts a real reason, so the guard is not simply refusing everything", async () => {
    const res = await prepareSessionPaymentChargeAction(
      form({ final: "100.00", reason: "Client discount" }),
    );
    expect(res.ok).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].amount_cents).toBe(10_000);
    expect(String(inserted[0].internal_note)).toContain("Client discount");
  });

  it("still accepts a non-English reason", async () => {
    const res = await prepareSessionPaymentChargeAction(
      form({ final: "100.00", reason: "R\u00E9duction client" }),
    );
    expect(res.ok).toBe(true);
    expect(String(inserted[0].internal_note)).toContain("R\u00E9duction client");
  });

  it("leaves the unchanged-amount path free of any reason requirement", async () => {
    const res = await prepareSessionPaymentChargeAction(
      form({ final: "120.00", reason: "\u200B" }),
    );
    expect(res.ok).toBe(true);
    expect(inserted[0].amount_cents).toBe(12_000);
    expect(inserted[0].internal_note).toBeNull();
  });

  // F-PAY-002 / Codex P2 round 2. THE SERVER decides sufficiency, and a blank
  // FILLER is the case that survived the first repair: U+2800 is a Symbol and
  // the Hangul fillers are Letters, so a category-based rule waved them
  // through. Proved here through the REAL action, with zero rows as the oracle.
  const BLANK_FILLER_REASONS: Array<[string, string]> = [
    ["U+2800 braille pattern blank", "\u2800"],
    ["U+3164 hangul filler", "\u3164"],
    ["U+FFA0 halfwidth hangul filler", "\uFFA0"],
    ["U+115F + U+1160 hangul fillers", "\u115F\u1160"],
    ["fillers mixed with zero-width", "\u200B\u2800\u200D"],
    ["a bare emoji", "\u{1F642}"],
    ["a bare hyphen", "-"],
  ];

  for (const [label, reason] of BLANK_FILLER_REASONS) {
    it(`refuses a direct post whose reason is only ${label}`, async () => {
      const res = await prepareSessionPaymentChargeAction(
        form({ final: "100.00", reason }),
      );
      expect(res.ok).toBe(false);
      expect(inserted).toHaveLength(0);
    });
  }

  it("still accepts a real reason, so the filler guard is not refusing everything", async () => {
    const res = await prepareSessionPaymentChargeAction(
      form({ final: "100.00", reason: "Client discount" }),
    );
    expect(res.ok).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].amount_cents).toBe(10_000);
    expect(String(inserted[0].internal_note)).toContain("Client discount");
  });

  it("accepts real words carrying an emoji, and stores the emoji intact", async () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const res = await prepareSessionPaymentChargeAction(
      form({ final: "100.00", reason: `Courtesy ${family}` }),
    );
    expect(res.ok).toBe(true);
    expect(String(inserted[0].internal_note)).toContain(family);
  });

  // F-PAY-002 / Codex P2 round 3. A compatibility SYMBOL whose NFKC form is text
  // must not buy an adjusted charge. Proved through the REAL action, zero rows.
  const NFKC_SYMBOL_REASONS: Array<[string, string]> = [
    ["U+2122 trade mark sign", "\u2122"],
    ["U+2116 numero sign", "\u2116"],
    ["U+2103 degree celsius", "\u2103"],
    ["U+33D2 square log", "\u33D2"],
  ];

  for (const [label, reason] of NFKC_SYMBOL_REASONS) {
    it(`refuses a direct post whose reason is only ${label}`, async () => {
      const res = await prepareSessionPaymentChargeAction(
        form({ final: "100.00", reason }),
      );
      expect(res.ok).toBe(false);
      expect(inserted).toHaveLength(0);
    });
  }

  it("accepts a real reason that merely CONTAINS a compatibility symbol", async () => {
    const res = await prepareSessionPaymentChargeAction(
      form({ final: "100.00", reason: "Client discount \u2122" }),
    );
    expect(res.ok).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].amount_cents).toBe(10_000);
    // Stored verbatim: the symbol is the practitioner's text, not ours to fold.
    expect(String(inserted[0].internal_note)).toContain("Client discount \u2122");
  });

  it("bounds the adjustment reason itself", async () => {
    const res = await prepareSessionPaymentChargeAction(
      form({ final: "100.00", reason: "y".repeat(5000) }),
    );
    expect(res.ok).toBe(false);
    expect(inserted).toHaveLength(0);
  });
});

// PAY-SETTLE / 0187. The pre-flight is mocked away above so the rest of this
// file stays about amount authority — which would leave the new behaviour
// untested. These two cases arm it.
describe("prepare refuses a visit that already has an attested outcome", () => {
  const settled = (method: string) => ({
    ok: true,
    byAppointmentId: new Map([
      [
        "appt-1",
        {
          id: "s-1",
          appointmentId: "appt-1",
          method,
          amountCents: 4500,
          quotedAmountCents: 4500,
          recordedAt: "2026-08-24T00:00:00Z",
          supersedesId: null,
        },
      ],
    ]),
  });

  afterEach(() => {
    settlements.load = { ok: true, byAppointmentId: new Map() };
  });

  it("creates NO attempt when the visit was recorded as paid in cash", async () => {
    settlements.load = settled("paid_cash");
    const before = inserted.length;
    // An otherwise PERFECTLY VALID prepare — same form every passing case in
    // this file uses. The only reason it is refused is the recorded outcome.
    const r = await prepareSessionPaymentChargeAction(form({ final: "120.00" }));
    expect(r.ok).toBe(false);
    expect(inserted.length).toBe(before);
    if (!r.ok) expect(r.error).toMatch(/already has a recorded outcome/);
  });

  it("still allows a charge when the visit is only recorded as still owing", async () => {
    // A debt followed by a card payment is the ordinary progression, so this
    // must NOT be blocked — the SQL claim command agrees.
    settlements.load = settled("still_owes");
    const before = inserted.length;
    const r = await prepareSessionPaymentChargeAction(form({ final: "120.00" }));
    expect(r.ok).toBe(true);
    expect(inserted.length).toBe(before + 1);
  });
});
