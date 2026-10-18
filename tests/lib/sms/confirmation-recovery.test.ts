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
import { sendBookingConfirmationSmsToClient } from "@/lib/sms/send-appointment";

// ===========================================================================
// D5 (#824): an OWED confirmation, delivered once when the sender is ready.
// ===========================================================================
//
// The appointments table is in memory, and claim_sms_send / record_sms_result
// reproduce 0049's semantics (sent_at null, attempts < 3, a 5-minute lease,
// record clears the claim and stamps sent_at on success), so duplicate
// prevention is exercised rather than assumed. Synthetic only.

vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: () => Promise.resolve() }));

const stamps: Array<[string, { emailed: boolean }]> = [];
vi.mock("@/lib/intake/queries", () => ({
  stampIntakeLinkIssued: (_admin: unknown, id: string, o: { emailed: boolean }) => {
    stamps.push([id, o]);
    return Promise.resolve();
  },
}));

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
  client_id: string;
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
type Snapshot = { data: unknown; error: unknown };
let snapshot: Snapshot | ((studioId: string) => Snapshot);
/** Whether a status/start re-read fails, by phase: before the claim, or while it is held. */
let failRead: ((phase: "pre" | "post") => boolean) | null;
let fromCalls: number;
/** Called after the select and before the claim: a concurrent change. */
let beforeClaim: ((id: string) => void) | null;
/** Called on a re-read made while the claim is held. */
let afterClaimRead: ((row: Appt) => void) | null;
/** Called on a re-read made BEFORE the claim. */
let preClaimRead: ((row: Appt) => void) | null;
/** A studio whose owed-rows page read fails. */
let failSelectFor: string | null;
/** Each studio's confirmation switch as it is NOW (default on). */
let switchOff: Set<string>;
type Intake = { id: string; studio_id: string; client_id: string; status: string; created_at: string };
let intakes: Intake[];
let intakeReadFails: boolean;

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
    client_id: "client-1",
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
      if (table === "client_intake_forms") {
        events.push("intake_read");
        const f: Array<(r: Intake) => boolean> = [];
        const iq = {
          select: () => iq,
          eq: (col: keyof Intake, v: unknown) => {
            f.push((r) => r[col] === v);
            return iq;
          },
          is: () => iq,
          order: () => iq,
          limit: () => iq,
          maybeSingle: () => {
            if (intakeReadFails) return Promise.resolve({ data: null, error: { code: "57014" } });
            const rows = intakes.filter((r) => f.every((x) => x(r))).sort((x, y) => (x.created_at < y.created_at ? 1 : -1));
            return Promise.resolve({ data: rows[0] ? { id: rows[0].id, status: rows[0].status } : null, error: null });
          },
        };
        return iq;
      }
      expect(table).toBe("appointments");
      fromCalls += 1;
      const filters: Filter[] = [];
      let columns = "";
      const order: Array<{ col: keyof Appt; asc: boolean }> = [];
      let studioFilter: unknown = null;
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
          if (col === "studio_id") studioFilter = v;
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
          order.push({ col, asc: o.ascending });
          return q;
        },
        or(expr: string) {
          // Exactly the keyset form the recovery pass builds.
          const m = /^created_at\.(gt|lt)\."([^"]+)",and\(created_at\.eq\."([^"]+)",id\.(gt|lt)\."([^"]+)"\)$/.exec(expr);
          expect(m, `unexpected or(): ${expr}`).not.toBeNull();
          const [, op, at, eqAt, idOp, id] = m!;
          expect(eqAt).toBe(at);
          expect(idOp).toBe(op);
          const sign = op === "gt" ? 1 : -1;
          filters.push((r) => {
            const t = Date.parse(r.created_at);
            const a = Date.parse(at);
            return sign * (t - a) > 0 || (t === a && sign * (r.id < id ? -1 : r.id > id ? 1 : 0) > 0);
          });
          return q;
        },
        limit(n: number) {
          events.push("select_owed");
          if (failSelectFor !== null && studioFilter === failSelectFor) {
            return Promise.resolve({ data: null, error: { code: "57014" } });
          }
          let rows = db.filter((r) => filters.every((f) => f(r)));
          // Ties beyond the requested order come back in REVERSE insertion
          // order: a database promises nothing about them, so neither may we.
          rows = [...rows].reverse().sort((x, y) => {
            for (const { col, asc } of order) {
              const a = String(x[col]);
              const b = String(y[col]);
              if (a !== b) return (a < b ? -1 : 1) * (asc ? 1 : -1);
            }
            return 0;
          });
          expect(columns).toContain("client:clients(");
          const data = rows.slice(0, n).map((r) => ({
            ...r,
            studio: studioRow(r.studio_id),
            client: { phone: r.client_phone, sms_consent_at: "2026-10-01T00:00:00Z", sms_opted_out_at: r.client_opted_out_at },
          }));
          return Promise.resolve({ data, error: null });
        },
        maybeSingle() {
          const row = db.find((r) => filters.every((f) => f(r)));
          const phase = row && row.sms_confirmation_claimed_at !== null ? "post" : "pre";
          events.push(`revalidate_${phase}`);
          if (failRead?.(phase)) return Promise.resolve({ data: null, error: { code: "57014" } });
          if (row && phase === "post" && afterClaimRead) afterClaimRead(row);
          if (row && phase === "pre" && preClaimRead) preClaimRead(row);
          return Promise.resolve({
            data: row
              ? {
                  status: row.status,
                  starts_at: row.starts_at,
                  created_at: row.created_at,
                  sms_confirmation_send_attempts: row.sms_confirmation_send_attempts,
                  studio: { send_confirmation_sms: !switchOff.has(row.studio_id) },
                  // The client as it is NOW, not as the page saw it.
                  client: { phone: row.client_phone, sms_consent_at: "2026-10-01T00:00:00Z", sms_opted_out_at: row.client_opted_out_at },
                }
              : null,
            error: null,
          });
        },
      };
      return q;
    },
    rpc(fn: string, args: Record<string, unknown> = {}) {
      events.push(fn);
      if (fn === SNAPSHOT_RPC) {
        return Promise.resolve(typeof snapshot === "function" ? snapshot(String(args.p_studio_id)) : snapshot);
      }
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

// READINESS (#841 fe89a006): long codes are never an A2P route to Canadian
// recipients. A READY sender is a toll-free number whose own complete
// verification is approved (Active for Canadian and US recipients).
const READY_NUMBER = "+18885550100";
const approval = (studioId: string, senderId: string, phone: string, kind: string) => ({
  sender_id: senderId,
  studio_id: studioId,
  phone_number: phone,
  kind,
  status: "approved",
  missing_information: null,
  provider_reference: "ref",
  updated_at: "2026-10-01T00:00:00Z",
});
const readySnap = (studioId: string, senderId: string) => ({
  data: {
    senders: [{ id: senderId, studio_id: studioId, status: "active", phone_number: READY_NUMBER, messaging_service_sid: MSID_A }],
    registrations: [approval(studioId, senderId, READY_NUMBER, "toll_free_verification")],
  },
  error: null,
});
const readyStudioA = () => readySnap(A, "sender-a-1");

const ENABLED = { [CONFIRMATION_RECOVERY_ENV]: "on", [STUDIO_ROUTING_ENV]: A };
const manageUrls: Array<[string, string]> = [];
let manageLinkFails = false;
let clock: (() => number) | undefined;
const run = (env: Record<string, string> = ENABLED, pageSize?: number) =>
  recoverOwedConfirmations({
    admin: admin(),
    nowMs: NOW,
    env,
    pageSize,
    clock: clock ?? (() => NOW),
    intakeUrlFor: (intakeId) => `https://app.example/intake/${intakeId}`,
    manageUrlFor: (id, startsAt) => {
      manageUrls.push([id, startsAt.toISOString()]);
      return manageLinkFails ? null : `https://app.example/manage/${id}`;
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
  preClaimRead = null;
  failRead = null;
  failSelectFor = null;
  clock = undefined;
  switchOff = new Set();
  manageLinkFails = false;
  intakes = [];
  intakeReadFails = false;
  stamps.length = 0;
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
    // Pre-claim revalidation, THEN the route, immediately before the claim
    // (Codex P1 4254248449).
    expect(events.lastIndexOf("revalidate_pre")).toBeLessThan(events.lastIndexOf(SNAPSHOT_RPC));
    expect(events.lastIndexOf(SNAPSHOT_RPC)).toBeLessThan(events.indexOf("claim_sms_send"));
    expect(events.indexOf("claim_sms_send")).toBeLessThan(events.indexOf("revalidate_post"));
    expect(events.indexOf("revalidate_post")).toBeLessThan(events.indexOf("provider"));
    expect(providerBodies[0].get("MessagingServiceSid")).toBe(MSID_A);
    expect(providerBodies[0].get("From")).toBe(READY_NUMBER);
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
    // Checked before the claim (start as then) and built after it (the move).
    expect(manageUrls.at(-1)).toEqual(["appt-1", moved]);
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

  // Codex P2 4305212716: two runs select the same zero-attempt row. The first
  // makes an ambiguous attempt and clears its claim; claim_sms_send would let
  // the second claim the now-one-attempt row. The post-claim re-read sees two
  // attempts and refuses before the provider: no duplicate.
  it("a second run that claims a row ANOTHER run already attempted: refused after the claim, no provider call", async () => {
    db = [appt()];
    beforeClaim = (id) => {
      const row = db.find((x) => x.id === id)!;
      // The other run's ambiguous attempt landed between our selection and claim.
      row.sms_confirmation_send_attempts = 1;
      row.sms_confirmation_claimed_at = null;
    };
    const r = await run();
    expect(r).toMatchObject({ sent: 0, skipped: { recovery_attempt_already_made: 1 } });
    expect(providerCalls()).toBe(0);
    expect(db[0].sms_confirmation_sent_at).toBeNull();
    expect(db[0].sms_confirmation_claimed_at).toBeNull();
  });

  it("a row whose count rose before our claim is refused BEFORE it (attempts must be 0), spending nothing", async () => {
    db = [appt()];
    preClaimRead = (row) => {
      row.sms_confirmation_send_attempts = 1;
    };
    const r = await run();
    expect(r).toMatchObject({ sent: 0, skipped: { recovery_attempt_already_made: 1 } });
    expect(providerCalls()).toBe(0);
    expect(db[0].sms_confirmation_send_attempts).toBe(1);
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
  it("one studio's page read failing never stops another studio's recovery", async () => {
    const B2 = "studio-b2";
    db = [appt({ id: "a-1" }), appt({ id: "b-1", studio_id: B2 })];
    failSelectFor = A;
    snapshot = (studioId) => readySnap(studioId, `sender-${studioId}`);
    process.env[STUDIO_ROUTING_ENV] = `${A},${B2}`;
    const r = await run({ [CONFIRMATION_RECOVERY_ENV]: "on", [STUDIO_ROUTING_ENV]: `${A},${B2}` });
    expect(r).toMatchObject({ ran: true, sent: 1, skipped: { read_failed: 1 } });
    expect(db.find((x) => x.id === "b-1")!.sms_confirmation_sent_at).not.toBeNull();
    expect(db.find((x) => x.id === "a-1")!.sms_confirmation_send_attempts).toBe(0);
  });

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

describe("eligibility survives an unreadable or refused re-read BEFORE the claim", () => {
  it("cancelled before the claim: nothing claimed, nothing spent", async () => {
    db = [appt()];
    preClaimRead = (row) => {
      row.status = "cancelled";
    };
    expect(await run()).toMatchObject({ sent: 0, skipped: { recovery_not_confirmed: 1 } });
    expect(events).not.toContain("claim_sms_send");
    expect(db[0].sms_confirmation_send_attempts).toBe(0);
  });

  it("an unreadable re-read before the claim: nothing spent, and the next run sends it", async () => {
    db = [appt()];
    failRead = (phase) => phase === "pre";
    expect(await run()).toMatchObject({ sent: 0, skipped: { recovery_revalidate_failed: 1 } });
    expect(events).not.toContain("claim_sms_send");
    expect(db[0].sms_confirmation_send_attempts).toBe(0);
    failRead = null;
    events = [];
    expect(await run()).toMatchObject({ sent: 1 });
    expect(providerCalls()).toBe(1);
  });

  it("a post-claim re-read that fails once is looked at again, and sends", async () => {
    db = [appt()];
    let failures = 1;
    failRead = (phase) => phase === "post" && failures-- > 0;
    expect(await run()).toMatchObject({ sent: 1 });
    expect(events.filter((e) => e === "revalidate_post")).toHaveLength(2);
  });

  it("RESIDUAL (documented): a post-claim re-read failing every look releases the claim with its attempt spent", async () => {
    db = [appt()];
    failRead = (phase) => phase === "post";
    expect(await run()).toMatchObject({ sent: 0, skipped: { recovery_revalidate_failed: 1 } });
    expect(events.filter((e) => e === "revalidate_post")).toHaveLength(3);
    expect(providerCalls()).toBe(0);
    expect(db[0].sms_confirmation_claimed_at).toBeNull();
    expect(db[0].sms_confirmation_send_attempts).toBe(1);
  });
});

describe("FAIRNESS: rows that keep refusing never starve the rest", () => {
  const minutesAgo = (m: number) => iso(NOW - m * 60_000);

  it("60 older opted-out rows ahead of an owed one: the owed one is still sent, in one run", async () => {
    db = [
      ...Array.from({ length: 60 }, (_, i) =>
        appt({ id: `stop-${i}`, created_at: minutesAgo(600 - i), client_opted_out_at: minutesAgo(1) }),
      ),
      appt({ id: "owed", created_at: minutesAgo(30) }),
    ];
    const r = await run(ENABLED, 50);
    expect(r).toMatchObject({ ran: true, considered: 61, sent: 1, skipped: { client_opted_out: 60 } });
    expect(db.find((x) => x.id === "owed")!.sms_confirmation_sent_at).not.toBeNull();
  });

  it("an unready studio's backlog never starves another routed studio, and its snapshot is read once", async () => {
    const B2 = "studio-b2";
    db = [
      ...Array.from({ length: 60 }, (_, i) => appt({ id: `a-${i}`, created_at: minutesAgo(600 - i) })),
      appt({ id: "b-1", studio_id: B2, created_at: minutesAgo(30) }),
    ];
    snapshot = (studioId) =>
      studioId === A
        ? { data: { senders: [], registrations: [] }, error: null }
        : readySnap(B2, "sender-b2");
    process.env[STUDIO_ROUTING_ENV] = `${A},${B2}`;
    const r = await run({ [CONFIRMATION_RECOVERY_ENV]: "on", [STUDIO_ROUTING_ENV]: `${A},${B2}` }, 50);
    expect(r).toMatchObject({ ran: true, sent: 1, skipped: { sms_route_no_active_sender: 60 } });
    expect(db.find((x) => x.id === "b-1")!.sms_confirmation_sent_at).not.toBeNull();
    expect(events.filter((e) => e === SNAPSHOT_RPC)).toHaveLength(2);
    expect(db.filter((x) => x.studio_id === A).every((x) => x.sms_confirmation_send_attempts === 0)).toBe(true);
  });

  it("an unreadable snapshot costs one row's looks per run (3), not looks per row", async () => {
    db = Array.from({ length: 5 }, (_, i) => appt({ id: `r-${i}`, created_at: iso(NOW - (60 + i) * 60_000) }));
    snapshot = { data: null, error: { code: "PGRST202" } };
    expect(await run()).toMatchObject({ sent: 0, skipped: { sms_route_sender_read_failed: 5 } });
    expect(events.filter((e) => e === SNAPSHOT_RPC)).toHaveLength(3);
  });
});

describe("run bounds and a live horizon", () => {
  it("TIED created_at across a page boundary: every tied row is reached, none skipped", async () => {
    const same = iso(NOW - 2 * HOUR);
    // 5 tied rows that keep refusing (opted out), then 3 tied owed rows, page size 2.
    db = [
      ...Array.from({ length: 5 }, (_, i) => appt({ id: `t0-${i}`, created_at: same, client_opted_out_at: iso(NOW - 60_000) })),
      ...Array.from({ length: 3 }, (_, i) => appt({ id: `t1-${i}`, created_at: same })),
    ];
    const r = await run(ENABLED, 2);
    expect(r).toMatchObject({ ran: true, considered: 8, sent: 3, skipped: { client_opted_out: 5 } });
  });

  it("a provider outage stops the run at the attempt cap, counting failures, not only sends", async () => {
    db = Array.from({ length: 70 }, (_, i) => appt({ id: `o-${String(i).padStart(2, "0")}`, created_at: iso(NOW - (100 + i) * 60_000) }));
    providerStatus = 400; // a definite refusal: attempt spent, not sent
    const r = await run();
    expect(providerCalls()).toBe(50);
    expect(r).toMatchObject({ ran: true, sent: 0, failed: 50 });
  });

  it("a row that crosses into the reminder window during a slow run is not confirmed", async () => {
    // Barely eligible at selection; by its re-read, time has moved on.
    db = [appt({ starts_at: iso(NOW + RECOVERY_MIN_LEAD_MS + 60_000) })];
    clock = () => NOW + 2 * 60_000;
    const r = await run();
    expect(r).toMatchObject({ sent: 0, skipped: { recovery_too_late: 1 } });
    expect(events).not.toContain("claim_sms_send");
    expect(providerCalls()).toBe(0);
  });
});

describe("a provider that could never be reached spends nothing", () => {
  it("missing credentials: refused before the claim, still owed, and sent once they return", async () => {
    db = [appt()];
    delete process.env.TWILIO_AUTH_TOKEN;
    expect(await run()).toMatchObject({ sent: 0, skipped: { twilio_not_configured: 1 } });
    expect(events).not.toContain("claim_sms_send");
    expect(db[0].sms_confirmation_send_attempts).toBe(0);
    process.env.TWILIO_AUTH_TOKEN = "token";
    events = [];
    expect(await run()).toMatchObject({ sent: 1 });
    expect(providerCalls()).toBe(1);
  });
});

describe("the INITIAL routed confirmation preflights its provider before the claim (Codex P2 4264231238)", () => {
  const STUDIO = { id: A, name: "Studio", send_confirmation_sms: true, send_24h_sms_reminders: true, send_2h_sms_reminders: true };
  const CLIENT = { phone: "+16475550123", sms_consent_at: "2026-10-01T00:00:00Z", sms_opted_out_at: null as string | null };
  const initial = (over: { studio?: Partial<typeof STUDIO>; client?: Partial<typeof CLIENT> } = {}) =>
    sendBookingConfirmationSmsToClient({
      admin: admin(),
      appointmentId: db[0].id,
      startsAt: new Date(db[0].starts_at),
      timezone: "America/Toronto",
      studio: { ...STUDIO, ...over.studio },
      client: { ...CLIENT, ...over.client },
      intakeUrl: null,
      manageUrl: null,
    });

  it("missing credentials: zero provider calls, zero spent claim, still owed; once configured, recovery sends EXACTLY once", async () => {
    db = [appt()];
    delete process.env.TWILIO_AUTH_TOKEN;
    expect(await initial()).toMatchObject({ ok: false, skipped: true, reason: "twilio_not_configured" });
    expect(events).toContain(SNAPSHOT_RPC);
    expect(events).not.toContain("claim_sms_send");
    expect(providerCalls()).toBe(0);
    expect(db[0]).toMatchObject({ sms_confirmation_send_attempts: 0, sms_confirmation_claimed_at: null, sms_confirmation_sent_at: null });

    process.env.TWILIO_AUTH_TOKEN = "token";
    expect(await run()).toMatchObject({ sent: 1 });
    expect(providerCalls()).toBe(1);
    expect(await run()).toMatchObject({ sent: 0 });
    expect(providerCalls()).toBe(1);
  });

  it("an ambiguous acceptance (provider 5xx) on the initial send is never resent by recovery", async () => {
    db = [appt()];
    providerStatus = 503;
    await initial();
    expect(providerCalls()).toBe(1);
    expect(db[0].sms_confirmation_send_attempts).toBe(1);
    providerStatus = 201;
    expect(await run()).toMatchObject({ sent: 0 });
    expect(providerCalls()).toBe(1);
  });

  it("an initial send that succeeded is never resent", async () => {
    db = [appt()];
    expect(await initial()).toMatchObject({ ok: true });
    expect(await run()).toMatchObject({ sent: 0 });
    expect(providerCalls()).toBe(1);
  });

  it("STOP: the consent gate refuses first, nothing claimed, and recovery never sends", async () => {
    db = [appt({ client_opted_out_at: iso(NOW - 60_000) })];
    delete process.env.TWILIO_AUTH_TOKEN;
    const r = await initial({ client: { sms_opted_out_at: iso(NOW - 60_000) } });
    expect(r).toMatchObject({ ok: false, skipped: true });
    expect(r).not.toMatchObject({ reason: "twilio_not_configured" });
    expect(events).toEqual([]);
    process.env.TWILIO_AUTH_TOKEN = "token";
    expect(await run()).toMatchObject({ sent: 0 });
    expect(providerCalls()).toBe(0);
  });

  it("confirmations toggled off: the consent gate refuses first, nothing read or claimed", async () => {
    db = [appt()];
    delete process.env.TWILIO_AUTH_TOKEN;
    const r = await initial({ studio: { send_confirmation_sms: false } });
    expect(r).toMatchObject({ ok: false, skipped: true });
    expect(r).not.toMatchObject({ reason: "twilio_not_configured" });
    expect(events).toEqual([]);
  });

  it("LEGACY gate off (studio not listed): today's order is unchanged, it claims and the provider module refuses", async () => {
    db = [appt()];
    delete process.env[STUDIO_ROUTING_ENV];
    delete process.env.TWILIO_AUTH_TOKEN;
    await initial();
    expect(events).not.toContain(SNAPSHOT_RPC);
    expect(events).toContain("claim_sms_send");
    expect(providerCalls()).toBe(0);
    expect(db[0].sms_confirmation_send_attempts).toBe(1);
  });
});

describe("FRESHNESS: an approval is never reused, and a STOP mid-run is honoured", () => {
  const twoRows = () => [
    appt({ id: "r-1", created_at: iso(NOW - 3 * HOUR) }),
    appt({ id: "r-2", created_at: iso(NOW - 2 * HOUR) }),
  ];

  it("a sender suspended after the first send is seen by the next: no claim, no send", async () => {
    db = twoRows();
    let reads = 0;
    snapshot = () => {
      reads += 1;
      return reads === 1
        ? readyStudioA()
        : {
            data: {
              senders: [{ id: "sender-a-1", studio_id: A, status: "suspended", phone_number: "+14165550100", messaging_service_sid: MSID_A }],
              registrations: [],
            },
            error: null,
          };
    };
    const r = await run();
    expect(r).toMatchObject({ sent: 1, skipped: { sms_route_no_active_sender: 1 } });
    expect(reads).toBe(2);
    expect(db.find((x) => x.id === "r-2")!.sms_confirmation_send_attempts).toBe(0);
    expect(providerCalls()).toBe(1);
  });

  it("STOP landing after the page was read, before the claim: refused, nothing claimed", async () => {
    db = [appt()];
    preClaimRead = (row) => {
      row.client_opted_out_at = iso(NOW - 1000);
    };
    expect(await run()).toMatchObject({ sent: 0, skipped: { client_opted_out: 1 } });
    expect(events).not.toContain("claim_sms_send");
    expect(providerCalls()).toBe(0);
  });

  it("STOP landing while the claim is held: no provider call, the claim released", async () => {
    db = [appt()];
    afterClaimRead = (row) => {
      row.client_opted_out_at = iso(NOW - 1000);
    };
    expect(await run()).toMatchObject({ sent: 0, skipped: { client_opted_out: 1 } });
    expect(providerCalls()).toBe(0);
    expect(db[0].sms_confirmation_claimed_at).toBeNull();
  });

  it("the client's number changed since the page was read: refused before the claim, still owed", async () => {
    db = [appt()];
    preClaimRead = (row) => {
      row.client_phone = "+16475559999";
    };
    expect(await run()).toMatchObject({ sent: 0, skipped: { recovery_client_phone_changed: 1 } });
    expect(events).not.toContain("claim_sms_send");
    expect(db[0].sms_confirmation_send_attempts).toBe(0);
  });

  it("a studio-wide refusal is remembered for the run; an approval is not", async () => {
    db = twoRows();
    let reads = 0;
    snapshot = () => {
      reads += 1;
      return { data: { senders: [], registrations: [] }, error: null };
    };
    expect(await run()).toMatchObject({ sent: 0, skipped: { sms_route_no_active_sender: 2 } });
    expect(reads).toBe(1);
    reads = 0;
    events = [];
    db = twoRows();
    snapshot = () => {
      reads += 1;
      return readyStudioA();
    };
    expect(await run()).toMatchObject({ sent: 2 });
    expect(reads).toBe(2);
  });
});

describe("the switch, the age and the whole window", () => {
  it("the studio's confirmation switch turned off mid-run: refused before the claim", async () => {
    db = [appt()];
    preClaimRead = (row) => {
      switchOff.add(row.studio_id);
    };
    expect(await run()).toMatchObject({ sent: 0, skipped: { studio_toggle_off: 1 } });
    expect(events).not.toContain("claim_sms_send");
  });

  it("a row that passes the 24-hour age during a slow run is not confirmed", async () => {
    db = [appt({ created_at: iso(NOW - RECOVERY_MAX_AGE_MS + 30_000) })];
    clock = () => NOW + 60_000;
    expect(await run()).toMatchObject({ sent: 0, skipped: { recovery_expired: 1 } });
    expect(events).not.toContain("claim_sms_send");
  });

  it("NO PAGE CEILING: 500 refusing rows on one timestamp never hide the 501st", async () => {
    const same = iso(NOW - 3 * HOUR);
    db = [
      ...Array.from({ length: 500 }, (_, i) =>
        appt({ id: `s-${String(i).padStart(3, "0")}`, created_at: same, client_opted_out_at: iso(NOW - 60_000) }),
      ),
      appt({ id: "z-owed", created_at: same }),
    ];
    const r = await run(ENABLED, 50);
    expect(r).toMatchObject({ ran: true, considered: 501, sent: 1 });
    expect(db.find((x) => x.id === "z-owed")!.sms_confirmation_sent_at).not.toBeNull();
  });

  it("a destination refusal is remembered per country: CA rows cost one read, the US row still sends", async () => {
    // A US long code with approved 10DLC: US recipients are served, Canadian
    // recipients never are (not an A2P route to Canada).
    const US_LONG_CODE = "+12065550100";
    db = [
      appt({ id: "ca-1", created_at: iso(NOW - 4 * HOUR) }),
      appt({ id: "ca-2", client_phone: "+16475550124", created_at: iso(NOW - 3 * HOUR) }),
      appt({ id: "ca-3", client_phone: "+16475550125", created_at: iso(NOW - 2 * HOUR) }),
      appt({ id: "us-1", client_phone: "+12125550101", created_at: iso(NOW - HOUR) }),
    ];
    let reads = 0;
    snapshot = () => {
      reads += 1;
      return {
        data: {
          senders: [{ id: "sender-a-1", studio_id: A, status: "active", phone_number: US_LONG_CODE, messaging_service_sid: MSID_A }],
          registrations: [approval(A, "sender-a-1", US_LONG_CODE, "us_10dlc")],
        },
        error: null,
      };
    };
    const r = await run();
    expect(r).toMatchObject({ sent: 1, skipped: { sms_route_destination_not_ready: 3 } });
    expect(reads).toBe(2);
    expect(db.find((x) => x.id === "us-1")!.sms_confirmation_sent_at).not.toBeNull();
    expect(db.filter((x) => x.id.startsWith("ca-")).every((x) => x.sms_confirmation_send_attempts === 0)).toBe(true);
  });

  it("the run stops at its time budget", async () => {
    db = Array.from({ length: 10 }, (_, i) => appt({ id: `t-${i}`, created_at: iso(NOW - (100 + i) * 60_000) }));
    let t = NOW;
    clock = () => (t += 61_000);
    const r = await run();
    expect(r.ran && r.considered).toBeLessThan(10);
  });
});

describe("a confirmation goes with its manage link or not at all", () => {
  it("a manage link that cannot be minted: refused before the claim, still owed", async () => {
    db = [appt()];
    manageLinkFails = true;
    expect(await run()).toMatchObject({ sent: 0, skipped: { recovery_manage_link_unavailable: 1 } });
    expect(events).not.toContain("claim_sms_send");
    expect(db[0].sms_confirmation_send_attempts).toBe(0);
  });
});

describe("studios share a run", () => {
  it("two routed studios with 60 owed rows each get an equal share of the 50-request cap", async () => {
    const B2 = "studio-b2";
    db = [
      ...Array.from({ length: 60 }, (_, i) => appt({ id: `a-${String(i).padStart(2, "0")}`, created_at: iso(NOW - (200 - i) * 60_000) })),
      ...Array.from({ length: 60 }, (_, i) => appt({ id: `b-${String(i).padStart(2, "0")}`, studio_id: B2, created_at: iso(NOW - (200 - i) * 60_000) })),
    ];
    snapshot = (studioId) => readySnap(studioId, `sender-${studioId}`);
    process.env[STUDIO_ROUTING_ENV] = `${A},${B2}`;
    const r = await run({ [CONFIRMATION_RECOVERY_ENV]: "on", [STUDIO_ROUTING_ENV]: `${A},${B2}` });
    expect(r).toMatchObject({ sent: 50 });
    const sentFor = (sid: string) => db.filter((x) => x.studio_id === sid && x.sms_confirmation_sent_at).length;
    expect([sentFor(A), sentFor(B2)]).toEqual([25, 25]);
  });

  it("a quiet studio's unused share goes to the busy one: one studio with 50 owed, the other none, sends all 50 (Codex P2 4264089023)", async () => {
    const B2 = "studio-b2";
    db = Array.from({ length: 50 }, (_, i) => appt({ id: `a-${String(i).padStart(2, "0")}`, created_at: iso(NOW - (200 - i) * 60_000) }));
    snapshot = (studioId) => readySnap(studioId, `sender-${studioId}`);
    process.env[STUDIO_ROUTING_ENV] = `${A},${B2}`;
    const r = await run({ [CONFIRMATION_RECOVERY_ENV]: "on", [STUDIO_ROUTING_ENV]: `${A},${B2}` });
    expect(r).toMatchObject({ sent: 50, considered: 50 });
    expect(db.filter((x) => x.sms_confirmation_sent_at).length).toBe(50);
  });

  it("redistribution resumes where the studio stopped: 60 and 10 owed send 40 and 10, and no row is considered twice", async () => {
    const B2 = "studio-b2";
    db = [
      // A's oldest row is refused (opted out): considered once, never again.
      appt({ id: "a-00", created_at: iso(NOW - 200 * 60_000), client_opted_out_at: iso(NOW - 60_000) }),
      ...Array.from({ length: 59 }, (_, i) => appt({ id: `a-${String(i + 1).padStart(2, "0")}`, created_at: iso(NOW - (199 - i) * 60_000) })),
      ...Array.from({ length: 10 }, (_, i) => appt({ id: `b-${String(i).padStart(2, "0")}`, studio_id: B2, created_at: iso(NOW - (200 - i) * 60_000) })),
    ];
    snapshot = (studioId) => readySnap(studioId, `sender-${studioId}`);
    process.env[STUDIO_ROUTING_ENV] = `${A},${B2}`;
    const r = await run({ [CONFIRMATION_RECOVERY_ENV]: "on", [STUDIO_ROUTING_ENV]: `${A},${B2}` });
    const sentFor = (sid: string) => db.filter((x) => x.studio_id === sid && x.sms_confirmation_sent_at).length;
    expect(r).toMatchObject({ sent: 50 });
    expect([sentFor(A), sentFor(B2)]).toEqual([40, 10]);
    expect(Object.values(r.ran ? r.skipped : {}).reduce((n, k) => n + k, 0)).toBe(1);
    expect(r).toMatchObject({ considered: 51 });
  });
});

describe("the first studio rotates per 15-minute slot", () => {
  it("when a run's time runs out after one studio, the next slot starts with the other", async () => {
    const B2 = "studio-b2";
    const both = { [CONFIRMATION_RECOVERY_ENV]: "on", [STUDIO_ROUTING_ENV]: `${A},${B2}` };
    process.env[STUDIO_ROUTING_ENV] = `${A},${B2}`;
    snapshot = (studioId) => readySnap(studioId, `sender-${studioId}`);
    const served: string[] = [];
    for (const slot of [0, 1]) {
      const at = NOW + slot * 15 * 60_000;
      events = [];
      db = [appt({ id: "a-1", created_at: iso(at - HOUR), starts_at: iso(at + 48 * HOUR) }), appt({ id: "b-1", studio_id: B2, created_at: iso(at - HOUR), starts_at: iso(at + 48 * HOUR) })];
      // Time runs out once the first message has gone.
      const r = await recoverOwedConfirmations({
        admin: admin(),
        nowMs: at,
        env: both,
        clock: () => (providerCalls() > 0 ? at + 10 * 60_000 : at),
        manageUrlFor: () => "https://app.example/manage/x",
      });
      expect(r).toMatchObject({ sent: 1 });
      served.push(db.find((x) => x.sms_confirmation_sent_at)!.studio_id);
    }
    expect(new Set(served).size).toBe(2);
  });

  it("149 routed studios with backlogs: every one is reached within ceil(149 / 50) = 3 slots, not 100 (Codex P2 4250550574)", async () => {
    const ids = Array.from({ length: 149 }, (_, i) => `studio-r${String(i).padStart(3, "0")}`);
    const list = ids.join(",");
    const env = { [CONFIRMATION_RECOVERY_ENV]: "on", [STUDIO_ROUTING_ENV]: list };
    process.env[STUDIO_ROUTING_ENV] = list;
    snapshot = (studioId) => readySnap(studioId, `sender-${studioId}`);
    // Two owed rows per studio, so every studio still has a backlog after a run.
    db = ids.flatMap((sid) => [0, 1].map((k) => appt({ id: `${sid}-${k}`, studio_id: sid, created_at: iso(NOW - HOUR - k * 60_000), starts_at: iso(NOW + 48 * HOUR) })));
    const slot0 = Math.floor(NOW / (15 * 60_000)) * 15 * 60_000;
    for (const k of [0, 1, 2]) {
      const at = slot0 + k * 15 * 60_000 + 60_000;
      const r = await recoverOwedConfirmations({ admin: admin(), nowMs: at, env, clock: () => at, manageUrlFor: () => "https://app.example/manage/x" });
      expect(r).toMatchObject({ sent: 50 });
    }
    const reached = new Set(db.filter((x) => x.sms_confirmation_sent_at).map((x) => x.studio_id));
    expect(reached.size).toBe(149);
  });
});

describe("the intake link the original confirmation would carry", () => {
  it("an in-progress intake: the link is in the message and stamped as issued", async () => {
    db = [appt()];
    intakes = [{ id: "intake-1", studio_id: A, client_id: "client-1", status: "in_progress", created_at: iso(NOW - HOUR) }];
    expect(await run()).toMatchObject({ sent: 1 });
    expect(providerBodies[0].get("Body")).toContain("https://app.example/intake/intake-1");
    expect(stamps).toEqual([["intake-1", { emailed: false }]]);
  });

  it("a submitted intake, or none: no link and no stamp", async () => {
    db = [appt()];
    intakes = [{ id: "intake-2", studio_id: A, client_id: "client-1", status: "submitted", created_at: iso(NOW - HOUR) }];
    expect(await run()).toMatchObject({ sent: 1 });
    expect(providerBodies[0].get("Body")).not.toContain("/intake/");
    expect(stamps).toEqual([]);
  });

  it("another studio's intake for the same client is never used", async () => {
    db = [appt()];
    intakes = [{ id: "intake-x", studio_id: "studio-other", client_id: "client-1", status: "in_progress", created_at: iso(NOW - HOUR) }];
    await run();
    expect(providerBodies[0].get("Body")).not.toContain("/intake/");
  });

  it("an intake read error: sent without the link, never blocked", async () => {
    db = [appt()];
    intakes = [{ id: "intake-1", studio_id: A, client_id: "client-1", status: "in_progress", created_at: iso(NOW - HOUR) }];
    intakeReadFails = true;
    expect(await run()).toMatchObject({ sent: 1 });
    expect(providerBodies[0].get("Body")).not.toContain("/intake/");
    expect(stamps).toEqual([]);
  });

  it("a refused row never reads the intake", async () => {
    db = [appt({ client_opted_out_at: iso(NOW - 60_000) })];
    await run();
    expect(events).not.toContain("intake_read");
  });

  // Codex P2 4305038680 / 4305026103: the provider was asked and its answer
  // lost (5xx), so the message, and the link in it, may be with the client.
  // The claim spent the attempt, so this run is the only chance to record it.
  it("an AMBIGUOUS provider outcome (5xx) that carried the link: stamped as issued, still counted as a failure", async () => {
    db = [appt()];
    intakes = [{ id: "intake-1", studio_id: A, client_id: "client-1", status: "in_progress", created_at: iso(NOW - HOUR) }];
    providerStatus = 503;
    expect(await run()).toMatchObject({ sent: 0, failed: 1 });
    expect(providerBodies[0].get("Body")).toContain("https://app.example/intake/intake-1");
    expect(stamps).toEqual([["intake-1", { emailed: false }]]);
  });

  it("a DEFINITE provider refusal (4xx): the message never left, so no stamp", async () => {
    db = [appt()];
    intakes = [{ id: "intake-1", studio_id: A, client_id: "client-1", status: "in_progress", created_at: iso(NOW - HOUR) }];
    providerStatus = 400;
    expect(await run()).toMatchObject({ sent: 0, failed: 1 });
    expect(stamps).toEqual([]);
  });

  it("refused after the claim: no stamp", async () => {
    db = [appt()];
    intakes = [{ id: "intake-1", studio_id: A, client_id: "client-1", status: "in_progress", created_at: iso(NOW - HOUR) }];
    afterClaimRead = (row) => {
      row.status = "cancelled";
    };
    await run();
    expect(stamps).toEqual([]);
  });
});

describe("scan direction alternates per slot; an unreadable route is re-read", () => {
  it("a run cut off by its budget serves the oldest row in an even slot and the newest in an odd one", async () => {
    const even = Math.floor(NOW / (15 * 60_000)) % 2 === 0 ? NOW : NOW + 15 * 60_000;
    const served: string[] = [];
    for (const at of [even, even + 15 * 60_000]) {
      events = [];
      db = [
        appt({ id: "old", created_at: iso(at - 10 * HOUR), starts_at: iso(at + 48 * HOUR) }),
        appt({ id: "mid", created_at: iso(at - 5 * HOUR), starts_at: iso(at + 48 * HOUR) }),
        appt({ id: "new", created_at: iso(at - HOUR), starts_at: iso(at + 48 * HOUR) }),
      ];
      const r = await recoverOwedConfirmations({
        admin: admin(),
        nowMs: at,
        env: ENABLED,
        clock: () => (providerCalls() > 0 ? at + 10 * 60_000 : at),
        manageUrlFor: () => "https://app.example/manage/x",
      });
      expect(r).toMatchObject({ sent: 1 });
      served.push(db.find((x) => x.sms_confirmation_sent_at)!.id);
    }
    expect(served).toEqual(["old", "new"]);
  });

  it("newest-first pages through ties without skipping", async () => {
    const odd = Math.floor(NOW / (15 * 60_000)) % 2 === 1 ? NOW : NOW + 15 * 60_000;
    const same = iso(odd - 2 * HOUR);
    db = [
      ...Array.from({ length: 5 }, (_, i) => appt({ id: `t1-${i}`, created_at: same, starts_at: iso(odd + 48 * HOUR) })),
      ...Array.from({ length: 5 }, (_, i) => appt({ id: `t0-${i}`, created_at: same, client_opted_out_at: iso(odd - 60_000), starts_at: iso(odd + 48 * HOUR) })),
    ];
    const r = await recoverOwedConfirmations({
      admin: admin(),
      nowMs: odd,
      env: ENABLED,
      clock: () => odd,
      pageSize: 2,
      manageUrlFor: () => "https://app.example/manage/x",
    });
    expect(r).toMatchObject({ considered: 10, sent: 5, skipped: { client_opted_out: 5 } });
  });

  it("an unreadable route is looked at again in the same run (no later slot may exist)", async () => {
    db = [appt()];
    let reads = 0;
    snapshot = () => {
      reads += 1;
      return reads === 1 ? { data: null, error: { code: "57014" } } : readyStudioA();
    };
    expect(await run()).toMatchObject({ sent: 1 });
    expect(reads).toBe(2);
  });
});

describe("THE SENDER CHANGES WHILE THE PRE-CLAIM READS RUN (Codex P1 4254248449)", () => {
  // The route is resolved AFTER beforeClaim, immediately before the claim.
  // Each case changes the studio's sender during the pre-claim re-read; the
  // fake 0217 snapshot and the fake provider (stubbed fetch) show what happens.
  const OLD_MSID = MSID_A;
  const NEW_MSID = `MG${"c".repeat(32)}`;
  const NEW_NUMBER = "+18775550100";
  let current: Snapshot;
  const useLiveSnapshot = () => {
    current = readyStudioA();
    snapshot = () => current;
  };

  it("SUSPENDED during the reads: no claim, no send, still owed; sent once re-activated", async () => {
    db = [appt()];
    useLiveSnapshot();
    preClaimRead = () => {
      current = {
        data: {
          senders: [{ id: "sender-a-1", studio_id: A, status: "suspended", phone_number: READY_NUMBER, messaging_service_sid: OLD_MSID }],
          registrations: [approval(A, "sender-a-1", READY_NUMBER, "toll_free_verification")],
        },
        error: null,
      };
    };
    expect(await run()).toMatchObject({ sent: 0, skipped: { sms_route_no_active_sender: 1 } });
    expect(events).not.toContain("claim_sms_send");
    expect(providerCalls()).toBe(0);
    expect(db[0].sms_confirmation_send_attempts).toBe(0);
    preClaimRead = null;
    current = readyStudioA();
    events = [];
    expect(await run()).toMatchObject({ sent: 1 });
    expect(providerCalls()).toBe(1);
  });

  it("RELEASED during the reads (0217 returns no live sender): no claim, no send, still owed", async () => {
    db = [appt()];
    useLiveSnapshot();
    preClaimRead = () => {
      current = { data: { senders: [], registrations: [] }, error: null };
    };
    expect(await run()).toMatchObject({ sent: 0, skipped: { sms_route_no_active_sender: 1 } });
    expect(events).not.toContain("claim_sms_send");
    expect(providerCalls()).toBe(0);
    expect(db[0].sms_confirmation_send_attempts).toBe(0);
  });

  it("REPLACED by an approved sender during the reads: sent from the NEW service and number, never the old", async () => {
    db = [appt()];
    useLiveSnapshot();
    preClaimRead = () => {
      current = {
        data: {
          senders: [{ id: "sender-a-2", studio_id: A, status: "active", phone_number: NEW_NUMBER, messaging_service_sid: NEW_MSID }],
          registrations: [approval(A, "sender-a-2", NEW_NUMBER, "toll_free_verification")],
        },
        error: null,
      };
    };
    expect(await run()).toMatchObject({ sent: 1 });
    expect(providerBodies[0].get("MessagingServiceSid")).toBe(NEW_MSID);
    expect(providerBodies[0].get("From")).toBe(NEW_NUMBER);
    expect(JSON.stringify([...providerBodies[0]])).not.toContain(OLD_MSID);
    expect(JSON.stringify([...providerBodies[0]])).not.toContain(READY_NUMBER);
  });

  it("REPLACED by a sender whose registration is not yet approved: refused before any claim", async () => {
    db = [appt()];
    useLiveSnapshot();
    preClaimRead = () => {
      current = {
        data: {
          senders: [{ id: "sender-a-2", studio_id: A, status: "active", phone_number: NEW_NUMBER, messaging_service_sid: NEW_MSID }],
          registrations: [],
        },
        error: null,
      };
    };
    expect(await run()).toMatchObject({ sent: 0, skipped: { sms_route_destination_not_ready: 1 } });
    expect(events).not.toContain("claim_sms_send");
    expect(providerCalls()).toBe(0);
    expect(db[0].sms_confirmation_send_attempts).toBe(0);
  });

  it("UNCHANGED sender: the ordinary recovered send still goes through, from the studio's own sender", async () => {
    db = [appt()];
    useLiveSnapshot();
    expect(await run()).toMatchObject({ sent: 1 });
    expect(providerBodies[0].get("MessagingServiceSid")).toBe(OLD_MSID);
    expect(providerBodies[0].get("From")).toBe(READY_NUMBER);
  });
});
