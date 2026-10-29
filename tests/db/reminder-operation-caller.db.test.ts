import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL } from "@/e2e/helpers/local-env";
import { adminQuery, closePool, seedStudio } from "@/tests/db/helpers/harness";

vi.mock("server-only", () => ({}));

// getResendTransport() builds a fresh fake per call; share one so sends are countable.
const sdk = vi.hoisted(() => ({ send: vi.fn(), shared: null as unknown }));
vi.mock("@/lib/email/client", async (orig) => {
  const actual = await orig<typeof import("@/lib/email/client")>();
  return {
    ...actual,
    getResendTransport: () => {
      if (!sdk.shared) {
        const inner = actual.getResendTransport()!;
        sdk.shared = { emails: { send: (...a: unknown[]) => { sdk.send(...a); return (inner.emails.send as (...x: unknown[]) => unknown)(...a); } } };
      }
      return sdk.shared;
    },
  };
});

// 0247 compatibility, caller side, on a REAL migrated database: the application's
// operation caller sends one reminder through the sealed 0247 authority (offline
// fake Resend, no egress), settles it, and cannot send it twice. Runs only where
// 0247 exists; on a database without it the mode test proves the legacy side.

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}
const admin = createClient(E2E_SUPABASE_URL, E2E_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const digest = (s: string) => createHash("sha256").update(s).digest("hex");

let has0247 = false;
beforeAll(async () => {
  const r = await adminQuery("select count(*)::int as n from pg_proc where proname = 'inspect_appointment_email_operation'");
  has0247 = (r.rows[0] as { n: number }).n > 0;
  vi.stubEnv("HONE_E2E_FAKE_RESEND", "1");
  vi.stubEnv("NEXT_PUBLIC_APP_ORIGIN", "https://example.invalid");
  vi.stubEnv("APPOINTMENT_SIGNING_SECRET", "synthetic-appointment-secret-32-bytes");
  vi.stubEnv("INTAKE_SIGNING_SECRET", "synthetic-intake-secret-32-bytes");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await closePool();
});

async function fixture(label: string) {
  const studio = await seedStudio(label);
  await adminQuery("update public.clients set email='synthetic@harness.local' where id=$1 and studio_id=$2", [studio.clientId, studio.studioId]);
  await adminQuery("update public.studios set send_24h_reminders=true, send_intake_reminders=false where id=$1", [studio.studioId]);
  const appointmentId = (await adminQuery(`insert into public.appointments
    (studio_id,practitioner_id,client_id,starts_at,ends_at,duration_minutes,status,buffer_minutes_snapshot,blocked_ends_at,cancellation_token_hash)
    values($1,$2,$3,now()+interval '24 hours',now()+interval '25 hours',60,'confirmed',15,now()+interval '1 hour 15 minutes' + interval '24 hours',$4) returning id`,
    [studio.studioId, studio.practitionerId, studio.clientId, digest(`${studio.studioId}:${label}`)])).rows[0].id as string;
  return { studio, appointmentId };
}

describe("operation caller against the sealed 0247 authority", () => {
  it("sends once, settles the reminder, and a second call cannot send it again", async () => {
    if (!has0247) return; // legacy database: covered by reminder-authority-mode.db.test.ts
    const { sendAppointmentReminderOperation } = await import("@/lib/email/send-appointment");
    sdk.send.mockClear();
    const { studio, appointmentId } = await fixture("op-caller-once");

    const first = await sendAppointmentReminderOperation(admin, studio.studioId, appointmentId, "reminder_24h");
    expect(first.kind).not.toBe("held");
    expect(first).toMatchObject({ observation: { kind: "accepted" } });
    expect(sdk.send).toHaveBeenCalledTimes(1);
    const sent = await adminQuery("select reminder_24h_sent_at from public.appointments where id=$1 and studio_id=$2", [appointmentId, studio.studioId]);
    expect(sent.rows[0].reminder_24h_sent_at, "an accepted send settles the reminder").not.toBeNull();

    const second = await sendAppointmentReminderOperation(admin, studio.studioId, appointmentId, "reminder_24h");
    expect(second).toEqual({ kind: "held" });
    expect(sdk.send, "no second SDK call").toHaveBeenCalledTimes(1);
  });

  it("an ineligible (cancelled) appointment is held and nothing reaches the provider", async () => {
    if (!has0247) return;
    const { sendAppointmentReminderOperation } = await import("@/lib/email/send-appointment");
    sdk.send.mockClear();
    const { studio, appointmentId } = await fixture("op-caller-cancelled");
    await adminQuery("update public.appointments set status='cancelled' where id=$1 and studio_id=$2", [appointmentId, studio.studioId]);
    expect(await sendAppointmentReminderOperation(admin, studio.studioId, appointmentId, "reminder_24h")).toEqual({ kind: "held" });
    expect(sdk.send).not.toHaveBeenCalled();
  });
});
