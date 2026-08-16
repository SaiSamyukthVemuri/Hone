import { beforeEach, describe, expect, it, vi } from "vitest";

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
  });
  empty("payment_charge_attempts");
  empty("manual_fee_charge_attempts");
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
