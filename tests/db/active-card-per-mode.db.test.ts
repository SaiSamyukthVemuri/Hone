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

// FIXTURE ISOLATION (repeat-run safety): same defect and same remedy as
// tests/db/mode-scoped-connect-provisioning.db.test.ts.
// `studio_payment_settings_stripe_account_id_key` is UNIQUE GLOBALLY on
// stripe_account_id, so hard-coded `acct_cpm_*` ids bound this suite to
// whichever studio ran first: green on a fresh database, duplicate-key on the
// second run. Every synthetic id is derived from one run-unique namespace, so
// the suite is repeatable without deleting anything and two namespaces coexist.
const NS = randomUUID().slice(0, 8);
const ACCT_TEST = `acct_cpm_${NS}_test`;
const ACCT_LIVE = `acct_cpm_${NS}_live`;
const CUS_TEST = `cus_cpm_${NS}_test`;
const CUS_LIVE = `cus_cpm_${NS}_live`;

let s: SeededStudio;

beforeAll(async () => {
  s = await seedStudio("card-per-mode");
  // Lineage prerequisites for client_payment_methods rows: a settings
  // binding + a client_stripe_customers row per mode (0032/0058 FKs).
  for (const [acct, mode, cus] of [
    [ACCT_TEST, false, CUS_TEST],
    [ACCT_LIVE, true, CUS_LIVE],
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
  const acct = mode ? ACCT_LIVE : ACCT_TEST;
  const cus = mode ? CUS_LIVE : CUS_TEST;
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
