import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminQuery, closePool } from "./helpers/harness";
import { E2E_SUPABASE_URL, E2E_SERVICE_ROLE_KEY } from "@/e2e/helpers/local-env";
import type { IdempotentEmailTransport, ProviderPayload } from "@/lib/email/new-client-waitlist-send";

// ===========================================================================
// THE STACKED CONTRACT: 0213 (LEAD-ALERT-01, #831) over 0212
// (DELIVERY-EVENTS-01, #832), on the contiguous chain 0210 -> 0211 -> 0212 ->
// 0213. ONE OWNER PER RETRY AUTHORITY:
//
//   * 0213 owns the lead alert's SEND retries (claim -> send -> settle).
//   * 0212 owns delivery-event RECEIPTS (record -> claim -> process). It never
//     resends. Its ledger is studio-scoped, so a receipt about a lead-alert
//     email matches no ledger row and stays platform-only.
//
// A provider event about a lead-alert email therefore never touches the
// alert, never re-opens it for another send, and never writes the ledger.
// "accepted" stays "accepted": nothing here turns it into "delivered".
// ===========================================================================

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

const DOMAIN = "lead-alert-contract.test";
const OPS = "success+lead-ops@harness.local";
const saved = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };

let delivery: typeof import("@/lib/platform-leads/alert-delivery");
let admin: SupabaseClient;
const sent: Array<{ payload: ProviderPayload; key?: string; id: string }> = [];

/** Accepts every send with a DISTINCT provider id, recording what was sent. */
const transport: IdempotentEmailTransport = {
  emails: {
    send: async (payload, options) => {
      // Resend email ids are UUIDs; 0212 refuses any other shape.
      const id = randomUUID();
      sent.push({ payload, key: options?.idempotencyKey, id });
      return { data: { id }, error: null };
    },
  },
};

const deps = () => ({
  admin,
  transport,
  env: { LEAD_ALERT_EMAIL: OPS, ADMIN_EMAILS: OPS },
  appOrigin: () => "https://console.lead-alert-contract.test",
});

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;
  delivery = await import("@/lib/platform-leads/alert-delivery");
  admin = (await import("@/lib/supabase/admin-server")).createAdminClient();
});

afterAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
  await closePool();
});

beforeEach(async () => {
  sent.length = 0;
  await adminQuery("delete from public.platform_lead_alerts");
  await adminQuery("delete from public.demo_requests where email like $1", [`%@${DOMAIN}`]);
});

async function acceptedAlert() {
  const lead = (await adminQuery(
    "select * from public.record_platform_demo_request('Contract Lead', $1, 'Practice', 'City', 'laser', '1', null, null)",
    [`c-${randomUUID().slice(0, 8)}@${DOMAIN}`],
  )).rows[0];
  expect(await delivery.deliverPlatformLeadAlert(lead.alert_id, deps())).toEqual({ result: "accepted" });
  const alert = (await adminQuery("select * from public.platform_lead_alerts where id = $1", [lead.alert_id])).rows[0];
  expect(alert.provider_message_id).toBe(sent[sent.length - 1].id);
  return alert;
}

async function receiptFor(providerEmailId: string, eventType: string, bounceType: string | null = null) {
  const recorded = (await adminQuery(
    "select * from public.record_email_provider_event($1, $2, $3, null, now(), $4, null, null, null)",
    [`evt_${randomUUID()}`, eventType, providerEmailId, bounceType],
  )).rows[0];
  expect(recorded.result).toBe("recorded");
  const claimed = (await adminQuery(
    "select * from public.claim_email_provider_events($1, 1)",
    [recorded.receipt_id],
  )).rows.map((r) => r.receipt_id);
  expect(claimed).toEqual([recorded.receipt_id]);
  const processed = (await adminQuery(
    "select * from public.process_email_provider_event($1)",
    [recorded.receipt_id],
  )).rows[0];
  const receipt = (await adminQuery(
    "select processing_state, email_message_id from public.email_provider_events where id = $1",
    [recorded.receipt_id],
  )).rows[0];
  return { processed, receipt };
}

describe("a delivery event about a lead-alert email", () => {
  for (const [event, bounce] of [
    ["email.delivered", null],
    ["email.bounced", "permanent"],
    ["email.failed", null],
  ] as const) {
    it(`${event}: an unmatched, platform-only receipt; the alert is untouched and nothing is resent`, async () => {
      const before = await acceptedAlert();
      const ledgerBefore = Number((await adminQuery("select count(*) n from public.email_outbound_messages")).rows[0].n);

      const { processed, receipt } = await receiptFor(before.provider_message_id, event, bounce);
      expect(processed.message_id).toBeNull();
      expect(receipt).toEqual({ processing_state: "unmatched", email_message_id: null });

      const after = (await adminQuery("select * from public.platform_lead_alerts where id = $1", [before.id])).rows[0];
      expect(after).toMatchObject({
        status: "accepted",
        attempt_count: before.attempt_count,
        provider_message_id: before.provider_message_id,
        send_generation: 1,
        last_error_code: null,
      });
      expect(after.updated_at.toISOString()).toBe(before.updated_at.toISOString());
      expect(Number((await adminQuery("select count(*) n from public.email_outbound_messages")).rows[0].n)).toBe(ledgerBefore);

      // The 0213 sweep is the only send authority, and it finds nothing to send.
      const sweep = await delivery.sweepPlatformLeadAlerts(deps());
      expect(sweep).toMatchObject({ ok: true, attempted: 0 });
      expect(sent).toHaveLength(1);
    });
  }

  it("a receipt replayed under one delivery id is one receipt, and still changes no alert", async () => {
    const alert = await acceptedAlert();
    const deliveryId = `evt_${randomUUID()}`;
    const args = [deliveryId, "email.delivered", alert.provider_message_id];
    const first = (await adminQuery("select * from public.record_email_provider_event($1, $2, $3, null, now(), null, null, null, null)", args)).rows[0];
    const again = (await adminQuery("select * from public.record_email_provider_event($1, $2, $3, null, now(), null, null, null, null)", args)).rows[0];
    expect([first.result, again.result]).toEqual(["recorded", "duplicate"]);
    expect(again.receipt_id).toBe(first.receipt_id);
    expect(Number((await adminQuery("select count(*) n from public.email_provider_events where provider_event_id = $1", [deliveryId])).rows[0].n)).toBe(1);
    expect((await adminQuery("select status from public.platform_lead_alerts where id = $1", [alert.id])).rows[0].status).toBe("accepted");
  });
});

describe("one retry authority each, in the database", () => {
  it("0212 has no grant or reference that reaches platform_lead_alerts, and 0213 none that reaches the email ledger", async () => {
    const defs = (await adminQuery(
      `select p.proname, pg_get_functiondef(p.oid) d
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and (p.proname like '%email%' or p.proname like '%platform_lead%' or p.proname like 'record_platform_%')`,
    )).rows as Array<{ proname: string; d: string }>;
    const email = defs.filter((r) => /email_(message|provider_event)/.test(r.proname));
    const lead = defs.filter((r) => /platform_lead|^record_platform_/.test(r.proname));
    expect(email.length).toBeGreaterThanOrEqual(5);
    expect(lead.length).toBeGreaterThanOrEqual(7);
    for (const r of email) expect(r.d, r.proname).not.toMatch(/platform_lead_alerts/);
    for (const r of lead) expect(r.d, r.proname).not.toMatch(/email_outbound_messages|email_provider_events/);
  });

  it("the chain under test is CONTIGUOUS and carries 0209-0213", async () => {
    // INTEGRATION HANDOFF, on the integration branch only. This assertion was
    // `toEqual(["0209","0210","0211","0212","0213"])`, which is correct on
    // #831's own branch where 0213 IS the top — and false the moment anything
    // stacks above it. A hard-coded list of applied versions is the same
    // anti-pattern CLAUDE.md §2 bans for filenames: it turns every later
    // migration, in any lane, into a red test in this one.
    //
    // The INTENT is preserved and made derived: the applied chain from 0209 up
    // must be CONTIGUOUS (the property this test exists to prove), and must
    // contain the five versions this contract depends on. What it no longer
    // claims is which version is last, because that is a fact about a branch
    // rather than about this contract.
    const versions = (await adminQuery(
      "select version from supabase_migrations.schema_migrations where version >= '0209' order by version",
    )).rows.map((r) => r.version as string);

    for (const required of ["0209", "0210", "0211", "0212", "0213"]) {
      expect(versions, `${required} must be applied`).toContain(required);
    }

    // CONTIGUOUS: no gap anywhere above 0209. A hole here would mean the stack
    // under test is not the stack this contract was written against.
    const numbers = versions.map(Number);
    for (let i = 1; i < numbers.length; i += 1) {
      expect(
        numbers[i],
        `gap in the applied chain between ${versions[i - 1]} and ${versions[i]}`,
      ).toBe(numbers[i - 1] + 1);
    }
  });
});
