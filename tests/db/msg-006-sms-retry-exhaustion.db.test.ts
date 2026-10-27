import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL } from "@/e2e/helpers/local-env";
import { adminQuery, closePool, seedStudio } from "@/tests/db/helpers/harness";

// ===========================================================================
// MSG-006: EXHAUSTED SMS RETRIES, END TO END, with zero real egress.
//
// The path under test is the REAL one, not a model of it:
//
//   send24hReminderSmsToClient (lib/sms/send-appointment.ts)
//     -> claim_reminder_sms_send / claim_sms_send   (real RPCs, real PostgREST)
//     -> sendSmsSafely (lib/sms/twilio.ts) -> fetch to api.twilio.com
//     -> record_sms_result, the ledger row, logSmsFailure -> recordOpsAlert
//     -> public.ops_alerts
//
// The ONLY substitution is the network: the #1117 Twilio egress fake
// (e2e/helpers/twilio-egress-fake.cjs) is armed in this process, refusing the
// connection before it opens (ECONNREFUSED, the default mode), with
// tests/fixtures/twilio-socket-backstop.cjs underneath it so a broken fake
// fails here instead of reaching Twilio.
//
// WHAT IT PROVES
//   1. Attempts 1 and 2 are retryable and raise NO alert; attempt 3 (the cap,
//      claim_sms_send's `attempts < 3`) raises ONE `sms_send_failed` warning
//      alert that carries the failure CLASS (twilio_unreachable) and the
//      attempt count.
//   2. The alert row, and everything the fake saw, carries no PII: no phone,
//      no client name, no studio name, no message text.
//   3. The send records its TERMINAL state: attempts = 3, never marked sent,
//      claim released, every ledger row `refused` (a definite non-send), and a
//      fourth try is refused by the claim and never reaches the provider.
//   4. CONTROL: a 503 is AMBIGUOUS, so it is recorded as sent, never retried,
//      ledgered `unknown`, and alerts immediately (not after three).
//
// Synthetic studio, client and numbers only (+1 604 555 01xx, a fictional range).
// ===========================================================================

// supabase-js needs a global WebSocket at construction; Node 20 has none and
// this test opens no realtime channel (the same stub other DB tests use).
if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

const ROOT = process.cwd();
const FAKE = path.join(ROOT, "e2e", "helpers", "twilio-egress-fake.cjs");
const BACKSTOP = path.join(ROOT, "tests", "fixtures", "twilio-socket-backstop.cjs");

const REFUSED_PHONE = "+16045550142"; // default mode: refused before connecting
const AMBIGUOUS_PHONE = "+16045550153"; // ...0153: the scripted 503
const STUDIO_NAME = "Quartermain Lashworks";
const CLIENT_NAME = "Zelda Quartermain";

type Fake = Record<symbol, { active?: boolean } | undefined>;

let logDir = "";
let logFile = "";
let send24h: typeof import("@/lib/sms/send-appointment").send24hReminderSmsToClient;
const admin = () => createClient(E2E_SUPABASE_URL, E2E_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const hits = () =>
  (globalThis as Record<symbol, string[] | undefined>)[Symbol.for("hone.test.twilioBackstopHits")] ?? [];
const fakeRecords = (): Array<Record<string, unknown>> =>
  (existsSync(logFile) ? readFileSync(logFile, "utf8") : "")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

beforeAll(async () => {
  for (const name of ["VERCEL", "VERCEL_ENV", "AWS_REGION", "AWS_EXECUTION_ENV", "KUBERNETES_SERVICE_HOST", "TWILIO_MESSAGING_SERVICE_SID"]) {
    vi.stubEnv(name, "");
  }
  logDir = mkdtempSync(path.join(os.tmpdir(), "msg-006-exhaustion-"));
  logFile = path.join(logDir, "twilio.jsonl");
  vi.stubEnv("HONE_E2E_TWILIO_EGRESS_LOG", logFile);
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC00000000000000000000000000000000");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "dummy-twilio-token");
  vi.stubEnv("TWILIO_FROM_NUMBER", "+15555550100");
  // recordOpsAlert and the ledger build their own service-role client from env.
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", E2E_SUPABASE_URL);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", E2E_SERVICE_ROLE_KEY);
  // Never email an operator from a test, whatever the environment carries.
  vi.stubEnv("OPS_ALERT_EMAILS", "");

  const load = createRequire(__filename);
  load(BACKSTOP); // underneath, exactly as in tests/scripts/twilio-egress-fake.test.ts
  load(FAKE);
  // INTERLOCK: never call the sender unless the fake armed in this process.
  expect((globalThis as Fake)[Symbol.for("hone.e2e.twilioEgressFake")]?.active).toBe(true);

  ({ send24hReminderSmsToClient: send24h } = await import("@/lib/sms/send-appointment"));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (logDir) rmSync(logDir, { recursive: true, force: true });
  await closePool();
});

type Fixture = { studioId: string; appointmentId: string; phone: string; window: { startIso: string; endIso: string } };

/** A studio with SMS reminders on, a consenting client, and a confirmed appointment inside the window. */
async function fixture(label: string, phone: string): Promise<Fixture> {
  const s = await seedStudio(`msg006-${label}`);
  await adminQuery(
    `update public.studios set name = $2, send_24h_sms_reminders = true where id = $1`,
    [s.studioId, STUDIO_NAME],
  );
  await adminQuery(
    `update public.clients set name = $2, phone = $3, sms_consent_at = now() where id = $1`,
    [s.clientId, CLIENT_NAME, phone],
  );
  const starts = new Date(Date.now() + 24 * 3_600_000);
  const ends = new Date(starts.getTime() + 3_600_000);
  const appt = await adminQuery(
    `insert into public.appointments
       (id, studio_id, client_id, practitioner_id, starts_at, ends_at, duration_minutes,
        buffer_minutes_snapshot, blocked_ends_at, status)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, 60, 0, $5, 'confirmed') returning id`,
    [s.studioId, s.clientId, s.practitionerId, starts.toISOString(), ends.toISOString()],
  );
  return {
    studioId: s.studioId,
    appointmentId: appt.rows[0].id as string,
    phone,
    window: {
      startIso: new Date(starts.getTime() - 3_600_000).toISOString(),
      endIso: new Date(starts.getTime() + 3_600_000).toISOString(),
    },
  };
}

function sendOnce(f: Fixture) {
  return send24h({
    admin: admin(),
    appointmentId: f.appointmentId,
    window: f.window,
    timezone: "UTC",
    studio: {
      id: f.studioId,
      name: STUDIO_NAME,
      send_confirmation_sms: true,
      send_24h_sms_reminders: true,
      send_2h_sms_reminders: false,
    },
    client: { phone: f.phone, sms_consent_at: new Date().toISOString(), sms_opted_out_at: null },
    manageUrlFor: () => null,
    intakeUrl: null,
  });
}

const alertsFor = async (studioId: string) =>
  (await adminQuery(`select * from public.ops_alerts where studio_id = $1 and event = 'sms_send_failed' order by created_at`, [studioId])).rows;

/** The alert insert is fire-and-forget; wait for it rather than sleeping a fixed time. */
async function waitForAlerts(studioId: string, count: number, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await alertsFor(studioId);
    if (rows.length >= count || Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 750));

const appointmentRow = async (id: string) =>
  (await adminQuery(
    `select sms_reminder_24h_send_attempts as attempts, sms_reminder_24h_sent_at as sent_at, sms_reminder_24h_claimed_at as claimed_at
       from public.appointments where id = $1`,
    [id],
  )).rows[0];

const ledgerStatuses = async (appointmentId: string) =>
  (await adminQuery(
    `select status from public.sms_outbound_messages where appointment_id = $1 and purpose = 'appointment_reminder_24h' order by created_at`,
    [appointmentId],
  )).rows.map((r) => r.status as string);

describe("MSG-006: exhausted SMS retries (pre-connection refusal, the default fake mode)", () => {
  it("retries twice silently, alerts once at the cap with the failure CLASS and no PII, and records a terminal state", async () => {
    const f = await fixture("exhaust", REFUSED_PHONE);
    const before = fakeRecords().length;

    // ATTEMPTS 1 AND 2: a definite refusal, retryable, no alert.
    for (const n of [1, 2]) {
      const r = await sendOnce(f);
      expect(r, `attempt ${n}`).toMatchObject({ ok: false, error: "twilio_unreachable", retryable: true });
      expect((await appointmentRow(f.appointmentId)).attempts).toBe(n);
    }
    await settle();
    expect(await alertsFor(f.studioId), "no alert before the cap").toEqual([]);

    // ATTEMPT 3: the cap. One warning alert.
    const third = await sendOnce(f);
    expect(third).toMatchObject({ ok: false, error: "twilio_unreachable", retryable: true });
    const alerts = await waitForAlerts(f.studioId, 1);
    await settle();
    const all = await alertsFor(f.studioId);
    expect(all, "exactly one alert, at the cap").toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: "warning",
      event: "sms_send_failed",
      studio_id: f.studioId,
      appointment_id: f.appointmentId,
      route: "lib/sms/send-appointment",
    });
    // The failure CLASS and the attempt count, as safe structured details.
    expect(alerts[0].safe_details).toMatchObject({
      sms_type: "reminder_24h",
      attempt_number: 3,
      retryable: true,
      provider_error: "twilio_unreachable",
    });
    expect(alerts[0].message).toContain("gave up after 3 attempts");

    // NO PII anywhere on the row: not the phone (any common rendering), the
    // client's name, the studio's name or the message text.
    const blob = JSON.stringify(alerts[0]).toLowerCase();
    for (const secret of [
      "6045550142",
      "604 555",
      "(604)",
      CLIENT_NAME.toLowerCase(),
      "zelda",
      STUDIO_NAME.toLowerCase(),
      "quartermain",
      "reminder:", // the body's own opening words are never copied
      "your appointment",
    ]) {
      expect(blob, `the alert carries ${secret}`).not.toContain(secret);
    }

    // TERMINAL STATE of the send: three attempts spent, never marked sent, the
    // claim released, and every ledger row a definite non-send.
    const row = await appointmentRow(f.appointmentId);
    expect(row.attempts).toBe(3);
    expect(row.sent_at).toBeNull();
    expect(row.claimed_at).toBeNull();
    expect(await ledgerStatuses(f.appointmentId)).toEqual(["refused", "refused", "refused"]);

    // A FOURTH try is refused by the claim and never reaches the provider.
    const recordsAfterThree = fakeRecords().length;
    const fourth = await sendOnce(f);
    expect(fourth).toMatchObject({ ok: false, skipped: true, reason: "not_claimed" });
    expect(fakeRecords().length).toBe(recordsAfterThree);
    expect((await appointmentRow(f.appointmentId)).attempts).toBe(3);

    // WHAT THE FAKE SAW: exactly the three attempts, each refused before
    // connecting, and nothing that identifies the studio, the client or the text.
    const seen = fakeRecords().slice(before);
    expect(seen).toHaveLength(3);
    for (const rec of seen) {
      expect(rec).toMatchObject({ kind: "message", via: "fetch", host: "api.twilio.com", mode: "refuse", toLast4: "0142" });
    }
    const seenBlob = JSON.stringify(seen).toLowerCase();
    expect(seenBlob).not.toContain("6045550142");
    expect(seenBlob).not.toContain("quartermain");

    // The backstop never fired: nothing went anywhere but the fake.
    expect(hits()).toEqual([]);
  }, 90_000);

  it("a different studio's alerts are untouched (the alert is scoped to the studio that exhausted)", async () => {
    const a = await fixture("scope-a", REFUSED_PHONE);
    const b = await fixture("scope-b", REFUSED_PHONE);
    for (let i = 0; i < 3; i += 1) await sendOnce(a);
    await waitForAlerts(a.studioId, 1);
    await settle();
    expect(await alertsFor(a.studioId)).toHaveLength(1);
    expect(await alertsFor(b.studioId)).toEqual([]);
  }, 90_000);
});

describe("MSG-006 control: an ambiguous 503 is recorded as sent and never retried", () => {
  it("is ledgered `unknown`, marked sent, alerts on the FIRST attempt, and a second try never reaches the provider", async () => {
    const f = await fixture("ambiguous", AMBIGUOUS_PHONE);
    const before = fakeRecords().length;

    const first = await sendOnce(f);
    expect(first).toMatchObject({ ok: false, possiblySent: true, retryable: false });
    const alerts = await waitForAlerts(f.studioId, 1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].safe_details).toMatchObject({
      sms_type: "reminder_24h",
      retryable: false,
    });
    expect(String((alerts[0].safe_details as Record<string, unknown>).provider_error)).toMatch(/:outcome_unknown$/);
    expect(JSON.stringify(alerts[0]).toLowerCase()).not.toContain("6045550153");

    // Possibly sent counts as sent: marked, claim released, ledger `unknown`.
    const row = await appointmentRow(f.appointmentId);
    expect(row.sent_at).not.toBeNull();
    expect(row.claimed_at).toBeNull();
    expect(await ledgerStatuses(f.appointmentId)).toEqual(["unknown"]);

    const second = await sendOnce(f);
    expect(second).toMatchObject({ ok: false, skipped: true, reason: "not_claimed" });
    const seen = fakeRecords().slice(before);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ mode: "ambiguous_503", toLast4: "0153" });
    expect(hits()).toEqual([]);
  }, 90_000);
});
