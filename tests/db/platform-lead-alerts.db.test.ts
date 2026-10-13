import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  adminQuery,
  asRole,
  closePool,
  resolveLocalDbUrl,
} from "./helpers/harness";
import { E2E_SUPABASE_URL, E2E_SERVICE_ROLE_KEY } from "@/e2e/helpers/local-env";
import type {
  IdempotentEmailTransport,
  ProviderPayload,
} from "@/lib/email/new-client-waitlist-send";

// ===========================================================================
// LEAD-ALERT-01 (#826), migration 0213, against the real migrated database.
//
//   * the lead and its alert intent are written together, or not at all;
//   * a duplicate early-access signup is no new lead and no alert;
//   * claim / settle: one worker per alert, fencing, bounded retries with
//     backoff, crash recovery under the SAME idempotency key, expiry;
//   * configuration blockers spend no attempt and are never success;
//   * the table and every command are service_role only;
//   * and the real delivery worker (lib/platform-leads/alert-delivery.ts),
//     driven through the existing fake Resend transport: acceptance,
//     rejection, an ambiguous attempt, crash-after-acceptance, concurrent
//     workers, missing configuration, malicious text and recipient injection.
//
// Nothing here can reach a real provider: every send goes through the fake
// transport, and the database is the local stack the harness pins.
// ===========================================================================

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

const DOMAIN = "lead-alert.test";
const OPS = "success+lead-ops@harness.local";
const REJECT = "reject+lead-ops@harness.local";
const THROW = "throw+lead-ops@harness.local";
const HOLD = "hold+lead-ops@harness.local";
const ADMIN_EMAILS = [OPS, REJECT, THROW, HOLD].join(",");
const ORIGIN = "https://console.lead-alert.test";

const savedEnv = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
};

type Delivery = typeof import("@/lib/platform-leads/alert-delivery");
let delivery: Delivery;
let admin: SupabaseClient;
let makeFake: () => IdempotentEmailTransport;

type Sent = { payload: ProviderPayload; key: string | undefined };

/** The existing fake Resend transport, with every request it receives recorded. */
function spy(sent: Sent[]): IdempotentEmailTransport {
  const inner = makeFake();
  return {
    emails: {
      send: async (payload, options) => {
        sent.push({ payload, key: options?.idempotencyKey });
        return inner.emails.send(payload, options);
      },
    },
  };
}

/** The fake transport, except that its FIRST request throws (an ambiguous attempt). */
function throwingOnce(sent: Sent[]): IdempotentEmailTransport {
  const inner = spy(sent);
  let thrown = false;
  return {
    emails: {
      send: async (payload, options) => {
        if (!thrown) {
          thrown = true;
          sent.push({ payload, key: options?.idempotencyKey });
          throw new Error("socket hang up");
        }
        return inner.emails.send(payload, options);
      },
    },
  };
}

function deps(recipient: string | undefined, sent: Sent[] = []) {
  return {
    admin,
    transport: spy(sent),
    env: { LEAD_ALERT_EMAIL: recipient, ADMIN_EMAILS },
    appOrigin: () => ORIGIN,
  };
}

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;
  delivery = await import("@/lib/platform-leads/alert-delivery");
  admin = (await import("@/lib/supabase/admin-server")).createAdminClient();
  const fake = await import("@/lib/email/e2e-fake-resend");
  makeFake = () => fake.createFakeResendTransport() as unknown as IdempotentEmailTransport;
});

afterAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = savedEnv.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = savedEnv.key;
  await closePool();
});

beforeEach(async () => {
  // Only this suite writes alerts; its leads carry its own domain.
  await adminQuery("delete from public.platform_lead_alerts");
  await adminQuery("delete from public.demo_requests where email like $1", [`%@${DOMAIN}`]);
  await adminQuery("delete from public.waitlist where email like $1", [`%@${DOMAIN}`]);
});

const uid = () => randomUUID().slice(0, 8);

type Recorded = { result: string; lead_id: string | null; alert_id: string | null };

async function recordDemo(over: Partial<Record<string, string | null>> = {}): Promise<Recorded & { email: string }> {
  const p = {
    name: "Avery Lead",
    email: `avery-${uid()}@${DOMAIN}`,
    practice: "Maple Clinic",
    location: "Toronto",
    type: "electrolysis",
    count: "2-5",
    tool: "Paper charts",
    notes: null as string | null,
    ...over,
  };
  const { rows } = await adminQuery(
    "select * from public.record_platform_demo_request($1, $2, $3, $4, $5, $6, $7, $8)",
    [p.name, p.email, p.practice, p.location, p.type, p.count, p.tool, p.notes],
  );
  return { ...(rows[0] as Recorded), email: p.email as string };
}

async function recordEarlyAccess(email: string): Promise<Recorded> {
  const { rows } = await adminQuery(
    "select * from public.record_platform_early_access_signup($1)",
    [email],
  );
  return rows[0] as Recorded;
}

async function alertRow(id: string) {
  const { rows } = await adminQuery("select * from public.platform_lead_alerts where id = $1", [id]);
  return rows[0];
}

async function claim(id: string | null, lease = 120) {
  const { rows } = await adminQuery(
    "select * from public.claim_platform_lead_alert($1, $2)",
    [id, lease],
  );
  return rows[0];
}

async function settle(
  id: string,
  token: string,
  outcome: string,
  code: string | null = null,
  providerError: string | null = null,
  messageId: string | null = null,
): Promise<string> {
  const { rows } = await adminQuery(
    "select public.settle_platform_lead_alert($1, $2, $3, $4, $5, $6) as r",
    [id, token, outcome, messageId, code, providerError],
  );
  return rows[0].r as string;
}

const makeDue = (id: string) =>
  adminQuery(
    "update public.platform_lead_alerts set next_attempt_at = clock_timestamp() - interval '1 second' where id = $1",
    [id],
  );
const expireLease = (id: string) =>
  adminQuery(
    "update public.platform_lead_alerts set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1",
    [id],
  );
const count = async (sql: string, params: unknown[] = []) =>
  Number((await adminQuery(sql, params)).rows[0].n);

// ---------------------------------------------------------------------------
describe("the lead and its alert intent are saved together", () => {
  it("a demo request: one lead, one pending alert dated by the lead, a derived key, nothing sent", async () => {
    const r = await recordDemo({ notes: "Please call after 5." });
    expect(r.result).toBe("recorded");
    const lead = (await adminQuery("select * from public.demo_requests where id = $1", [r.lead_id])).rows[0];
    expect(lead.email).toBe(r.email);
    expect(lead.status).toBe("new");
    expect(lead.notes).toBe("Please call after 5.");

    const a = await alertRow(r.alert_id!);
    expect(a.lead_kind).toBe("demo_request");
    expect(a.demo_request_id).toBe(r.lead_id);
    expect(a.waitlist_id).toBeNull();
    expect(a.status).toBe("pending");
    expect(a.attempt_count).toBe(0);
    expect(a.event_at.toISOString()).toBe(lead.created_at.toISOString());
    expect(a.next_attempt_at.toISOString()).toBe(lead.created_at.toISOString());
    expect(a.idempotency_key).toBe(`lead-alert/${a.id}/1`);
    expect(a.provider_message_id).toBeNull();
  });

  it("a refused lead write leaves neither a lead nor an alert", async () => {
    const email = `bad-${uid()}@${DOMAIN}`;
    await expect(
      adminQuery(
        "select * from public.record_platform_demo_request($1, $2, null, null, 'tattoo', null, null, null)",
        ["Bad Type", email],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    expect(await count("select count(*) n from public.demo_requests where email = $1", [email])).toBe(0);
    expect(await count("select count(*) n from public.platform_lead_alerts")).toBe(0);
  });

  it("a refused ALERT write leaves no lead behind either", async () => {
    // Make every demo alert insert fail, then call the command on its own
    // (autocommit): the lead must not survive its alert's failure.
    await adminQuery(
      "alter table public.platform_lead_alerts add constraint lead_alert_suite_refuse check (lead_kind <> 'demo_request') not valid",
    );
    const email = `orphan-${uid()}@${DOMAIN}`;
    try {
      await expect(
        adminQuery(
          "select * from public.record_platform_demo_request($1, $2, null, null, null, null, null, null)",
          ["Orphan Check", email],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await adminQuery("alter table public.platform_lead_alerts drop constraint lead_alert_suite_refuse");
    }
    expect(await count("select count(*) n from public.demo_requests where email = $1", [email])).toBe(0);
  });

  it("refuses what could never be a lead, writing nothing", async () => {
    const r = await recordDemo({ name: "   " });
    expect(r).toMatchObject({ result: "invalid_input", lead_id: null, alert_id: null });
    expect((await recordEarlyAccess("  ")).result).toBe("invalid_input");
    expect(await count("select count(*) n from public.platform_lead_alerts")).toBe(0);
  });

  it("a REPEATED demo submission is a new lead with its own single alert (lead capture unchanged)", async () => {
    const email = `repeat-${uid()}@${DOMAIN}`;
    const first = await recordDemo({ email });
    const second = await recordDemo({ email });
    expect(first.lead_id).not.toBe(second.lead_id);
    expect(first.alert_id).not.toBe(second.alert_id);
    expect(await count("select count(*) n from public.demo_requests where email = $1", [email])).toBe(2);
    const keys = (await adminQuery("select idempotency_key from public.platform_lead_alerts")).rows.map((r) => r.idempotency_key);
    expect(new Set(keys).size).toBe(2);
  });

  it("an early-access signup: one lead and one alert; the same address again is a duplicate with no alert", async () => {
    const email = `early-${uid()}@${DOMAIN}`;
    const first = await recordEarlyAccess(email);
    expect(first.result).toBe("recorded");
    const a = await alertRow(first.alert_id!);
    expect(a).toMatchObject({ lead_kind: "early_access", waitlist_id: first.lead_id, demo_request_id: null, status: "pending" });

    const again = await recordEarlyAccess(email);
    expect(again).toEqual({ result: "duplicate", lead_id: null, alert_id: null });
    expect(await count("select count(*) n from public.waitlist where email = $1", [email])).toBe(1);
    expect(await count("select count(*) n from public.platform_lead_alerts")).toBe(1);
  });

  it("two simultaneous signups for one address: one lead, one alert, one duplicate", async () => {
    const email = `race-${uid()}@${DOMAIN}`;
    const a = new Client({ connectionString: resolveLocalDbUrl() });
    const b = new Client({ connectionString: resolveLocalDbUrl() });
    await Promise.all([a.connect(), b.connect()]);
    try {
      await a.query("begin");
      const first = await a.query("select result from public.record_platform_early_access_signup($1)", [email]);
      // b blocks on a's uncommitted row, then sees it and does nothing.
      const second = b.query("select result from public.record_platform_early_access_signup($1)", [email]);
      await new Promise((r) => setTimeout(r, 150));
      await a.query("commit");
      const results = [first.rows[0].result, (await second).rows[0].result].sort();
      expect(results).toEqual(["duplicate", "recorded"]);
    } finally {
      await Promise.all([a.end(), b.end()]);
    }
    expect(await count("select count(*) n from public.waitlist where email = $1", [email])).toBe(1);
    expect(await count("select count(*) n from public.platform_lead_alerts")).toBe(1);
  });

  it("NO CATCH-UP: a lead saved any other way has no alert, and nothing ever sends for it", async () => {
    await adminQuery(
      "insert into public.demo_requests (name, email) values ('Old Lead', $1)",
      [`old-${uid()}@${DOMAIN}`],
    );
    await adminQuery("insert into public.waitlist (email) values ($1)", [`old-${uid()}@${DOMAIN}`]);
    expect(await count("select count(*) n from public.platform_lead_alerts")).toBe(0);
    expect((await claim(null)).result).toBe("none");
    const sent: Sent[] = [];
    const summary = await delivery.sweepPlatformLeadAlerts(deps(OPS, sent));
    expect(summary).toMatchObject({ ok: true, attempted: 0 });
    expect(sent).toHaveLength(0);
  });

  it("deleting a lead removes its alert", async () => {
    const r = await recordDemo();
    await adminQuery("delete from public.demo_requests where id = $1", [r.lead_id]);
    expect(await alertRow(r.alert_id!)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe("privileges: service_role only", () => {
  const COMMANDS = [
    "select * from public.record_platform_demo_request('n', 'e@x.test', null, null, null, null, null, null)",
    "select * from public.record_platform_early_access_signup('e@x.test')",
    "select * from public.claim_platform_lead_alert(null, 60)",
    "select public.settle_platform_lead_alert(gen_random_uuid(), gen_random_uuid(), 'accepted', null, null, null)",
    "select public.expire_platform_lead_alerts()",
    "select public.record_platform_lead_alerts_unconfigured('recipient_not_configured', null)",
    "select public.requeue_platform_lead_alert(gen_random_uuid())",
  ];

  for (const role of ["anon", "authenticated"] as const) {
    it(`${role} can neither read, write nor forge an alert`, async () => {
      for (const sql of [
        "select * from public.platform_lead_alerts",
        "insert into public.platform_lead_alerts (lead_kind, demo_request_id, event_at) values ('demo_request', gen_random_uuid(), now())",
        "update public.platform_lead_alerts set status = 'accepted', accepted_at = now()",
        "delete from public.platform_lead_alerts",
      ]) {
        await expect(asRole(role, (q) => q(sql)), sql).rejects.toMatchObject({ code: "42501" });
      }
    });

    it(`${role} can execute none of the commands`, async () => {
      for (const sql of COMMANDS) {
        await expect(asRole(role, (q) => q(sql)), sql).rejects.toMatchObject({ code: "42501" });
      }
    });

    it(`${role} still cannot read any lead`, async () => {
      await recordDemo();
      const demo = await asRole(role, (q) => q("select count(*) n from public.demo_requests"));
      const early = await asRole(role, (q) => q("select count(*) n from public.waitlist"));
      expect(Number(demo.rows[0].n)).toBe(0);
      expect(Number(early.rows[0].n)).toBe(0);
    });
  }

  it("service_role reads the table, runs the commands, and cannot write the table directly", async () => {
    await asRole("service_role", async (q) => {
      await q("select id, status from public.platform_lead_alerts");
      for (const sql of COMMANDS) await q(sql);
    });
    for (const sql of [
      "insert into public.platform_lead_alerts (lead_kind, demo_request_id, event_at) values ('demo_request', gen_random_uuid(), now())",
      "update public.platform_lead_alerts set status = 'accepted', accepted_at = now()",
      "delete from public.platform_lead_alerts",
    ]) {
      await expect(asRole("service_role", (q) => q(sql)), sql).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("the lead an alert is about can never be changed, even by the owner", async () => {
    const r = await recordDemo();
    const other = await recordDemo();
    await expect(
      adminQuery("update public.platform_lead_alerts set demo_request_id = $1 where id = $2", [other.lead_id, r.alert_id]),
    ).rejects.toThrow(/never changes/);
    await expect(
      adminQuery("update public.platform_lead_alerts set event_at = now() - interval '1 day' where id = $1", [r.alert_id]),
    ).rejects.toThrow(/never changes/);
    await expect(
      adminQuery("update public.platform_lead_alerts set idempotency_key = 'chosen' where id = $1", [r.alert_id]),
    ).rejects.toMatchObject({ code: "428C9" });
  });
});

// ---------------------------------------------------------------------------
describe("claim and settle", () => {
  it("one claim per alert: leased, counted, keyed; a second claim gets nothing", async () => {
    const r = await recordDemo({ notes: "secret" });
    const c = await claim(r.alert_id);
    expect(c).toMatchObject({
      result: "claimed",
      alert_id: r.alert_id,
      attempt: 1,
      idempotency_key: `lead-alert/${r.alert_id}/1`,
      lead_kind: "demo_request",
      lead_id: r.lead_id,
      lead_name: "Avery Lead",
      lead_email: r.email,
      practice_name: "Maple Clinic",
      location: "Toronto",
      practice_type: "electrolysis",
      practitioner_count: "2-5",
      current_tool: "Paper charts",
      has_notes: true,
    });
    // Notes are reported only as present: the claim returns no notes column.
    expect(Object.keys(c)).not.toContain("notes");
    const a = await alertRow(r.alert_id!);
    expect(a.status).toBe("sending");
    expect(a.claim_token).toBe(c.claim_token);
    const leaseSeconds = (a.lease_expires_at.getTime() - a.claimed_at.getTime()) / 1000;
    expect(leaseSeconds).toBe(120);
    expect((await claim(r.alert_id)).result).toBe("none");
    expect((await claim(null)).result).toBe("none");
  });

  it("the lease is bounded", async () => {
    await expect(claim(null, 5)).rejects.toMatchObject({ code: "22023" });
    await expect(claim(null, 3600)).rejects.toMatchObject({ code: "22023" });
  });

  it("accepted: recorded once, for the current claim only", async () => {
    const r = await recordDemo();
    const c = await claim(r.alert_id);
    expect(await settle(r.alert_id!, c.claim_token, "accepted", null, null, "msg-1")).toBe("accepted");
    const a = await alertRow(r.alert_id!);
    expect(a).toMatchObject({ status: "accepted", provider_message_id: "msg-1", claim_token: null, lease_expires_at: null, last_error_code: null });
    expect(a.accepted_at).not.toBeNull();
    expect(await settle(r.alert_id!, c.claim_token, "accepted", null, null, "msg-2")).toBe("stale_claim");
    expect((await alertRow(r.alert_id!)).provider_message_id).toBe("msg-1");
    expect(await settle(randomUUID(), c.claim_token, "accepted")).toBe("not_found");
  });

  it("refuses an unknown outcome, a missing error code and the reserved codes", async () => {
    const r = await recordDemo();
    const c = await claim(r.alert_id);
    expect(await settle(r.alert_id!, c.claim_token, "delivered")).toBe("invalid_input");
    expect(await settle(r.alert_id!, c.claim_token, "retry")).toBe("invalid_input");
    expect(await settle(r.alert_id!, c.claim_token, "fail", "expired")).toBe("invalid_input");
    expect(await settle(r.alert_id!, c.claim_token, "retry", "lease_expired")).toBe("invalid_input");
    expect((await alertRow(r.alert_id!)).status).toBe("sending");
  });

  it("retries back off 2 min, 10 min, 1 h, 6 h under ONE key, and the fifth failure is final", async () => {
    const r = await recordDemo();
    const expected = [2 * 60, 10 * 60, 60 * 60, 6 * 60 * 60];
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const c = await claim(r.alert_id);
      expect(c.attempt).toBe(attempt);
      expect(c.idempotency_key).toBe(`lead-alert/${r.alert_id}/1`);
      expect(await settle(r.alert_id!, c.claim_token, "retry", "provider_timeout")).toBe("retry_scheduled");
      const a = await alertRow(r.alert_id!);
      expect(a.status).toBe("pending");
      expect(a.last_error_code).toBe("provider_timeout");
      const wait = (a.next_attempt_at.getTime() - a.last_error_at.getTime()) / 1000;
      expect(wait).toBe(expected[attempt - 1]);
      // Not due yet: nobody can claim it early.
      expect((await claim(r.alert_id)).result).toBe("none");
      await makeDue(r.alert_id!);
    }
    const fifth = await claim(r.alert_id);
    expect(fifth.attempt).toBe(5);
    expect(await settle(r.alert_id!, fifth.claim_token, "retry", "provider_unavailable", "rate_limit_exceeded")).toBe("failed");
    const a = await alertRow(r.alert_id!);
    expect(a).toMatchObject({ status: "failed", attempt_count: 5, last_error_code: "provider_unavailable", last_provider_error: "rate_limit_exceeded" });
    await makeDue(r.alert_id!);
    expect((await claim(r.alert_id)).result).toBe("none");
  });

  it("a terminal refusal is final at once; a provider error name is kept only in its known shape", async () => {
    const r = await recordDemo();
    const c = await claim(r.alert_id);
    expect(await settle(r.alert_id!, c.claim_token, "fail", "provider_rejected", "Bad name: <x@y.z>")).toBe("failed");
    const a = await alertRow(r.alert_id!);
    expect(a).toMatchObject({ status: "failed", attempt_count: 1, last_error_code: "provider_rejected", last_provider_error: null });
  });

  it("crash recovery: an abandoned lease is re-claimed under the SAME key, and the old worker is fenced out", async () => {
    const r = await recordDemo();
    const first = await claim(r.alert_id);
    await expireLease(r.alert_id!);
    const second = await claim(null);
    expect(second).toMatchObject({ result: "claimed", alert_id: r.alert_id, attempt: 2 });
    expect(second.idempotency_key).toBe(first.idempotency_key);
    expect(second.claim_token).not.toBe(first.claim_token);
    expect((await alertRow(r.alert_id!)).last_error_code).toBe("lease_expired");

    // The first worker comes back late: it changes nothing.
    expect(await settle(r.alert_id!, first.claim_token, "accepted", null, null, "late")).toBe("stale_claim");
    expect(await settle(r.alert_id!, first.claim_token, "fail", "provider_rejected")).toBe("stale_claim");
    expect((await alertRow(r.alert_id!)).status).toBe("sending");
    expect(await settle(r.alert_id!, second.claim_token, "accepted", null, null, "msg-2")).toBe("accepted");
    expect((await alertRow(r.alert_id!)).provider_message_id).toBe("msg-2");
  });

  it("concurrent workers on separate connections never share an alert", async () => {
    const ids = [(await recordDemo()).alert_id, (await recordDemo()).alert_id, (await recordEarlyAccess(`c-${uid()}@${DOMAIN}`)).alert_id];
    const clients = Array.from({ length: 8 }, () => new Client({ connectionString: resolveLocalDbUrl() }));
    await Promise.all(clients.map((c) => c.connect()));
    try {
      const results = await Promise.all(
        clients.map((c) => c.query("select result, alert_id from public.claim_platform_lead_alert(null, 120)")),
      );
      const claimed = results.map((r) => r.rows[0]).filter((r) => r.result === "claimed").map((r) => r.alert_id);
      expect(claimed.sort()).toEqual([...ids].sort());
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });

  it("a claim in progress is skipped, not waited for", async () => {
    const r = await recordDemo();
    const a = new Client({ connectionString: resolveLocalDbUrl() });
    const b = new Client({ connectionString: resolveLocalDbUrl() });
    await Promise.all([a.connect(), b.connect()]);
    try {
      await a.query("begin");
      const held = await a.query("select result from public.claim_platform_lead_alert($1, 120)", [r.alert_id]);
      expect(held.rows[0].result).toBe("claimed");
      const started = Date.now();
      const other = await b.query("select result from public.claim_platform_lead_alert(null, 120)");
      expect(other.rows[0].result).toBe("none");
      expect(Date.now() - started).toBeLessThan(2_000);
      await a.query("commit");
    } finally {
      await Promise.all([a.end(), b.end()]);
    }
    expect((await alertRow(r.alert_id!)).attempt_count).toBe(1);
  });

  it("retries never re-create the lead", async () => {
    const r = await recordDemo();
    let c = await claim(r.alert_id);
    await settle(r.alert_id!, c.claim_token, "retry", "provider_exception");
    await makeDue(r.alert_id!);
    c = await claim(r.alert_id);
    await expireLease(r.alert_id!);
    c = await claim(null);
    await settle(r.alert_id!, c.claim_token, "fail", "provider_rejected", "validation_error");
    expect(await adminQuery("select public.requeue_platform_lead_alert($1) r", [r.alert_id]).then((x) => x.rows[0].r)).toBe("requeued");
    c = await claim(r.alert_id);
    await settle(r.alert_id!, c.claim_token, "accepted", null, null, "m");
    expect(await count("select count(*) n from public.demo_requests where email = $1", [r.email])).toBe(1);
    expect(await count("select count(*) n from public.platform_lead_alerts")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("expiry, configuration blockers and the operator's retry", () => {
  async function insertAged(hours: number) {
    const email = `aged-${uid()}@${DOMAIN}`;
    const lead = (await adminQuery(
      "insert into public.demo_requests (name, email, created_at) values ('Aged', $1, now() - make_interval(hours => $2)) returning id, created_at",
      [email, hours],
    )).rows[0];
    const alert = (await adminQuery(
      "insert into public.platform_lead_alerts (lead_kind, demo_request_id, event_at, next_attempt_at) values ('demo_request', $1, $2, $2) returning id",
      [lead.id, lead.created_at],
    )).rows[0];
    return alert.id as string;
  }

  it("an alert past its 72-hour window is never claimed, and expiry makes it a visible failure", async () => {
    const old = await insertAged(73);
    const fresh = (await recordDemo()).alert_id!;
    const c = await claim(null);
    expect(c.alert_id).toBe(fresh);
    expect((await claim(old)).result).toBe("none");
    expect(Number((await adminQuery("select public.expire_platform_lead_alerts() n")).rows[0].n)).toBe(1);
    expect(await alertRow(old)).toMatchObject({ status: "failed", last_error_code: "expired" });
    expect((await alertRow(fresh)).status).toBe("sending");
  });

  it("an abandoned fifth attempt fails as lease_expired", async () => {
    const r = await recordDemo();
    for (let i = 1; i <= 4; i += 1) {
      const c = await claim(r.alert_id);
      await settle(r.alert_id!, c.claim_token, "retry", "provider_timeout");
      await makeDue(r.alert_id!);
    }
    await claim(r.alert_id);
    await expireLease(r.alert_id!);
    expect((await claim(null)).result).toBe("none");
    await adminQuery("select public.expire_platform_lead_alerts()");
    expect(await alertRow(r.alert_id!)).toMatchObject({ status: "failed", attempt_count: 5, last_error_code: "lease_expired" });
  });

  it("a configuration blocker annotates waiting alerts only, and spends no attempt", async () => {
    const waiting = (await recordDemo()).alert_id!;
    const sending = (await recordDemo()).alert_id!;
    await claim(sending);
    expect(Number((await adminQuery("select public.record_platform_lead_alerts_unconfigured('recipient_not_configured', null) n")).rows[0].n)).toBe(1);
    expect(await alertRow(waiting)).toMatchObject({ status: "pending", attempt_count: 0, last_error_code: "recipient_not_configured" });
    expect((await alertRow(sending)).last_error_code).toBeNull();
    await expect(
      adminQuery("select public.record_platform_lead_alerts_unconfigured('provider_rejected', null)"),
    ).rejects.toMatchObject({ code: "22023" });
  });

  // Codex P2 4261478391: an abandoned send (expired lease) under blocked
  // configuration returns to pending, atomically and fenced.
  describe("an abandoned send under blocked configuration", () => {
    const MESSAGE = { from: "Hone <alerts@hone.test>", subject: "New demo request", html: "<p>frozen</p>", text: "frozen" };

    /** Claimed, frozen for OPS, then abandoned: the worker died mid-attempt. */
    async function abandoned() {
      const r = await recordDemo();
      const c = await claim(r.alert_id);
      const frozen = await adminQuery(
        "select result from public.freeze_platform_lead_alert_message($1, $2, $3::jsonb, $4)",
        [r.alert_id, c.claim_token, JSON.stringify(MESSAGE), delivery.recipientDigest(OPS)],
      );
      expect(frozen.rows[0].result).toBe("frozen");
      await expireLease(r.alert_id!);
      return { id: r.alert_id!, token: c.claim_token as string, key: c.idempotency_key as string, before: await alertRow(r.alert_id!) };
    }

    const BLOCKED: Array<[string, (sent: Sent[]) => Parameters<Delivery["sweepPlatformLeadAlerts"]>[0]]> = [
      ["recipient_not_configured", (sent) => deps(undefined, sent)],
      ["recipient_not_allowlisted", (sent) => deps("someone-else@lead-alert.test", sent)],
      ["transport_not_configured", (sent) => ({ ...deps(OPS, sent), transport: null })],
      ["app_origin_not_configured", (sent) => ({ ...deps(OPS, sent), appOrigin: () => { throw new Error("no origin"); } })],
    ];

    for (const [code, blockedDeps] of BLOCKED) {
      it(`${code}: an expired sending lease becomes blocked pending; a live lease is untouched; nothing is sent`, async () => {
        const gone = await abandoned();
        const live = (await recordDemo()).alert_id!;
        const liveClaim = await claim(live);
        const liveBefore = await alertRow(live);
        const sent: Sent[] = [];

        const summary = await delivery.sweepPlatformLeadAlerts(blockedDeps(sent));
        expect(summary).toMatchObject({ ok: true, blocked: code, blockedAlerts: 1, attempted: 0 });
        expect(sent).toHaveLength(0);

        const after = await alertRow(gone.id);
        expect(after).toMatchObject({
          status: "pending", claim_token: null, claimed_at: null, lease_expires_at: null, last_error_code: code,
        });
        // Nothing that makes the next claim a safe replay has moved.
        for (const col of ["attempt_count", "first_attempted_at", "next_attempt_at", "send_generation", "frozen_message", "frozen_recipient_sha256"]) {
          expect(after[col], col).toEqual(gone.before[col]);
        }
        // The live lease: byte for byte as it was.
        expect(await alertRow(live)).toEqual({ ...liveBefore });
        expect((await alertRow(live)).claim_token).toBe(liveClaim.claim_token);
      });
    }

    it("the old worker is fenced out: its late freeze and settle answer stale_claim and change nothing", async () => {
      const gone = await abandoned();
      await adminQuery("select public.record_platform_lead_alerts_unconfigured('transport_not_configured', null)");
      expect(await settle(gone.id, gone.token, "accepted", null, null, "late")).toBe("stale_claim");
      expect(await settle(gone.id, gone.token, "fail", "provider_rejected")).toBe("stale_claim");
      const frozen = await adminQuery(
        "select result from public.freeze_platform_lead_alert_message($1, $2, $3::jsonb, $4)",
        [gone.id, gone.token, JSON.stringify(MESSAGE), delivery.recipientDigest(OPS)],
      );
      expect(frozen.rows[0].result).toBe("stale_claim");
      expect(await alertRow(gone.id)).toMatchObject({ status: "pending", provider_message_id: null, last_error_code: "transport_not_configured", attempt_count: 1 });
    });

    it("once configured, the normal reclaim is the same replay-safe retry: same key, frozen bytes, one send", async () => {
      const gone = await abandoned();
      await adminQuery("select public.record_platform_lead_alerts_unconfigured('recipient_not_configured', null)");
      const sent: Sent[] = [];
      const summary = await delivery.sweepPlatformLeadAlerts(deps(OPS, sent));
      expect(summary).toMatchObject({ ok: true, attempted: 1, accepted: 1 });
      expect(sent).toHaveLength(1);
      expect(sent[0].key).toBe(gone.key);
      expect(sent[0].payload).toMatchObject({ to: OPS, subject: MESSAGE.subject, html: MESSAGE.html, text: MESSAGE.text });
      expect(await alertRow(gone.id)).toMatchObject({ status: "accepted", attempt_count: 2, send_generation: gone.before.send_generation });
    });

    it("an abandoned send past its attempts or replay window is not revived: expiry fails it", async () => {
      const fifth = (await recordDemo()).alert_id!;
      for (let i = 1; i <= 4; i += 1) {
        const c = await claim(fifth);
        await settle(fifth, c.claim_token, "retry", "provider_timeout");
        await makeDue(fifth);
      }
      await claim(fifth);
      await expireLease(fifth);
      const late = await abandoned();
      await adminQuery("update public.platform_lead_alerts set first_attempted_at = clock_timestamp() - interval '21 hours' where id = $1", [late.id]);

      expect(Number((await adminQuery("select public.record_platform_lead_alerts_unconfigured('recipient_not_configured', null) n")).rows[0].n)).toBe(0);
      expect((await alertRow(fifth)).status).toBe("sending");
      expect((await alertRow(late.id)).status).toBe("sending");
      expect(Number((await adminQuery("select public.expire_platform_lead_alerts() n")).rows[0].n)).toBe(2);
      expect(await alertRow(fifth)).toMatchObject({ status: "failed", attempt_count: 5 });
      expect((await alertRow(late.id)).status).toBe("failed");
    });

    it("ATOMIC against a concurrent reclaim: a lease renewed while the blocker waits is not touched", async () => {
      const gone = await abandoned();
      const a = new Client({ connectionString: resolveLocalDbUrl() });
      const b = new Client({ connectionString: resolveLocalDbUrl() });
      await Promise.all([a.connect(), b.connect()]);
      try {
        // A configured worker re-leases the abandoned alert, uncommitted.
        await a.query("begin");
        const re = await a.query("select result, claim_token from public.claim_platform_lead_alert($1, 120)", [gone.id]);
        expect(re.rows[0].result).toBe("claimed");
        // The blocker (another instance, blocked config) runs meanwhile: it
        // waits on the row, then re-checks the lease on the committed row.
        const blocked = b.query("select public.record_platform_lead_alerts_unconfigured('recipient_not_configured', $1) n", [gone.id]);
        await new Promise((r) => setTimeout(r, 300));
        await a.query("commit");
        expect(Number((await blocked).rows[0].n)).toBe(0);
        expect(await alertRow(gone.id)).toMatchObject({ status: "sending", claim_token: re.rows[0].claim_token, attempt_count: 2, last_error_code: "lease_expired" });
      } finally {
        await Promise.all([a.end(), b.end()]);
      }
    });
  });

  it("THE REPLAY WINDOW: no automatic attempt 20 hours after the first, whatever the cadence (Codex P2 4243922090)", async () => {
    const r = await recordDemo();
    const first = await claim(r.alert_id);
    const a1 = await alertRow(r.alert_id!);
    expect(a1.first_attempted_at.toISOString()).toBe(a1.claimed_at.toISOString());
    expect(await settle(r.alert_id!, first.claim_token, "retry", "provider_timeout")).toBe("retry_scheduled");
    // A later attempt inside the window keeps the window's start.
    await makeDue(r.alert_id!);
    const second = await claim(r.alert_id);
    expect((await alertRow(r.alert_id!)).first_attempted_at.toISOString()).toBe(a1.first_attempted_at.toISOString());
    await settle(r.alert_id!, second.claim_token, "retry", "provider_timeout");

    // The first attempt is now 21 hours old: the provider may no longer
    // recognise the key, so nothing claims it, even though it is due.
    await adminQuery(
      "update public.platform_lead_alerts set first_attempted_at = clock_timestamp() - interval '21 hours', next_attempt_at = clock_timestamp() - interval '1 second' where id = $1",
      [r.alert_id],
    );
    expect((await claim(r.alert_id)).result).toBe("none");
    expect((await claim(null)).result).toBe("none");
    await adminQuery("select public.expire_platform_lead_alerts()");
    expect(await alertRow(r.alert_id!)).toMatchObject({ status: "failed", last_error_code: "expired", attempt_count: 2 });

    // Only the operator's retry sends again, and under a NEW key generation.
    expect((await adminQuery("select public.requeue_platform_lead_alert($1) r", [r.alert_id])).rows[0].r).toBe("requeued");
    expect(await alertRow(r.alert_id!)).toMatchObject({ first_attempted_at: null, attempt_count: 0, idempotency_key: `lead-alert/${r.alert_id}/2` });
    expect((await claim(r.alert_id)).idempotency_key).toBe(`lead-alert/${r.alert_id}/2`);
  });

  it("a retryable failure that settles past the replay window is final", async () => {
    const r = await recordDemo();
    const c = await claim(r.alert_id);
    await adminQuery("update public.platform_lead_alerts set first_attempted_at = clock_timestamp() - interval '21 hours' where id = $1", [r.alert_id]);
    expect(await settle(r.alert_id!, c.claim_token, "retry", "provider_timeout")).toBe("failed");
  });

  it("an abandoned attempt past the replay window is never re-leased; expiry fails it", async () => {
    const r = await recordDemo();
    await claim(r.alert_id);
    await adminQuery(
      "update public.platform_lead_alerts set first_attempted_at = clock_timestamp() - interval '21 hours', lease_expires_at = clock_timestamp() - interval '1 second' where id = $1",
      [r.alert_id],
    );
    expect((await claim(null)).result).toBe("none");
    await adminQuery("select public.expire_platform_lead_alerts()");
    expect(await alertRow(r.alert_id!)).toMatchObject({ status: "failed", last_error_code: "lease_expired" });
  });

  it("the first attempt and the attempt count move together", async () => {
    const r = await recordDemo();
    await expect(
      adminQuery("update public.platform_lead_alerts set first_attempted_at = now() where id = $1", [r.alert_id]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("the operator's retry: failed only, a fresh budget, window and key", async () => {
    const old = await insertAged(80);
    await adminQuery("select public.expire_platform_lead_alerts()");
    expect((await alertRow(old)).status).toBe("failed");
    const requeue = async (id: string) =>
      (await adminQuery("select public.requeue_platform_lead_alert($1) r", [id])).rows[0].r as string;
    expect(await requeue(old)).toBe("requeued");
    const a = await alertRow(old);
    expect(a).toMatchObject({ status: "pending", attempt_count: 0, send_generation: 2, failed_at: null, idempotency_key: `lead-alert/${old}/2` });
    // The window restarts from the request, so an old lead can be re-sent ON REQUEST.
    const c = await claim(old);
    expect(c).toMatchObject({ result: "claimed", idempotency_key: `lead-alert/${old}/2` });
    expect(await requeue(old)).toBe("not_failed");
    expect(await requeue(randomUUID())).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
describe("the delivery worker, through the existing fake Resend transport", () => {
  it("a new demo request: one email, to the configured operator, under the alert's key; accepted, not 'delivered'", async () => {
    const r = await recordDemo();
    const sent: Sent[] = [];
    const out = await delivery.deliverPlatformLeadAlert(r.alert_id!, deps(OPS, sent));
    expect(out).toEqual({ result: "accepted" });
    expect(sent).toHaveLength(1);
    expect(sent[0].key).toBe(`lead-alert/${r.alert_id}/1`);
    expect(sent[0].payload.to).toBe(OPS);
    expect(sent[0].payload.from).toBe("Hone <hello@hone.care>");
    expect(sent[0].payload).not.toHaveProperty("replyTo");
    expect(sent[0].payload.text).toContain(r.email);
    expect(sent[0].payload.text).toContain(`${ORIGIN}/admin/leads/demo-request/${r.lead_id}`);
    const a = await alertRow(r.alert_id!);
    expect(a).toMatchObject({ status: "accepted", provider_message_id: "fake-resend-message-id", attempt_count: 1 });
  });

  it("a new early-access signup: accepted", async () => {
    const email = `ea-${uid()}@${DOMAIN}`;
    const r = await recordEarlyAccess(email);
    const sent: Sent[] = [];
    expect(await delivery.deliverPlatformLeadAlert(r.alert_id!, deps(OPS, sent))).toEqual({ result: "accepted" });
    expect(sent[0].payload.subject).toMatch(/^New Hone early-access signup \(\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\)$/);
    expect(sent[0].payload.text).toContain(email);
    expect((await alertRow(r.alert_id!)).status).toBe("accepted");
  });

  it("a provider REJECTION fails the alert, keeps the lead, and raises an ops alert without PII", async () => {
    const r = await recordDemo();
    const before = new Date();
    expect(await delivery.deliverPlatformLeadAlert(r.alert_id!, deps(REJECT))).toEqual({ result: "failed" });
    expect(await alertRow(r.alert_id!)).toMatchObject({ status: "failed", last_error_code: "provider_rejected", last_provider_error: "validation_error" });
    expect(await count("select count(*) n from public.demo_requests where id = $1", [r.lead_id])).toBe(1);
    const ops = (await adminQuery(
      "select message, safe_details::text d from public.ops_alerts where event = 'platform_lead_alert_failed' and created_at >= $1",
      [before],
    )).rows;
    expect(ops).toHaveLength(1);
    expect(ops[0].d).toContain(r.alert_id);
    expect(`${ops[0].message} ${ops[0].d}`).not.toContain(r.email);
  });

  it("an ambiguous attempt (the request threw) is retried later under the SAME key, then accepted", async () => {
    const r = await recordDemo();
    const sent: Sent[] = [];
    // The SAME recipient throughout: a retry repeats the first request exactly.
    expect(await delivery.deliverPlatformLeadAlert(r.alert_id!, { ...deps(OPS, sent), transport: throwingOnce(sent) })).toEqual({ result: "retry_scheduled" });
    expect(await alertRow(r.alert_id!)).toMatchObject({ status: "pending", last_error_code: "provider_timeout", attempt_count: 1 });
    // Not due yet: the sweep leaves it alone.
    expect((await delivery.sweepPlatformLeadAlerts(deps(OPS, sent))).attempted).toBe(0);
    await makeDue(r.alert_id!);
    const summary = await delivery.sweepPlatformLeadAlerts(deps(OPS, sent));
    expect(summary).toMatchObject({ ok: true, attempted: 1, accepted: 1 });
    expect(sent.map((s) => s.key)).toEqual([`lead-alert/${r.alert_id}/1`, `lead-alert/${r.alert_id}/1`]);
    expect(await count("select count(*) n from public.demo_requests where email = $1", [r.email])).toBe(1);
  });

  it("crash after the provider ACCEPTED: the sweep re-sends under the same key, so the provider replays rather than repeats", async () => {
    const r = await recordDemo();
    const sent: Sent[] = [];
    // A worker claims, its send is accepted, and it dies before settling.
    const c = await claim(r.alert_id);
    await spy(sent).emails.send(
      { from: "Hone <hello@hone.care>", to: OPS, subject: "s", html: "h", text: "t" },
      { idempotencyKey: c.idempotency_key },
    );
    expect((await alertRow(r.alert_id!)).status).toBe("sending");
    await expireLease(r.alert_id!);
    const summary = await delivery.sweepPlatformLeadAlerts(deps(OPS, sent));
    expect(summary).toMatchObject({ attempted: 1, accepted: 1 });
    expect(sent.map((s) => s.key)).toEqual([c.idempotency_key, c.idempotency_key]);
    expect(await alertRow(r.alert_id!)).toMatchObject({ status: "accepted", attempt_count: 2 });
  });

  it("a worker mid-send keeps its alert: a concurrent sweep sends nothing", async () => {
    const r = await recordDemo();
    const sent: Sent[] = [];
    // HOLD keeps the first request genuinely in flight for a few seconds.
    const inFlight = delivery.deliverPlatformLeadAlert(r.alert_id!, deps(HOLD, sent));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const sweep = await delivery.sweepPlatformLeadAlerts(deps(OPS, sent));
    expect(sweep.attempted).toBe(0);
    expect(await inFlight).toEqual({ result: "accepted" });
    expect(sent).toHaveLength(1);
  });

  it("two sweeps at once send each due alert exactly once", async () => {
    const ids = [(await recordDemo()).alert_id, (await recordDemo()).alert_id, (await recordDemo()).alert_id];
    const sent: Sent[] = [];
    const [x, y] = await Promise.all([
      delivery.sweepPlatformLeadAlerts(deps(OPS, sent)),
      delivery.sweepPlatformLeadAlerts(deps(OPS, sent)),
    ]);
    expect(x.accepted + y.accepted).toBe(3);
    expect(sent.map((s) => s.key).sort()).toEqual(ids.map((id) => `lead-alert/${id}/1`).sort());
  });

  it("missing or refused configuration: nothing sent, no attempt spent, the alert says why; fixed, it sends", async () => {
    const r = await recordDemo();
    const sent: Sent[] = [];
    expect(await delivery.deliverPlatformLeadAlert(r.alert_id!, deps(undefined, sent))).toEqual({ result: "blocked", code: "recipient_not_configured", recorded: true });
    expect(await alertRow(r.alert_id!)).toMatchObject({ status: "pending", attempt_count: 0, last_error_code: "recipient_not_configured" });

    expect(await delivery.deliverPlatformLeadAlert(r.alert_id!, deps("someone-else@example.test", sent))).toEqual({ result: "blocked", code: "recipient_not_allowlisted", recorded: true });
    expect(await delivery.deliverPlatformLeadAlert(r.alert_id!, { ...deps(OPS, sent), transport: null })).toEqual({ result: "blocked", code: "transport_not_configured", recorded: true });
    expect(
      await delivery.deliverPlatformLeadAlert(r.alert_id!, {
        ...deps(OPS, sent),
        appOrigin: () => {
          throw new Error("NEXT_PUBLIC_APP_ORIGIN is required in production.");
        },
      }),
    ).toEqual({ result: "blocked", code: "app_origin_not_configured", recorded: true });
    expect(sent).toHaveLength(0);
    expect((await alertRow(r.alert_id!)).attempt_count).toBe(0);

    const sweep = await delivery.sweepPlatformLeadAlerts(deps(OPS, sent));
    expect(sweep).toMatchObject({ blocked: null, accepted: 1 });
    expect(await alertRow(r.alert_id!)).toMatchObject({ status: "accepted", last_error_code: null });
  });

  it("a blocked sweep records the blocker on every waiting alert and sends nothing", async () => {
    await recordDemo();
    await recordEarlyAccess(`b-${uid()}@${DOMAIN}`);
    const sent: Sent[] = [];
    const summary = await delivery.sweepPlatformLeadAlerts(deps(undefined, sent));
    expect(summary).toMatchObject({ ok: true, blocked: "recipient_not_configured", blockedAlerts: 2, attempted: 0 });
    expect(sent).toHaveLength(0);
  });

  it("malicious submitted text is flattened and escaped; the subject carries none of it", async () => {
    const CR = String.fromCharCode(13);
    const LF = String.fromCharCode(10);
    const RLO = String.fromCharCode(0x202e);
    const r = await recordDemo({
      name: `<script>alert(1)</script>${CR}${LF}Console: https://evil.example${LF}`,
      practice: `"><img src=x onerror=alert(1)>${RLO}cilbup`,
      location: "x".repeat(5000),
      tool: `Paper${LF}Bcc: attacker@evil.example`,
      notes: "SECRET-NOTE-TEXT",
    });
    const sent: Sent[] = [];
    expect(await delivery.deliverPlatformLeadAlert(r.alert_id!, deps(OPS, sent))).toEqual({ result: "accepted" });
    const { subject, html, text } = sent[0].payload;
    expect(subject).toMatch(/^New Hone demo request \(\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\)$/);
    expect(html).not.toMatch(/<script|<img/i);
    expect(html).toContain("&lt;script&gt;");
    expect(`${html}${text}`).not.toContain(RLO);
    // Every line of the text starts with a known label or fixed copy: no
    // submitted value opened a line of its own.
    expect(text.split(LF).filter((l) => /^(Console|Bcc):/.test(l))).toEqual([]);
    expect(text).toContain("Notes: Included with the request. Read them in the console.");
    expect(`${html}${text}`).not.toContain("SECRET-NOTE-TEXT");
    expect(text.length).toBeLessThan(3000);
  });

  it("recipient injection: the prospect's own address and every submitted value never become a destination", async () => {
    const r = await recordDemo({
      email: `victim-${uid()}@${DOMAIN}`,
      name: `Mallory${String.fromCharCode(13, 10)}To: attacker@evil.example`,
    });
    const sent: Sent[] = [];
    await delivery.deliverPlatformLeadAlert(r.alert_id!, deps(OPS, sent));
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0].payload).sort()).toEqual(["from", "html", "subject", "text", "to"]);
    expect(sent[0].payload.to).toBe(OPS);

    // And a configured value that is not exactly ONE allowlisted address is refused.
    for (const configured of [
      `${OPS},attacker@evil.example`,
      `${OPS}${String.fromCharCode(10)}Bcc: attacker@evil.example`,
      `Ops <${OPS}>`,
    ]) {
      const out = await delivery.deliverPlatformLeadAlert(r.alert_id!, deps(configured, sent));
      expect(out, configured).toEqual({ result: "blocked", code: "recipient_not_allowlisted", recorded: true });
    }
    expect(sent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Codex P2 4244387544: ONE KEY, ONE REQUEST. The first attempt of a generation
// freezes what it sends; every automatic retry sends exactly that.
// ---------------------------------------------------------------------------
describe("the payload is frozen per generation", () => {
  const MESSAGE = { from: "Hone <hello@hone.care>", subject: "s", html: "<p>h</p>", text: "t" };
  const DIGEST = "a".repeat(64);
  const freeze = async (id: string, token: string, message: unknown = MESSAGE, digest: string | null = DIGEST) =>
    (await adminQuery("select * from public.freeze_platform_lead_alert_message($1, $2, $3, $4)", [id, token, message === null ? null : JSON.stringify(message), digest])).rows[0] as {
      result: string;
      message: unknown;
      recipient_sha256: string | null;
    };

  it("first writer wins, under the current claim only; a stale claim or a malformed message freezes nothing", async () => {
    const r = await recordDemo();
    const c = await claim(r.alert_id);
    expect(c.frozen_message).toBeNull();
    for (const bad of [
      { ...MESSAGE, to: "someone@else.test" },
      { from: "f", subject: "s", html: "h" },
      { ...MESSAGE, text: 7 },
    ]) {
      expect((await freeze(r.alert_id!, c.claim_token, bad)).result, JSON.stringify(bad)).toBe("invalid_input");
    }
    expect((await freeze(r.alert_id!, c.claim_token, MESSAGE, "not-a-digest")).result).toBe("invalid_input");
    expect((await freeze(r.alert_id!, randomUUID())).result).toBe("stale_claim");
    expect(await freeze(r.alert_id!, c.claim_token)).toEqual({ result: "frozen", message: MESSAGE, recipient_sha256: DIGEST });
    // A second render (another deploy, another origin) is discarded.
    expect(await freeze(r.alert_id!, c.claim_token, { ...MESSAGE, html: "<p>other</p>" }, "b".repeat(64))).toEqual({
      result: "existing",
      message: MESSAGE,
      recipient_sha256: DIGEST,
    });
    // The next claim of the same generation carries it.
    await settle(r.alert_id!, c.claim_token, "retry", "provider_timeout");
    await makeDue(r.alert_id!);
    const c2 = await claim(r.alert_id);
    expect(c2).toMatchObject({ idempotency_key: c.idempotency_key, frozen_message: MESSAGE, frozen_recipient_sha256: DIGEST });
  });

  it("end to end: the retry after an origin change sends the first attempt's bytes under the same key, and acceptance clears them", async () => {
    const r = await recordDemo();
    const sent: Sent[] = [];
    expect(await delivery.deliverPlatformLeadAlert(r.alert_id!, { ...deps(OPS, sent), transport: throwingOnce(sent) })).toEqual({ result: "retry_scheduled" });
    expect((await alertRow(r.alert_id!)).frozen_message).not.toBeNull();
    await makeDue(r.alert_id!);
    const moved = { ...deps(OPS, sent), appOrigin: () => "https://moved.lead-alert.test" };
    expect(await delivery.sweepPlatformLeadAlerts(moved)).toMatchObject({ ok: true, attempted: 1, accepted: 1 });
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[1].payload)).toBe(JSON.stringify(sent[0].payload));
    expect(sent[1].key).toBe(sent[0].key);
    expect(JSON.stringify(sent[1].payload)).not.toContain("moved.lead-alert.test");
    expect(await alertRow(r.alert_id!)).toMatchObject({ status: "accepted", frozen_message: null, frozen_recipient_sha256: null });
  });

  it("a recipient changed mid-generation is not sent: recipient_changed, final, and the operator's Retry renders afresh", async () => {
    const r = await recordDemo();
    const sent: Sent[] = [];
    await delivery.deliverPlatformLeadAlert(r.alert_id!, { ...deps(OPS, sent), transport: throwingOnce(sent) });
    await makeDue(r.alert_id!);
    // HOLD is on the admin allowlist too: a legitimate configuration change.
    const summary = await delivery.sweepPlatformLeadAlerts(deps(HOLD, sent));
    expect(summary).toMatchObject({ attempted: 1, failed: 1 });
    expect(sent).toHaveLength(1);
    expect(await alertRow(r.alert_id!)).toMatchObject({
      status: "failed",
      last_error_code: "recipient_changed",
      frozen_message: null,
      frozen_recipient_sha256: null,
    });
    expect((await adminQuery("select public.requeue_platform_lead_alert($1) r", [r.alert_id])).rows[0].r).toBe("requeued");
    const c = await claim(r.alert_id);
    expect(c).toMatchObject({ idempotency_key: `lead-alert/${r.alert_id}/2`, frozen_message: null });
  });

  it("expiry and a final failure clear the frozen message", async () => {
    const r = await recordDemo();
    const c = await claim(r.alert_id);
    await freeze(r.alert_id!, c.claim_token);
    expect(await settle(r.alert_id!, c.claim_token, "fail", "provider_rejected")).toBe("failed");
    expect((await alertRow(r.alert_id!)).frozen_message).toBeNull();

    const r2 = await recordDemo();
    const c2 = await claim(r2.alert_id);
    await freeze(r2.alert_id!, c2.claim_token);
    await settle(r2.alert_id!, c2.claim_token, "retry", "provider_timeout");
    await adminQuery("update public.platform_lead_alerts set first_attempted_at = clock_timestamp() - interval '21 hours' where id = $1", [r2.alert_id]);
    expect(Number((await adminQuery("select public.expire_platform_lead_alerts() n")).rows[0].n)).toBeGreaterThanOrEqual(1);
    expect(await alertRow(r2.alert_id!)).toMatchObject({ status: "failed", last_error_code: "expired", frozen_message: null });
  });

  it("a frozen message cannot outlive its generation or exist without an attempt, even for a superuser", async () => {
    const r = await recordDemo();
    await expect(
      adminQuery("update public.platform_lead_alerts set frozen_message = $2, frozen_recipient_sha256 = $3 where id = $1", [r.alert_id, JSON.stringify(MESSAGE), DIGEST]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("the freeze is service_role only", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(
        asRole(role, (q) => q("select * from public.freeze_platform_lead_alert_message($1, $2, $3, $4)", [randomUUID(), randomUUID(), JSON.stringify(MESSAGE), DIGEST])),
      ).rejects.toMatchObject({ code: "42501" });
    }
  });
});

// Codex P2 4253669922: FAIR scheduling. The claim serves the earliest-DUE
// alert first, not the oldest-created, so a backlog cannot starve later alerts.
describe("fair claim order", () => {
  it("an older alert due LATER waits behind a newer alert due EARLIER", async () => {
    const older = await recordDemo();
    const newer = await recordDemo();
    await adminQuery("update public.platform_lead_alerts set next_attempt_at = clock_timestamp() - interval '1 minute' where id = $1", [older.alert_id]);
    await adminQuery("update public.platform_lead_alerts set next_attempt_at = clock_timestamp() - interval '30 minutes' where id = $1", [newer.alert_id]);
    expect((await claim(null)).alert_id).toBe(newer.alert_id);
    expect((await claim(null)).alert_id).toBe(older.alert_id);
  });
});
