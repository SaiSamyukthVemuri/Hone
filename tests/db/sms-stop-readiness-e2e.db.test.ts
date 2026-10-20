import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminQuery, closePool, seedStudio, type SeededStudio } from "./helpers/harness";
import { E2E_SUPABASE_URL, E2E_SERVICE_ROLE_KEY } from "@/e2e/helpers/local-env";
import { FakeSmsProvisioningProvider } from "@/lib/sms/provider/fake-provider";
import {
  evaluateInboundStopPreflight,
  STOP_PREFLIGHT_CHECKLIST_VERSION,
  type InboundStopFacts,
} from "@/lib/sms/inbound-stop-preflight";
import { liveSendTimeRouteReader, type SendTimeRouteReader } from "@/lib/sms/send-time-route";

// ===========================================================================
// SMS STOP / readiness, END TO END (Sam's priority 5), on the isolated stack.
// ===========================================================================
//
// One real chain, FAKE providers only, nothing sent:
//   sender adopted through 0191 → 0217 evidence → 0229 campaign binding →
//   0230 STOP preflight (recorded from evaluateInboundStopPreflight's OWN
//   checks) → the one-statement snapshot → the send-time route →
//   claim + provider call (a recording fake of Twilio's Messages API).
//
// EGRESS (ops01): fetch is replaced for the whole file. Loopback (this stack)
// passes through; api.twilio.com's Messages endpoint is answered by the fake
// and recorded; ANY other host THROWS, so a missed stub can never send.
// No Twilio credential: the account SID and auth token are dummy values.
// ===========================================================================

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

const BASE = "https://hone.care";
const ORIGIN = BASE;
const DUMMY_TOKEN = "dummy-e2e-auth-token-not-a-credential";
const ACCOUNT = `AC${"1".repeat(32)}`;
const hex = (n: number) => randomBytes(n).toString("hex");
const mg = () => `MG${hex(16)}`;
const qe = () => `QE${hex(16)}`;

// ---------------------------------------------------------------------------
// Egress fence and the recording fake of Twilio's Messages API.
// ---------------------------------------------------------------------------
type TwilioCall = { url: string; form: Record<string, string> };
const twilioCalls: TwilioCall[] = [];
const blockedHosts: string[] = [];
const realFetch = globalThis.fetch;

async function fencedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(input, init);
  if (url.hostname === "api.twilio.com" && /\/Accounts\/[^/]+\/Messages\.json$/.test(url.pathname) && init?.method === "POST") {
    const form = Object.fromEntries(new URLSearchParams(String(init.body ?? "")));
    twilioCalls.push({ url: url.href, form });
    // A Messaging Service may pool several numbers, and without From Twilio
    // picks any member (Codex P2 4305406389). The fake refuses a service send
    // that does not pin its sender, as an unverified pool member could go out.
    if (form.MessagingServiceSid && !form.From) {
      return new Response(JSON.stringify({ code: 21603, message: "From is required by this fake for a pinned studio send" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ sid: `SM${hex(16)}`, status: "queued", to: form.To, from: null, messaging_service_sid: form.MessagingServiceSid ?? null }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }
  blockedHosts.push(url.hostname);
  throw new Error(`egress blocked in E2E: ${url.hostname}`);
}

// ---------------------------------------------------------------------------
// Environment: this stack, dummy Twilio values, the webhook base. Restored after.
// ---------------------------------------------------------------------------
const ENV_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_WEBHOOK_BASE_URL",
  "TWILIO_MESSAGING_SERVICE_SID",
  "TWILIO_FROM_NUMBER",
  "SMS_STUDIO_ROUTING_STUDIO_IDS",
  "SMS_CONFIRMATION_RECOVERY",
  "CRON_SECRET",
  "NEXT_PUBLIC_APP_ORIGIN",
  "APPOINTMENT_SIGNING_SECRET",
  "VERCEL_ENV",
  "VERCEL",
] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

let controls: typeof import("@/lib/sms/sender-controls");
let sends: typeof import("@/lib/sms/send-appointment");
let recovery: typeof import("@/lib/sms/confirmation-recovery");
let admin: SupabaseClient;

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL;
  delete process.env.TWILIO_MESSAGING_SERVICE_SID;
  delete process.env.TWILIO_FROM_NUMBER;
  process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;
  process.env.TWILIO_ACCOUNT_SID = ACCOUNT;
  process.env.TWILIO_AUTH_TOKEN = DUMMY_TOKEN;
  process.env.TWILIO_WEBHOOK_BASE_URL = BASE;
  vi.stubGlobal("fetch", fencedFetch);
  controls = await import("@/lib/sms/sender-controls");
  sends = await import("@/lib/sms/send-appointment");
  recovery = await import("@/lib/sms/confirmation-recovery");
  admin = (await import("@/lib/supabase/admin-server")).createAdminClient();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await closePool();
});

beforeEach(() => {
  twilioCalls.length = 0;
});

// ---------------------------------------------------------------------------
// Fixtures: a studio with a consenting US client, its sender adopted through
// the real lifecycle, and each record written by its own command.
// ---------------------------------------------------------------------------
async function freshNumber(area: string): Promise<string> {
  for (;;) {
    const n = `+1${area}555${String(1000 + Math.floor(Math.random() * 8999))}`;
    const { rows } = await adminQuery(
      "select 1 from public.studio_sms_senders where phone_number = $1 or claimed_phone_number = $1 limit 1",
      [n],
    );
    if (rows.length === 0) return n;
  }
}

type Fixture = SeededStudio & { clientPhone: string; senderId: string; senderPhone: string; service: string };

async function readyStudio(label: string): Promise<Fixture> {
  const s = await seedStudio(label);
  const clientPhone = await freshNumber("212"); // a US mobile-range number
  await adminQuery(
    "update public.studios set send_confirmation_sms = true, timezone = 'America/Toronto' where id = $1",
    [s.studioId],
  );
  await adminQuery(
    "update public.clients set phone = $2, sms_consent_at = now(), sms_opted_out_at = null where id = $1",
    [s.clientId, clientPhone],
  );
  const senderPhone = await freshNumber("416"); // a long code: 10DLC for US-bound traffic
  const service = mg();
  const provider = new FakeSmsProvisioningProvider({
    preOwnedNumbers: { [senderPhone]: `PN${hex(16)}` },
    accountServices: [
      { sid: service, numbers: [senderPhone], inboundUrl: `${ORIGIN}/api/twilio/inbound-sms`, statusUrl: `${ORIGIN}/api/twilio/message-status` },
    ],
  });
  const adopted = await controls.runSenderAdoption(
    { admin, provider, appOrigin: ORIGIN, testDestination: "+14165553199" },
    { studioId: s.studioId, actorUserId: s.userId, country: "CA", phoneNumber: senderPhone, messagingServiceSid: service },
  );
  expect(adopted).toMatchObject({ ok: true, result: "adopted" });
  const senderId = (await adminQuery(
    "select id from public.studio_sms_senders where studio_id = $1 and status <> 'released'",
    [s.studioId],
  )).rows[0].id as string;
  return { ...s, clientPhone, senderId, senderPhone, service };
}

async function recordRegistrationApproved(f: Fixture) {
  const r = (await adminQuery(
    "select * from public.record_studio_sms_sender_registration($1, $2, $3, 'approved', null, null, null)",
    [f.studioId, f.senderId, f.senderPhone],
  )).rows[0] as { result: string };
  expect(r.result).toBe("recorded");
}

async function recordBindingVerified(f: Fixture) {
  const r = (await adminQuery(
    "select * from public.record_studio_sms_campaign_binding($1, $2, $3, $4, $5, 'verified', 'cutover', null)",
    [f.studioId, f.senderId, f.senderPhone, f.service, qe()],
  )).rows[0] as { result: string };
  expect(r.result).toBe("recorded");
}

/** Facts proving THIS sender's STOP path (Willow's allProven, bound to the real sender). */
function provenFacts(f: Fixture): InboundStopFacts {
  const url = `${BASE}/api/twilio/inbound-sms#ct=1000&rt=5000&tt=15000&rc=2&rp=4xx,5xx,ct,rt&e=ashburn,umatilla`;
  return {
    env: { TWILIO_WEBHOOK_BASE_URL: BASE, TWILIO_AUTH_TOKEN: "x", NEXT_PUBLIC_APP_ORIGIN: BASE },
    signatureProof: { lastVerifiedCallbackAt: "2026-10-12T10:00:00Z", credentialsActiveSince: "2026-10-01T00:00:00Z" },
    endpointProbe: { status: 405, redirectedTo: null },
    service: {
      sid: f.service,
      inboundRequestUrl: url,
      inboundMethod: "POST",
      useInboundWebhookOnNumber: false,
      numberSmsUrl: null,
      numberSmsApplicationSid: null,
      accountSid: ACCOUNT,
      checkedNumber: f.senderPhone,
    },
    routedFromNumber: f.senderPhone,
    webhookRules: { matched: false },
    staticProxyEnabled: false,
    webhookPropagation: { ruleOperationStatuses: ["COMPLETED"], secondsSinceLastConfigChange: 3600 },
    honeAccountSid: ACCOUNT,
    mappedStudioId: f.studioId,
    expectedStudioId: f.studioId,
    liveStopObservation: {
      reachedRoute: true,
      routeStatus: 200,
      phoneWideOptOutStamped: true,
      observedAt: "2026-10-12T12:00:00Z",
      toNumber: f.senderPhone,
      messagingServiceSid: f.service,
    },
    optOutConfiguration: { dropsKeywordMessages: false, lastChangedAt: "2026-10-01T00:00:00Z" },
    currentActivation: { handlerDeployedAt: "2026-10-11T00:00:00Z", databaseMigratedAt: "2026-10-10T00:00:00Z" },
  } as InboundStopFacts;
}

/** Evaluate the facts with the REAL evaluator and record exactly its checks through 0230. */
async function recordPreflightFrom(f: Fixture, facts: InboundStopFacts) {
  const evaluated = evaluateInboundStopPreflight(facts);
  const checks = evaluated.checks.map((c) => ({ id: c.id, status: c.status }));
  const expected = ((await adminQuery(
    "select to_jsonb(checked_at) #>> '{}' as t from public.studio_sms_sender_stop_preflights where sender_id = $1",
    [f.senderId],
  )).rows[0]?.t as string | undefined) ?? null;
  const r = (await adminQuery(
    "select * from public.record_studio_sms_stop_preflight($1, $2, $3, $4, $5::jsonb, $6::smallint, $7, $8, $9, $10, $11)",
    [f.studioId, f.senderId, f.senderPhone, f.service, JSON.stringify(checks), STOP_PREFLIGHT_CHECKLIST_VERSION, BASE, null, null, "cutover", expected],
  )).rows[0] as { result: string };
  expect(r.result).toBe("recorded");
  return evaluated;
}

let slot = 0;
async function seedAppointment(f: Fixture, opts: { createdMinutesAgo?: number; hoursOut?: number } = {}): Promise<{ id: string; startsAt: Date }> {
  const hoursOut = opts.hoursOut ?? 30 + slot++ * 2;
  const r = await adminQuery(
    `insert into public.appointments
       (id, studio_id, practitioner_id, client_id, starts_at, ends_at,
        duration_minutes, status, cancellation_token_hash,
        buffer_minutes_snapshot, blocked_ends_at, created_at)
     values (gen_random_uuid(), $1, $2, $3,
             now() + ($4::text || ' hours')::interval,
             now() + ($4::text || ' hours')::interval + interval '45 minutes',
             45, 'confirmed', encode(gen_random_bytes(32), 'hex'),
             15,
             now() + ($4::text || ' hours')::interval + interval '60 minutes',
             now() - ($5::text || ' minutes')::interval)
     returning id, starts_at`,
    [f.studioId, f.practitionerId, f.clientId, String(hoursOut), String(opts.createdMinutesAgo ?? 0)],
  );
  return { id: r.rows[0].id as string, startsAt: new Date(r.rows[0].starts_at as string) };
}

/** The booking path's send, with the client and studio READ FROM THE DATABASE now. */
async function sendConfirmation(f: Fixture, appointment: { id: string; startsAt: Date }) {
  const studio = (await adminQuery(
    "select id, name, send_confirmation_sms, send_24h_sms_reminders, send_2h_sms_reminders from public.studios where id = $1",
    [f.studioId],
  )).rows[0];
  const client = (await adminQuery(
    "select phone, sms_consent_at, sms_opted_out_at from public.clients where id = $1",
    [f.clientId],
  )).rows[0];
  return sends.sendBookingConfirmationSmsToClient({
    admin,
    appointmentId: appointment.id,
    startsAt: appointment.startsAt,
    timezone: "America/Toronto",
    studio,
    client,
    intakeUrl: null,
    manageUrl: `${ORIGIN}/manage/e2e`,
  });
}

const attemptsOf = async (appointmentId: string) =>
  (await adminQuery(
    "select sms_confirmation_send_attempts as n, sms_confirmation_sent_at as sent from public.appointments where id = $1",
    [appointmentId],
  )).rows[0] as { n: number; sent: Date | null };

function routeOnly(...studioIds: string[]) {
  process.env.SMS_STUDIO_ROUTING_STUDIO_IDS = studioIds.join(",");
}

// ===========================================================================
// 1. Ready → sent through the fake, from THIS studio's sender.
// ===========================================================================
describe("1. sender configured, complete v1 STOP preflight, campaign binding: ready and sent", () => {
  it("the confirmation leaves through the studio's Messaging Service to the client, once", async () => {
    const f = await readyStudio("e2e-ready");
    await recordRegistrationApproved(f);
    await recordBindingVerified(f);
    const evaluated = await recordPreflightFrom(f, provenFacts(f));
    expect(evaluated.ready).toBe(true);
    routeOnly(f.studioId);

    const appt = await seedAppointment(f);
    const out = await sendConfirmation(f, appt);
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(twilioCalls).toHaveLength(1);
    expect(twilioCalls[0].form.MessagingServiceSid).toBe(f.service);
    // The EXACT sender whose STOP readiness was verified, not any pool member.
    expect(twilioCalls[0].form.From).toBe(f.senderPhone);
    expect(twilioCalls[0].form.To).toBe(f.clientPhone);
    expect(twilioCalls[0].url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Messages.json`);
    const a = await attemptsOf(appt.id);
    expect(a.n).toBe(1);
    expect(a.sent).not.toBeNull();
  });
});

// ===========================================================================
// 2. Not ready → refused before any claim; recovery caches the refusal.
// ===========================================================================
describe("2. incomplete checklist or missing binding: refused, nothing spent, refusal cached", () => {
  it("(a) a recorded checklist that is not all-pass: sms_route_stop_preflight_not_ready, zero provider calls", async () => {
    const f = await readyStudio("e2e-incomplete");
    await recordRegistrationApproved(f);
    await recordBindingVerified(f);
    const facts = provenFacts(f);
    facts.liveStopObservation = undefined; // the live STOP not yet observed: stop_forwarded unknown
    const evaluated = await recordPreflightFrom(f, facts);
    expect(evaluated.ready).toBe(false);
    routeOnly(f.studioId);

    const appt = await seedAppointment(f);
    expect(await sendConfirmation(f, appt)).toMatchObject({ ok: false, skipped: true, reason: "sms_route_stop_preflight_not_ready" });
    expect(twilioCalls).toHaveLength(0);
    expect((await attemptsOf(appt.id)).n).toBe(0);
  });

  it("(b) no campaign binding for a US recipient: sms_route_campaign_binding_missing, zero provider calls", async () => {
    const f = await readyStudio("e2e-nobinding");
    await recordRegistrationApproved(f);
    await recordPreflightFrom(f, provenFacts(f));
    routeOnly(f.studioId);

    const appt = await seedAppointment(f);
    expect(await sendConfirmation(f, appt)).toMatchObject({ ok: false, skipped: true, reason: "sms_route_campaign_binding_missing" });
    expect(twilioCalls).toHaveLength(0);
    expect((await attemptsOf(appt.id)).n).toBe(0);
  });

  it("recovery: a not-ready studio costs ONE snapshot read, its visit ends at the first studio-wide refusal, and every row stays owed", async () => {
    const f = await readyStudio("e2e-recovery");
    await recordRegistrationApproved(f);
    await recordBindingVerified(f);
    const facts = provenFacts(f);
    facts.liveStopObservation = undefined;
    await recordPreflightFrom(f, facts);
    const owed = [
      await seedAppointment(f, { createdMinutesAgo: 10, hoursOut: 5 }),
      await seedAppointment(f, { createdMinutesAgo: 12, hoursOut: 7 }),
      await seedAppointment(f, { createdMinutesAgo: 14, hoursOut: 9 }),
    ];
    // The per-row send resolves its route from process.env (as in production,
    // where the cron and the send share one environment), so the allowlist is
    // set there; opts.env alone does not reach the send path.
    routeOnly(f.studioId);
    let reads = 0;
    const live = liveSendTimeRouteReader(admin);
    const counting: SendTimeRouteReader = async (studioId) => {
      reads += 1;
      return live(studioId);
    };
    const run = await recovery.recoverOwedConfirmations({
      admin,
      nowMs: Date.now(),
      env: { ...process.env, SMS_CONFIRMATION_RECOVERY: "on", SMS_STUDIO_ROUTING_STUDIO_IDS: f.studioId },
      routeReader: counting,
      manageUrlFor: (id) => `${ORIGIN}/manage/${id}`,
    });
    expect(run).toMatchObject({ ran: true, sent: 0, failed: 0 });
    if (!run.ran) return;
    // Codex P2 4305191997 (#916 ed058297): a studio-wide refusal ends the
    // studio's visit instead of paging its backlog; the rest stay owed.
    expect(run.considered).toBe(1);
    expect(run.skipped.sms_route_stop_preflight_not_ready).toBe(1);
    expect(reads).toBe(1);
    expect(twilioCalls).toHaveLength(0);
    for (const a of owed) expect((await attemptsOf(a.id)).n).toBe(0);
  });
});

// ===========================================================================
// 3. STOP: the opt-out is recorded and honoured; a STOP through another sender
//    never certifies this one.
// ===========================================================================
function twilioSignature(token: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return createHmac("sha1", token).update(Buffer.from(data, "utf-8")).digest("base64");
}

describe("3. STOP via a signed inbound webhook", () => {
  it("a STOP to the studio's sender opts the client out, and the next confirmation is refused at the consent gate", async () => {
    const f = await readyStudio("e2e-stop");
    await recordRegistrationApproved(f);
    await recordBindingVerified(f);
    await recordPreflightFrom(f, provenFacts(f));
    routeOnly(f.studioId);

    const url = `${BASE}/api/twilio/inbound-sms`;
    const params = {
      AccountSid: ACCOUNT,
      MessageSid: `SM${hex(16)}`,
      MessagingServiceSid: f.service,
      From: f.clientPhone,
      To: f.senderPhone,
      Body: "STOP",
    };
    const { POST } = await import("@/app/api/twilio/inbound-sms/route");
    const res = await POST(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(DUMMY_TOKEN, url, params) },
        body: new URLSearchParams(params).toString(),
      }),
    );
    expect(res.status).toBe(200);
    const client = (await adminQuery("select sms_opted_out_at from public.clients where id = $1", [f.clientId])).rows[0];
    expect(client.sms_opted_out_at).not.toBeNull();

    const appt = await seedAppointment(f);
    expect(await sendConfirmation(f, appt)).toMatchObject({ ok: false, skipped: true, reason: "client_opted_out" });
    expect(twilioCalls).toHaveLength(0);
    expect((await attemptsOf(appt.id)).n).toBe(0);
  });

  it("a STOP signed with the wrong token is refused (403) and writes nothing", async () => {
    const f = await readyStudio("e2e-stop-forged");
    const url = `${BASE}/api/twilio/inbound-sms`;
    const params = { AccountSid: ACCOUNT, MessageSid: `SM${hex(16)}`, MessagingServiceSid: f.service, From: f.clientPhone, To: f.senderPhone, Body: "STOP" };
    const { POST } = await import("@/app/api/twilio/inbound-sms/route");
    const res = await POST(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature("not-the-token", url, params) },
        body: new URLSearchParams(params).toString(),
      }),
    );
    expect(res.status).toBe(403);
    const client = (await adminQuery("select sms_opted_out_at from public.clients where id = $1", [f.clientId])).rows[0];
    expect(client.sms_opted_out_at).toBeNull();
  });

  it("a live STOP observed through ANOTHER sender never certifies this one: not ready, and the route refuses", async () => {
    const f = await readyStudio("e2e-stop-other");
    const other = await readyStudio("e2e-stop-other-sender");
    await recordRegistrationApproved(f);
    await recordBindingVerified(f);
    const facts = provenFacts(f);
    facts.liveStopObservation = { ...facts.liveStopObservation!, toNumber: other.senderPhone, messagingServiceSid: other.service };
    const evaluated = await recordPreflightFrom(f, facts);
    expect(evaluated.checks.find((c) => c.id === "stop_forwarded")?.status).toBe("fail");
    expect(evaluated.ready).toBe(false);
    routeOnly(f.studioId);

    const appt = await seedAppointment(f);
    expect(await sendConfirmation(f, appt)).toMatchObject({ ok: false, skipped: true, reason: "sms_route_stop_preflight_not_ready" });
    expect(twilioCalls).toHaveLength(0);
  });
});

// ===========================================================================
// 4. The recovery cron: a read failure is 503, and nothing is sent.
// ===========================================================================
describe("4. the recovery cron route", () => {
  it("when the owed-rows read fails for every studio: 503, ran:false/read_failed, zero provider calls", async () => {
    const f = await readyStudio("e2e-cron");
    process.env.CRON_SECRET = "e2e-cron-secret-not-a-credential";
    process.env.SMS_CONFIRMATION_RECOVERY = "on";
    process.env.NEXT_PUBLIC_APP_ORIGIN = ORIGIN;
    process.env.APPOINTMENT_SIGNING_SECRET = "e2e-signing-secret-not-a-credential-0123456789";
    routeOnly(f.studioId);
    // A well-formed key the stack rejects: every PostgREST read the route makes fails.
    process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.not-a-valid-signature";
    try {
      const { GET } = await import("@/app/api/cron/sms-confirmation-recovery/route");
      const res = await GET(
        new Request(`${ORIGIN}/api/cron/sms-confirmation-recovery`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }),
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ ok: false, ran: false, reason: "read_failed" });
      expect(twilioCalls).toHaveLength(0);
    } finally {
      process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;
    }
  });
});

describe("egress", () => {
  it("no request left for any host but this stack and the recording fake", () => {
    expect(blockedHosts).toEqual([]);
  });
});
