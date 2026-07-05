import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  closePool,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";

// Migration 0104: the one-active-card partial unique is now per
// (studio, client, MODE). A client may hold one active TEST card and one
// active LIVE card simultaneously (required by the mode-scoped webhook
// pre-flip); a same-mode duplicate active card is still refused.

let s: SeededStudio;

beforeAll(async () => {
  s = await seedStudio("card-per-mode");
  // Lineage prerequisites for client_payment_methods rows: a settings
  // binding + a client_stripe_customers row per mode (0032/0058 FKs).
  for (const [acct, mode, cus] of [
    ["acct_cpm_test", false, "cus_cpm_test"],
    ["acct_cpm_live", true, "cus_cpm_live"],
  ] as const) {
    await adminQuery(
      `insert into public.studio_payment_settings (studio_id, stripe_account_id, stripe_livemode)
       values ($1, $2, $3)`,
      [s.studioId, acct, mode],
    );
    await adminQuery(
      `insert into public.client_stripe_customers
         (client_id, studio_id, stripe_account_id, stripe_livemode, stripe_customer_id)
       values ($1, $2, $3, $4, $5)`,
      [s.clientId, s.studioId, acct, mode, cus],
    );
  }
});

afterAll(async () => {
  await closePool();
});

async function insertActiveCard(mode: boolean, setupIntent: string) {
  const acct = mode ? "acct_cpm_live" : "acct_cpm_test";
  const cus = mode ? "cus_cpm_live" : "cus_cpm_test";
  return adminQuery(
    `insert into public.client_payment_methods
       (studio_id, client_id, stripe_account_id, stripe_livemode, stripe_customer_id,
        stripe_payment_method_id, stripe_setup_intent_id, brand, last4, exp_month, exp_year,
        status, added_via)
     values ($1, $2, $3, $4, $5, $6, $7, 'visa', '4242', 12, 2030, 'active', 'portal')`,
    [s.studioId, s.clientId, acct, mode, cus, `pm_${randomUUID().slice(0, 12)}`, setupIntent],
  );
}

describe("one active card per (studio, client, mode)", () => {
  it("a client can hold an active TEST card and an active LIVE card at once", async () => {
    await expect(insertActiveCard(false, "seti_cpm_t1")).resolves.toBeDefined();
    await expect(insertActiveCard(true, "seti_cpm_l1")).resolves.toBeDefined();
    const { rows } = await adminQuery(
      `select stripe_livemode from public.client_payment_methods
        where studio_id = $1 and client_id = $2 and status = 'active'
        order by stripe_livemode`,
      [s.studioId, s.clientId],
    );
    expect(rows.map((r: { stripe_livemode: boolean }) => r.stripe_livemode)).toEqual([false, true]);
  });

  it("a SAME-mode duplicate active card is still refused by the index", async () => {
    await expect(insertActiveCard(true, "seti_cpm_l2")).rejects.toThrow(
      /client_payment_methods_one_active_per_pair/,
    );
  });
});
