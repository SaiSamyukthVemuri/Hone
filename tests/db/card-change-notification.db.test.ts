import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  closePool,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";

// Migration 0154 + the card-change notification writer, proven against the
// REAL migrated local database:
//   * the (studio_id, dedupe_key) partial unique index makes a re-attempt for
//     the same mode-scoped SetupIntent a no-op (the durable writer's
//     23505 -> confirm-row -> deduped:true path);
//   * NULL dedupe_key rows (every existing booking/cancel/reschedule/intake
//     notification) are unaffected;
//   * the length CHECK bounds the key;
//   * the added-vs-replaced determination = "count of same-mode payment-method
//     rows > 1", scoped per Stripe mode (a live card never affects the test
//     count, and vice versa);
//   * a card_added notification written the way ensureCardChangeNotification
//     writes it is studio-wide (practitioner_id null) and carries only the
//     safe body.

let s: SeededStudio;
// stripe_account_id is globally UNIQUE; suffix per run so the suite re-runs
// against the same local DB without colliding (CI uses a fresh DB either way).
const RUN = randomUUID().slice(0, 8);
const ACCT = { test: `acct_ccn_test_${RUN}`, live: `acct_ccn_live_${RUN}` };
const CUS = { test: `cus_ccn_test_${RUN}`, live: `cus_ccn_live_${RUN}` };

beforeAll(async () => {
  s = await seedStudio("card-change-notif");
  // Lineage prerequisites for client_payment_methods rows (0058 composite FKs):
  // a studio_payment_settings binding + a client_stripe_customers row per mode.
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
});

afterAll(async () => {
  await closePool();
});

async function insertCard(
  mode: boolean,
  setupIntent: string,
  status: "active" | "removed",
  brand = "visa",
  last4 = "4242",
) {
  const acct = mode ? ACCT.live : ACCT.test;
  const cus = mode ? CUS.live : CUS.test;
  const removedAt = status === "removed" ? "now()" : "null";
  return adminQuery(
    `insert into public.client_payment_methods
       (studio_id, client_id, stripe_account_id, stripe_livemode, stripe_customer_id,
        stripe_payment_method_id, stripe_setup_intent_id, brand, last4, exp_month, exp_year,
        status, removed_at, added_via)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 12, 2030, $10, ${removedAt}, 'portal')`,
    [
      s.studioId,
      s.clientId,
      acct,
      mode,
      cus,
      `pm_${randomUUID().slice(0, 12)}`,
      setupIntent,
      brand,
      last4,
      status,
    ],
  );
}

// The exact determination query ensureCardChangeNotification runs.
async function sameModeCount(mode: boolean): Promise<number> {
  const { rows } = await adminQuery(
    `select count(*)::int as n from public.client_payment_methods
     where studio_id = $1 and client_id = $2 and stripe_livemode = $3`,
    [s.studioId, s.clientId, mode],
  );
  return rows[0].n as number;
}

// Insert a notification the way the durable writer (ensurePractitionerNotification)
// does. Returns the pg error code (or null on success) so dedupe conflicts can be
// asserted without failing the test.
async function insertNotification(params: {
  dedupeKey: string | null;
  eventType: string;
  title: string;
  body: string;
  href: string;
}): Promise<{ code: string | null; id: string | null }> {
  try {
    const { rows } = await adminQuery(
      `insert into public.practitioner_notifications
         (studio_id, practitioner_id, event_type, title, body, appointment_id, client_id, href, dedupe_key)
       values ($1, null, $2, $3, $4, null, $5, $6, $7)
       returning id`,
      [
        s.studioId,
        params.eventType,
        params.title,
        params.body,
        s.clientId,
        params.href,
        params.dedupeKey,
      ],
    );
    return { code: null, id: rows[0].id as string };
  } catch (e: unknown) {
    const code = (e as { code?: string }).code ?? "unknown";
    return { code, id: null };
  }
}

describe("added-vs-replaced determination (same-mode payment-method count)", () => {
  it("first card in a mode => count 1 => card_added", async () => {
    expect(await sameModeCount(false)).toBe(0);
    await insertCard(false, "seti_ccn_add1", "active");
    expect(await sameModeCount(false)).toBe(1); // > 1 is false => card_added
  });

  it("a replacement (prior retired + new active) => count 2 => card_replaced", async () => {
    // The webhook pre-flip retires the prior active row then inserts the new one.
    await adminQuery(
      `update public.client_payment_methods
         set status = 'removed', removed_at = now()
       where studio_id = $1 and client_id = $2 and stripe_livemode = false and status = 'active'`,
      [s.studioId, s.clientId],
    );
    await insertCard(false, "seti_ccn_add2", "active", "mastercard", "5454");
    expect(await sameModeCount(false)).toBe(2); // > 1 => card_replaced
  });

  it("mode separation: a live-mode card does NOT change the test-mode count, and vice versa", async () => {
    const testBefore = await sameModeCount(false);
    await insertCard(true, "seti_ccn_live1", "active");
    expect(await sameModeCount(true)).toBe(1); // first LIVE card => card_added
    expect(await sameModeCount(false)).toBe(testBefore); // test count untouched
  });
});

describe("dedupe_key partial unique index (SetupIntent business-operation idempotency)", () => {
  it("two notifications with the SAME (studio, dedupe_key) => second hits 23505 (deduped)", async () => {
    const dedupeKey = `stripe:setup_intent:test:seti_${randomUUID().slice(0, 8)}`;
    const first = await insertNotification({
      dedupeKey,
      eventType: "card_added",
      title: "Card added on file",
      body: "Client card-change-notif added visa ending in 4242.",
      href: `/clients/${s.clientId}?tab=overview`,
    });
    expect(first.code).toBeNull();
    expect(first.id).toBeTruthy();

    const second = await insertNotification({
      dedupeKey,
      eventType: "card_added",
      title: "Card added on file",
      body: "Client card-change-notif added visa ending in 4242.",
      href: `/clients/${s.clientId}?tab=overview`,
    });
    expect(second.code).toBe("23505"); // unique_violation -> writer returns deduped:true
  });

  it("a DIFFERENT SetupIntent => a distinct notification is allowed", async () => {
    const a = await insertNotification({
      dedupeKey: `stripe:setup_intent:test:seti_${randomUUID().slice(0, 8)}`,
      eventType: "card_replaced",
      title: "Card replaced on file",
      body: "Client card-change-notif replaced the card on file with visa ending in 4242.",
      href: `/clients/${s.clientId}?tab=overview`,
    });
    const b = await insertNotification({
      dedupeKey: `stripe:setup_intent:test:seti_${randomUUID().slice(0, 8)}`,
      eventType: "card_replaced",
      title: "Card replaced on file",
      body: "Client card-change-notif replaced the card on file with visa ending in 4242.",
      href: `/clients/${s.clientId}?tab=overview`,
    });
    expect(a.code).toBeNull();
    expect(b.code).toBeNull();
    expect(a.id).not.toBe(b.id);
  });

  it("NULL dedupe_key rows are unaffected (existing writers can insert freely)", async () => {
    const n1 = await insertNotification({
      dedupeKey: null,
      eventType: "new_booking",
      title: "New booking",
      body: "A client booked.",
      href: `/calendar/${randomUUID()}`,
    });
    const n2 = await insertNotification({
      dedupeKey: null,
      eventType: "new_booking",
      title: "New booking",
      body: "A client booked.",
      href: `/calendar/${randomUUID()}`,
    });
    expect(n1.code).toBeNull();
    expect(n2.code).toBeNull();
    expect(n1.id).not.toBe(n2.id);
  });

  it("the length CHECK rejects an over-long dedupe key", async () => {
    const tooLong = "stripe:" + "x".repeat(300);
    const r = await insertNotification({
      dedupeKey: tooLong,
      eventType: "card_added",
      title: "Card added on file",
      body: "Client card-change-notif added visa ending in 4242.",
      href: `/clients/${s.clientId}?tab=overview`,
    });
    expect(r.code).toBe("23514"); // check_violation
  });
});

describe("a card_added notification is studio-wide with a safe body", () => {
  it("practitioner_id is null (studio-wide) and body holds only name + brand + last4", async () => {
    const dedupeKey = `stripe:setup_intent:test:seti_${randomUUID().slice(0, 8)}`;
    const body = "Client card-change-notif added visa ending in 4242.";
    const ins = await insertNotification({
      dedupeKey,
      eventType: "card_added",
      title: "Card added on file",
      body,
      href: `/clients/${s.clientId}?tab=overview`,
    });
    expect(ins.code).toBeNull();

    const { rows } = await adminQuery(
      `select practitioner_id, event_type, title, body, href, client_id
       from public.practitioner_notifications where id = $1`,
      [ins.id],
    );
    const row = rows[0];
    expect(row.practitioner_id).toBeNull(); // studio-wide
    expect(row.event_type).toBe("card_added");
    expect(row.client_id).toBe(s.clientId);
    expect(row.href).toBe(`/clients/${s.clientId}?tab=overview`);
    // No forbidden data in the body.
    expect(row.body).toContain("visa");
    expect(row.body).toContain("4242");
    expect(row.body).not.toMatch(/\d{5,}/); // never a full PAN
    expect(row.body).not.toMatch(/exp|@|\+\d/i); // no expiry/email/phone
  });
});
