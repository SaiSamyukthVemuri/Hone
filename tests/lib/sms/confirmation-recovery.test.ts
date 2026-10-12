import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CONFIRMATION_RECOVERY_ENV,
  RECOVERY_GRACE_MS,
  RECOVERY_MAX_AGE_MS,
  RECOVERY_MIN_LEAD_MS,
  isOwedConfirmation,
  recoverOwedConfirmations,
  type OwedConfirmationRow,
} from "@/lib/sms/confirmation-recovery";
import { STUDIO_ROUTING_ENV, type SendTimeRouteRead } from "@/lib/sms/send-time-route";

// ===========================================================================
// D5 (#824): an OWED confirmation, delivered once when the sender is ready.
// ===========================================================================
//
// The appointments table is in memory, and claim_sms_send / record_sms_result
// reproduce 0049's semantics (sent_at null, attempts < 3, a 5-minute lease,
// record clears the claim and stamps sent_at on success), so duplicate
// prevention is exercised rather than assumed. Synthetic only.

vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: () => Promise.resolve() }));

const NOW = Date.parse("2026-10-12T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const A = "studio-a";
const P = "studio-platform";
const MSID_A = `MG${"a".repeat(32)}`;
const SID = `SM${"0f".repeat(16)}`;
const SNAPSHOT_RPC = "get_live_studio_sms_sender_registration_state";

type Appt = {
  id: string;
  studio_id: string;
  status: string;
  starts_at: string;
  created_at: string;
  sms_confirmation_sent_at: string | null;
  sms_confirmation_send_attempts: number;
  sms_confirmation_claimed_at: string | null;
  client_phone: string | null;
  client_opted_out_at: string | null;
};

let db: Appt[];
let events: string[];
let providerBodies: URLSearchParams[];
let snapshot: { data: unknown; error: unknown };
let fromCalls: number;
/** Called after the select and before the claim: a concurrent change. */
let beforeClaim: ((id: string) => void) | null;
let afterClaimRead: ((row: Appt) => void) | null;

const studioRow = (id: string) => ({
  id,
  name: "Studio",
  timezone: "America/Toronto",
  send_confirmation_sms: true,
  send_24h_sms_reminders: true,
  send_2h_sms_reminders: true,
});

const iso = (ms: number) => new Date(ms).toISOString();

function appt(over: Partial<Appt> = {}): Appt {
  return {
    id: "appt-1",
    studio_id: A,
    status: "confirmed",
    starts_at: iso(NOW + 48 * HOUR),
    created_at: iso(NOW - HOUR),
    sms_confirmation_sent_at: null,
    sms_confirmation_send_attempts: 0,
    sms_confirmation_claimed_at: null,
    client_phone: "+16475550123",
    client_opted_out_at: null,
    ...over,
  };
}

type Filter = (r: Appt) => boolean;

function admin(): SupabaseClient {
  return {
    from(table: string) {
      expect(table).toBe("appointments");
      fromCalls += 1;
      const filters: Filter[] = [];
      let columns = "";
      let order: { col: keyof Appt; asc: boolean } | null = null;
      const q = {
        select(c: string) {
          columns = c;
          return q;
        },
        in(col: keyof Appt, vals: unknown[]) {
          filters.push((r) => vals.includes(r[col]));
          return q;
        },
        eq(col: keyof Appt, v: unknown) {
          filters.push((r) => r[col] === v);
          return q;
        },
        is(col: keyof Appt, v: unknown) {
          filters.push((r) => r[col] === v);
          return q;
        },
        gte(col: keyof Appt, v: string) {
          filters.push((r) => Date.parse(String(r[col])) >= Date.parse(v));
          return q;
        },
        lte(col: keyof Appt, v: string) {
          filters.push((r) => Date.parse(String(r[col])) <= Date.parse(v));
          return q;
        },
        gt(col: keyof Appt, v: string) {
          filters.push((r) => Date.parse(String(r[col])) > Date.parse(v));
          return q;
        },
        order(col: keyof Appt, o: { ascending: boolean }) {
          order = { col, asc: o.ascending };
          return q;
        },
        limit(n: number) {
          events.push("select_owed");
          let rows = db.filter((r) => filters.every((f) => f(r)));
          if (order) {
            const { col, asc } = order;
            rows = [...rows].sort((x, y) => (String(x[col]) < String(y[col]) ? -1 : 1) * (asc ? 1 : -1));
          }
          expect(columns).toContain("client:clients(");
          const data = rows.slice(0, n).map((r) => ({
            ...r,
            studio: studioRow(r.studio_id),
            client: { phone: r.client_phone, sms_consent_at: "2026-10-01T00:00:00Z", sms_opted_out_at: r.client_opted_out_at },
          }));
          return Promise.resolve({ data, error: null });
        },
        maybeSingle() {
          events.push("revalidate");
          const row = db.find((r) => filters.every((f) => f(r)));
          if (row && afterClaimRead) afterClaimRead(row);
          return Promise.resolve({ data: row ? { status: row.status, starts_at: row.starts_at } : null, error: null });
        },
      };
      return q;
    },
    rpc(fn: string, args: Record<string, unknown> = {}) {
      events.push(fn);
      if (fn === SNAPSHOT_RPC) return Promise.resolve(snapshot);
      const row = db.find((r) => r.id === args.p_appointment_id);
      if (fn === "claim_sms_send") {
        if (beforeClaim) beforeClaim(String(args.p_appointment_id));
        const stale = (c: string | null) => c === null || Date.parse(c) < NOW - 5 * 60 * 1000;
        if (row && row.sms_confirmation_sent_at === null && row.sms_confirmation_send_attempts < 3 && stale(row.sms_confirmation_claimed_at)) {
          row.sms_confirmation_send_attempts += 1;
          row.sms_confirmation_claimed_at = iso(NOW);
          return Promise.resolve({ data: true, error: null });
        }
        return Promise.resolve({ data: false, error: null });
      }
      if (fn === "record_sms_result") {
        if (row) {
          row.sms_confirmation_claimed_at = null;
          if (args.p_success) row.sms_confirmation_sent_at = iso(NOW);
        }
        return Promise.resolve({ data: null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as SupabaseClient;
}

const readyStudioA = () => ({
  data: {
    senders: [{ id: "sender-a-1", studio_id: A, status: "active", phone_number: "+14165550100", messaging_service_sid: MSID_A }],
    registrations: [],
  },
  error: null,
});

const ENABLED = { [CONFIRMATION_RECOVERY_ENV]: "on", [STUDIO_ROUTING_ENV]: A };
const manageUrls: Array<[string, string]> = [];
const run = (env: Record<string, string> = ENABLED) =>
  recoverOwedConfirmations({
    admin: admin(),
    nowMs: NOW,
    env,
    manageUrlFor: (id, startsAt) => {
      manageUrls.push([id, startsAt.toISOString()]);
      return `https://app.example/manage/${id}`;
    },
  });

const ENV_KEYS = ["VERCEL_ENV", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", STUDIO_ROUTING_ENV] as const;
const saved: Partial<Record<string, string | undefined>> = {};
let providerStatus = 201;

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  delete process.env.VERCEL_ENV;
  process.env.TWILIO_ACCOUNT_SID = `AC${"1".repeat(32)}`;
  process.env.TWILIO_AUTH_TOKEN = "token";
  process.env.TWILIO_FROM_NUMBER = "+15550001111";
  // The send path reads the routing list from process.env; mirror ENABLED.
  process.env[STUDIO_ROUTING_ENV] = A;
  db = [];
  events = [];
  providerBodies = [];
  manageUrls.length = 0;
  fromCalls = 0;
  beforeClaim = null;
  afterClaimRead = null;
  providerStatus = 201;
  snapshot = readyStudioA();
  vi.stubGlobal(
    "fetch",
    vi.fn((_u: string, init: { body: string }) => {
      events.push("provider");
      providerBodies.push(new URLSearchParams(init.body));
      return Promise.resolve(
        providerStatus === 201
          ? new Response(JSON.stringify({ sid: SID, status: "queued" }), { status: 201 })
          : new Response("upstream", { status: providerStatus }),
      );
    }),
  );
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const providerCalls = () => events.filter((e) => e === "provider").length;

describe("activation: off unless BOTH switches are on", () => {
  it("SMS_CONFIRMATION_RECOVERY unset: reads nothing, claims nothing, sends nothing", async () => {
    db = [appt()];
    expect(await run({ [STUDIO_ROUTING_ENV]: A })).toEqual({ ran: false, reason: "disabled" });
    expect(fromCalls).toBe(0);
    expect(events).toEqual([]);
  });

  it("any value but exactly `on` is off", async () => {
    db = [appt()];
    for (const v of ["ON", "true", "1", " on"]) {
      expect(await run({ [CONFIRMATION_RECOVERY_ENV]: v, [STUDIO_ROUTING_ENV]: A })).toEqual({ ran: false, reason: "disabled" });
    }
    expect(events).toEqual([]);
  });

  it("enabled with no studio listed for routing: reads nothing (platform studios keep today's behaviour)", async () => {
    db = [appt({ studio_id: P })];
    expect(await run({ [CONFIRMATION_RECOVERY_ENV]: "on" })).toEqual({ ran: false, reason: "no_routed_studios" });
    expect(events).toEqual([]);
  });
});

describe("WHEN THE SENDER BECOMES READY: an owed confirmation is delivered exactly once", () => {
  it("not ready: refused before any claim and still owed; ready on a later run: sent once, from the studio's sender", async () => {
    db = [appt()];
    snapshot = { data: { senders: [], registrations: [] }, error: null }; // no active sender yet
    const r1 = await run();
    expect(r1).toEqual({ ran: true, considered: 1, sent: 0, failed: 0, skipped: { sms_route_no_active_sender: 1 } });
    expect(events).not.toContain("claim_sms_send");
    expect(db[0].sms_confirmation_send_attempts).toBe(0);

    events = [];
    snapshot = readyStudioA();
    const r2 = await run();
    expect(r2).toMatchObject({ ran: true, considered: 1, sent: 1, failed: 0 });
    expect(events.indexOf(SNAPSHOT_RPC)).toBeLessThan(events.indexOf("claim_sms_send"));
    expect(events.indexOf("claim_sms_send")).toBeLessThan(events.indexOf("revalidate"));
    expect(events.indexOf("revalidate")).toBeLessThan(events.indexOf("provider"));
    expect(providerBodies[0].get("MessagingServiceSid")).toBe(MSID_A);
    expect(providerBodies[0].has("From")).toBe(false);
    expect(db[0].sms_confirmation_sent_at).not.toBeNull();

    events = [];
    expect(await run()).toEqual({ ran: true, considered: 0, sent: 0, failed: 0, skipped: {} });
    expect(providerCalls()).toBe(0);
  });

  it("the message and its manage link use the start re-read after the claim", async () => {
    db = [appt()];
    const moved = iso(NOW + 72 * HOUR);
    afterClaimRead = (row) => {
      row.starts_at = moved; // moved in place between the select and the send
    };
    await run();
    expect(manageUrls).toEqual([["appt-1", moved]]);
  });

  it("two overlapping runs send it once", async () => {
    db = [appt()];
    const [r1, r2] = await Promise.all([run(), run()]);
    expect(providerCalls()).toBe(1);
    expect([r1, r2].map((r) => (r.ran ? r.sent : -1)).sort()).toEqual([0, 1]);
  });
});

describe("DUPLICATE PREVENTION and EXPIRY: what is never owed", () => {
  const notOwed: Array<[string, Partial<Appt>]> = [
    ["already sent", { sms_confirmation_sent_at: iso(NOW - HOUR) }],
    ["a provider attempt was made (failed or possibly sent)", { sms_confirmation_send_attempts: 1 }],
    ["a claim is in flight", { sms_confirmation_claimed_at: iso(NOW - 60_000) }],
    ["cancelled or rescheduled away", { status: "cancelled" }],
    ["booked more than 24h ago (expired)", { created_at: iso(NOW - RECOVERY_MAX_AGE_MS - 1) }],
    ["booked under 5 minutes ago (the booking's own send may be running)", { created_at: iso(NOW - RECOVERY_GRACE_MS + 1) }],
    ["starting inside the 2h-reminder horizon (expired)", { starts_at: iso(NOW + RECOVERY_MIN_LEAD_MS) }],
    ["a platform-routed studio", { studio_id: P }],
  ];
  for (const [why, over] of notOwed) {
    it(`${why}: never selected, never claimed, never sent`, async () => {
      db = [appt(over)];
      const r = await run();
      expect(r).toEqual({ ran: true, considered: 0, sent: 0, failed: 0, skipped: {} });
      expect(events).toEqual(["select_owed"]);
    });
  }

  it("the boundaries that ARE owed: just inside the age, grace and lead limits", async () => {
    db = [
      appt({ id: "x1", created_at: iso(NOW - RECOVERY_MAX_AGE_MS) }),
      appt({ id: "x2", created_at: iso(NOW - RECOVERY_GRACE_MS) }),
      appt({ id: "x3", starts_at: iso(NOW + RECOVERY_MIN_LEAD_MS + 1) }),
    ];
    expect(await run()).toMatchObject({ ran: true, considered: 3, sent: 3 });
  });

  it("isOwedConfirmation re-checks every rule on the row itself", () => {
    const row = (over: Partial<Appt>): OwedConfirmationRow => {
      const a = appt(over);
      return { ...a, studio: studioRow(a.studio_id), client: { phone: a.client_phone, sms_consent_at: null, sms_opted_out_at: null } };
    };
    expect(isOwedConfirmation(row({}), NOW, [A])).toBe(true);
    for (const [, over] of notOwed) expect(isOwedConfirmation(row(over), NOW, [A])).toBe(false);
    expect(isOwedConfirmation({ ...row({}), studio: studioRow("other") }, NOW, [A])).toBe(false);
    expect(isOwedConfirmation(row({ starts_at: "not a date" }), NOW, [A])).toBe(false);
  });
});

describe("every send-time gate applies again at recovery", () => {
  it("STOP received after booking: refused, nothing claimed, never sent", async () => {
    db = [appt({ client_opted_out_at: iso(NOW - 10 * 60_000) })];
    expect(await run()).toMatchObject({ sent: 0, skipped: { client_opted_out: 1 } });
    expect(events).toEqual(["select_owed"]);
  });

  it("stale registration on a toll-free sender: refused before the claim, still owed", async () => {
    db = [appt()];
    snapshot = {
      data: {
        senders: [{ id: "sender-a-2", studio_id: A, status: "active", phone_number: "+18885550100", messaging_service_sid: MSID_A }],
        registrations: [],
      },
      error: null,
    };
    expect(await run()).toMatchObject({ sent: 0, skipped: { sms_route_destination_not_ready: 1 } });
    expect(events).not.toContain("claim_sms_send");
    expect(db[0].sms_confirmation_send_attempts).toBe(0);
  });

  it("an unreadable snapshot: refused before the claim, still owed", async () => {
    db = [appt()];
    snapshot = { data: null, error: { code: "PGRST202" } };
    expect(await run()).toMatchObject({ sent: 0, skipped: { sms_route_sender_read_failed: 1 } });
    expect(events).not.toContain("claim_sms_send");
  });
});

describe("races after the selection", () => {
  it("cancelled after the claim: no provider call, the claim released, and never recovered again", async () => {
    db = [appt()];
    afterClaimRead = (row) => {
      row.status = "cancelled";
    };
    expect(await run()).toMatchObject({ sent: 0, skipped: { recovery_not_confirmed: 1 } });
    expect(providerCalls()).toBe(0);
    expect(db[0].sms_confirmation_claimed_at).toBeNull();
    expect(db[0].sms_confirmation_sent_at).toBeNull();
    afterClaimRead = null;
    db[0].status = "confirmed";
    events = [];
    expect(await run()).toMatchObject({ considered: 0 });
  });

  it("moved inside the horizon after the claim: too late, no provider call", async () => {
    db = [appt()];
    afterClaimRead = (row) => {
      row.starts_at = iso(NOW + HOUR);
    };
    expect(await run()).toMatchObject({ sent: 0, skipped: { recovery_too_late: 1 } });
    expect(providerCalls()).toBe(0);
  });

  it("the booking request's own send took the claim first: not_claimed, no second message", async () => {
    db = [appt()];
    beforeClaim = (id) => {
      const row = db.find((r) => r.id === id)!;
      row.sms_confirmation_send_attempts = 1;
      row.sms_confirmation_claimed_at = iso(NOW);
    };
    expect(await run()).toMatchObject({ sent: 0, skipped: { not_claimed: 1 } });
    expect(providerCalls()).toBe(0);
  });

  it("a possibly-sent attempt (provider 5xx) is recorded as sent and never recovered again", async () => {
    db = [appt()];
    providerStatus = 503;
    const r = await run();
    expect(r).toMatchObject({ ran: true, sent: 0 });
    expect(db[0].sms_confirmation_send_attempts).toBe(1);
    providerStatus = 201;
    events = [];
    expect(await run()).toMatchObject({ considered: 0 });
    expect(providerCalls()).toBe(0);
  });
});

describe("the database read failing", () => {
  it("is a run that did nothing, never a throw", async () => {
    db = [appt()];
    const broken = {
      from: () => {
        throw new Error("down");
      },
    } as unknown as SupabaseClient;
    expect(
      await recoverOwedConfirmations({ admin: broken, nowMs: NOW, env: ENABLED, manageUrlFor: () => null }),
    ).toEqual({ ran: false, reason: "read_failed" });
  });
});

// Type-only guard: the snapshot answer shape the reader consumes.
const _shape: SendTimeRouteRead = { ok: false };
void _shape;
