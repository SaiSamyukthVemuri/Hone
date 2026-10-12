import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  send24hReminderSmsToClient,
  sendBookingConfirmationSmsToClient,
} from "@/lib/sms/send-appointment";
import { sendSmsSafely } from "@/lib/sms/twilio";
import {
  STUDIO_ROUTING_ENV,
  type SendTimeRegistration,
  type SendTimeRouteRead,
  type SendTimeRouteReader,
  type SendTimeSender,
} from "@/lib/sms/send-time-route";

// ===========================================================================
// WILLOW-ROUTING-CANDIDATE-01 (#824): the ORDER of an appointment SMS.
// ===========================================================================
//
// One event log records every step that matters, in the order it happened:
//   "route_read"  the send-time sender/readiness read
//   <rpc name>    claim_sms_send / claim_reminder_sms_send / the ledger / record
//   "provider"    the Twilio request
// and proves, through the REAL send helpers and the REAL provider module:
//   * consent and STOP refuse before the route is even read;
//   * every sender or destination refusal happens after that read and before
//     any claim or provider call, so it spends no attempt (safe retry);
//   * a studio-routed send leaves from that studio's messaging service only,
//     never the platform's, even with both platform keys set;
//   * with the cutover gate unset, the platform path is today's, unchanged.
// Synthetic only: nothing here reaches a network or a database.

const alerts: unknown[] = [];
vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: (input: unknown) => {
    alerts.push(input);
    return Promise.resolve();
  },
}));

const A = "studio-a";
const B = "studio-b";
const MSID_A = `MG${"a".repeat(32)}`;
const MSID_B = `MG${"b".repeat(32)}`;
const PLATFORM_MSID = `MG${"0".repeat(32)}`;
const PLATFORM_FROM = "+15550001111";
const CA_RECIPIENT = "+16475550123";
const SID = `SM${"0f".repeat(16)}`;

let events: string[];
let providerBodies: URLSearchParams[];
/** What 0217's snapshot RPC answers, when the default (live) reader is used. */
let snapshot: { data: unknown; error: unknown };
const SNAPSHOT_RPC = "get_live_studio_sms_sender_registration_state";

function admin(): SupabaseClient {
  return {
    rpc(fn: string) {
      events.push(fn);
      if (fn === SNAPSHOT_RPC) return Promise.resolve(snapshot);
      if (fn === "claim_sms_send") return Promise.resolve({ data: true, error: null });
      if (fn === "claim_reminder_sms_send") {
        return Promise.resolve({ data: [{ result: "claimed", starts_at: "2026-10-13T15:00:00Z" }], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as SupabaseClient;
}

const sender = (over: Partial<SendTimeSender> = {}): SendTimeSender => ({
  id: "sender-a-1",
  studio_id: A,
  status: "active",
  phone_number: "+14165550100",
  messaging_service_sid: MSID_A,
  ...over,
});

function reader(answer: SendTimeRouteRead | (() => SendTimeRouteRead)): SendTimeRouteReader {
  return async () => {
    events.push("route_read");
    return typeof answer === "function" ? answer() : answer;
  };
}

const ready = (): SendTimeRouteRead => ({ ok: true, senders: [sender()], registrations: [] });

const studio = {
  id: A,
  name: "Studio",
  send_confirmation_sms: true,
  send_24h_sms_reminders: true,
  send_2h_sms_reminders: true,
};
const consenting = { phone: CA_RECIPIENT, sms_consent_at: "2026-10-01T00:00:00Z", sms_opted_out_at: null };

type Client = typeof consenting | { phone: string | null; sms_consent_at: string | null; sms_opted_out_at: string | null };

const confirmation = (routeReader?: SendTimeRouteReader, client: Client = consenting, s = studio) =>
  sendBookingConfirmationSmsToClient({
    admin: admin(),
    appointmentId: "appt-1",
    startsAt: new Date("2026-10-13T15:00:00Z"),
    timezone: "America/Toronto",
    studio: s,
    client,
    intakeUrl: null,
    manageUrl: null,
    routeReader,
  });

const reminder = (routeReader?: SendTimeRouteReader, client: Client = consenting, s = studio) =>
  send24hReminderSmsToClient({
    admin: admin(),
    appointmentId: "appt-1",
    window: { startIso: "2026-10-13T14:00:00Z", endIso: "2026-10-13T16:00:00Z" },
    timezone: "America/Toronto",
    studio: s,
    client,
    manageUrlFor: () => null,
    routeReader,
  });

const PATHS = [
  ["confirmation", confirmation, "claim_sms_send"],
  ["24h reminder", reminder, "claim_reminder_sms_send"],
] as const;

const ENV_KEYS = [
  "VERCEL_ENV",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
  "TWILIO_MESSAGING_SERVICE_SID",
  STUDIO_ROUTING_ENV,
] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  delete process.env.VERCEL_ENV;
  delete process.env.TWILIO_MESSAGING_SERVICE_SID;
  delete process.env[STUDIO_ROUTING_ENV];
  process.env.TWILIO_ACCOUNT_SID = `AC${"1".repeat(32)}`;
  process.env.TWILIO_AUTH_TOKEN = "token";
  process.env.TWILIO_FROM_NUMBER = PLATFORM_FROM;
  events = [];
  providerBodies = [];
  // 0217 is not applied on production: the function does not exist there.
  snapshot = { data: null, error: { code: "PGRST202", message: "function not found" } };
  alerts.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: { body: string }) => {
      events.push("provider");
      providerBodies.push(new URLSearchParams(init.body));
      return Promise.resolve(new Response(JSON.stringify({ sid: SID, status: "queued" }), { status: 201 }));
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

const routeStudioA = () => {
  process.env[STUDIO_ROUTING_ENV] = A;
};

describe.each(PATHS)("%s: with the cutover gate unset, the platform path is today's", (_label, send, claimRpc) => {
  it("reads no route, claims, and sends From the platform number exactly as before", async () => {
    const r = await send(reader(ready));
    expect(r).toMatchObject({ ok: true, messageSid: SID });
    expect(events).not.toContain("route_read");
    expect(events[0]).toBe(claimRpc);
    expect(events.filter((e) => e === "provider")).toHaveLength(1);
    expect(providerBodies[0].get("From")).toBe(PLATFORM_FROM);
    expect(providerBodies[0].has("MessagingServiceSid")).toBe(false);
  });

  it("with a platform messaging service configured, uses it, as before", async () => {
    process.env.TWILIO_MESSAGING_SERVICE_SID = PLATFORM_MSID;
    await send(reader(ready));
    expect(providerBodies[0].get("MessagingServiceSid")).toBe(PLATFORM_MSID);
    expect(providerBodies[0].has("From")).toBe(false);
  });

  it("listing ANOTHER studio leaves this one on the platform path", async () => {
    process.env[STUDIO_ROUTING_ENV] = B;
    await send(reader(ready));
    expect(events).not.toContain("route_read");
    expect(providerBodies[0].get("From")).toBe(PLATFORM_FROM);
  });
});

describe.each(PATHS)("%s: a routed studio sends from its own sender, after the route and the claim", (_label, send, claimRpc) => {
  it("route read, then claim, then provider; the studio's messaging service only", async () => {
    routeStudioA();
    process.env.TWILIO_MESSAGING_SERVICE_SID = PLATFORM_MSID;
    const r = await send(reader(ready));
    expect(r).toMatchObject({ ok: true, messageSid: SID });
    const route = events.indexOf("route_read");
    const claim = events.indexOf(claimRpc);
    const provider = events.indexOf("provider");
    expect(route).toBe(0);
    expect(claim).toBeGreaterThan(route);
    expect(provider).toBeGreaterThan(claim);
    expect(providerBodies[0].get("MessagingServiceSid")).toBe(MSID_A);
    // The exact pool member whose readiness was checked, never the platform's.
    expect(providerBodies[0].get("From")).toBe("+14165550100");
    expect(JSON.stringify([...providerBodies[0]])).not.toContain(PLATFORM_MSID);
    expect(JSON.stringify([...providerBodies[0]])).not.toContain(PLATFORM_FROM);
  });
});

describe.each(PATHS)("%s: consent and STOP refuse before the route is even read", (_label, send) => {
  for (const [why, client, reason] of [
    ["an opted-out client (STOP)", { ...consenting, sms_opted_out_at: "2026-10-02T00:00:00Z" }, "client_opted_out"],
    ["a client with no consent", { ...consenting, sms_consent_at: null }, "client_no_consent"],
    ["a client with no phone", { ...consenting, phone: null }, "invalid_phone"],
  ] as const) {
    it(`${why}: no route read, no claim, no provider`, async () => {
      routeStudioA();
      const r = await send(reader(ready), client);
      expect(r).toEqual({ ok: false, skipped: true, reason });
      expect(events).toEqual([]);
    });
  }

  it("the studio's switch off: no route read, no claim, no provider", async () => {
    routeStudioA();
    const off = { ...studio, send_confirmation_sms: false, send_24h_sms_reminders: false };
    const r = await send(reader(ready), consenting, off);
    expect(r).toEqual({ ok: false, skipped: true, reason: "studio_toggle_off" });
    expect(events).toEqual([]);
  });

  it("a fenced preview deployment: no route read either", async () => {
    routeStudioA();
    process.env.VERCEL_ENV = "preview";
    const r = await send(reader(ready));
    expect(r).toEqual({ ok: false, skipped: true, reason: "non_production_deployment" });
    expect(events).toEqual([]);
  });
});

const TOLL_FREE = sender({ id: "sender-a-2", phone_number: "+18885550100" });
const staleApproval: SendTimeRegistration = {
  studio_id: A,
  sender_id: "sender-a-1", // the studio's PREVIOUS sender
  kind: "toll_free_verification",
  status: "approved",
  missing_information: null,
};

const REFUSALS: Array<[string, SendTimeRouteRead, string]> = [
  ["an unreadable sender", { ok: false }, "sms_route_sender_read_failed"],
  [
    "WRONG STUDIO: Studio B's ready sender",
    { ok: true, senders: [sender({ id: "sender-b-1", studio_id: B, messaging_service_sid: MSID_B })], registrations: [] },
    "sms_route_sender_wrong_studio",
  ],
  ["no active sender", { ok: true, senders: [sender({ status: "suspended" })], registrations: [] }, "sms_route_no_active_sender"],
  [
    "two active senders",
    { ok: true, senders: [sender(), sender({ id: "sender-a-2", messaging_service_sid: MSID_B })], registrations: [] },
    "sms_route_ambiguous_active_sender",
  ],
  [
    "WRONG SENDER: an active row with no messaging service",
    { ok: true, senders: [sender({ messaging_service_sid: "" })], registrations: [] },
    "sms_route_sender_identity_missing",
  ],
  [
    "STALE REGISTRATION: approval recorded for the previous sender",
    { ok: true, senders: [TOLL_FREE, sender({ status: "released", messaging_service_sid: null })], registrations: [staleApproval] },
    "sms_route_destination_not_ready",
  ],
];

/** Route looks a path takes on an UNREADABLE answer: a one-shot confirmation looks three times. */
const LOOKS = { confirmation: 3, "24h reminder": 1 } as const;
const looksFor = (label: keyof typeof LOOKS, reason: string, ev: string) =>
  Array(reason === "sms_route_sender_read_failed" ? LOOKS[label] : 1).fill(ev);

describe.each(PATHS)("%s: every sender or destination refusal comes before the claim", (label, send) => {
  for (const [why, answer, reason] of REFUSALS) {
    it(`${why}: refused after the read, with no claim and no provider call`, async () => {
      routeStudioA();
      const r = await send(reader(answer));
      expect(r).toEqual({ ok: false, skipped: true, reason });
      expect(events).toEqual(looksFor(label, reason, "route_read"));
    });
  }

  it("UNREADY RECIPIENT: a toll-free client number refuses with no claim and no provider call", async () => {
    routeStudioA();
    const r = await send(reader(ready), { ...consenting, phone: "+18005550123" });
    expect(r).toEqual({ ok: false, skipped: true, reason: "sms_route_recipient_unroutable" });
    expect(events).toEqual(["route_read"]);
  });

  it("a reader that throws refuses the same way", async () => {
    routeStudioA();
    const r = await send(async () => {
      events.push("route_read");
      throw new Error("boom");
    });
    expect(r).toEqual({ ok: false, skipped: true, reason: "sms_route_sender_read_failed" });
    expect(events).toEqual(looksFor(label, "sms_route_sender_read_failed", "route_read"));
  });

  it("a malformed sender row refuses instead of throwing into the send path", async () => {
    routeStudioA();
    const r = await send(reader({ ok: true, senders: [null as unknown as SendTimeSender], registrations: [] }));
    expect(r).toEqual({ ok: false, skipped: true, reason: "sms_route_sender_read_failed" });
    expect(events).toEqual(looksFor(label, "sms_route_sender_read_failed", "route_read"));
  });

  it("PRODUCTION TODAY (0217 unapplied): the snapshot read fails, and a routed studio refuses rather than falling back", async () => {
    routeStudioA();
    const r = await send(undefined);
    expect(r).toEqual({ ok: false, skipped: true, reason: "sms_route_sender_read_failed" });
    expect(events).toEqual(looksFor(label, "sms_route_sender_read_failed", SNAPSHOT_RPC));
    expect(providerBodies).toEqual([]);
  });
});

describe.each(PATHS)("%s: SAFE RETRY: a refusal spends nothing", (_label, send, claimRpc) => {
  it("refused while not ready, then sent exactly once when ready, with one claim in total", async () => {
    routeStudioA();
    let answer: SendTimeRouteRead = { ok: true, senders: [sender({ status: "provisioning" })], registrations: [] };
    const r1 = await send(reader(() => answer));
    expect(r1).toEqual({ ok: false, skipped: true, reason: "sms_route_no_active_sender" });
    answer = ready();
    const r2 = await send(reader(() => answer));
    expect(r2).toMatchObject({ ok: true, messageSid: SID });
    expect(events.filter((e) => e === claimRpc)).toHaveLength(1);
    expect(events.filter((e) => e === "provider")).toHaveLength(1);
    expect(events.filter((e) => e === "route_read")).toHaveLength(2);
  });

  it("a refusal raises no provider-failure alert (nothing was attempted)", async () => {
    routeStudioA();
    await send(reader({ ok: false }));
    await new Promise((r) => setTimeout(r, 0));
    expect(alerts).toEqual([]);
  });
});

describe("the provider module: a routed sender is the only sender", () => {
  it("a blank routed sender is refused before any request, never replaced by the platform's", async () => {
    for (const messagingServiceSid of ["", "   "]) {
      const r = await sendSmsSafely({ to: CA_RECIPIENT, body: "x", messagingServiceSid });
      expect(r).toEqual({ ok: false, error: "twilio_missing_sender", retryable: false, attempt: "none" });
    }
    expect(events).toEqual([]);
  });

  it("a routed sender is used with no platform fallback, even with both platform keys set", async () => {
    process.env.TWILIO_MESSAGING_SERVICE_SID = PLATFORM_MSID;
    await sendSmsSafely({ to: CA_RECIPIENT, body: "x", messagingServiceSid: MSID_A });
    expect(providerBodies[0].get("MessagingServiceSid")).toBe(MSID_A);
    expect(providerBodies[0].has("From")).toBe(false);
  });

  it("PINNED SENDER: a routed send names the exact pool member as From, beside its service", async () => {
    await sendSmsSafely({ to: CA_RECIPIENT, body: "x", messagingServiceSid: MSID_A, fromNumber: "+14165550100" });
    expect(providerBodies[0].get("MessagingServiceSid")).toBe(MSID_A);
    expect(providerBodies[0].get("From")).toBe("+14165550100");
  });

  it("a From without a routed service, or a malformed one, is refused before any request", async () => {
    for (const params of [
      { to: CA_RECIPIENT, body: "x", fromNumber: "+14165550100" },
      { to: CA_RECIPIENT, body: "x", messagingServiceSid: MSID_A, fromNumber: "4165550100" },
      { to: CA_RECIPIENT, body: "x", messagingServiceSid: MSID_A, fromNumber: "" },
    ]) {
      expect(await sendSmsSafely(params)).toEqual({
        ok: false,
        error: "twilio_invalid_sender",
        retryable: false,
        attempt: "none",
      });
    }
    expect(events).toEqual([]);
  });

  it("no routed sender: the platform keys choose, exactly as before", async () => {
    await sendSmsSafely({ to: CA_RECIPIENT, body: "x" });
    expect(providerBodies[0].get("From")).toBe(PLATFORM_FROM);
    delete process.env.TWILIO_FROM_NUMBER;
    const r = await sendSmsSafely({ to: CA_RECIPIENT, body: "x" });
    expect(r).toMatchObject({ ok: false, error: "twilio_missing_sender" });
  });
});

// The DEFAULT reader: 0217's one-statement snapshot, parsed by the SMS lane's
// parseLiveRegistrationState, answered here as the RPC would answer it.
const snapshotOf = (senders: unknown[], registrations: unknown[] = []) => ({
  data: { senders, registrations },
  error: null,
});
const snapRow = (over: Record<string, unknown> = {}) => ({
  id: "sender-a-1",
  studio_id: A,
  status: "active",
  phone_number: "+14165550100",
  messaging_service_sid: MSID_A,
  ...over,
});
const snapReg = (over: Record<string, unknown> = {}) => ({
  sender_id: "sender-a-1",
  studio_id: A,
  kind: "toll_free_verification",
  status: "approved",
  missing_information: null,
  provider_reference: "ref",
  updated_at: "2026-10-01T00:00:00Z",
  ...over,
});

describe.each(PATHS)("%s: through 0217's snapshot (the default reader)", (label, send, claimRpc) => {
  it("a ready snapshot: one snapshot read, then the claim, then the studio's own sender", async () => {
    routeStudioA();
    snapshot = snapshotOf([snapRow()]);
    const r = await send(undefined);
    expect(r).toMatchObject({ ok: true, messageSid: SID });
    expect(events.indexOf(SNAPSHOT_RPC)).toBe(0);
    expect(events.indexOf(claimRpc)).toBeGreaterThan(0);
    expect(events.filter((e) => e === SNAPSHOT_RPC)).toHaveLength(1);
    expect(providerBodies[0].get("MessagingServiceSid")).toBe(MSID_A);
  });

  it("toll-free with its OWN approved verification routes", async () => {
    routeStudioA();
    snapshot = snapshotOf([snapRow({ phone_number: "+18885550100" })], [snapReg()]);
    expect(await send(undefined)).toMatchObject({ ok: true, messageSid: SID });
  });

  for (const [why, snap] of [
    ["WRONG STUDIO: Studio B's sender in A's snapshot", snapshotOf([snapRow({ id: "sender-b-1", studio_id: B, messaging_service_sid: MSID_B })])],
    ["a registration of a sender not in the snapshot", snapshotOf([snapRow({ phone_number: "+18885550100" })], [snapReg({ sender_id: "sender-old" })])],
    ["a registration recorded for another studio", snapshotOf([snapRow({ phone_number: "+18885550100" })], [snapReg({ studio_id: B })])],
    ["a malformed answer (null arrays)", { data: { senders: null, registrations: null }, error: null }],
  ] as const) {
    it(`${why}: refused after the one read, no claim, no provider`, async () => {
      routeStudioA();
      snapshot = snap;
      const r = await send(undefined);
      expect(r).toEqual({ ok: false, skipped: true, reason: "sms_route_sender_read_failed" });
      expect(events).toEqual(looksFor(label, "sms_route_sender_read_failed", SNAPSHOT_RPC));
    });
  }

  it("STALE REGISTRATION: a toll-free sender with no evidence of its own is not ready", async () => {
    routeStudioA();
    snapshot = snapshotOf([snapRow({ phone_number: "+18885550100" })]);
    const r = await send(undefined);
    expect(r).toEqual({ ok: false, skipped: true, reason: "sms_route_destination_not_ready" });
    expect(events).toEqual([SNAPSHOT_RPC]);
  });

  it("two live senders in one snapshot are refused, never chosen between", async () => {
    routeStudioA();
    snapshot = snapshotOf([snapRow(), snapRow({ id: "sender-a-2", messaging_service_sid: MSID_B })]);
    const r = await send(undefined);
    expect(r).toEqual({ ok: false, skipped: true, reason: "sms_route_ambiguous_active_sender" });
    expect(events).toEqual([SNAPSHOT_RPC]);
  });

  it("with the gate unset, the snapshot is never read", async () => {
    snapshot = snapshotOf([snapRow()]);
    await send(undefined);
    expect(events).not.toContain(SNAPSHOT_RPC);
    expect(providerBodies[0].get("From")).toBe(PLATFORM_FROM);
  });
});

describe("a ONE-SHOT confirmation looks again at an unreadable route; a reminder does not", () => {
  it("confirmation: unreadable, then readable on the second look: one claim, one send", async () => {
    routeStudioA();
    const answers: SendTimeRouteRead[] = [{ ok: false }, ready()];
    const r = await confirmation(reader(() => answers.shift() ?? ready()));
    expect(r).toMatchObject({ ok: true, messageSid: SID });
    expect(events.filter((e) => e === "route_read")).toHaveLength(2);
    expect(events.filter((e) => e === "claim_sms_send")).toHaveLength(1);
    expect(events.indexOf("claim_sms_send")).toBeGreaterThan(events.lastIndexOf("route_read"));
    expect(providerBodies[0].get("MessagingServiceSid")).toBe(MSID_A);
  });

  it("confirmation: a configuration refusal is NOT retried (a second look cannot change it)", async () => {
    routeStudioA();
    const r = await confirmation(reader({ ok: true, senders: [sender({ status: "suspended" })], registrations: [] }));
    expect(r).toEqual({ ok: false, skipped: true, reason: "sms_route_no_active_sender" });
    expect(events).toEqual(["route_read"]);
  });

  it("reminder: one look; the cron's next pass is its retry", async () => {
    routeStudioA();
    const r = await reminder(reader({ ok: false }));
    expect(r).toEqual({ ok: false, skipped: true, reason: "sms_route_sender_read_failed" });
    expect(events).toEqual(["route_read"]);
  });
});
