// ===========================================================================
// HON-7 — a client's cancellation through the public cancel link must reach the
// practitioner bell exactly once, whatever the joined reads return.
// ===========================================================================
//
// The recorder and the action are REAL here; only the database client, the
// rate limiter, the token helpers and the email sender are faked. Synthetic data only.

import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "raw-url-token";
const APPT = "11111111-1111-4111-8111-111111111111";
const STUDIO = "22222222-2222-4222-8222-222222222222";
const CLIENT = "33333333-3333-4333-8333-333333333333";
const SERVICE = "44444444-4444-4444-8444-444444444444";
// 2026-11-09 19:30 UTC is 2:30 PM in New York (EST).
const STARTS_AT = "2026-11-09T19:30:00.000Z";
const OWNER_A = "bbbbbbbb-0000-4000-8000-00000000000a";
const OWNER_B = "bbbbbbbb-0000-4000-8000-00000000000b";
// 2026-11-08T15:00:00.123Z as epoch milliseconds
const OCCURRENCE = "1794150000123";
const STAFF = "bbbbbbbb-0000-4000-8000-0000000000cc";

type Insert = Record<string, unknown>;
const inserts: Insert[] = [];
const rpcCalls: string[] = [];
const alerts: unknown[] = [];

const scenario = {
  cancelResult: "cancelled" as string,
  rpcStudioId: STUDIO as string | null,
  // The old joined read (appointments + studios(*) + clients(name)) returns nothing.
  joinedReadNull: false,
  // The new minimal reads return nothing.
  appointmentReadNull: false,
  clientReadNull: false,
  serviceReadNull: false,
  studioReadNull: false,
  seenKeys: new Set<string>(),
  // the appointment's committed cancelled_at (a restore clears it; the next cancel stamps a new one)
  cancelledAt: "2026-11-08T15:00:00.123456+00:00" as string | null,
  // active owners of the studio (ids), and the active actor's display name for staff cancels
  owners: [OWNER_A] as string[],
  // emails of the studio's active owners, as the owner-email read sees them
  ownerEmails: ["owner-a@example.invalid"] as string[],
  ownerEmailReadError: false,
  ownersError: false,
  // the staff member has no display name, only an email
  actorNoName: false,
  // the insert completes only after this many ms (proves the writer waits for it)
  insertDelayMs: 0,
};

function studioRow() {
  return { id: STUDIO, name: "Test Studio", slug: "test-studio", timezone: "America/New_York", cancellation_policy_text: null, no_show_policy_text: null, send_confirmation_emails: false };
}

function makeQuery(table: string) {
  let columns = "";
  let pending: Insert | null = null;
  const chain = {
    select(value: string) { columns = value; return chain; },
    eq() { return chain; },
    insert(row: Insert) {
      pending = row;
      return chain;
    },
    then(resolve: (v: { error: { code: string } | null }) => void) {
      if (table === "practitioners" && columns === "id") {
        return resolve(
          (scenario.ownersError ? { data: null, error: { code: "XX000", message: "PRIVATE owner read" } } : { data: scenario.owners.map((id) => ({ id })), error: null }) as never,
        );
      }
      if (table === "practitioners" && columns === "display_name, email") {
        // The plural read: every active owner's row, or a read error when the scenario says so.
        return resolve(
          (scenario.ownerEmailReadError
            ? { data: null, error: { code: "XX000", message: "PRIVATE owner read" } }
            : { data: scenario.ownerEmails.map((email) => ({ display_name: "Synthetic owner", email })), error: null }) as never,
        );
      }
      if (table !== "practitioner_notifications" || !pending) return resolve({ error: null });
      if (scenario.insertDelayMs > 0) {
        const row = pending;
        return void setTimeout(() => {
          inserts.push(row);
          resolve({ error: null });
        }, scenario.insertDelayMs);
      }
      const key = typeof pending.dedupe_key === "string" ? pending.dedupe_key : null;
      if (key && scenario.seenKeys.has(key)) return resolve({ error: { code: "23505" } });
      if (key) scenario.seenKeys.add(key);
      inserts.push(pending);
      return resolve({ error: null });
    },
    async maybeSingle() {
      if (table === "appointments") {
        if (columns.includes("studio:studios")) {
          return scenario.joinedReadNull
            ? { data: null, error: null }
            : { data: { studio_id: STUDIO, client_id: CLIENT, practitioner_id: null, starts_at: STARTS_AT, duration_minutes: 45, service: { name: "Full Face" }, studio: studioRow(), client: { name: "Test Client" } }, error: null };
        }
        if (columns.startsWith("studio_id, client_id")) {
          return scenario.appointmentReadNull
            ? { data: null, error: null }
            : { data: { studio_id: STUDIO, client_id: CLIENT, practitioner_id: null, starts_at: STARTS_AT, service_id: SERVICE, cancelled_at: scenario.cancelledAt }, error: null };
        }
        return { data: { id: APPT, studio_id: STUDIO, client_id: CLIENT, practitioner_id: null, status: "confirmed", starts_at: STARTS_AT, duration_minutes: 45, cancellation_token_hash: "a".repeat(64), studio: studioRow(), service: { name: "Full Face", modality: "electrolysis", price_cents: 9000 }, client: { name: "Test Client" } }, error: null };
      }
      if (table === "clients") return { data: scenario.clientReadNull ? null : { name: "Test Client" }, error: null };
      if (table === "services") return { data: scenario.serviceReadNull ? null : { name: "Full Face" }, error: null };
      // Only the bell's own timezone read is emptied; the self-service gate reads the full studio row.
      if (table === "studios") return { data: scenario.studioReadNull && columns === "timezone" ? null : studioRow(), error: null };
      if (table === "practitioners" && columns === "display_name") return { data: { display_name: scenario.actorNoName ? null : "Syn Staff" }, error: null };
      return { data: null, error: null };
    },
    async single() { return chain.maybeSingle(); },
  };
  return chain;
}

const admin = {
  from(table: string) { return makeQuery(table); },
  async rpc(fn: string) {
    rpcCalls.push(fn);
    return { data: [{ result: scenario.cancelResult, appointment_id: APPT, studio_id: scenario.rpcStudioId }], error: null };
  },
};

vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => admin }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/rate-limit/public", () => ({ limitTokenRoute: async () => ({ allowed: true }), RATE_LIMIT_MESSAGE: "rate limited" }));
vi.mock("@/lib/booking/appointment-token", () => ({ hashAppointmentToken: () => "a".repeat(64) }));
vi.mock("@/lib/booking/tokens", () => ({ verifyCancellationToken: () => ({ ok: false, error: "invalid" }) }));
const emails: Array<{ to: string }> = [];
const failFor = new Set<string>();
vi.mock("@/lib/email/send-appointment", () => ({ sendCancellationEmail: async (p: { to: string }) => { emails.push({ to: p.to }); return failFor.has(p.to) ? { ok: false, error: "x", retryable: true } : { ok: true }; } }));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: async (a: unknown) => { alerts.push(a); } }));

const { publicCancelAppointmentAction } = await import("@/app/cancel/[token]/actions");
const { recordPractitionerNotification } = await import("@/lib/notifications/practitioner-notifications");
const { recordAppointmentCancelNotifications } = await import("@/lib/notifications/appointment-cancel-notification");

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function cancelForm(): FormData {
  const fd = new FormData();
  fd.set("token", TOKEN);
  fd.set("presented_policy_hash", "b".repeat(64));
  return fd;
}

beforeEach(() => {
  inserts.length = 0;
  rpcCalls.length = 0;
  alerts.length = 0;
  emails.length = 0;
  failFor.clear();
  Object.assign(scenario, { cancelResult: "cancelled", owners: [OWNER_A], ownerEmails: ["owner-a@example.invalid"], ownerEmailReadError: false, seenKeys: new Set<string>() });
});

// HON-13: a client's cancel through the link emails the studio owner. The in-app bell already notifies EVERY
// active owner; the schema does not guarantee a single owner (the invite form can add a second one).
describe("owner cancellation email: who receives it", () => {
  it("control: one active owner is emailed once", async () => {
    const r = await publicCancelAppointmentAction(cancelForm());
    await flush();
    expect(r.ok).toBe(true);
    expect(emails.map((e) => e.to)).toEqual(["owner-a@example.invalid"]);
  });

  it("two active owners: the email is not silently dropped (the bell reaches both)", async () => {
    scenario.owners = [OWNER_A, OWNER_B];
    scenario.ownerEmails = ["owner-a@example.invalid", "owner-b@example.invalid"];
    const r = await publicCancelAppointmentAction(cancelForm());
    await flush();
    expect(r.ok).toBe(true);
    expect(inserts).toHaveLength(2);
    expect(emails.map((e) => e.to).sort()).toEqual(["owner-a@example.invalid", "owner-b@example.invalid"]);
  });

  it("an unreadable owner list is 'unconfirmed' (fail closed), sends nothing, and the cancel still succeeds", async () => {
    scenario.ownerEmailReadError = true;
    const r = await publicCancelAppointmentAction(cancelForm());
    await flush();
    expect(r).toEqual({ ok: true, notification: "unconfirmed" });
    expect(emails).toEqual([]);
    expect(JSON.stringify(alerts)).not.toMatch(/PRIVATE|@example/);
  });

  it("one owner's email failing marks the notification unconfirmed but still tells the other owner, once", async () => {
    scenario.ownerEmails = ["owner-a@example.invalid", "owner-b@example.invalid"];
    failFor.add("owner-a@example.invalid");
    const r = await publicCancelAppointmentAction(cancelForm());
    await flush();
    expect(r).toEqual({ ok: true, notification: "unconfirmed" });
    expect(emails.map((e) => e.to).sort()).toEqual(["owner-a@example.invalid", "owner-b@example.invalid"]);
  });

  it("two owners sharing one address receive one email, not two", async () => {
    scenario.ownerEmails = ["Shared@Example.invalid", "shared@example.invalid"];
    await publicCancelAppointmentAction(cancelForm());
    await flush();
    expect(emails).toHaveLength(1);
  });
});
