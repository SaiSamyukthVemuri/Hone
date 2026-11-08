// ===========================================================================
// HON-7 — a client's cancellation through the public cancel link must reach the
// practitioner bell exactly once, whatever the joined reads return.
// ===========================================================================
//
// The recorder and the action are REAL here; only the database client, the
// rate limiter, the token helpers and the email sender are faked. Synthetic data only.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TOKEN = "raw-url-token";
const APPT = "11111111-1111-4111-8111-111111111111";
const STUDIO = "22222222-2222-4222-8222-222222222222";
const CLIENT = "33333333-3333-4333-8333-333333333333";
const SERVICE = "44444444-4444-4444-8444-444444444444";
// 2026-11-09 19:30 UTC is 2:30 PM in New York (EST).
const STARTS_AT = "2026-11-09T19:30:00.000Z";
const OWNER_A = "bbbbbbbb-0000-4000-8000-00000000000a";
const OWNER_B = "bbbbbbbb-0000-4000-8000-00000000000b";
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
  // active owners of the studio (ids), and the active actor's display name for staff cancels
  owners: [OWNER_A] as string[],
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
      if (table === "practitioners" && columns === "id") return resolve({ data: scenario.owners.map((id) => ({ id })), error: null } as never);
      if (table !== "practitioner_notifications" || !pending) return resolve({ error: null });
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
            : { data: { studio_id: STUDIO, client_id: CLIENT, practitioner_id: null, starts_at: STARTS_AT, service_id: SERVICE }, error: null };
        }
        return { data: { id: APPT, studio_id: STUDIO, client_id: CLIENT, practitioner_id: null, status: "confirmed", starts_at: STARTS_AT, duration_minutes: 45, cancellation_token_hash: "a".repeat(64), studio: studioRow(), service: { name: "Full Face", modality: "electrolysis", price_cents: 9000 }, client: { name: "Test Client" } }, error: null };
      }
      if (table === "clients") return { data: scenario.clientReadNull ? null : { name: "Test Client" }, error: null };
      if (table === "services") return { data: scenario.serviceReadNull ? null : { name: "Full Face" }, error: null };
      // Only the bell's own timezone read is emptied; the self-service gate reads the full studio row.
      if (table === "studios") return { data: scenario.studioReadNull && columns === "timezone" ? null : studioRow(), error: null };
      if (table === "practitioners" && columns === "display_name, email") return { data: { display_name: "Syn Staff", email: "staff@example.invalid" }, error: null };
      if (table === "practitioners") return { data: { display_name: "Synthetic owner", email: "owner@example.invalid" }, error: null };
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
vi.mock("@/lib/email/send-appointment", () => ({ sendCancellationEmail: async () => ({ ok: true }) }));
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
  Object.assign(scenario, {
    cancelResult: "cancelled",
    rpcStudioId: STUDIO,
    joinedReadNull: false,
    appointmentReadNull: false,
    clientReadNull: false,
    serviceReadNull: false,
    studioReadNull: false,
    seenKeys: new Set<string>(),
    owners: [OWNER_A],
  });
});

describe("a client cancel through the link", () => {
  it("creates exactly one appointment_cancelled row with the right fields", async () => {
    const r = await publicCancelAppointmentAction(cancelForm());
    await flush();
    expect(r.ok).toBe(true);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      studio_id: STUDIO,
      event_type: "appointment_cancelled",
      title: "Appointment cancelled",
      body: "Test Client cancelled Full Face on Mon, Nov 9 at 2:30 PM.",
      appointment_id: APPT,
      client_id: CLIENT,
      href: `/calendar/${APPT}`,
      practitioner_id: OWNER_A,
      dedupe_key: `appointment_cancelled:${APPT}:${OWNER_A}`,
    });
  });

  it("a repeat of the same cancel (command says already_cancelled) creates no row", async () => {
    scenario.cancelResult = "already_cancelled";
    const r = await publicCancelAppointmentAction(cancelForm());
    await flush();
    expect(r.ok).toBe(false);
    expect(inserts).toHaveLength(0);
  });

  it("even a second 'cancelled' answer for the same appointment cannot write a second row (database key)", async () => {
    await publicCancelAppointmentAction(cancelForm());
    await publicCancelAppointmentAction(cancelForm());
    await flush();
    expect(inserts).toHaveLength(1);
    expect(alerts).toEqual([]);
  });

  it("a null studios/clients join STILL notifies", async () => {
    scenario.joinedReadNull = true;
    const r = await publicCancelAppointmentAction(cancelForm());
    await flush();
    expect(r.ok).toBe(true);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].body).toBe("Test Client cancelled Full Face on Mon, Nov 9 at 2:30 PM.");
  });

  it("with every display read empty it still notifies, in neutral wording and without a date", async () => {
    scenario.clientReadNull = true;
    scenario.serviceReadNull = true;
    scenario.studioReadNull = true;
    await publicCancelAppointmentAction(cancelForm());
    await flush();
    expect(inserts).toHaveLength(1);
    expect(inserts[0].body).toBe("A client cancelled an appointment.");
    expect(inserts[0].href).toBe(`/calendar/${APPT}`);
  });

  it("takes the studio from the command when the minimal appointment read is empty", async () => {
    scenario.appointmentReadNull = true;
    await publicCancelAppointmentAction(cancelForm());
    await flush();
    expect(inserts).toHaveLength(1);
    expect(inserts[0].studio_id).toBe(STUDIO);
  });

  it("writes nothing, and does not fail the cancel, when no studio can be established", async () => {
    scenario.appointmentReadNull = true;
    scenario.rpcStudioId = null;
    const r = await publicCancelAppointmentAction(cancelForm());
    await flush();
    expect(r.ok).toBe(true);
    expect(inserts).toHaveLength(0);
  });
});

describe("the booking notification is unchanged", () => {
  it("an unkeyed write carries no dedupe_key", async () => {
    recordPractitionerNotification({
      studioId: STUDIO,
      practitionerId: null,
      eventType: "new_booking",
      title: "New booking",
      body: "x",
      appointmentId: APPT,
      clientId: CLIENT,
      href: `/calendar/${APPT}`,
    });
    await flush();
    expect(inserts).toHaveLength(1);
    expect(Object.keys(inserts[0])).not.toContain("dedupe_key");
  });

  it("the public booking action still records new_booking with its existing arguments", () => {
    const src = readFileSync(join(process.cwd(), "app/book/[slug]/actions.ts"), "utf8");
    expect(src).toContain('eventType: "new_booking"');
    expect(src).toContain('title: "New booking"');
    expect(src).not.toContain("dedupeKey");
  });

  it("the cancel action no longer records the bell from inside the joined read", () => {
    const src = readFileSync(join(process.cwd(), "app/cancel/[token]/actions.ts"), "utf8");
    expect(src).toContain("recordAppointmentCancelNotifications(");
    expect(src).not.toContain("recordPractitionerNotification(");
  });
});

describe("who is notified (per-recipient rows, the actor never)", () => {
  const call = async (actor: string | null) => {
    await recordAppointmentCancelNotifications(admin as never, { appointmentId: APPT, studioId: STUDIO, reasonLabel: null, actorPractitionerId: actor });
    await flush();
  };

  it("a client cancel notifies every active owner, one row each, with its own key", async () => {
    scenario.owners = [OWNER_A, OWNER_B];
    await call(null);
    expect(inserts.map((r) => r.practitioner_id).sort()).toEqual([OWNER_A, OWNER_B]);
    expect(inserts.map((r) => r.dedupe_key).sort()).toEqual([`appointment_cancelled:${APPT}:${OWNER_A}`, `appointment_cancelled:${APPT}:${OWNER_B}`]);
  });

  it("another staff member's cancel notifies the owner once, naming the staff member, the client, the service and the time", async () => {
    await call(STAFF);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      practitioner_id: OWNER_A,
      event_type: "appointment_cancelled",
      body: "Syn Staff cancelled Test Client's Full Face on Mon, Nov 9 at 2:30 PM.",
      href: `/calendar/${APPT}`,
    });
  });

  it("the owner cancelling herself notifies NOBODY when she is the only owner", async () => {
    await call(OWNER_A);
    expect(inserts).toHaveLength(0);
  });

  it("with two owners, the owner who cancels is skipped and the OTHER owner is notified", async () => {
    scenario.owners = [OWNER_A, OWNER_B];
    await call(OWNER_A);
    expect(inserts.map((r) => r.practitioner_id)).toEqual([OWNER_B]);
  });

  it("a retry, or a client cancel racing a staff cancel, still leaves exactly one row per owner", async () => {
    await call(null);
    await call(null);
    await call(STAFF);
    expect(inserts).toHaveLength(1);
  });

  it("with no owner readable: a client cancel falls back to one studio-wide row; a staff cancel writes nothing", async () => {
    scenario.owners = [];
    await call(null);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].practitioner_id).toBeNull();
    inserts.length = 0;
    scenario.seenKeys = new Set();
    await call(STAFF);
    expect(inserts).toHaveLength(0);
  });
});

describe("the in-app cancel action", () => {
  it("records the bell after the RPC succeeds, as the signed-in practitioner, never with free text", () => {
    const src = readFileSync(join(process.cwd(), "app/(app)/calendar/actions.ts"), "utf8");
    const rpc = src.indexOf('"practitioner_cancel_appointment"');
    const call = src.indexOf("recordAppointmentCancelNotifications(admin");
    expect(rpc).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(rpc);
    expect(src.slice(call, call + 300)).toContain("actorPractitionerId: practitioner.id");
    expect(src.slice(call, call + 300)).toContain("reasonLabel: null");
    // the already_cancelled answer returns before the bell is written
    expect(src.indexOf('rpcResult === "already_cancelled"')).toBeLessThan(call);
  });

  it("the detail page shows a success line after an in-app cancel, and the form carries it", () => {
    const page = readFileSync(join(process.cwd(), "app/(app)/calendar/[id]/page.tsx"), "utf8");
    const form = readFileSync(join(process.cwd(), "app/(app)/calendar/PractitionerCancelForm.tsx"), "utf8");
    expect(page).toContain("Appointment cancelled.");
    expect(page).toContain('(await searchParams).cancelled === "1"');
    expect(form).toContain('searchParams.set("cancelled", "1")');
  });
});
