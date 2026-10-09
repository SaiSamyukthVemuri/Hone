import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// SMS-02 — the reminder cron's INTAKE-LINK ACCOUNTING for SMS (Codex P2
// 4232680581), driven through the real route and the real send helper.
//
// The cron stamps intake-link issue (stampIntakeLinkIssued: count + 1, expiry
// refreshed, never `last_sent_at`, which means "emailed") exactly when the
// link may be in the client's hands: the SMS that carried it was ACCEPTED, or
// POSSIBLY accepted (an ambiguous answer: recorded sent, never retried, still
// counted as a failed attempt). Never for a definite refusal or a skipped
// send, where the link never left Hone, and never for a message that did not
// carry it. What the message carried is reported by the send helper.
//
// Real: the route's passes, the send helper, the consent gate, the fence, the
// reminder claim wrapper, the transport's classification, and the intake-link
// minting and stamping helpers. Substituted: the database, cron auth, the
// heartbeat writer, ops alerts and the network.
// ===========================================================================

const h = vi.hoisted(() => {
  const START = "2026-10-09T17:00:00.000Z";
  const state = {
    claim: "claimed" as "claimed" | "not_claimed" | "error",
    intakeStatus: "in_progress",
    rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
    intakeUpdates: [] as Array<Record<string, unknown>>,
  };
  const APPT = {
    id: "appt-1",
    studio_id: "studio-1",
    client_id: "client-1",
    status: "confirmed",
    starts_at: START,
    service: { name: "Consultation", default_duration_minutes: 30, pre_care_instructions: null },
    studio: {
      id: "studio-1",
      name: "Willow",
      timezone: "America/Vancouver",
      send_confirmation_sms: false,
      send_24h_sms_reminders: true,
      send_2h_sms_reminders: true,
      // ON: the SMS reminder carries the intake CTA while the intake is open.
      send_intake_reminders: true,
    },
    client: {
      name: "Client",
      email: null,
      phone: "604-555-0199",
      sms_consent_at: "2026-09-01T00:00:00Z",
      sms_opted_out_at: null,
    },
    practitioner: null,
  };

  type Filter = [op: string, column: string, value: unknown];
  function query(table: string) {
    const filters: Filter[] = [];
    let patch: Record<string, unknown> | null = null;
    const answer = () => {
      if (patch) {
        state.intakeUpdates.push(patch);
        return { data: null, error: null };
      }
      // Only the 24h SMS window has a row.
      const sms24 = filters.some(([op, c]) => op === "is" && c === "sms_reminder_24h_sent_at");
      return { data: table === "appointments" && sms24 ? [APPT] : [], error: null };
    };
    const b: Record<string, unknown> = {};
    for (const m of ["select", "order", "limit"]) b[m] = () => b;
    for (const op of ["eq", "is", "lt", "gte", "lte"]) {
      b[op] = (column: string, value: unknown) => {
        filters.push([op, column, value]);
        return b;
      };
    }
    b.update = (p: Record<string, unknown>) => {
      if (table !== "client_intake_forms") throw new Error(`unexpected update on ${table}`);
      patch = p;
      return b;
    };
    b.maybeSingle = () =>
      Promise.resolve(
        table === "client_intake_forms"
          ? // The cron's live intake read (id, status) and the stamp's count read.
            { data: { id: "intake-1", status: state.intakeStatus, intake_link_send_count: 1 }, error: null }
          : { data: { status: "confirmed" }, error: null },
      );
    b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(answer()).then(resolve, reject);
    return b;
  }

  const admin = {
    from: (table: string) => query(table),
    rpc: (fn: string, args: Record<string, unknown>) => {
      state.rpcs.push({ fn, args });
      if (fn === "claim_reminder_sms_send") {
        if (state.claim === "error") return Promise.resolve({ data: null, error: { message: "connection refused" } });
        return Promise.resolve({ data: [{ result: state.claim, starts_at: START }], error: null });
      }
      if (fn === "begin_appointment_sms_message") {
        return Promise.resolve({ data: "0b8f1c1e-6a52-4c0e-9f3e-2f6c3c1a7d10", error: null });
      }
      if (fn === "settle_sms_message") return Promise.resolve({ data: "settled", error: null });
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { state, admin };
});

vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => h.admin }));
vi.mock("@/lib/cron/auth", () => ({ isAuthorizedCronRequest: () => true }));
vi.mock("@/lib/cron/reminder-heartbeat", () => ({ recordReminderRunSuccess: () => Promise.resolve() }));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: () => Promise.resolve() }));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://hone.care" }));

import { GET } from "@/app/api/cron/appointment-reminders/route";

const ENV_KEYS = [
  "VERCEL_ENV",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
  "INTAKE_SIGNING_SECRET",
] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let fetchMock: ReturnType<typeof vi.fn>;
const SID = `SM${"3c".repeat(16)}`;
const answer = (status: number, body: unknown) => () =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  delete process.env.VERCEL_ENV;
  process.env.TWILIO_ACCOUNT_SID = `AC${"1".repeat(32)}`;
  process.env.TWILIO_AUTH_TOKEN = "token";
  process.env.TWILIO_FROM_NUMBER = "+15550001111";
  // A test fixture, not a credential: the intake link is minted for real.
  process.env.INTAKE_SIGNING_SECRET = "reminder-sms-intake-stamp-fixture".padEnd(48, "x");
  h.state.claim = "claimed";
  h.state.intakeStatus = "in_progress";
  h.state.rpcs = [];
  h.state.intakeUpdates = [];
  fetchMock = vi.fn(answer(201, { sid: SID }));
  vi.stubGlobal("fetch", fetchMock);
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

async function run() {
  const res = await GET(new Request("https://hone.care/api/cron/appointment-reminders"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, Record<string, number>>;
  const recorded = h.state.rpcs.filter((r) => r.fn === "record_sms_result").map((r) => r.args.p_success);
  return { sms24: body.sms_reminder_24h!, recorded };
}

function sentBody(): string {
  const init = fetchMock.mock.calls[0]?.[1] as { body?: unknown } | undefined;
  return new URLSearchParams(String(init?.body ?? "")).get("Body") ?? "";
}

function expectStampedOnce() {
  expect(h.state.intakeUpdates, "intake-link metadata left stale").toHaveLength(1);
  expect(h.state.intakeUpdates[0]).toMatchObject({ intake_link_send_count: 2 });
  expect(h.state.intakeUpdates[0]).toHaveProperty("intake_link_expires_at");
  expect(h.state.intakeUpdates[0], "an SMS never claims an email went").not.toHaveProperty(
    "intake_link_last_sent_at",
  );
}

describe("STAMPED: the SMS carrying the link was accepted or possibly accepted", () => {
  it("accepted: stamped once", async () => {
    const { sms24, recorded } = await run();
    expect(sentBody()).toContain("https://hone.care/intake/");
    expect(recorded).toEqual([true]);
    expect(sms24).toMatchObject({ attempted: 1, succeeded: 1, failed: 0, intakeCtaIncluded: 1 });
    expectStampedOnce();
  });

  for (const [label, impl] of [
    ["a Twilio 5xx", answer(503, { message: "upstream" })],
    ["a success without a readable SID", answer(201, { sid: "not-a-sid" })],
  ] as const) {
    it(`POSSIBLY sent (${label}): sent once, recorded sent, counted failed, and stamped`, async () => {
      fetchMock.mockImplementation(impl);
      const { sms24, recorded } = await run();
      expect(fetchMock, "an ambiguous attempt is never retried").toHaveBeenCalledTimes(1);
      expect(sentBody()).toContain("https://hone.care/intake/");
      expect(recorded, "recorded as sent: no later fire retries it").toEqual([true]);
      // Provider-attempt counters are unchanged: an attempt, not proven delivered.
      expect(sms24).toMatchObject({ attempted: 1, succeeded: 0, failed: 1, skipped: 0, intakeCtaIncluded: 1 });
      expectStampedOnce();
    });
  }
});

describe("NOT stamped: the link never left Hone, or the message did not carry it", () => {
  it("a definite refusal carrying the link", async () => {
    fetchMock.mockImplementation(answer(400, { code: 21211, message: "invalid To" }));
    const { sms24, recorded } = await run();
    expect(sentBody()).toContain("https://hone.care/intake/");
    expect(recorded).toEqual([false]);
    expect(sms24).toMatchObject({ attempted: 1, failed: 1, intakeCtaIncluded: 0 });
    expect(h.state.intakeUpdates).toEqual([]);
  });

  for (const [label, claim] of [
    ["a claim refused (another run holds the slot)", "not_claimed"],
    ["a claim that could not be reached", "error"],
  ] as const) {
    it(`a skipped send: ${label}`, async () => {
      h.state.claim = claim;
      const { sms24 } = await run();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(sms24).toMatchObject({ attempted: 0, skipped: 1, intakeCtaIncluded: 0 });
      expect(h.state.intakeUpdates).toEqual([]);
    });
  }

  for (const [label, impl] of [
    ["accepted", answer(201, { sid: SID })],
    ["possibly sent", answer(503, {})],
  ] as const) {
    it(`a message that did not carry the link (intake already submitted), ${label}`, async () => {
      h.state.intakeStatus = "submitted";
      fetchMock.mockImplementation(impl);
      const { sms24 } = await run();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sentBody()).not.toContain("/intake/");
      expect(sms24.intakeCtaIncluded).toBe(0);
      expect(h.state.intakeUpdates).toEqual([]);
    });
  }
});
