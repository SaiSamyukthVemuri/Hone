import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { NEW_CLIENT_WAITLIST_SLUGS_ENV } from "@/lib/booking/new-client-waitlist";

// Reproductions for the two reviewed findings, written BEFORE the repair.
//   P2-A  a non-array weekday representation is coerced to "every day"
//   P3-A  a refused consume leaves a newly-created client row behind

const STUDIO_ID = "22222222-2222-4222-8222-222222222222";
const SERVICE_ID = "55555555-5555-4555-8555-555555555555";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const APPT_ID = "66666666-6666-4666-8666-666666666666";
const SLUG = "waitlisted-studio";
const TOKEN = "a".repeat(64);
const CAP = "b".repeat(64);
const EMAIL = "chloe@example.test";
const HASH = createHash("sha256").update(EMAIL, "utf8").digest("hex");
const START = new Date("2026-10-07T14:00:00.000Z"); // a WEDNESDAY in Toronto
const START_ISO = START.toISOString();

const rpcCalls: string[] = [];
const clientWrites: Array<{ table: string; op: string }> = [];
const scenario = { weekdays: null as unknown, redeemResult: "redeemed" as string };

function makeChain(table: string) {
  const chain: Record<string, unknown> = {};
  const self = () => chain as never;
  let inserted = false;
  const result = () => {
    if (table === "services") return { count: 3, data: [], error: null };
    if (table === "studio_availability_default") {
      return { data: [{ is_open: true, open_time: "09:00", close_time: "17:00" },
                       { is_open: true, open_time: "09:00", close_time: "17:00" }], error: null };
    }
    return { data: null, error: null, count: 0 };
  };
  Object.assign(chain, {
    select: self, eq: self, is: self, not: self, in: self, order: self, limit: self,
    insert: () => { clientWrites.push({ table, op: "insert" }); if (table === "clients") inserted = true; return chain; },
    update: () => { clientWrites.push({ table, op: "update" }); return chain; },
    delete: () => { clientWrites.push({ table, op: "delete" }); return chain; },
    upsert: () => { clientWrites.push({ table, op: "upsert" }); return chain; },
    maybeSingle: async () =>
      table === "services"
        ? { data: { id: SERVICE_ID, studio_id: STUDIO_ID, name: "Consultation",
                    modality: "consultation", default_duration_minutes: 45, active: true }, error: null }
        : { data: null, error: null },
    single: async () =>
      table === "clients" && inserted
        ? { data: { id: CLIENT_ID, name: "Chloe", email: EMAIL, phone: null,
                    sms_consent_at: null, sms_opted_out_at: null }, error: null }
        : { data: null, error: null },
    then: (r: (v: unknown) => unknown) => Promise.resolve(result()).then(r),
  });
  return chain;
}

const admin = {
  from: (t: string) => makeChain(t),
  rpc: async (fn: string) => {
    rpcCalls.push(fn);
    if (fn === "resolve_new_client_waitlist_invitation") {
      return { data: [{ result: "live", invitation_id: "inv-1", studio_id: STUDIO_ID,
        entry_id: "entry-1", scope_service_id: SERVICE_ID, scope_start_date: "2026-10-01",
        scope_end_date: "2026-10-31", scope_allowed_weekdays: scenario.weekdays,
        expires_at: "2026-10-31T12:00:00Z", recipient_contact_hash: HASH }], error: null };
    }
    if (fn === "redeem_new_client_waitlist_invitation_verified") {
      return { data: [{ result: scenario.redeemResult, studio_id: STUDIO_ID, entry_id: "entry-1" }], error: null };
    }
    if (fn === "create_public_appointment") {
      return { data: [{ result: "created", appointment_id: APPT_ID, created_at: new Date().toISOString() }], error: null };
    }
    return { data: null, error: null };
  },
};

vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => admin }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/rate-limit/public", () => ({
  limitPublicBooking: async () => ({ allowed: true }),
  limitPublicSlots: async () => ({ allowed: true }), RATE_LIMIT_MESSAGE: "rate limited" }));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://studio.example.test" }));
vi.mock("@/lib/booking/queries", () => ({
  getStudioBySlug: async () => ({ id: STUDIO_ID, slug: SLUG, name: "S", owner_email: "o@s.test",
    timezone: "America/Toronto", default_appointment_duration_minutes: 45, buffer_minutes: 0,
    public_booking_horizon_months: 6, send_confirmation_emails: false,
    show_treatment_time_to_clients: false, notify_practitioner_on_new_booking: false }) }));
vi.mock("@/lib/booking/slots", () => ({
  getAvailableSlots: async () => [{ start: START_ISO, end: new Date(START.getTime() + 45 * 60_000).toISOString() }],
  filterFutureSlots: (s: unknown[]) => s }));
vi.mock("@/lib/booking/readiness", () => ({ isPubliclyBookable: () => true, UNAVAILABLE_PUBLIC_BOOKING_MESSAGE: "u" }));
vi.mock("@/lib/booking/horizon", () => ({ isWithinPublicBookingHorizon: () => true,
  horizonRangeInStudioTz: () => ({ min: "2020-01-01", max: "2030-01-01" }), maxPublicBookingHorizonDays: () => 400 }));
vi.mock("@/lib/intake/queries", () => ({ ensureIntakeForClient: async () => ({ id: "i", url: "https://x/i" }) }));
vi.mock("@/lib/treatment-time/queries", () => ({ buildTreatmentTimeLine: () => null,
  getTreatmentTimeContextForEmail: async () => ({ sessionCount: 0, totalMinutes: 0 }) }));
vi.mock("@/lib/email/send-appointment", () => ({ sendBookingConfirmationToClient: async () => ({ ok: true }),
  sendBookingNotificationToPractitioner: async () => ({ ok: true }), recordEmailAttempt: async () => {}, logEmailFailure: () => {} }));
vi.mock("@/lib/sms/send-appointment", () => ({ sendBookingConfirmationSmsToClient: async () => ({ ok: false, skipped: true }) }));
vi.mock("@/lib/conversion/dispatch", () => ({ dispatchBookingConversion: async () => {} }));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: () => {} }));
vi.mock("@/lib/notifications/practitioner-notifications", () => ({ recordPractitionerNotification: () => {} }));

const { publicBookAppointmentAction } = await import("@/app/book/[slug]/actions");

function form(over: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("slug", SLUG); fd.set("service_id", SERVICE_ID); fd.set("starts_at", START_ISO);
  fd.set("name", "Chloe"); fd.set("email", EMAIL); fd.set("phone", "+15550111"); fd.set("client_type", "new");
  for (const [k, v] of Object.entries(over)) fd.set(k, v);
  return fd;
}
const clientRowsCreated = () => clientWrites.filter((w) => w.table === "clients" && w.op === "insert").length;

beforeEach(() => {
  process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = SLUG;
  rpcCalls.length = 0; clientWrites.length = 0;
  scenario.weekdays = null; scenario.redeemResult = "redeemed";
});

describe("P2-A — the allowed-weekday authority must fail CLOSED", () => {
  it("refuses a Wednesday against a Mondays-only offer (canonical array form)", async () => {
    scenario.weekdays = [1];
    const out = await publicBookAppointmentAction(form({ invitation_token: TOKEN, invitation_capability: CAP }));
    expect(out.ok).toBe(false);
  });

  it("SQL NULL still means every day inside the range", async () => {
    scenario.weekdays = null;
    const out = await publicBookAppointmentAction(form({ invitation_token: TOKEN, invitation_capability: CAP }));
    expect(out.ok).toBe(true);
  });

  // THE DEFECT: any representation the canonical reader cannot establish as
  // permitting this slot must refuse. It must NOT widen to "every day".
  it.each([
    ["a Postgres array literal string", "{1}"],
    ["a bare number", 1],
    ["an object", { 0: 1 }],
    ["a comma string", "1,3"],
  ])("refuses when the weekday authority is unreadable: %s", async (_label, weekdays) => {
    scenario.weekdays = weekdays;
    const out = await publicBookAppointmentAction(form({ invitation_token: TOKEN, invitation_capability: CAP }));
    expect(out.ok, "an unreadable weekday authority must never authorise").toBe(false);
  });
});

describe("P3-A — a refused consume must leave no newly-created client row", () => {
  it("POSITIVE CONTROL: an accepted consume still books and creates its client", async () => {
    const out = await publicBookAppointmentAction(form({ invitation_token: TOKEN, invitation_capability: CAP }));
    expect(out.ok).toBe(true);
    expect(rpcCalls).toContain("create_public_appointment");
  });

  it.each(["proof_expired", "proof_invalid", "proof_required", "not_live"])(
    "creates no appointment and no client row when the consume answers %s",
    async (code) => {
      scenario.redeemResult = code;
      const out = await publicBookAppointmentAction(form({ invitation_token: TOKEN, invitation_capability: CAP }));
      expect(out.ok).toBe(false);
      expect(rpcCalls).not.toContain("create_public_appointment");
      expect(clientRowsCreated(), "a refused consume must not leave a client row").toBe(0);
    },
  );
});
