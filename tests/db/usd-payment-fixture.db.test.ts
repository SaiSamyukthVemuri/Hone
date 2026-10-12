import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, adminTx, closePool, seedStudio, type SeededStudio } from "./helpers/harness";
import { E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL } from "@/e2e/helpers/local-env";
import {
  bindFakeStripeAccount,
  makeStudioUsd,
  seedCardOnFile,
  seedChargeableVisit,
  seedUsdPaymentLayer,
} from "./helpers/usd-payment-fixture";
import type { SessionPaymentEligibility } from "@/lib/billing/session-payment-types";

// PAY-CCY-06 (#824). The composable USD layer, proved against the REAL
// eligibility resolver (supabase-js -> REST -> the 0214 schema), so DB/WAIT can
// compose it onto the synthetic Fett studio (#853) with confidence. Nothing is
// mocked; Stripe is never called (eligibility reads only Hone's tables).

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

const saved = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  stripe: process.env.STRIPE_SECRET_KEY,
};
beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_harness_dummy";
});

const created: SeededStudio[] = [];
afterAll(async () => {
  for (const s of created) {
    for (const sql of [
      `delete from public.payment_charge_attempts where studio_id=$1`,
      `delete from public.client_payment_methods where studio_id=$1`,
      `delete from public.client_stripe_customers where studio_id=$1`,
      `delete from public.client_consent_signatures where studio_id=$1`,
      `delete from public.consent_form_templates where studio_id=$1`,
      `delete from public.studio_payment_settings where studio_id=$1`,
      `delete from public.sessions where studio_id=$1`,
      `delete from public.appointments where studio_id=$1`,
      `delete from public.services where studio_id=$1`,
      `delete from public.studios where id=$1`,
    ]) {
      await adminQuery(sql, [s.studioId]).catch(() => undefined);
    }
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
  process.env.STRIPE_SECRET_KEY = saved.stripe;
  await closePool();
});

async function studio(label: string) {
  const s = await seedStudio(`usdfix-${label}`);
  created.push(s);
  return s;
}

async function eligibility(studioId: string, sessionId: string): Promise<SessionPaymentEligibility> {
  const { getSessionPaymentEligibility } = await import("@/lib/billing/session-payment-eligibility");
  return getSessionPaymentEligibility({ studioId, sessionId });
}

describe("seedUsdPaymentLayer composes onto an existing studio", () => {
  it("makes it chargeable in USD: eligible, paymentCurrency usd", async () => {
    const s = await studio("happy");
    const { account, card, visit } = await seedUsdPaymentLayer(s, { priceCents: 15_000 });
    expect(account.reportedCountry).toBe("US");
    expect(card.clientEmail).toMatch(/^success\+/);

    const j = await adminQuery(
      `select payment_country, payment_currency, source from public.studio_payment_jurisdictions where studio_id=$1`,
      [s.studioId],
    );
    expect(j.rows[0]).toEqual({ payment_country: "US", payment_currency: "usd", source: "operator" });

    const e = await eligibility(s.studioId, visit.sessionId);
    expect(e.eligible ? null : e.blockingReasons).toBeNull();
    expect(e.eligible && e.paymentCurrency).toBe("usd");
    expect(e.eligible && e.stripeAccountId).toBe(account.accountId);
  });

  it("wrong-country variant: same layer on a Canadian-reported account is refused", async () => {
    const s = await studio("wrong-country");
    const { visit } = await seedUsdPaymentLayer(s, { accountCountry: "CA" });
    const e = await eligibility(s.studioId, visit.sessionId);
    expect(e.eligible).toBe(false);
    expect(e.eligible === false && e.blockingReasons.join(" | ")).toMatch(/different country/);
  });

  it("Canadian control: the same pieces without the switch stay CAD and chargeable", async () => {
    const s = await studio("ca-control");
    const account = await bindFakeStripeAccount(s, { reportedCountry: "CA" });
    await seedCardOnFile(s, account);
    const visit = await seedChargeableVisit(s, { priceCents: 15_000 });
    const e = await eligibility(s.studioId, visit.sessionId);
    expect(e.eligible ? null : e.blockingReasons).toBeNull();
    expect(e.eligible && e.paymentCurrency).toBe("cad");
  });

  it("refuses outright on a database without 0214, instead of quietly seeding CAD", async () => {
    // Simulated on ONE connection inside a transaction that is always rolled
    // back: the command is renamed so the probe cannot find it, exactly as on a
    // 0210 stack. Nothing persists.
    const { assertUsdCapableDatabase } = await import("./helpers/usd-payment-fixture");
    await assertUsdCapableDatabase(); // present here
    const rollback = new Error("rollback");
    let refusal: unknown = null;
    await adminTx(async (q) => {
      await q(
        `alter function public.set_studio_payment_jurisdiction(uuid,text,text,text,text,boolean) rename to set_studio_payment_jurisdiction_hidden`,
      );
      refusal = await assertUsdCapableDatabase((text) => q(text)).catch((e: unknown) => e);
      throw rollback;
    }).catch((e) => {
      if (e !== rollback) throw e;
    });
    expect(String(refusal)).toMatch(/no migration 0214/);
    await assertUsdCapableDatabase(); // restored: the rename never committed
  });

  it("enforces 0214's order: the switch is refused once an account exists", async () => {
    const s = await studio("order");
    await bindFakeStripeAccount(s, { reportedCountry: "US" });
    await expect(makeStudioUsd(s)).rejects.toThrow(/refused_payment_account/);
  });

  it("prices an EXISTING service (the #853 composition) instead of creating one", async () => {
    const s = await studio("existing-service");
    const svc = await adminQuery(
      `insert into public.services (studio_id, name, default_duration_minutes, active, modality)
       values ($1,'SYNTH-FETT treatment',60,true,'electrolysis') returning id`,
      [s.studioId],
    );
    const { visit } = await seedUsdPaymentLayer(s, { serviceId: svc.rows[0].id, priceCents: 22_000 });
    expect(visit.serviceId).toBe(svc.rows[0].id);
    const price = await adminQuery(`select price_cents from public.services where id=$1`, [svc.rows[0].id]);
    expect(price.rows[0].price_cents).toBe(22_000);
    const e = await eligibility(s.studioId, visit.sessionId);
    expect(e.eligible && e.paymentCurrency).toBe("usd");
  });
});
