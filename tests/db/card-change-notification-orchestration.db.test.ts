import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  closePool,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";
import { E2E_SUPABASE_URL, E2E_SERVICE_ROLE_KEY } from "@/e2e/helpers/local-env";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

// Behavioral proof of the REAL durable orchestration (ensureCardChangeNotification
// -> ensurePractitionerNotification) against the migrated local database, nothing
// is mocked. The card rows are written the way the webhook writes them (service-
// role INSERT), then the real orchestration reads them, decides added vs replaced
// from persisted history, and writes the notification through the durable writer
// with the mode-scoped SetupIntent dedupe key.

// supabase-js realtime construction needs a global WebSocket; the DB lane's Node
// has none. A no-op stub satisfies construction (admin queries open no channel).
if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

const savedEnv = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  stripe: process.env.STRIPE_SECRET_KEY,
};

let s: SeededStudio;
let admin: SupabaseClient;
let ensureCardChangeNotification: (typeof import("@/lib/billing/card-change-notification"))["ensureCardChangeNotification"];
// stripe_account_id is globally UNIQUE; suffix per run for local re-runnability.
const RUN = randomUUID().slice(0, 8);
const ACCT = { test: `acct_orch_test_${RUN}`, live: `acct_orch_live_${RUN}` };
const CUS = { test: `cus_orch_test_${RUN}`, live: `cus_orch_live_${RUN}` };

beforeAll(async () => {
  // Point createAdminClient() at the local disposable Supabase (REST 54321).
  process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";

  s = await seedStudio("card-change-orch");
  for (const [acct, mode, cus] of [
    [ACCT.test, false, CUS.test],
    [ACCT.live, true, CUS.live],
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

  const adminMod = await import("@/lib/supabase/admin-server");
  admin = adminMod.createAdminClient();
  ({ ensureCardChangeNotification } = await import(
    "@/lib/billing/card-change-notification"
  ));
});

afterAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = savedEnv.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = savedEnv.key;
  process.env.STRIPE_SECRET_KEY = savedEnv.stripe;
  await closePool();
});

// Write a card the way the webhook does: retire any same-mode active row, insert
// the new active row. The orchestration only READS these.
async function insertActiveCard(
  mode: boolean,
  setupIntentId: string,
  brand = "visa",
  last4 = "4242",
) {
  const acct = mode ? ACCT.live : ACCT.test;
  const cus = mode ? CUS.live : CUS.test;
  await adminQuery(
    `update public.client_payment_methods set status='removed', removed_at=now()
     where studio_id=$1 and client_id=$2 and stripe_livemode=$3 and status='active'`,
    [s.studioId, s.clientId, mode],
  );
  await adminQuery(
    `insert into public.client_payment_methods
       (studio_id, client_id, stripe_account_id, stripe_livemode, stripe_customer_id,
        stripe_payment_method_id, stripe_setup_intent_id, brand, last4, exp_month, exp_year,
        status, added_via)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,12,2030,'active','portal')`,
    [
      s.studioId,
      s.clientId,
      acct,
      mode,
      cus,
      `pm_${randomUUID().slice(0, 12)}`,
      setupIntentId,
      brand,
      last4,
    ],
  );
}

const key = (mode: boolean, sid: string) =>
  `stripe:setup_intent:${mode ? "live" : "test"}:${sid}`;

async function notifCount(dedupeKey: string): Promise<number> {
  const { rows } = await adminQuery(
    `select count(*)::int as n from public.practitioner_notifications
     where studio_id=$1 and dedupe_key=$2`,
    [s.studioId, dedupeKey],
  );
  return rows[0].n as number;
}
async function notifRow(dedupeKey: string) {
  const { rows } = await adminQuery(
    `select practitioner_id, event_type, title, body, href, client_id
     from public.practitioner_notifications where studio_id=$1 and dedupe_key=$2`,
    [s.studioId, dedupeKey],
  );
  return rows[0];
}
async function cardCount(mode: boolean): Promise<number> {
  const { rows } = await adminQuery(
    `select count(*)::int as n from public.client_payment_methods
     where studio_id=$1 and client_id=$2 and stripe_livemode=$3`,
    [s.studioId, s.clientId, mode],
  );
  return rows[0].n as number;
}
const call = (mode: boolean, sid: string) =>
  ensureCardChangeNotification(admin, {
    studioId: s.studioId,
    clientId: s.clientId,
    livemode: mode,
    setupIntentId: sid,
  });

describe("real ensureCardChangeNotification against the local DB", () => {
  it("first SetupIntent -> exactly one card_added notification (studio-wide, safe body, href to client)", async () => {
    await insertActiveCard(false, "seti_first");
    const r = await call(false, "seti_first");
    expect(r).toEqual({ eventType: "card_added", deduped: false });

    const k = key(false, "seti_first");
    expect(await notifCount(k)).toBe(1);
    const row = await notifRow(k);
    expect(row.practitioner_id).toBeNull(); // studio-wide
    expect(row.event_type).toBe("card_added");
    expect(row.client_id).toBe(s.clientId);
    expect(row.href).toBe(`/clients/${s.clientId}?tab=overview`);
    expect(row.title).toBe("Card added on file");
    expect(row.body).toBe("Client card-change-orch added visa ending in 4242.");
    expect(row.body).not.toMatch(/\d{5,}/); // no full PAN
    expect(row.body).not.toMatch(/exp|@|\+\d/i); // no expiry/email/phone
  });

  it("replacement -> exactly one card_replaced notification", async () => {
    await insertActiveCard(false, "seti_replace", "mastercard", "5454");
    const r = await call(false, "seti_replace");
    expect(r).toEqual({ eventType: "card_replaced", deduped: false });

    const k = key(false, "seti_replace");
    expect(await notifCount(k)).toBe(1);
    const row = await notifRow(k);
    expect(row.title).toBe("Card replaced on file");
    expect(row.body).toBe(
      "Client card-change-orch replaced the card on file with mastercard ending in 5454.",
    );
  });

  it("same SetupIntent again (redelivery OR a second distinct Event) -> NO duplicate", async () => {
    const k = key(false, "seti_replace");
    expect(await notifCount(k)).toBe(1);
    // Two more calls represent (a) a Stripe redelivery and (b) a second distinct
    // Event object for the same successful SetupIntent. Both must dedupe.
    const r2 = await call(false, "seti_replace");
    expect(r2.deduped).toBe(true);
    const r3 = await call(false, "seti_replace");
    expect(r3.deduped).toBe(true);
    expect(await notifCount(k)).toBe(1);
  });

  it("card persisted but notification missing -> the ensure call creates the missing notification", async () => {
    // Card saved (first delivery) but notification not yet written.
    await insertActiveCard(false, "seti_missing", "amex", "0005");
    const k = key(false, "seti_missing");
    expect(await notifCount(k)).toBe(0);
    const r = await call(false, "seti_missing");
    expect(r.deduped).toBe(false);
    expect(await notifCount(k)).toBe(1);
  });

  it("notification already present -> returns deduped success, adds no row", async () => {
    const k = key(false, "seti_missing");
    expect(await notifCount(k)).toBe(1);
    const r = await call(false, "seti_missing");
    expect(r.deduped).toBe(true);
    expect(await notifCount(k)).toBe(1);
  });

  it("test and live SetupIntents with the SAME id produce DISTINCT notifications (mode-scoped key)", async () => {
    const sid = "seti_modemix";
    await insertActiveCard(false, sid); // test-mode replacement
    await insertActiveCard(true, sid); // first live-mode card (distinct row)
    const rTest = await call(false, sid);
    const rLive = await call(true, sid);
    expect(rTest.deduped).toBe(false);
    expect(rLive.deduped).toBe(false);
    expect(rLive.eventType).toBe("card_added"); // first live card
    expect(await notifCount(key(false, sid))).toBe(1);
    expect(await notifCount(key(true, sid))).toBe(1);
  });

  it("never mutates or undoes a card row", async () => {
    const beforeTest = await cardCount(false);
    const beforeLive = await cardCount(true);
    await call(false, "seti_replace"); // a deduped call
    expect(await cardCount(false)).toBe(beforeTest);
    expect(await cardCount(true)).toBe(beforeLive);
  });
});
