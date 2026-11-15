import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Per-studio manual-fee switches (0351) and their relation to the temporary LIVE release lists.
// Synthetic ids only. The runner section drives the REAL executor against a fake database and a Stripe
// tripwire, then arms controls proving the same harness DOES reach the claim when the gate allows it.

const h = vi.hoisted(() => ({
  livemode: false,
  studioRow: null as unknown,
  studioError: false,
  attempt: {} as Record<string, unknown>,
  rpcs: [] as string[],
  stripeCalls: [] as string[],
  studioReads: 0,
}));

vi.mock("@/lib/stripe/server", () => ({
  inferStripeLivemode: () => h.livemode,
  getStripe: () => stripe,
}));
vi.mock("@/lib/stripe/session-payment-stripe", () => ({ getSessionPaymentStripe: () => stripe }));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: async () => {} }));
vi.mock("@/lib/billing/charge-description", () => ({ buildChargeDescription: () => "desc" }));
vi.mock("@/lib/consent/current-card-authorization", () => {
  const ok = async () => ({ kind: "signed_current", signatureId: "sig-1", templateId: "tpl-1", templateVersion: 3, signedAt: "2026-08-01T00:00:00.000Z" });
  return { getChargeReadyCardAuthorizationStatus: ok, getCardAuthorizationStatus: ok };
});
const stripe = {
  paymentIntents: {
    create: () => { h.stripeCalls.push("create"); throw new Error("stripe reached"); },
    retrieve: () => { h.stripeCalls.push("retrieve"); throw new Error("stripe reached"); },
    cancel: () => { h.stripeCalls.push("cancel"); throw new Error("stripe reached"); },
  },
};
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const q: Record<string, unknown> = {};
      let sibling = false;
      const read = () => {
        if (table === "studios") {
          h.studioReads++;
          return h.studioError ? { data: null, error: { code: "57014" } } : { data: h.studioRow, error: null };
        }
        if (table === "payment_charge_attempts") return sibling ? { data: [], error: null } : { data: h.attempt, error: null };
        return { data: ROWS[table] ?? null, error: null };
      };
      for (const m of ["select", "eq", "is", "in", "order", "limit"]) q[m] = () => q;
      q.neq = () => { sibling = true; return q; };
      q.maybeSingle = async () => read();
      q.single = async () => read();
      q.then = (resolve: (v: unknown) => unknown) => resolve(read());
      for (const m of ["insert", "update", "upsert", "delete"]) q[m] = () => { throw new Error(`write ${m} on ${table}`); };
      return q;
    },
    rpc: async (name: string) => {
      h.rpcs.push(name);
      // The claim refuses (settled_externally): the harness stops right after the claim, never at Stripe.
      return { data: [{ result: "settled_externally", attempt_id: ATTEMPT, studio_id: null, appointment_id: null, charge_reason: null }], error: null };
    },
  }),
}));

const {
  LATE_CANCEL_FEE_LIVE_STUDIOS_ENV,
  LEGACY_MANUAL_FEE_LIVE_STUDIOS_ENV,
  NO_SHOW_FEE_LIVE_STUDIOS_ENV,
} = await import("@/lib/billing/live-charge-reason-allowlist");
const {
  LATE_CANCEL_FEE_DISABLED_MESSAGE,
  MANUAL_FEE_SETTING_UNREADABLE_MESSAGE,
  MANUAL_FEE_STATE_COPY,
  NO_SHOW_FEE_DISABLED_MESSAGE,
  loadManualFeeExecuteHold,
  MANUAL_FEE_SETTINGS_CHANGED_MESSAGE,
  MANUAL_FEE_PRICE_CHANGED_MESSAGE,
  manualFeeEffectiveState,
  manualFeeSettingBlockMessage,
} = await import("@/lib/billing/manual-fee-studio-setting");
const { runSessionPaymentCharge } = await import("@/lib/billing/session-payment-charge");

const STUDIO = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ATTEMPT = "33333333-3333-4333-8333-333333333333";
const PRACT = "44444444-4444-4444-8444-444444444444";
const LATE = "late_cancellation_fee" as const;
const NOSHOW = "no_show_fee" as const;
const CONFIG = {
  late_cancel_fee_mode: "fixed", no_show_fee_mode: "fixed",
  late_cancel_fee_percent_bp: null, no_show_fee_percent_bp: null,
  late_cancel_fee_cents: 5000, no_show_fee_cents: 5000,
};
const BOTH_OFF = { ...CONFIG, late_cancel_fee_enabled: false, no_show_fee_enabled: false };
const BOTH_ON = { ...CONFIG, late_cancel_fee_enabled: true, no_show_fee_enabled: true };

const ROWS: Record<string, unknown> = {
  client_payment_methods: { id: "cpm-1", studio_id: STUDIO, client_id: "c1", status: "active", stripe_livemode: false, stripe_account_id: "acct_test", stripe_customer_id: "cus_test", stripe_payment_method_id: "pm_test", card_authorization_signature_id: "sig-1" },
  studio_payment_settings: { stripe_account_id: "acct_test", stripe_livemode: false },
  studio_payment_jurisdictions: { payment_country: "CA", payment_currency: "cad" },
  client_stripe_customers: { stripe_customer_id: "cus_test" },
};
const attemptRow = (over: Record<string, unknown> = {}) => ({
  id: ATTEMPT, studio_id: STUDIO, charge_reason: LATE, client_id: "c1", session_id: null, appointment_id: "a1",
  amount_cents: 5000, currency: "cad", status: "ready", stripe_livemode: false, client_payment_method_id: "cpm-1",
  card_authorization_signature_id: "sig-1", stripe_account_id: "acct_test", stripe_customer_id: "cus_test",
  stripe_payment_method_id: "pm_test", stripe_payment_intent_id: null, stripe_idempotency_key: null,
  updated_at: "2026-08-01T00:00:00.000Z", created_at: "2026-08-01T00:00:00.000Z",
  calc_mode: "fixed", basis_cents: null, percent_bp: null, ...over,
});
const run = () => runSessionPaymentCharge({ attemptId: ATTEMPT, studioId: STUDIO, practitionerId: PRACT });

beforeEach(() => {
  h.livemode = false; h.studioRow = BOTH_ON; h.studioError = false; h.attempt = attemptRow();
  h.rpcs = []; h.stripeCalls = []; h.studioReads = 0;
});
afterEach(() => vi.unstubAllEnvs());

describe("the studio setting is a pure, fail-closed gate", () => {
  it("OFF by default and for anything that is not the boolean true", () => {
    for (const row of [null, {}, { late_cancel_fee_enabled: false }, { late_cancel_fee_enabled: "true" }, { late_cancel_fee_enabled: 1 }, { late_cancel_fee_enabled: null }]) {
      expect(manualFeeSettingBlockMessage(LATE, row)).toBe(LATE_CANCEL_FEE_DISABLED_MESSAGE);
    }
    for (const row of [null, {}, { no_show_fee_enabled: false }, { no_show_fee_enabled: "true" }]) {
      expect(manualFeeSettingBlockMessage(NOSHOW, row)).toBe(NO_SHOW_FEE_DISABLED_MESSAGE);
    }
  });
  it("the two types are independent", () => {
    const lateOnly = { late_cancel_fee_enabled: true, no_show_fee_enabled: false };
    expect(manualFeeSettingBlockMessage(LATE, lateOnly)).toBeNull();
    expect(manualFeeSettingBlockMessage(NOSHOW, lateOnly)).toBe(NO_SHOW_FEE_DISABLED_MESSAGE);
    const noShowOnly = { late_cancel_fee_enabled: false, no_show_fee_enabled: true };
    expect(manualFeeSettingBlockMessage(NOSHOW, noShowOnly)).toBeNull();
    expect(manualFeeSettingBlockMessage(LATE, noShowOnly)).toBe(LATE_CANCEL_FEE_DISABLED_MESSAGE);
  });
  it("session_payment and unknown reasons are not governed by it", () => {
    expect(manualFeeSettingBlockMessage("session_payment", BOTH_OFF)).toBeNull();
    expect(manualFeeSettingBlockMessage("some_future_reason", null)).toBeNull();
  });
});

describe("saved versus actually active (the Settings screen uses the same gates as prepare and execute)", () => {
  const state = (reason: typeof LATE | typeof NOSHOW, row: unknown, ready: boolean, live: boolean) =>
    manualFeeEffectiveState({ chargeReason: reason, settingRow: row as never, paymentsReady: ready, livemode: live, studioId: STUDIO });

  it("saved OFF is off whatever else is true", () => {
    for (const ready of [true, false]) for (const live of [true, false]) expect(state(LATE, BOTH_OFF, ready, live)).toBe("off");
  });
  it("saved ON, payments not ready: NOT active (payments), in test and live", () => {
    expect(state(LATE, BOTH_ON, false, false)).toBe("not_active_payments");
    expect(state(LATE, BOTH_ON, false, true)).toBe("not_active_payments");
  });
  it("saved ON, ready, TEST mode: active (the release list is skipped in test mode)", () => {
    expect(state(LATE, BOTH_ON, true, false)).toBe("active");
    expect(state(NOSHOW, BOTH_ON, true, false)).toBe("active");
  });
  it("saved ON, ready, LIVE mode, studio NOT on that type's release list: NOT active (not released for the studio)", () => {
    expect(state(LATE, BOTH_ON, true, true)).toBe("not_active_release");
    vi.stubEnv(NO_SHOW_FEE_LIVE_STUDIOS_ENV, STUDIO);
    expect(state(LATE, BOTH_ON, true, true)).toBe("not_active_release"); // the OTHER type's list does not open this one
  });
  it("saved ON, ready, LIVE mode, on that type's list: active; the other type stays pending", () => {
    vi.stubEnv(LATE_CANCEL_FEE_LIVE_STUDIOS_ENV, STUDIO);
    expect(state(LATE, BOTH_ON, true, true)).toBe("active");
    expect(state(NOSHOW, BOTH_ON, true, true)).toBe("not_active_release");
    expect(state(LATE, { ...BOTH_ON, late_cancel_fee_enabled: false }, true, true)).toBe("off");
  });
  it("another studio's id on the list never makes this studio active", () => {
    vi.stubEnv(LATE_CANCEL_FEE_LIVE_STUDIOS_ENV, OTHER);
    expect(state(LATE, BOTH_ON, true, true)).toBe("not_active_release");
  });
  it("the legacy combined variable opens nothing", () => {
    vi.stubEnv(LEGACY_MANUAL_FEE_LIVE_STUDIOS_ENV, STUDIO);
    expect(state(LATE, BOTH_ON, true, true)).toBe("not_active_release");
    expect(state(NOSHOW, BOTH_ON, true, true)).toBe("not_active_release");
  });
  it("the screen never says Active unless the state is active, and never says on-and-active for a gated type", () => {
    for (const s of ["off", "not_active_payments", "not_active_release"] as const) expect(MANUAL_FEE_STATE_COPY[s].effective).not.toMatch(/^Active/);
    expect(MANUAL_FEE_STATE_COPY.active.effective).toBe("Active");
    expect(MANUAL_FEE_STATE_COPY.not_active_release.effective).toMatch(/not released for your studio/);
    expect(MANUAL_FEE_STATE_COPY.not_active_payments.effective).toMatch(/payments are not ready/);
  });
  it("the Settings page asks this function, with the same gates, and holds no studio id or env read of its own", () => {
    const view = readFileSync(path.resolve(__dirname, "../../../app/(app)/settings/payments/PaymentsView.tsx"), "utf8");
    expect(view).toMatch(/manualFeeEffectiveState\(/);
    expect(view).not.toMatch(/process\.env/);
    const mod = readFileSync(path.resolve(__dirname, "../../../lib/billing/manual-fee-studio-setting.ts"), "utf8");
    expect(mod).toMatch(/manualFeeSettingBlockMessage\(args\.chargeReason, args\.settingRow\)/);
    expect(mod).toMatch(/liveChargeReasonBlockMessage\(args\.chargeReason, args\.livemode, args\.studioId\)/);
  });
});

describe("EXECUTE: the runner re-reads the studio setting before any claim or Stripe call", () => {
  it("CONTROL: with the fee ON the same harness reaches the claim (so the refusals below are the setting, not the fixture)", async () => {
    await run();
    expect(h.rpcs).toContain("claim_session_payment_charge_attempt");
    expect(h.stripeCalls).toEqual([]);
  });
  it("a prepared-then-DISABLED late-cancel attempt is refused: no claim, no Stripe, the setting message", async () => {
    h.studioRow = { late_cancel_fee_enabled: false, no_show_fee_enabled: true };
    const r = await run();
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.outcome).toBe("blocked");
    expect(r.message).toBe(LATE_CANCEL_FEE_DISABLED_MESSAGE);
    expect(h.rpcs).toEqual([]);
    expect(h.stripeCalls).toEqual([]);
  });
  it("a prepared-then-DISABLED no-show attempt is refused, and the other type being ON does not help", async () => {
    h.attempt = attemptRow({ charge_reason: NOSHOW });
    h.studioRow = { late_cancel_fee_enabled: true, no_show_fee_enabled: false };
    const r = await run();
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.message).toBe(NO_SHOW_FEE_DISABLED_MESSAGE);
    expect(h.rpcs).toEqual([]);
  });
  it("an unreadable or missing studio setting refuses (fail closed)", async () => {
    h.studioError = true;
    let r = await run();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe(MANUAL_FEE_SETTING_UNREADABLE_MESSAGE);
    h.studioError = false; h.studioRow = null;
    r = await run();
    expect(r.ok).toBe(false);
    expect(h.rpcs).toEqual([]);
  });
  it("an attempt ALREADY SENT (pending_stripe) is not re-gated by the setting: it is reconciled as before even when the fee is off", async () => {
    h.attempt = attemptRow({ status: "pending_stripe", stripe_payment_intent_id: "pi_1" });
    h.studioRow = BOTH_OFF;
    h.studioReads = 0;
    const r = await run().catch(() => null);
    expect(h.studioReads).toBe(0); // the setting was never consulted for an in-flight attempt
    if (r && !r.ok) {
      expect(r.message).not.toBe(LATE_CANCEL_FEE_DISABLED_MESSAGE);
      expect(r.message).not.toBe(NO_SHOW_FEE_DISABLED_MESSAGE);
    }
  });
  it("a settled (succeeded) attempt replay is unchanged by the setting", async () => {
    h.attempt = attemptRow({ status: "succeeded", stripe_payment_intent_id: "pi_1" });
    h.studioRow = BOTH_OFF;
    const r = await run();
    expect(r.ok).toBe(true);
  });
  it("session_payment is not governed by the fee switches", async () => {
    h.attempt = attemptRow({ charge_reason: "session_payment", session_id: "s1" });
    h.studioRow = BOTH_OFF;
    await run().catch(() => null);
    expect(h.studioReads).toBe(0);
  });
  it("LIVE mode needs BOTH: setting ON alone is refused by the release gate; setting OFF is refused even when listed", async () => {
    h.livemode = true;
    h.attempt = attemptRow({ stripe_livemode: true });
    const saved = { cpm: ROWS.client_payment_methods, sps: ROWS.studio_payment_settings };
    ROWS.client_payment_methods = { ...(saved.cpm as object), stripe_livemode: true };
    ROWS.studio_payment_settings = { ...(saved.sps as object), stripe_livemode: true };
    try {
    const r1 = await run();
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.outcome).toBe("live_mode_blocked");
    expect(h.rpcs).toEqual([]);
    vi.stubEnv(LATE_CANCEL_FEE_LIVE_STUDIOS_ENV, STUDIO);
    h.studioRow = BOTH_OFF;
    const r2 = await run();
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.message).toBe(LATE_CANCEL_FEE_DISABLED_MESSAGE);
    expect(h.rpcs).toEqual([]);
    h.studioRow = BOTH_ON;
    await run();
    expect(h.rpcs).toContain("claim_session_payment_charge_attempt");
    } finally {
      ROWS.client_payment_methods = saved.cpm;
      ROWS.studio_payment_settings = saved.sps;
    }
  });
  it("LIVE mode: a late-cancel-only studio still sees no-show held (release list is per reason)", async () => {
    h.livemode = true;
    vi.stubEnv(LATE_CANCEL_FEE_LIVE_STUDIOS_ENV, STUDIO);
    h.attempt = attemptRow({ stripe_livemode: true, charge_reason: NOSHOW });
    const r = await run();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.outcome).toBe("live_mode_blocked");
    expect(h.rpcs).toEqual([]);
  });
});

describe("PREPARE and the owner-only write use the same gate (source pins)", () => {
  const read = (rel: string) => readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
  it("eligibility reads the settings and applies manualFeeSettingBlockMessage with the same fee reason as the live gate", () => {
    const src = read("lib/billing/manual-fee-eligibility.ts");
    expect(src).toMatch(/late_cancel_fee_enabled, no_show_fee_enabled, late_cancel_fee_mode, no_show_fee_mode, late_cancel_fee_percent_bp, no_show_fee_percent_bp, timezone/);
    expect(src).toMatch(/manualFeeSettingBlockMessage\(feeChargeReason, studioRow\)/);
    expect(src).toMatch(/liveChargeReasonBlockMessage\(feeChargeReason, livemode, args\.studioId\)/);
  });
  it("the runner reads the settings THREE times for a new (ready) fee: early, immediately before the claim, and after the claim before the create; never for a sent attempt", () => {
    const src = read("lib/billing/session-payment-charge.ts");
    const run = src.slice(src.indexOf("export async function runSessionPaymentCharge"));
    const live = run.indexOf("liveChargeReasonBlockMessage(");
    const early = run.indexOf("loadManualFeeExecuteHold(admin, attemptRow)");
    const pre = run.indexOf("loadManualFeeExecuteHold(admin, attemptRow)", early + 10);
    const claim = run.indexOf("claim_session_payment_charge_attempt");
    const post = run.indexOf("loadManualFeeExecuteHold(admin, attemptRow)", pre + 10);
    const create = run.indexOf("sender.paymentIntents.create(");
    expect(run.match(/loadManualFeeExecuteHold\(/g)?.length).toBe(3);
    expect(live).toBeGreaterThan(-1);
    expect(early).toBeGreaterThan(live);
    expect(pre).toBeGreaterThan(early);
    expect(claim).toBeGreaterThan(pre);
    expect(post).toBeGreaterThan(claim);
    expect(create).toBeGreaterThan(post);
    // all three sit under the isNewManualFee condition, which is the unsent (ready) attempt
    expect(run).toMatch(/const isNewManualFee = attemptRow\.status === "ready"/);
    for (const idx of [early, pre, post]) expect(run.slice(Math.max(0, idx - 80), idx)).toMatch(/isNewManualFee/);
    // the post-claim refusal retains the claim for manual review and never reaches the create call
    expect(run.slice(post, create)).toMatch(/needs_manual_review/);
  });
  it("the amounts action stays owner-only and no longer writes any switch, mode or percentage", () => {
    const src = read("app/(app)/settings/payments/fee-amounts-actions.ts");
    expect(src).toMatch(/practitioner\.role !== "owner"/);
    // it may READ the switches and modes (to refuse blanking a live amount) but the only UPDATE it issues carries the two amounts
    const update = src.slice(src.indexOf(".update("), src.indexOf(".eq(\"id\", studio.id);", src.indexOf(".update(")));
    expect(update).not.toMatch(/_fee_enabled|_fee_mode|_percent_bp/);
    expect(src).toMatch(/\.update\(\{\s*late_cancel_fee_cents: lateCancel,\s*no_show_fee_cents: noShow,\s*\}\)/);
  });
  it("each setting has its own owner-only compare-and-set action", () => {
    const src = read("app/(app)/settings/payments/fee-settings-actions.ts");
    expect(src.match(/export async function set\w+Action/g)).toHaveLength(3);
    expect(src.match(/await owner\(\)/g)).toHaveLength(3);
    expect(src).toMatch(/expected === null \? q\.is\(column, null\) : q\.eq\(column, expected/);
    expect(src).toMatch(/data\.length === 0\) return \{ ok: false, error: STALE \}/);
    // never the service role: the owner's own session and RLS
    expect(src).not.toMatch(/createAdminClient/);
  });
  it("the state module is server-only and the release-criteria comment carries no day or charge-count threshold", () => {
    for (const f of ["lib/billing/manual-fee-studio-setting.ts", "lib/billing/live-charge-reason-allowlist.ts"]) {
      const src = read(f);
      expect(src.startsWith('import "server-only";')).toBe(true);
      expect(src).toMatch(/the platform operator gives explicit rollout approval/);
      expect(src).not.toMatch(/14 days|5 real|at least 5/);
    }
  });
});

// "Nothing is ever charged automatically" (Settings copy). This pins it: the fee-charge server actions have exactly one importer
// (the owner-facing card), the shared runner has exactly the two owner-pressed callers, and no cron route or library job reaches either.
import { readdirSync, statSync } from "node:fs";
describe("no automatic fee charge path exists", () => {
  const root = path.resolve(__dirname, "../../..");
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(path.relative(root, p));
    }
    return out;
  };
  const files = [...walk(path.join(root, "app")), ...walk(path.join(root, "lib"))];
  const importersOf = (needle: RegExp) =>
    files
      .filter((f) => needle.test(readFileSync(path.join(root, f), "utf8").split("\n").filter((l) => /^\s*(import|export)\b|\bfrom\s+["']/.test(l) || /import\(/.test(l)).join("\n")))
      .sort();
  it("the fee prepare and charge actions are imported only by the owner-facing card", () => {
    expect(importersOf(/manual-fee-actions/)).toEqual(["app/(app)/calendar/[id]/ManualFeeChargeCard.tsx"]);
  });
  it("the shared runner is called only from the two owner-pressed actions (plus its own helpers)", () => {
    const callers = importersOf(/session-payment-charge["']/).filter((f) => !f.startsWith("lib/billing/"));
    expect(callers).toEqual(["app/(app)/calendar/[id]/manual-fee-actions.ts", "app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts"]);
  });
  it("no cron route imports either", () => {
    for (const f of files.filter((x) => x.startsWith("app/api/cron/"))) {
      const src = readFileSync(path.join(root, f), "utf8");
      expect(src).not.toMatch(/manual-fee-actions|session-payment-charge|payment-actions/);
    }
  });
  it("the charge action requires the owner and an explicit confirmation", () => {
    const src = readFileSync(path.join(root, "app/(app)/calendar/[id]/manual-fee-actions.ts"), "utf8");
    expect(src).toMatch(/practitioner\.role !== "owner"/);
    expect(src).toMatch(/confirmCharge !== "true"/);
  });
});


const priceMock = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/lib/billing/authoritative-appointment-price", () => ({ loadAppointmentSessionPrice: priceMock.load }));

describe("execute hold: the owner's settings now versus what was frozen at prepare", () => {
  beforeEach(() => { priceMock.load.mockReset(); priceMock.load.mockResolvedValue({ ok: true, result: { kind: "resolved", amountCents: 12000, source: "service_price", serviceName: "S", durationMinutes: null, customPricingNote: null } }); });
  const FIXED = { id: ATTEMPT, studio_id: STUDIO, charge_reason: LATE, amount_cents: 5000 };
  // A fake whose studios row and frozen attempt row are chosen per test; reads are the only thing it supports.
  const mk = (studio: unknown, frozen: unknown, studioErr = false, frozenErr = false) => ({
    from: (t: string) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => {
      if (t === "studios") return { data: studio, error: studioErr ? { code: "x" } : null };
      return { data: frozen, error: frozenErr ? { code: "x" } : null };
    } }) }) }),
  });
  const FROZEN_FIXED = { calc_mode: "fixed", basis_cents: null, percent_bp: null };
  const FROZEN_PCT = { calc_mode: "percent", basis_cents: 12000, percent_bp: 7500 };
  it("fixed: unchanged settings pass", async () => {
    expect(await loadManualFeeExecuteHold(mk(BOTH_ON, FROZEN_FIXED), FIXED)).toBeNull();
  });
  it("fixed: the amount, the mode or the switch changed since prepare is refused", async () => {
    expect(await loadManualFeeExecuteHold(mk({ ...BOTH_ON, late_cancel_fee_cents: 6000 }, FROZEN_FIXED), FIXED)).toBe(MANUAL_FEE_SETTINGS_CHANGED_MESSAGE);
    expect(await loadManualFeeExecuteHold(mk({ ...BOTH_ON, late_cancel_fee_mode: "percent", late_cancel_fee_percent_bp: 7500 }, FROZEN_FIXED), FIXED)).toBe(MANUAL_FEE_SETTINGS_CHANGED_MESSAGE);
    expect(await loadManualFeeExecuteHold(mk({ ...BOTH_ON, late_cancel_fee_enabled: false }, FROZEN_FIXED), FIXED)).toBe(LATE_CANCEL_FEE_DISABLED_MESSAGE);
  });
  it("percent: same percentage passes; a different percentage, or the mode switched back to fixed, is refused", async () => {
    const pct = { ...BOTH_ON, late_cancel_fee_mode: "percent", late_cancel_fee_percent_bp: 7500 };
    expect(await loadManualFeeExecuteHold(mk(pct, FROZEN_PCT), FIXED)).toBeNull();
    expect(await loadManualFeeExecuteHold(mk({ ...pct, late_cancel_fee_percent_bp: 5000 }, FROZEN_PCT), FIXED)).toBe(MANUAL_FEE_SETTINGS_CHANGED_MESSAGE);
    expect(await loadManualFeeExecuteHold(mk({ ...BOTH_ON }, FROZEN_PCT), FIXED)).toBe(MANUAL_FEE_SETTINGS_CHANGED_MESSAGE);
  });
  it("percent: a price that became $0, missing, ambiguous or unreadable after prepare blocks execute; a different positive price does not", async () => {
    const pct = { ...BOTH_ON, late_cancel_fee_mode: "percent", late_cancel_fee_percent_bp: 7500, timezone: "America/Toronto" };
    const frozen = { ...FROZEN_PCT, appointment_id: "appt-1" };
    for (const result of [
      { kind: "free", serviceName: "S", durationMinutes: null },
      { kind: "missing_price", serviceName: "S" },
      { kind: "missing_service" },
      { kind: "ambiguous_custom_pricing", serviceName: "S", candidateCents: [1, 2] },
    ]) {
      priceMock.load.mockResolvedValue({ ok: true, result });
      expect(await loadManualFeeExecuteHold(mk(pct, frozen), FIXED)).toBe(MANUAL_FEE_PRICE_CHANGED_MESSAGE);
    }
    priceMock.load.mockResolvedValue({ ok: false, reason: "read_failed" });
    expect(await loadManualFeeExecuteHold(mk(pct, frozen), FIXED)).toBe(MANUAL_FEE_SETTING_UNREADABLE_MESSAGE);
    priceMock.load.mockResolvedValue({ ok: true, result: { kind: "resolved", amountCents: 9999, source: "service_price", serviceName: "S", durationMinutes: null, customPricingNote: null } });
    expect(await loadManualFeeExecuteHold(mk(pct, frozen), FIXED)).toBeNull();
  });
  it("a fee with no frozen calculation, or an unreadable read, fails closed", async () => {
    expect(await loadManualFeeExecuteHold(mk(BOTH_ON, { calc_mode: null, basis_cents: null, percent_bp: null }), FIXED)).toBe(MANUAL_FEE_SETTINGS_CHANGED_MESSAGE);
    expect(await loadManualFeeExecuteHold(mk(null, FROZEN_FIXED), FIXED)).toBe(MANUAL_FEE_SETTING_UNREADABLE_MESSAGE);
    expect(await loadManualFeeExecuteHold(mk(BOTH_ON, null, false, true), FIXED)).toBe(MANUAL_FEE_SETTING_UNREADABLE_MESSAGE);
    const throwing = { from: () => { throw new Error("x"); } };
    expect(await loadManualFeeExecuteHold(throwing, FIXED)).toBe(MANUAL_FEE_SETTING_UNREADABLE_MESSAGE);
  });
  it("session payments and unknown reasons are not governed by it", async () => {
    expect(await loadManualFeeExecuteHold(mk(null, null, true), { ...FIXED, charge_reason: "session_payment" })).toBeNull();
  });
});

describe("runner: the three reads (behaviour)", () => {
  it("a fee whose settings changed since prepare is refused before the claim and stays ready (recoverable)", async () => {
    h.studioRow = { ...BOTH_ON, late_cancel_fee_cents: 6000 };
    const r = await run();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe(MANUAL_FEE_SETTINGS_CHANGED_MESSAGE);
    expect(h.rpcs).toEqual([]);
    expect(h.stripeCalls).toEqual([]);
  });
  it("a pending_stripe attempt reads no setting at all (reconcile is never re-gated)", async () => {
    h.attempt = attemptRow({ status: "pending_stripe", stripe_payment_intent_id: "pi_1" });
    await run().catch(() => undefined);
    expect(h.studioReads).toBe(0);
  });
});
