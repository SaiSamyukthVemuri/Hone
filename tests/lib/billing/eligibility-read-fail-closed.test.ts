import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PAY-READ-01 PR D. Eligibility reads must fail CLOSED, and must not lie.
//
// A fresh census at bb7b45e8 found TWELVE authoritative reads across the two
// eligibility helpers - four in session-payment, eight in manual-fee - and
// ZERO error handling in either file. Every one destructures only `data`.
//
// PostgREST leaves `data` null (or the code applies `?? []`) on failure, so a
// query ERROR was indistinguishable from a successful EMPTY result. Two
// different harms follow:
//
//   1. CONFIDENT WRONG FACT. A failed card read became "No card on file",
//      a failed template read became "template is no longer live", a failed
//      studio read became "Studio not found". Hone blocked - safely - while
//      telling the practitioner something false about the client or studio.
//
//   2. FAIL-OPEN DUPLICATE PROTECTION. The attempt-history reads apply
//      `?? []`, so a failed read became TRUSTED EMPTY HISTORY and the
//      "an attempt already exists" block silently disappeared.
//
// The law under test:
//
//   READ FAILURE  -> eligible:false + ONE generic retryable reason
//   CLEAN ZERO    -> the existing specific, actionable copy, UNCHANGED
//
// Blocking more is not the goal. Blocking WITHOUT LYING is, and a fix that
// replaced the specific clean-zero copy with generic copy would be a
// regression - which is what the clean-zero half of every pair below pins.
//
// THE FAKE MUST REPRESENT FOUR OUTCOMES INDEPENDENTLY PER TABLE:
//   A. query error   { data: null, error }
//   B. clean zero    { data: null, error: null }
//   C. clean empty   { data: [],   error: null }
//   D. clean row(s)  { data: ...,  error: null }
// If A and B/C are not distinct inputs, every assertion here is vacuous.

type Outcome =
  | { kind: "error" }
  | { kind: "zero" }
  | { kind: "empty" }
  | { kind: "rows"; data: unknown };

const DB_ERROR = {
  code: "57014",
  message: "canceling statement due to statement timeout",
};

const h = vi.hoisted(() => ({
  livemode: false,
  // table -> outcome. Absent = clean zero.
  outcomes: {} as Record<string, { kind: string; data?: unknown }>,
  reads: [] as Array<{ table: string; filters: Array<[string, unknown]> }>,
  cardAuthKind: "signed_current" as string,
}));

vi.mock("@/lib/stripe/server", () => ({
  inferStripeLivemode: () => h.livemode,
}));

// #585's helper. Kept at signed_current for every case here so the session
// tests isolate the read under test; a dedicated case below flips it to prove
// authorization_unverified still blocks with its own truthful copy.
vi.mock("@/lib/consent/current-card-authorization", () => ({
  getChargeReadyCardAuthorizationStatus: async () => ({
    kind: h.cardAuthKind,
    signatureId: "sig-1",
    templateId: "tpl-1",
    templateVersion: 3,
    signedAt: "2026-08-01T00:00:00.000Z",
  }),
  getCardAuthorizationStatus: async () => ({
    kind: h.cardAuthKind,
    signatureId: "sig-1",
    templateId: "tpl-1",
    templateVersion: 3,
    signedAt: "2026-08-01T00:00:00.000Z",
  }),
}));

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const q: Record<string, unknown> = {};
      const settle = () => {
        h.reads.push({ table, filters: [...filters] });
        const o = h.outcomes[table] ?? { kind: "zero" };
        switch (o.kind) {
          case "error":
            return { data: null, error: DB_ERROR };
          case "empty":
            return { data: [], error: null };
          case "rows":
            return { data: o.data, error: null };
          default:
            return { data: null, error: null };
        }
      };
      q.select = () => q;
      q.eq = (c: string, v: unknown) => {
        filters.push([c, v]);
        return q;
      };
      q.is = (c: string, v: unknown) => {
        filters.push([c, v]);
        return q;
      };
      q.in = (c: string, v: unknown) => {
        filters.push([c, v]);
        return q;
      };
      q.order = () => q;
      q.limit = () => q;
      q.maybeSingle = async () => settle();
      q.single = async () => settle();
      q.then = (resolve: (v: unknown) => unknown) => resolve(settle());
      return q;
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));

const { getSessionPaymentEligibility } = await import(
  "@/lib/billing/session-payment-eligibility"
);
const { getManualFeeChargeEligibility } = await import(
  "@/lib/billing/manual-fee-eligibility"
);

const STUDIO = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const APPT = "44444444-4444-4444-8444-444444444444";

// The generic retryable copy this PR introduces.
const READ_FAILED = /could not be verified/i;
const RETRYABLE = /try again/i;

function err(table: string) {
  h.outcomes[table] = { kind: "error" };
}
function rows(table: string, data: unknown) {
  h.outcomes[table] = { kind: "rows", data };
}
function empty(table: string) {
  h.outcomes[table] = { kind: "empty" };
}

// ---------------------------------------------------------------------------
// Healthy fixtures. Every read succeeds, so the ONLY variable in each case
// below is the single table put into error. Without this, a test could pass
// because some unrelated fixture was unsatisfiable.
// ---------------------------------------------------------------------------
function healthySession() {
  rows("studio_payment_jurisdictions", { payment_country: "CA", payment_currency: "cad" });
  rows("sessions", {
    id: SESSION,
    studio_id: STUDIO,
    client_id: CLIENT,
    modality: "electrolysis",
    started_at: "2026-08-01T00:00:00.000Z",
    ended_at: "2026-08-01T01:00:00.000Z",
    price_paid_cents: null,
    appointment_id: APPT,
    appointments: { id: APPT, status: "completed", starts_at: "2026-08-01T00:00:00.000Z" },
  });
  rows("client_payment_methods", {
    id: "cpm-1",
    brand: "visa",
    last4: "4242",
    exp_month: 12,
    exp_year: 2030,
    status: "active",
    stripe_livemode: false,
    stripe_account_id: "acct_test",
    stripe_customer_id: "cus_test",
    stripe_payment_method_id: "pm_test",
    card_authorization_signature_id: "sig-1",
  });
  rows("studio_payment_settings", {
    stripe_account_id: "acct_test",
    stripe_account_status: "enabled",
    stripe_account_country: "CA",
    stripe_account_country_conflict: null,
    stripe_livemode: false,
  });
  empty("payment_charge_attempts");
}

function healthyManualFee() {
  // NOTE the embed ALIASES: the select is `service:services(name)` and
  // `client:clients(id, name)`, so the row carries `service`/`client`, not the
  // table names. Getting this wrong makes clientSummary null and the helper
  // returns ineligible with an EMPTY reasons array - blocked, silently, for a
  // reason no test could see.
  rows("appointments", {
    id: APPT,
    studio_id: STUDIO,
    client_id: CLIENT,
    status: "no_show",
    starts_at: "2026-08-01T00:00:00.000Z",
    cancelled_at: null,
    created_at: "2026-07-30T00:00:00.000Z",
    service: { name: "Service" },
    client: { id: CLIENT, name: "A B" },
  });
  rows("client_payment_methods", {
    id: "cpm-1",
    brand: "visa",
    last4: "4242",
    exp_month: 12,
    exp_year: 2030,
    status: "active",
    stripe_livemode: false,
    card_authorization_signature_id: "sig-1",
  });
  rows("client_consent_signatures", {
    id: "sig-1",
    client_id: CLIENT,
    template_id: "tpl-1",
    template_version: 3,
  });
  rows("consent_form_templates", { id: "tpl-1", version: 3 });
  rows("appointment_policy_acknowledgements", {
    id: "ack-1",
    acknowledged_at: "2026-08-01T00:00:00.000Z",
    policy_snapshot_hash: "hash-1",
  });
  rows("studios", {
    id: STUDIO,
    no_show_fee_cents: 5000,
    late_cancel_fee_cents: 5000,
    late_cancel_fee_enabled: true,
    no_show_fee_enabled: true,
    late_cancel_fee_mode: "fixed",
    no_show_fee_mode: "fixed",
    late_cancel_fee_percent_bp: null,
    no_show_fee_percent_bp: null,
    timezone: "America/Toronto",
  });
  empty("payment_charge_attempts");
  empty("manual_fee_charge_attempts");
  // The fee's currency is the studio's verified jurisdiction currency.
  rows("studio_payment_jurisdictions", { payment_country: "CA", payment_currency: "cad" });
}

function sessionArgs() {
  return { studioId: STUDIO, sessionId: SESSION };
}
function feeArgs() {
  return { studioId: STUDIO, appointmentId: APPT, chargeType: "no_show" as const };
}

async function sessionReasons() {
  const e = await getSessionPaymentEligibility(sessionArgs());
  return { eligible: e.eligible, reasons: e.eligible ? [] : e.blockingReasons };
}
async function feeReasons() {
  const e = await getManualFeeChargeEligibility(feeArgs());
  return { eligible: e.eligible, reasons: e.eligible ? [] : e.blockingReasons };
}

beforeEach(() => {
  h.livemode = false;
  h.outcomes = {};
  h.reads = [];
  h.cardAuthKind = "signed_current";
});

// ---------------------------------------------------------------------------

describe("harness fidelity (guards every assertion below from vacuity)", () => {
  it("a query ERROR and a clean ZERO produce DIFFERENT answers", async () => {
    healthySession();
    err("sessions");
    const a = await sessionReasons();

    h.outcomes = {};
    h.reads = [];
    healthySession();
    h.outcomes["sessions"] = { kind: "zero" };
    const b = await sessionReasons();

    // Both block. If they produced the SAME reason set, error and absence
    // would still be indistinguishable and every pair below would be vacuous.
    expect(a.eligible).toBe(false);
    expect(b.eligible).toBe(false);
    expect(a.reasons.join("|")).not.toEqual(b.reasons.join("|"));
  });

  it("a clean EMPTY list is a third, distinct input", async () => {
    healthySession();
    empty("payment_charge_attempts");
    const ok = await sessionReasons();
    h.outcomes = {};
    h.reads = [];
    healthySession();
    err("payment_charge_attempts");
    const bad = await sessionReasons();
    expect(ok.eligible).toBe(true);
    expect(bad.eligible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SESSION PAYMENT - 4 reads, each proved on BOTH sides.
// ---------------------------------------------------------------------------

const SESSION_READS: Array<{
  table: string;
  label: string;
  cleanZeroCopy: RegExp;
}> = [
  {
    table: "sessions",
    label: "session",
    cleanZeroCopy: /Session not found in this studio/i,
  },
  {
    table: "client_payment_methods",
    label: "active card",
    cleanZeroCopy: /must add a card on file/i,
  },
  {
    table: "studio_payment_settings",
    label: "studio payment settings",
    cleanZeroCopy: /Studio payment settings are not configured/i,
  },
];

describe("SESSION PAYMENT: read error != absence", () => {
  for (const r of SESSION_READS) {
    it(`${r.label} QUERY ERROR -> generic retryable reason, never the absence claim`, async () => {
      healthySession();
      err(r.table);
      const { eligible, reasons } = await sessionReasons();
      const joined = reasons.join(" | ");
      expect(eligible).toBe(false);
      expect(joined).toMatch(READ_FAILED);
      expect(joined).toMatch(RETRYABLE);
      // The confident wrong fact must be gone.
      expect(joined).not.toMatch(r.cleanZeroCopy);
      // And no database text may reach a practitioner.
      expect(joined).not.toMatch(/57014|statement timeout|PGRST|supabase/i);
    });

    it(`${r.label} CLEAN ZERO -> keeps its specific actionable copy`, async () => {
      healthySession();
      h.outcomes[r.table] = { kind: "zero" };
      const { eligible, reasons } = await sessionReasons();
      const joined = reasons.join(" | ");
      expect(eligible).toBe(false);
      expect(joined).toMatch(r.cleanZeroCopy);
      // Must NOT be replaced by the generic copy - that would be the
      // over-block regression NC-D exists to catch.
      expect(joined).not.toMatch(READ_FAILED);
    });
  }

  it("a failed session read does NOT cascade into false downstream claims", async () => {
    // The session read supplies client_id. When it fails, dependent reads have
    // no id - the helper must not therefore also claim "no card", "no Stripe
    // settings" etc. One truth: eligibility could not be verified.
    healthySession();
    err("sessions");
    const { reasons } = await sessionReasons();
    const joined = reasons.join(" | ");
    expect(joined).not.toMatch(/must add a card on file/i);
    expect(joined).not.toMatch(/not linked to a confirmed appointment/i);
  });

  it("CONTROL: with every read healthy the session IS eligible", async () => {
    healthySession();
    const { eligible } = await sessionReasons();
    expect(eligible).toBe(true);
  });
});

describe("SESSION PAYMENT: attempt history is load-bearing", () => {
  it("history QUERY ERROR is NEVER treated as empty history", async () => {
    healthySession();
    err("payment_charge_attempts");
    const { eligible, reasons } = await sessionReasons();
    expect(eligible).toBe(false);
    expect(reasons.join(" | ")).toMatch(READ_FAILED);
  });

  it("a genuine EMPTY list does not block", async () => {
    healthySession();
    empty("payment_charge_attempts");
    const { eligible } = await sessionReasons();
    expect(eligible).toBe(true);
  });

  it("an ACTIVE attempt still blocks with its specific duplicate copy", async () => {
    healthySession();
    rows("payment_charge_attempts", [
      {
        id: "att-1",
        status: "ready",
        amount_cents: 12000,
        created_at: "2026-08-01T00:00:00.000Z",
      },
    ]);
    const { eligible, reasons } = await sessionReasons();
    expect(eligible).toBe(false);
    expect(reasons.join(" | ")).toMatch(/already prepared for this session/i);
  });
});

describe("SESSION PAYMENT: #585 authorization_unverified is preserved", () => {
  it("still blocks with its OWN truthful copy, not collapsed into the new reason", async () => {
    healthySession();
    h.cardAuthKind = "authorization_unverified";
    const { eligible, reasons } = await sessionReasons();
    const joined = reasons.join(" | ");
    expect(eligible).toBe(false);
    expect(joined).toMatch(/Card authorization could not be verified/i);
  });
});

// ---------------------------------------------------------------------------
// MANUAL FEE - 8 reads.
//
// NOTE ON THE LIVE HOLD: manual fee charging is hard-held in LIVE mode. Every
// case here runs in TEST mode (h.livemode = false) so the hold is absent and
// the read under test is actually reachable. If these ran in live, every
// assertion would pass for the wrong reason - the hold alone would block.
// ---------------------------------------------------------------------------

const FEE_READS: Array<{ table: string; label: string; cleanZeroCopy: RegExp }> = [
  {
    table: "appointments",
    label: "appointment",
    cleanZeroCopy: /Appointment not found for this studio/i,
  },
  {
    table: "client_payment_methods",
    label: "active card",
    cleanZeroCopy: /No card on file/i,
  },
  {
    table: "appointment_policy_acknowledgements",
    label: "policy acknowledgement",
    cleanZeroCopy: /No policy acknowledgement found/i,
  },
  {
    table: "client_consent_signatures",
    label: "card authorization signature",
    cleanZeroCopy: /signature missing or not scoped to this client/i,
  },
  {
    table: "consent_form_templates",
    label: "live consent template",
    cleanZeroCopy: /template is no longer live/i,
  },
  {
    table: "studios",
    label: "studio fee config",
    cleanZeroCopy: /Studio not found/i,
  },
];

describe("MANUAL FEE: read error != absence", () => {
  for (const r of FEE_READS) {
    it(`${r.label} QUERY ERROR -> generic retryable reason, never the absence claim`, async () => {
      healthyManualFee();
      err(r.table);
      const { eligible, reasons } = await feeReasons();
      const joined = reasons.join(" | ");
      expect(eligible).toBe(false);
      expect(joined).toMatch(READ_FAILED);
      expect(joined).not.toMatch(r.cleanZeroCopy);
      expect(joined).not.toMatch(/57014|statement timeout|PGRST|supabase/i);
    });

    it(`${r.label} CLEAN ZERO -> keeps its specific actionable copy`, async () => {
      healthyManualFee();
      h.outcomes[r.table] = { kind: "zero" };
      const { eligible, reasons } = await feeReasons();
      const joined = reasons.join(" | ");
      expect(eligible).toBe(false);
      expect(joined).toMatch(r.cleanZeroCopy);
      expect(joined).not.toMatch(READ_FAILED);
    });
  }

  it("CONTROL: with every read healthy the fee IS eligible in test mode", async () => {
    healthyManualFee();
    const { eligible } = await feeReasons();
    expect(eligible).toBe(true);
  });

  // PREPARE side of the studio's own switches (0351): the fee type must be ON for THIS studio.
  const studioRow = (over: Record<string, unknown>) =>
    rows("studios", { id: STUDIO, no_show_fee_cents: 5000, late_cancel_fee_cents: 5000, late_cancel_fee_enabled: true, no_show_fee_enabled: true, late_cancel_fee_mode: "fixed", no_show_fee_mode: "fixed", late_cancel_fee_percent_bp: null, no_show_fee_percent_bp: null, timezone: "America/Toronto", ...over });
  it("studio switch OFF for the type being charged blocks prepare with the plain setting message (test mode too)", async () => {
    healthyManualFee();
    const baseArgs = feeArgs() as { chargeType?: string };
    const isLate = baseArgs.chargeType === "late_cancel" || baseArgs.chargeType === undefined;
    studioRow(isLate ? { late_cancel_fee_enabled: false } : { no_show_fee_enabled: false });
    const { eligible, reasons } = await feeReasons();
    expect(eligible).toBe(false);
    expect(reasons.join(" | ")).toMatch(/turned off for this studio/i);
  });
  it("the OTHER type's switch being on does not help; a missing or non-boolean switch is OFF", async () => {
    healthyManualFee();
    for (const bad of [{ late_cancel_fee_enabled: undefined, no_show_fee_enabled: undefined }, { late_cancel_fee_enabled: "true", no_show_fee_enabled: "true" }, { late_cancel_fee_enabled: false, no_show_fee_enabled: false }]) {
      studioRow(bad);
      const { eligible, reasons } = await feeReasons();
      expect(eligible).toBe(false);
      expect(reasons.join(" | ")).toMatch(/turned off for this studio/i);
    }
  });
  it("LIVE mode needs BOTH the switch and the release list: switch ON alone stays held", async () => {
    healthyManualFee();
    h.livemode = true;
    studioRow({});
    const { eligible, reasons } = await feeReasons();
    expect(eligible).toBe(false);
    expect(reasons.join(" | ")).toMatch(/on hold for this launch/i);
    expect(reasons.join(" | ")).not.toMatch(/turned off for this studio/i);
  });
});

describe("MANUAL FEE: BOTH history sources are load-bearing", () => {
  it("canonical history QUERY ERROR fails closed", async () => {
    healthyManualFee();
    err("payment_charge_attempts");
    const { eligible, reasons } = await feeReasons();
    expect(eligible).toBe(false);
    expect(reasons.join(" | ")).toMatch(READ_FAILED);
  });

  it("LEGACY history QUERY ERROR fails closed too", async () => {
    // The legacy source is read in the same Promise.all and was equally
    // discarded. A partial history must never prove "no active attempt".
    healthyManualFee();
    err("manual_fee_charge_attempts");
    const { eligible, reasons } = await feeReasons();
    expect(eligible).toBe(false);
    expect(reasons.join(" | ")).toMatch(READ_FAILED);
  });

  it("both genuinely empty -> no duplicate block", async () => {
    healthyManualFee();
    empty("payment_charge_attempts");
    empty("manual_fee_charge_attempts");
    const { eligible } = await feeReasons();
    expect(eligible).toBe(true);
  });

  it("an ACTIVE canonical attempt still blocks with its duplicate copy", async () => {
    healthyManualFee();
    rows("payment_charge_attempts", [
      {
        id: "att-1",
        charge_reason: "no_show_fee",
        status: "ready",
        amount_cents: 5000,
        currency: "cad",
        created_at: "2026-08-01T00:00:00.000Z",
      },
    ]);
    const { eligible, reasons } = await feeReasons();
    expect(eligible).toBe(false);
    expect(reasons.join(" | ")).toMatch(/active fee charge attempt already exists/i);
  });
});

describe("LEGACY failed rows: the provider facts decide whether the appointment is freed", () => {
  const legacy = (over: Record<string, unknown>) => ({
    id: "leg-1", charge_type: "no_show", status: "failed", amount_cents: 5000, currency: "cad",
    created_at: "2026-08-01T00:00:00.000Z", stripe_payment_intent_id: "pi_leg", stripe_charge_id: null,
    stripe_status: null, charged_at: null, failed_at: "2026-08-01T00:01:00.000Z", failure_code: "card_declined",
    failure_message: null, cancelled_at: null, cancelled_reason: null, ...over,
  });
  const run = async (row: Record<string, unknown>) => {
    healthyManualFee();
    empty("payment_charge_attempts");
    rows("manual_fee_charge_attempts", [row]);
    return feeReasons();
  };
  it("failed + stripe_status canceled + a PaymentIntent + nothing captured: FREES the appointment", async () => {
    const { eligible, reasons } = await run(legacy({ stripe_status: "canceled" }));
    expect(reasons.join(" | ")).not.toMatch(/only one manual fee|already exists|unclear/i);
    expect(eligible).toBe(true);
  });
  for (const [name, over] of [
    ["stripe_status null (today's behaviour: blocks)", { stripe_status: null }],
    ["stripe_status missing from the row", { stripe_status: undefined }],
    ["an unknown stripe_status", { stripe_status: "something_new" }],
    ["requires_payment_method (the intent can still collect)", { stripe_status: "requires_payment_method" }],
    ["canceled but a charge id is stored (captured)", { stripe_status: "canceled", stripe_charge_id: "ch_x" }],
    ["canceled but charged_at is set (captured)", { stripe_status: "canceled", charged_at: "2026-08-01T00:00:30.000Z" }],
    ["canceled but no PaymentIntent id", { stripe_status: "canceled", stripe_payment_intent_id: null }],
  ] as const) {
    it(`${name}: still BLOCKS both fee types' preparation`, async () => {
      const { eligible, reasons } = await run(legacy(over));
      expect(eligible).toBe(false);
      expect(reasons.join(" | ")).toMatch(/only one manual fee|already exists/i);
    });
  }
  it("the legacy select asks for stripe_status (the fake ignores columns, so the source is pinned)", () => {
    const src = readFileSync(join(__dirname, "../../../lib/billing/manual-fee-eligibility.ts"), "utf8");
    const m = src.match(/\.from\("manual_fee_charge_attempts"\)\s*\.select\(\s*"([^"]+)"/);
    expect(m).not.toBeNull();
    expect(m![1].split(/,\s*/)).toContain("stripe_status");
  });
});

// ---------------------------------------------------------------------------

describe("scoping survives the change", () => {
  it("session mode-bearing reads still filter the current stripe_livemode", async () => {
    h.livemode = true;
    healthySession();
    await sessionReasons();
    for (const t of ["client_payment_methods", "studio_payment_settings", "payment_charge_attempts"]) {
      const read = h.reads.find((r) => r.table === t);
      expect(read?.filters).toContainEqual(["stripe_livemode", true]);
    }
  });

  it("manual-fee history reads stay scoped to studio, appointment and mode", async () => {
    healthyManualFee();
    await feeReasons();
    for (const t of ["payment_charge_attempts", "manual_fee_charge_attempts"]) {
      const read = h.reads.find((r) => r.table === t);
      expect(read?.filters).toContainEqual(["studio_id", STUDIO]);
      expect(read?.filters).toContainEqual(["appointment_id", APPT]);
      expect(read?.filters).toContainEqual(["stripe_livemode", false]);
    }
  });
});


describe("G1 guard-only eligibility country authority", () => {
  const setCountry = (country: "CA" | "US", currency: "cad" | "usd", observed: string | null, conflict: string | null = null) => {
    rows("studio_payment_jurisdictions", { payment_country: country, payment_currency: currency });
    const o = h.outcomes.studio_payment_settings;
    rows("studio_payment_settings", { ...(o.data as Record<string, unknown>),
      stripe_account_country: observed, stripe_account_country_conflict: conflict });
  };
  const refused = async (reason: RegExp) => {
    const result = await getSessionPaymentEligibility(sessionArgs());
    expect(result.eligible).toBe(false);
    if (result.eligible) throw new Error("guard did not refuse");
    expect(result.blockingReasons.join(" | ")).toMatch(reason);
  };
  beforeEach(() => healthySession());
  it("UNKNOWN jurisdiction cannot present eligibility", async () => {
    delete h.outcomes.studio_payment_jurisdictions; await refused(/could not be verified/i);
  });
  it("failed jurisdiction read is not a Canada default", async () => {
    err("studio_payment_jurisdictions"); await refused(/could not be verified/i);
  });
  it("invalid jurisdiction pair cannot present eligibility", async () => {
    rows("studio_payment_jurisdictions", { payment_country: "US", payment_currency: "cad" });
    await refused(/could not be verified/i);
  });
  it("observed account mismatch refuses preparation readiness", async () => {
    setCountry("US", "usd", "CA"); await refused(/different country/i);
  });
  it.each([["US", "usd", "US", "CA"], ["CA", "cad", "CA", "US"]] as const)(
    "%s matching original observation does not clear a persisted conflict", async (country, currency, observed, conflict) => {
      setCountry(country, currency, observed, conflict); await refused(/conflicting countries/i);
    });
  it("US unobserved account refuses", async () => {
    setCountry("US", "usd", null); await refused(/not yet confirmed/i);
  });
  it.each([["CA", "cad", "CA"], ["US", "usd", "US"], ["CA", "cad", null]] as const)(
    "%s healthy existing verdict remains eligible without a new currency interface", async (country, currency, observed) => {
      setCountry(country, currency, observed);
      const result = await getSessionPaymentEligibility(sessionArgs());
      expect(result.eligible).toBe(true);
      expect(result).not.toHaveProperty("paymentCurrency");
      expect(h.reads).toContainEqual({ table: "studio_payment_jurisdictions", filters: [["studio_id", STUDIO]] });
      expect(h.reads).toContainEqual({ table: "studio_payment_settings", filters: [["studio_id", STUDIO], ["stripe_livemode", false]] });
    });
  // #1035 Codex P1 4352197754 (P1-C): the prepare writer needs the currency
  // this read decided, so the eligible result carries the jurisdiction.
  it.each([["CA", "cad", "CA"], ["US", "usd", "US"], ["CA", "cad", null]] as const)(
    "%s eligible result carries the jurisdiction it was decided on", async (country, currency, observed) => {
      setCountry(country, currency, observed);
      const result = await getSessionPaymentEligibility(sessionArgs());
      if (!result.eligible) throw new Error("expected eligible");
      expect(result.jurisdiction).toEqual({ country, currency });
    });
  it("settings read failure keeps the existing generic retryable reason", async () => {
    err("studio_payment_settings"); await refused(/could not be verified/i);
  });
  it("unavailable attempt history still refuses despite valid country", async () => {
    err("payment_charge_attempts"); await refused(/could not be verified/i);
  });
});


// #1035 Codex P1 #4369182087. The manual / no-show fee is prepared and labelled
// in the studio's VERIFIED jurisdiction currency, never a constant.
describe("MANUAL FEE currency comes from the verified jurisdiction", () => {
  it("US studio: the eligible fee is usd (no CAD label for a US studio)", async () => {
    healthyManualFee();
    rows("studio_payment_jurisdictions", { payment_country: "US", payment_currency: "usd" });
    const e = await getManualFeeChargeEligibility(feeArgs());
    expect(e.eligible).toBe(true);
    if (e.eligible) expect(e.currency).toBe("usd");
  });
  it("CA studio: the eligible fee is cad", async () => {
    healthyManualFee();
    const e = await getManualFeeChargeEligibility(feeArgs());
    expect(e.eligible).toBe(true);
    if (e.eligible) expect(e.currency).toBe("cad");
  });
  it("no jurisdiction row (UNKNOWN): blocked with the unverified reason, never defaulted to cad", async () => {
    healthyManualFee();
    delete h.outcomes.studio_payment_jurisdictions;
    const e = await getManualFeeChargeEligibility(feeArgs());
    expect(e.eligible).toBe(false);
    if (!e.eligible) {
      expect(e.blockingReasons.join(" | ")).toMatch(/payment country and currency could not be verified/i);
      expect(e.currency).toBeNull();
    }
  });
  it("jurisdiction read ERROR: blocked, not Canada", async () => {
    healthyManualFee();
    err("studio_payment_jurisdictions");
    const e = await getManualFeeChargeEligibility(feeArgs());
    expect(e.eligible).toBe(false);
    if (!e.eligible) expect(e.currency).toBeNull();
  });
  it("an unsupported stored pair (eur) is UNKNOWN: blocked", async () => {
    healthyManualFee();
    rows("studio_payment_jurisdictions", { payment_country: "CA", payment_currency: "eur" });
    const e = await getManualFeeChargeEligibility(feeArgs());
    expect(e.eligible).toBe(false);
  });
});


// #1035 Codex P1 #4369182087. Existing attempts carry the PERSISTED currency,
// parsed (cad|usd), through the real getSessionPaymentEligibility.
describe("SESSION PAYMENT: existing attempts carry the persisted currency", () => {
  const attemptRow = (currency: unknown) => ({
    id: "att-1", status: "ready", amount_cents: 12000, currency, created_at: "2026-08-01T00:00:00.000Z",
  });
  it.each([["usd", "usd"], ["cad", "cad"], ["eur", null], ["USD", null], [null, null]] as const)(
    "stored %j -> card sees %j",
    async (stored, shown) => {
      healthySession();
      rows("payment_charge_attempts", [attemptRow(stored)]);
      const e = await getSessionPaymentEligibility(sessionArgs());
      expect(e.existingAttempts).toHaveLength(1);
      expect(e.existingAttempts[0].currency).toBe(shown);
    },
  );
});

// ---------------------------------------------------------------------------
// PERCENT MODE (0351). The amount is computed on the server at prepare, from the reviewed resolver, and frozen.
// ---------------------------------------------------------------------------
describe("MANUAL FEE percent mode: the amount comes from the reviewed price resolver, rounded once, and is never a fallback", () => {
  const pctStudio = (over: Record<string, unknown> = {}) =>
    rows("studios", {
      id: STUDIO, no_show_fee_cents: 5000, late_cancel_fee_cents: 5000, late_cancel_fee_enabled: true, no_show_fee_enabled: true,
      late_cancel_fee_mode: "fixed", no_show_fee_mode: "percent", late_cancel_fee_percent_bp: null, no_show_fee_percent_bp: 7500,
      timezone: "America/Toronto", ...over,
    });
  const appt = (service: unknown) =>
    rows("appointments", {
      id: APPT, studio_id: STUDIO, client_id: CLIENT, status: "no_show", starts_at: "2026-08-01T00:00:00.000Z", cancelled_at: null,
      created_at: "2026-07-30T00:00:00.000Z", duration_minutes: 60, service, client: { id: CLIENT, name: "A B" },
    });
  const customPrice = (cents: number, effective = "2026-01-01") =>
    rows("client_pricing", [{ service_name: "Service", price_cents: cents, notes: null, effective_from: effective }]);
  async function result() {
    return getManualFeeChargeEligibility(feeArgs());
  }
  const reasonsOf = (e: Awaited<ReturnType<typeof result>>) => (e.eligible ? [] : e.blockingReasons).join(" | ");

  it("menu price: 75% of $120.00 = $90.00, frozen with its basis", async () => {
    healthyManualFee(); pctStudio(); appt({ name: "Service", price_cents: 12000 }); empty("client_pricing");
    const e = await result();
    expect(e.eligible).toBe(true);
    if (e.eligible) {
      expect(e.amountCents).toBe(9000);
      expect(e.feeBasis).toEqual({ calcMode: "percent", basisCents: 12000, percentBp: 7500 });
    }
  });
  it("the client's custom price wins over the menu price", async () => {
    healthyManualFee(); pctStudio(); appt({ name: "Service", price_cents: 12000 }); customPrice(8000);
    const e = await result();
    expect(e.eligible).toBe(true);
    if (e.eligible) expect(e.feeBasis).toEqual({ calcMode: "percent", basisCents: 8000, percentBp: 7500 });
    if (e.eligible) expect(e.amountCents).toBe(6000);
  });
  it("a custom price not yet in effect is ignored", async () => {
    healthyManualFee(); pctStudio(); appt({ name: "Service", price_cents: 12000 }); customPrice(8000, "2099-01-01");
    const e = await result();
    if (e.eligible) expect(e.feeBasis).toMatchObject({ basisCents: 12000 });
  });
  it.each([
    [1, 7500, null], [3, 7500, 2], [9999, 7500, 7499], [12345, 7500, 9259],
  ])("odd price %i cents at %i bp keeps its cents (%s) or refuses a zero", async (price, bp, expected) => {
    healthyManualFee(); pctStudio({ no_show_fee_percent_bp: bp }); appt({ name: "Service", price_cents: price }); empty("client_pricing");
    const e = await result();
    if (expected === null) {
      // 1 cent at 75% = 0.75 -> 1 cent: a positive fee on a positive price, never zero
      expect(e.eligible).toBe(true);
      if (e.eligible) expect(e.amountCents).toBe(1);
    } else {
      expect(e.eligible).toBe(true);
      if (e.eligible) expect(e.amountCents).toBe(expected);
    }
  });
  it("an explicit $0 menu price is a ZERO FEE: not an error, no attempt, stated with its basis", async () => {
    healthyManualFee(); pctStudio(); appt({ name: "Service", price_cents: 0 }); empty("client_pricing");
    const e = await result();
    expect(e.eligible).toBe(false);
    if (!e.eligible) {
      expect(e.noFeeOwed).toBe(true);
      expect(e.amountCents).toBeNull();
      expect(e.feeBasis).toBeNull();
    }
    expect(reasonsOf(e)).toMatch(/Appointment price \$0\.00 \u00d7 75% = \$0\.00\. No fee is owed, so there is nothing to prepare\./);
    expect(reasonsOf(e)).not.toMatch(/could not be calculated|no usable|\$50/i);
  });
  // DECISION (platform operator, #1483): an explicitly recorded client-specific $0 price takes precedence over a positive
  // menu price and produces a zero fee. Missing pricing still refuses. These run the REAL loader (loadAppointmentSessionPrice)
  // and the eligibility path against the fake client.
  const zeroFeeStated = /Appointment price \$0\.00 \u00d7 75% = \$0\.00\. No fee is owed, so there is nothing to prepare\./;
  it("an explicit $0 CUSTOM price beats a positive menu price: zero fee, no attempt, no Prepare", async () => {
    healthyManualFee(); pctStudio(); appt({ name: "Service", price_cents: 12000 }); customPrice(0);
    const e = await result();
    expect(e.eligible).toBe(false);
    if (!e.eligible) {
      expect(e.noFeeOwed).toBe(true);
      expect(e.amountCents).toBeNull();
      expect(e.feeBasis).toBeNull();
    }
    expect(reasonsOf(e)).toMatch(zeroFeeStated);
    expect(reasonsOf(e)).not.toMatch(/\$90|\$50|No price is configured/i);
  });
  it("an explicit $0 custom price on a service with NO menu price is still a decided price: zero fee, not a missing price", async () => {
    healthyManualFee(); pctStudio(); appt({ name: "Service", price_cents: null }); customPrice(0);
    const e = await result();
    expect(e.eligible).toBe(false);
    if (!e.eligible) expect(e.noFeeOwed).toBe(true);
    expect(reasonsOf(e)).toMatch(zeroFeeStated);
  });
  it("a $0 custom price not yet in effect is ignored: the menu price decides", async () => {
    healthyManualFee(); pctStudio(); appt({ name: "Service", price_cents: 12000 }); customPrice(0, "2099-01-01");
    const e = await result();
    expect(e.eligible).toBe(true);
    if (e.eligible) expect(e.feeBasis).toEqual({ calcMode: "percent", basisCents: 12000, percentBp: 7500 });
  });
  it("conflicting rows: the NEWER row decides, whichever way (a newer positive price beats an older $0; a newer $0 beats an older positive)", async () => {
    const two = (rowsIn: Array<[number, string]>) =>
      rows("client_pricing", rowsIn.map(([c, d]) => ({ service_name: "Service", price_cents: c, notes: null, effective_from: d })));
    healthyManualFee(); pctStudio(); appt({ name: "Service", price_cents: 12000 }); two([[0, "2026-01-01"], [8000, "2026-03-01"]]);
    let e = await result();
    expect(e.eligible).toBe(true);
    if (e.eligible) expect(e.feeBasis).toEqual({ calcMode: "percent", basisCents: 8000, percentBp: 7500 });
    healthyManualFee(); pctStudio(); appt({ name: "Service", price_cents: 12000 }); two([[8000, "2026-01-01"], [0, "2026-03-01"]]);
    e = await result();
    expect(e.eligible).toBe(false);
    if (!e.eligible) expect(e.noFeeOwed).toBe(true);
    expect(reasonsOf(e)).toMatch(zeroFeeStated);
  });
  it("a $0 row and a positive row EQUALLY current disagree: refused as conflicting, never charged either way", async () => {
    healthyManualFee(); pctStudio(); appt({ name: "Service", price_cents: 12000 });
    rows("client_pricing", [
      { service_name: "Service", price_cents: 0, notes: null, effective_from: "2026-01-01" },
      { service_name: "Service", price_cents: 8000, notes: null, effective_from: "2026-01-01" },
    ]);
    const e = await result();
    expect(e.eligible).toBe(false);
    if (!e.eligible) expect(e.noFeeOwed).toBe(false);
    expect(reasonsOf(e)).toMatch(/conflicting current custom prices/i);
    expect(reasonsOf(e)).not.toMatch(/No fee is owed|\$90|\$60/);
  });
  it("a NEGATIVE or fractional custom price is unusable: its own refusal, NOT free and NOT a fall-through to the menu price", async () => {
    for (const bad of [-500, 12.5]) {
      healthyManualFee(); pctStudio(); appt({ name: "Service", price_cents: 12000 }); customPrice(bad);
      const e = await result();
      expect(e.eligible, `price ${bad}`).toBe(false);
      if (!e.eligible) { expect(e.noFeeOwed).toBe(false); expect(e.amountCents).toBeNull(); }
      expect(reasonsOf(e)).toMatch(/recorded price for this service is not a usable price/i);
      expect(reasonsOf(e)).not.toMatch(/No fee is owed|\$90|\$50/);
    }
  });
  it("a missing menu price with NO custom row is still a refusal (no fallback)", async () => {
    healthyManualFee(); pctStudio(); appt({ name: "Service", price_cents: null }); empty("client_pricing");
    const e = await result();
    expect(e.eligible).toBe(false);
    if (!e.eligible) expect(e.noFeeOwed).toBe(false);
    expect(reasonsOf(e)).toMatch(/No price is configured/i);
    expect(reasonsOf(e)).not.toMatch(/\$50|No fee is owed/);
  });
  it("a positive price whose percentage rounds to $0.00 is a zero fee, not an error", async () => {
    healthyManualFee(); pctStudio({ no_show_fee_percent_bp: 1 }); appt({ name: "Service", price_cents: 1 }); empty("client_pricing");
    const e = await result();
    expect(e.eligible).toBe(false);
    if (!e.eligible) { expect(e.noFeeOwed).toBe(true); expect(e.amountCents).toBeNull(); }
    expect(reasonsOf(e)).toMatch(/No fee is owed, so there is nothing to prepare/);
  });
  it("a missing price and a missing service are REFUSALS with their own messages and no fallback amount (never the fixed $50)", async () => {
    for (const [service, msg] of [
      [{ name: "Service", price_cents: null }, /No price is configured/i],
      [null, /no booked service/i],
    ] as const) {
      healthyManualFee(); pctStudio(); appt(service); empty("client_pricing");
      const e = await result();
      expect(e.eligible).toBe(false);
      expect(reasonsOf(e)).toMatch(msg);
      expect(reasonsOf(e)).not.toMatch(/\$50|No fee is owed/i);
      if (!e.eligible) { expect(e.amountCents).toBeNull(); expect(e.noFeeOwed).toBe(false); }
    }
  });
  it("conflicting equally-current custom prices are refused", async () => {
    healthyManualFee(); pctStudio(); appt({ name: "Service", price_cents: 12000 });
    rows("client_pricing", [
      { service_name: "Service", price_cents: 8000, notes: null, effective_from: "2026-01-01" },
      { service_name: "Service", price_cents: 9000, notes: null, effective_from: "2026-01-01" },
    ]);
    const e = await result();
    expect(e.eligible).toBe(false);
    expect(reasonsOf(e)).toMatch(/conflicting current custom prices/i);
  });
  it("a result at or above the ceiling is refused, not capped", async () => {
    healthyManualFee(); pctStudio(); appt({ name: "Service", price_cents: 30000 }); empty("client_pricing");
    const e = await result();
    expect(e.eligible).toBe(false);
    expect(reasonsOf(e)).toMatch(/above the maximum/i);
    if (!e.eligible) expect(e.amountCents).toBeNull();
  });
  it("a missing percentage is refused and does NOT fall back to the fixed amount", async () => {
    healthyManualFee(); pctStudio({ no_show_fee_percent_bp: null }); appt({ name: "Service", price_cents: 12000 }); empty("client_pricing");
    const e = await result();
    expect(e.eligible).toBe(false);
    expect(reasonsOf(e)).toMatch(/percentage is not set/i);
    if (!e.eligible) expect(e.amountCents).toBeNull();
  });
  it("a failed client_pricing read is a read failure, never 'no custom price' (no confident menu price)", async () => {
    healthyManualFee(); pctStudio(); appt({ name: "Service", price_cents: 12000 }); err("client_pricing");
    const e = await result();
    expect(e.eligible).toBe(false);
    expect(reasonsOf(e)).toMatch(READ_FAILED);
  });
  it("an unknown mode fails closed", async () => {
    healthyManualFee(); pctStudio({ no_show_fee_mode: "weird" }); appt({ name: "Service", price_cents: 12000 }); empty("client_pricing");
    const e = await result();
    expect(e.eligible).toBe(false);
    expect(reasonsOf(e)).toMatch(/fee mode/i);
  });
  it("FIXED mode is unchanged: the saved amount, frozen as fixed, with no price read at all", async () => {
    healthyManualFee();
    h.reads.length = 0;
    pctStudio({ no_show_fee_mode: "fixed" });
    const e = await result();
    expect(e.eligible).toBe(true);
    if (e.eligible) {
      expect(e.amountCents).toBe(5000);
      expect(e.feeBasis).toEqual({ calcMode: "fixed", basisCents: null, percentBp: null });
    }
    expect(h.reads.some((r) => r.table === "client_pricing")).toBe(false);
  });
  it("the appointment price read is studio-scoped and the client comes from the appointment row, not from an argument", async () => {
    healthyManualFee(); pctStudio(); appt({ name: "Service", price_cents: 12000 }); empty("client_pricing");
    h.reads.length = 0;
    await result();
    const pricing = h.reads.find((r) => r.table === "client_pricing");
    expect(pricing?.filters).toEqual(expect.arrayContaining([["studio_id", STUDIO], ["client_id", CLIENT]]));
    const apptRead = h.reads.filter((r) => r.table === "appointments").pop();
    expect(apptRead?.filters).toEqual(expect.arrayContaining([["id", APPT], ["studio_id", STUDIO]]));
  });
  it("source: the service embed is the BARE form (no studio_id inside it: 0151's composite FK would return a NULL service)", () => {
    const src = readFileSync(join(process.cwd(), "lib/billing/authoritative-appointment-price.ts"), "utf8");
    expect(src).toContain('service:services(name, price_cents)');
    expect(src).not.toMatch(/services\([^)]*studio_id/);
  });
});
