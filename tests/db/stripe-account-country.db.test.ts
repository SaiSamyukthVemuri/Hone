import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, adminTx, closePool, seedStudio, type SeededStudio } from "./helpers/harness";
import { E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL } from "@/e2e/helpers/local-env";

// ===========================================================================
// PAY-CCY-03 (#824): Stripe accounts follow the studio's verified country
// ===========================================================================
//
// The REAL lib/stripe/account.ts and the REAL webhook route run against the
// local database (REST + the 0103 / 0214 RPCs). Only Stripe is fake: an
// in-memory Connect API that records every call and answers with whatever
// country the scenario says Stripe would report. Nothing here reaches Stripe.
//
// Proves:
//   K1  a CA studio's account is created in CA, a US studio's in US — the
//       country comes from studio_payment_jurisdictions, not the environment;
//   K2  the country Stripe reports is recorded on create, refresh and
//       account.updated;
//   K3  a mismatch blocks onboarding (no link) and charging (the 0214 guard),
//       raises a critical alert, and NEVER replaces the account — a retry
//       makes no second accounts.create;
//   K4  a recorded country is never overwritten by a later, different report.

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

const fake = vi.hoisted(() => ({
  /** The country Stripe will REPORT for the next created account; null = as requested. */
  reportCountry: null as string | null,
  /** What accounts.retrieve / account.updated report, by account id. */
  accounts: new Map<string, { country: string; default_currency: string }>(),
  creates: [] as Array<{ country: string; idempotencyKey?: string }>,
  links: [] as string[],
  alerts: [] as Array<{ severity: string; event: string; details: Record<string, unknown> }>,
  nextEvent: null as unknown,
  /** Runs once, after the next jurisdiction read returns (see the mock below). */
  afterJurisdictionRead: null as null | ((studioId: string) => Promise<void>),
}));

function account(id: string) {
  const a = fake.accounts.get(id)!;
  return {
    id,
    object: "account",
    country: a.country,
    default_currency: a.default_currency,
    charges_enabled: true,
    payouts_enabled: true,
    requirements: { currently_due: [], eventually_due: [], disabled_reason: null },
  };
}

vi.mock("@/lib/stripe/server", () => ({
  inferStripeLivemode: () => false,
  getStripe: () => ({
    accounts: {
      create: async (params: { country: string }, opts?: { idempotencyKey?: string }) => {
        fake.creates.push({ country: params.country, idempotencyKey: opts?.idempotencyKey });
        const id = `acct_test_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
        const country = fake.reportCountry ?? params.country;
        fake.accounts.set(id, {
          country,
          default_currency: country === "US" ? "usd" : "cad",
        });
        return account(id);
      },
      retrieve: async (id: string) => account(id),
      createLoginLink: async () => ({ url: "https://example.invalid/login" }),
    },
    accountLinks: {
      create: async (p: { account: string }) => {
        fake.links.push(p.account);
        return { url: "https://example.invalid/onboard" };
      },
    },
    webhooks: { constructEvent: () => fake.nextEvent },
  }),
  getAppOrigin: () => "http://localhost",
}));
vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: async (a: { severity: string; event: string; safeDetails?: Record<string, unknown> }) => {
    fake.alerts.push({ severity: a.severity, event: a.event, details: a.safeDetails ?? {} });
  },
}));
vi.mock("@/lib/ops/alert-email", () => ({
  notifyCriticalOpsAlert: async (a: { event: string }) => {
    fake.alerts.push({ severity: "critical", event: a.event, details: {} });
  },
}));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: () => undefined }));
// The REAL jurisdiction read, plus an optional hook run AFTER it returns, so a
// test can commit an operator change between onboarding's read and its claim
// (Codex P1 4244982189).
vi.mock("@/lib/billing/payment-jurisdiction-server", async (importActual) => {
  const real = await importActual<typeof import("@/lib/billing/payment-jurisdiction-server")>();
  return {
    ...real,
    getStudioPaymentJurisdiction: async (studioId: string) => {
      const read = await real.getStudioPaymentJurisdiction(studioId);
      const hook = fake.afterJurisdictionRead;
      fake.afterJurisdictionRead = null;
      if (hook) await hook(studioId);
      return read;
    },
  };
});

const saved = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  secret: process.env.STRIPE_WEBHOOK_SECRET,
};
beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_fake";
});

const created: SeededStudio[] = [];
afterAll(async () => {
  for (const s of created) {
    for (const sql of [
      `delete from public.ops_alerts where studio_id=$1`,
      `delete from public.payment_charge_attempts where studio_id=$1`,
      `delete from public.stripe_events where studio_id=$1`,
      `delete from public.studio_payment_settings where studio_id=$1`,
      `delete from public.stripe_account_provisioning_attempts where studio_id=$1`,
      `delete from public.appointments where studio_id=$1`,
      `delete from public.studios where id=$1`,
    ]) {
      await adminQuery(sql, [s.studioId]).catch(() => undefined);
    }
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
  process.env.STRIPE_WEBHOOK_SECRET = saved.secret;
  await closePool();
});

beforeEach(() => {
  fake.reportCountry = null;
  fake.afterJurisdictionRead = null;
  fake.creates = [];
  fake.links = [];
  fake.alerts = [];
  fake.nextEvent = null;
});

async function studio(label: string, country: "CA" | "US" = "CA") {
  const s = await seedStudio(`acctc-${label}`);
  created.push(s);
  if (country === "US") {
    const r = await adminQuery(
      `select out_result from public.set_studio_payment_jurisdiction($1,'US','usd','operator:test','verified US business and charge currency',false,'fixture:verified-usd-account')`,
      [s.studioId],
    );
    expect(r.rows[0].out_result).toBe("changed");
  }
  return s;
}

async function bound(studioId: string) {
  const r = await adminQuery(
    `select stripe_account_id, stripe_account_country, stripe_account_default_currency
       from public.studio_payment_settings where studio_id=$1 and stripe_livemode=false`,
    [studioId],
  );
  return r.rows[0] as
    | {
        stripe_account_id: string;
        stripe_account_country: string | null;
        stripe_account_default_currency: string | null;
      }
    | undefined;
}

/** Attempt an insert the way the prepare action would; returns the refusal text or "ok". */
let slot = 0;
async function tryPrepare(s: SeededStudio, currency: string, accountId: string) {
  // Each attempt gets its own past hour: one practitioner, no overlapping bookings.
  slot += 1;
  const appt = await adminQuery(
    `insert into public.appointments
       (studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status)
     values ($1,$2,$3, now() - make_interval(hours => $4 * 2 + 1),
             now() - make_interval(hours => $4 * 2), 60, 'completed')
     returning id`,
    [s.studioId, s.practitionerId, s.clientId, slot],
  );
  try {
    await adminQuery(
      `insert into public.payment_charge_attempts
         (studio_id, charge_reason, client_id, appointment_id, created_by_practitioner_id,
          amount_cents, currency, status, stripe_livemode, stripe_account_id)
       values ($1,'no_show_fee',$2,$3,$4,5000,$5,'ready',false,$6)`,
      [s.studioId, s.clientId, appt.rows[0].id, s.practitionerId, currency, accountId],
    );
    return "ok";
  } catch (e) {
    return (e as Error).message;
  }
}

const mismatchAlerts = () =>
  fake.alerts.filter((a) => a.severity === "critical" && a.event === "stripe_account_country_mismatch");

async function account_ts() {
  return import("@/lib/stripe/account");
}

// ---------------------------------------------------------------------------
describe("K1 + K2 the account is created in the studio's country, and recorded", () => {
  it("CA studio: accounts.create asks for CA; CA is recorded; cad charging is open", async () => {
    const { createOrLoadConnectedAccountForStudio } = await account_ts();
    const s = await studio("ca");
    const out = await createOrLoadConnectedAccountForStudio(s.studioId);
    expect(fake.creates.map((c) => c.country)).toEqual(["CA"]);
    expect(await bound(s.studioId)).toEqual({
      stripe_account_id: out.stripeAccountId,
      stripe_account_country: "CA",
      stripe_account_default_currency: "cad",
    });
    expect(await tryPrepare(s, "cad", out.stripeAccountId)).toBe("ok");
    expect(mismatchAlerts()).toEqual([]);
  });

  it("US studio: accounts.create asks for US; US is recorded; usd charging is open", async () => {
    const { createOrLoadConnectedAccountForStudio } = await account_ts();
    const s = await studio("us", "US");
    const out = await createOrLoadConnectedAccountForStudio(s.studioId);
    expect(fake.creates.map((c) => c.country)).toEqual(["US"]);
    expect((await bound(s.studioId))?.stripe_account_country).toBe("US");
    expect(await tryPrepare(s, "usd", out.stripeAccountId)).toBe("ok");
    // Currency is the studio's, not something inferred from the account:
    expect(await tryPrepare(s, "cad", out.stripeAccountId)).toMatch(/payment_currency_mismatch/);
  });

  it("the environment variable no longer chooses the country", async () => {
    const { createOrLoadConnectedAccountForStudio } = await account_ts();
    const previous = process.env.STRIPE_CONNECT_COUNTRY;
    process.env.STRIPE_CONNECT_COUNTRY = "CA";
    try {
      const s = await studio("env", "US");
      await createOrLoadConnectedAccountForStudio(s.studioId);
      expect(fake.creates.map((c) => c.country)).toEqual(["US"]);
    } finally {
      process.env.STRIPE_CONNECT_COUNTRY = previous;
    }
  });

  // Codex P1 4244982189. The read happens before the claim; a change that
  // commits in between must not create the account for the stale country.
  it("an operator change committed between the read and the claim: the account is created in the NEW country", async () => {
    const { createOrLoadConnectedAccountForStudio } = await account_ts();
    const s = await studio("race");
    fake.afterJurisdictionRead = async (studioId) => {
      const r = await adminQuery(
        `select out_result from public.set_studio_payment_jurisdiction($1,'US','usd','operator:test','race',false,'fixture:verified-usd-race')`,
        [studioId],
      );
      expect(r.rows[0].out_result).toBe("changed");
    };
    const out = await createOrLoadConnectedAccountForStudio(s.studioId);
    expect(fake.afterJurisdictionRead).toBeNull(); // the hook really ran
    expect(fake.creates.map((c) => c.country)).toEqual(["US"]);
    expect((await bound(s.studioId))?.stripe_account_country).toBe("US");
    expect(await tryPrepare(s, "usd", out.stripeAccountId)).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
describe("K3 a mismatch blocks onboarding and charging, and never replaces the account", () => {
  it("Stripe creates the account in the wrong country: refused, bound, not replaced", async () => {
    const { createOrLoadConnectedAccountForStudio, ACCOUNT_COUNTRY_MISMATCH_ERROR } =
      await account_ts();
    const s = await studio("wrong-on-create", "US");
    fake.reportCountry = "CA";

    await expect(createOrLoadConnectedAccountForStudio(s.studioId)).rejects.toThrow(
      ACCOUNT_COUNTRY_MISMATCH_ERROR,
    );
    const first = await bound(s.studioId);
    expect(first).toMatchObject({ stripe_account_country: "CA" });
    expect(mismatchAlerts()).toHaveLength(1);

    // A retry by the owner is refused before any Stripe call: no second
    // account, no onboarding link, the same account still bound.
    fake.reportCountry = null;
    await expect(createOrLoadConnectedAccountForStudio(s.studioId)).rejects.toThrow(
      ACCOUNT_COUNTRY_MISMATCH_ERROR,
    );
    expect(fake.creates).toHaveLength(1);
    expect(fake.links).toEqual([]);
    expect((await bound(s.studioId))?.stripe_account_id).toBe(first!.stripe_account_id);

    // Charging is blocked at the database for the studio's own currency.
    expect(await tryPrepare(s, "usd", first!.stripe_account_id)).toMatch(
      /payment_account_country_mismatch/,
    );
  });

  it("the owner's onboarding action surfaces the mismatch verbatim and mints no link", async () => {
    const { ACCOUNT_COUNTRY_MISMATCH_ERROR } = await account_ts();
    const s = await studio("action", "US");
    fake.reportCountry = "CA";
    vi.doMock("@/lib/supabase/queries", () => ({
      getCurrentPractitionerWithStudio: async () => ({
        practitioner: { id: s.practitionerId, role: "owner" },
        studio: { id: s.studioId },
      }),
    }));
    vi.resetModules();
    const { startStripeConnectOnboardingAction } = await import(
      "@/app/(app)/settings/payments/actions"
    );
    await expect(startStripeConnectOnboardingAction()).rejects.toThrow(
      ACCOUNT_COUNTRY_MISMATCH_ERROR,
    );
    expect(fake.links).toEqual([]);
    vi.doUnmock("@/lib/supabase/queries");
    vi.resetModules();
  });
});

// ---------------------------------------------------------------------------
describe("K2 + K4 refresh and account.updated record the country", () => {
  async function legacyBound(s: SeededStudio, country: string) {
    const id = `acct_test_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await adminQuery(
      `insert into public.studio_payment_settings
         (studio_id, stripe_account_id, stripe_account_status, stripe_charges_enabled,
          stripe_payouts_enabled, stripe_livemode)
       values ($1,$2,'enabled',true,true,false)`,
      [s.studioId, id],
    );
    fake.accounts.set(id, { country, default_currency: country === "US" ? "usd" : "cad" });
    return id;
  }

  it("refresh records a legacy CA account's country (Canadian regression)", async () => {
    const { refreshAccountStatusFromStripe } = await account_ts();
    const s = await studio("refresh-ca");
    const id = await legacyBound(s, "CA");
    expect((await bound(s.studioId))?.stripe_account_country).toBeNull();
    // Unobserved legacy CA account: still chargeable before the refresh.
    expect(await tryPrepare(s, "cad", id)).toBe("ok");
    const snapshot = await refreshAccountStatusFromStripe({ studioId: s.studioId, stripeAccountId: id });
    expect(snapshot.status).toBe("enabled");
    expect((await bound(s.studioId))?.stripe_account_country).toBe("CA");
    expect(mismatchAlerts()).toEqual([]);
  });

  // Codex P1 4244834151: the conflict is persisted, so charging and
  // onboarding stop although the recorded country still matches the studio.
  it("refresh that finds a different country: status synced, conflict persisted, charging and onboarding stopped", async () => {
    const {
      refreshAccountStatusFromStripe,
      createOrLoadConnectedAccountForStudio,
      ACCOUNT_COUNTRY_MISMATCH_ERROR,
    } = await account_ts();
    const s = await studio("refresh-conflict");
    const id = await legacyBound(s, "CA");
    await refreshAccountStatusFromStripe({ studioId: s.studioId, stripeAccountId: id });
    fake.accounts.set(id, { country: "US", default_currency: "usd" });
    await expect(
      refreshAccountStatusFromStripe({ studioId: s.studioId, stripeAccountId: id }),
    ).rejects.toThrow(ACCOUNT_COUNTRY_MISMATCH_ERROR);
    expect((await bound(s.studioId))?.stripe_account_country).toBe("CA");
    expect(mismatchAlerts()).toHaveLength(1);
    const incident = await adminQuery(
      `select safe_details from public.ops_alerts where studio_id=$1
       and event='stripe_account_country_mismatch' and resolved_at is null`, [s.studioId],
    );
    expect(incident.rows).toHaveLength(1);
    expect(incident.rows[0].safe_details).toMatchObject({ reason: "country_conflict" });
    expect(
      (
        await adminQuery(
          `select stripe_account_country_conflict from public.studio_payment_settings
            where studio_id = $1 and stripe_account_id = $2`,
          [s.studioId, id],
        )
      ).rows[0].stripe_account_country_conflict,
    ).toBe("US");
    expect(await tryPrepare(s, "cad", id)).toMatch(/payment_account_country_conflict/);
    await expect(createOrLoadConnectedAccountForStudio(s.studioId)).rejects.toThrow(
      ACCOUNT_COUNTRY_MISMATCH_ERROR,
    );

    // Stripe agreeing again does not reopen it.
    fake.accounts.set(id, { country: "CA", default_currency: "cad" });
    await expect(
      refreshAccountStatusFromStripe({ studioId: s.studioId, stripeAccountId: id }),
    ).rejects.toThrow(ACCOUNT_COUNTRY_MISMATCH_ERROR);
    expect(await tryPrepare(s, "cad", id)).toMatch(/payment_account_country_conflict/);
  });

  it("account.updated records the country; a mismatch alerts and blocks charging", async () => {
    const s = await studio("webhook", "US");
    const id = await legacyBound(s, "CA");
    // Unobserved account on a US studio: already refused before the event.
    expect(await tryPrepare(s, "usd", id)).toMatch(/payment_account_country_unverified/);

    fake.nextEvent = {
      id: `evt_test_${randomUUID().slice(0, 12)}`,
      type: "account.updated",
      account: id,
      livemode: false,
      data: { object: account(id) },
    };
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(
      new Request("http://localhost/api/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=fake" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
    expect((await bound(s.studioId))?.stripe_account_country).toBe("CA");
    expect(mismatchAlerts()).toHaveLength(1);
    expect(await tryPrepare(s, "usd", id)).toMatch(/payment_account_country_mismatch/);
    const ev = await adminQuery(
      `select payload_summary->>'accountCountryObservation' as obs from public.stripe_events
        where stripe_event_id=$1`,
      [(fake.nextEvent as { id: string }).id],
    );
    expect(ev.rows[0]?.obs).toBe("mismatch");
  });

  it("account.updated on a matching account records it without an alert", async () => {
    const s = await studio("webhook-ok", "US");
    const id = await legacyBound(s, "US");
    fake.nextEvent = {
      id: `evt_test_${randomUUID().slice(0, 12)}`,
      type: "account.updated",
      account: id,
      livemode: false,
      data: { object: account(id) },
    };
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(
      new Request("http://localhost/api/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=fake" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
    expect((await bound(s.studioId))?.stripe_account_country).toBe("US");
    expect(mismatchAlerts()).toEqual([]);
    expect(await tryPrepare(s, "usd", id)).toBe("ok");
  });
});


// 0238 source prepared here; execute only on an OPS-approved target/slot.
describe("0238 durable account-country incident serialization", () => {
  async function mismatch() {
    const s = await studio("incident");
    const id = `acct_test_${randomUUID().replace(/-/g, "")}`;
    await adminQuery(`insert into public.studio_payment_settings
      (studio_id,stripe_account_id,stripe_account_status,stripe_livemode,stripe_account_country)
      values ($1,$2,'enabled',false,'US')`, [s.studioId, id]);
    fake.accounts.set(id, { country: "US", default_currency: "usd" });
    return { s, id };
  }
  async function claim(studioId: string, id: string, mode = false) {
    const r = await adminQuery(`select * from public.claim_stripe_account_country_alert($1,$2,$3)`,
      [studioId, id, mode]);
    return r.rows[0] as { out_result: string; out_alert_id: string; out_reason: string };
  }
  async function incidents(studioId: string) {
    return (await adminQuery(`select id,safe_details from public.ops_alerts where studio_id=$1
      and event='stripe_account_country_mismatch' and resolved_at is null`, [studioId])).rows;
  }
  it("concurrent RPCs yield one created winner, one durable row and a shared id", async () => {
    const { s, id } = await mismatch();
    const results = await Promise.all(Array.from({ length: 4 }, () => claim(s.studioId, id)));
    expect(results.filter((r) => r.out_result === "created")).toHaveLength(1);
    expect(results.filter((r) => r.out_result === "existing")).toHaveLength(3);
    expect(new Set(results.map((r) => r.out_alert_id)).size).toBe(1);
    expect(await incidents(s.studioId)).toHaveLength(1);
  });
  it("real refresh callers create one row and notify once while all still refuse", async () => {
    const { s, id } = await mismatch();
    const { refreshAccountStatusFromStripe, ACCOUNT_COUNTRY_MISMATCH_ERROR } = await account_ts();
    const results = await Promise.allSettled(Array.from({ length: 3 }, () =>
      refreshAccountStatusFromStripe({ studioId: s.studioId, stripeAccountId: id })));
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason.message).toBe(ACCOUNT_COUNTRY_MISMATCH_ERROR);
    }
    expect(mismatchAlerts()).toHaveLength(1);
    expect(await incidents(s.studioId)).toHaveLength(1);
    expect(fake.creates).toHaveLength(0);
    expect(fake.links).toHaveLength(0);
  });
  it("derives conflict, reuses existing incidents, re-arms only after operator resolution", async () => {
    const { s, id } = await mismatch();
    expect((await claim(s.studioId, id)).out_reason).toBe("country_mismatch");
    await adminQuery(`update public.studio_payment_settings set stripe_account_country_conflict='CA',
      stripe_account_country_conflict_at=now() where studio_id=$1`, [s.studioId]);
    const conflict = await claim(s.studioId, id);
    expect(conflict.out_reason).toBe("country_conflict");
    expect(conflict.out_result).toBe("created");
    expect((await claim(s.studioId, id)).out_result).toBe("existing");
    await adminQuery(`update public.ops_alerts set resolved_at=now(),resolved_by_practitioner_id=$2
      where id=$1`, [conflict.out_alert_id, s.practitionerId]);
    const rearmed = await claim(s.studioId, id);
    expect(rearmed.out_result).toBe("created");
    expect(rearmed.out_alert_id).not.toBe(conflict.out_alert_id);
    expect((await bound(s.studioId))?.stripe_account_country).toBe("US");
  });
  it("reuses historical open alerts without cleanup or another durable insert", async () => {
    const { s, id } = await mismatch();
    const prior = await adminQuery(`insert into public.ops_alerts(severity,event,message,studio_id,safe_details)
      values ('critical','stripe_account_country_mismatch','existing safe incident',$1,
      jsonb_build_object('stripe_account_id',$2::text,'livemode',false,'reason','country_mismatch')) returning id`,
      [s.studioId, id]);
    expect(await claim(s.studioId, id)).toMatchObject({out_result:"existing",out_alert_id:prior.rows[0].id});
    expect(await incidents(s.studioId)).toHaveLength(1);
  });
  it("separates account/mode/studio, unverified and healthy persisted state", async () => {
    const { s, id } = await mismatch();
    const other = await studio("incident-other");
    expect((await claim(other.studioId, id)).out_result).toBe("not_bound");
    expect((await claim(s.studioId, "acct_other")).out_result).toBe("not_bound");
    expect((await claim(s.studioId, id, true)).out_result).toBe("not_bound");
    await adminQuery(`insert into public.studio_payment_settings
      (studio_id,stripe_account_id,stripe_account_status,stripe_livemode,stripe_account_country)
      values ($1,$2,'enabled',true,'US')`, [s.studioId, id + "_live"]);
    expect((await claim(s.studioId, id, false)).out_result).toBe("created");
    expect((await claim(s.studioId, id + "_live", true)).out_result).toBe("created");
    expect(await incidents(s.studioId)).toHaveLength(2);
    await adminQuery(`update public.studio_payment_settings set stripe_account_country=null
      where studio_id=$1 and stripe_livemode=false`, [s.studioId]);
    expect((await claim(s.studioId, id)).out_result).toBe("unverified");
    await adminQuery(`update public.studio_payment_settings set stripe_account_country='CA'
      where studio_id=$1 and stripe_livemode=false`, [s.studioId]);
    expect((await claim(s.studioId, id)).out_result).toBe("not_mismatched");
    expect(await incidents(other.studioId)).toHaveLength(0);
  });
  it("rolls back a created incident if its transaction fails; fixed snapshots refuse", async () => {
    const { s, id } = await mismatch();
    await expect(adminTx(async (q) => {
      const r = await q(`select * from public.claim_stripe_account_country_alert($1,$2,false)`, [s.studioId, id]);
      expect(r.rows[0].out_result).toBe("created");
      throw new Error("synthetic rollback");
    })).rejects.toThrow("synthetic rollback");
    expect(await incidents(s.studioId)).toHaveLength(0);
    await expect(adminTx(async (q) => {
      await q("set transaction isolation level repeatable read");
      await q(`select * from public.claim_stripe_account_country_alert($1,$2,false)`, [s.studioId, id]);
    })).rejects.toMatchObject({ code: "40001" });
    expect((await claim(s.studioId, id)).out_result).toBe("created");
  });
  it("rejects malformed/unverified identifiers without fabricating incidents", async () => {
    const r = await adminQuery(`select * from public.claim_stripe_account_country_alert(null,'',null)`);
    expect(r.rows[0].out_result).toBe("invalid_input");
    expect(r.rows[0].out_alert_id).toBeNull();
  });
  it("exposes no browser-role execute privilege", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      const r = await adminQuery(`select has_function_privilege($1,
        'public.claim_stripe_account_country_alert(uuid,text,boolean)','EXECUTE') as allowed`, [role]);
      expect(r.rows[0].allowed).toBe(role === "service_role");
    }
  });
});
