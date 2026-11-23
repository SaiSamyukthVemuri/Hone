import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// A notification names the client by their DISPLAY name: the field the calendar shows (the preferred name where set, else the stored name).
// Never the legal identity. The cancel and card-change writers are driven for real against a recording fake client; the four public-flow writers
// (book, rebook, reschedule, intake) run inside large server actions, so for those the source contract pins that the text is built from the
// display-name loader's result.

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
const inserted: Row[] = [];
let clientReads = 0; // how many times `clients` was read
let failClientRead = false;

function from(table: string) {
  const filters: Array<[string, unknown]> = [];
  const q: Record<string, unknown> = {};
  const rows = () => (tables[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));
  for (const m of ["select", "order", "limit"]) q[m] = () => q;
  q.eq = (c: string, v: unknown) => (filters.push([c, v]), q);
  q.maybeSingle = () => {
    if (table === "clients") {
      clientReads++;
      if (failClientRead) return Promise.resolve({ data: null, error: { code: "XX000", message: "boom" } });
    }
    return Promise.resolve({ data: rows()[0] ?? null, error: null });
  };
  q.insert = async (row: Row) => (table === "practitioner_notifications" ? inserted.push(row) : null, { error: null });
  q.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: null });
  return q;
}
const fake = { from };

vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => fake }));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: vi.fn(() => Promise.resolve()) }));

import { recordAppointmentCancelNotifications } from "@/lib/notifications/appointment-cancel-notification";
import { ensureCardChangeNotification } from "@/lib/billing/card-change-notification";

const STUDIO = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const APPT = "33333333-3333-4333-8333-333333333333";
const OWNER = "44444444-4444-4444-8444-444444444444";

function seed(client: Row) {
  for (const k of Object.keys(tables)) delete tables[k];
  inserted.length = 0;
  clientReads = 0;
  failClientRead = false;
  tables.appointments = [{ id: APPT, studio_id: STUDIO, client_id: CLIENT, practitioner_id: OWNER, starts_at: "2026-12-01T17:00:00Z", service_id: "s1", cancelled_at: "2026-11-30T10:00:00Z" }];
  tables.clients = [{ id: CLIENT, studio_id: STUDIO, ...client }];
  tables.services = [{ id: "s1", name: "Consultation" }];
  tables.studios = [{ id: STUDIO, timezone: "UTC" }];
  tables.practitioners = [{ id: OWNER, studio_id: STUDIO, role: "owner", active: true, created_at: "2026-01-01" }];
  tables.client_payment_methods = [{ studio_id: STUDIO, client_id: CLIENT, stripe_livemode: false, stripe_setup_intent_id: "seti_1", status: "active", brand: "visa", last4: "4242" }];
}

describe("the cancel writer names the client by display name", () => {
  it("emits the preferred name where one is set, never the stored or legal name", async () => {
    seed({ name: "Katherine Example", preferred_name: "Kit", legal_given_name: "Katherine", legal_family_name: "Legal" });
    await recordAppointmentCancelNotifications(fake as never, { appointmentId: APPT, studioId: STUDIO, reasonLabel: null, actorPractitionerId: null });
    expect(inserted.length).toBeGreaterThan(0);
    for (const r of inserted) {
      expect(String(r.body)).toContain("Kit cancelled");
      expect(String(r.body)).not.toContain("Katherine");
      expect(String(r.body)).not.toContain("Legal");
    }
  });

  it("falls back to the stored name when no preferred name is set (unchanged behaviour)", async () => {
    seed({ name: "Katherine Example", preferred_name: null });
    await recordAppointmentCancelNotifications(fake as never, { appointmentId: APPT, studioId: STUDIO, reasonLabel: null, actorPractitionerId: null });
    expect(String(inserted[0].body)).toContain("Katherine Example cancelled");
  });

  it("reads the client ONCE (preferred name rides on the row the writer already reads): no separate display-name lookup", async () => {
    seed({ name: "Katherine Example", preferred_name: "Kit" });
    await recordAppointmentCancelNotifications(fake as never, { appointmentId: APPT, studioId: STUDIO, reasonLabel: null, actorPractitionerId: null });
    expect(clientReads).toBe(1);
  });

  it("keeps the generic wording when the client has no name, or the row read failed", async () => {
    seed({ name: "", preferred_name: null });
    await recordAppointmentCancelNotifications(fake as never, { appointmentId: APPT, studioId: STUDIO, reasonLabel: null, actorPractitionerId: null });
    expect(String(inserted[0].body)).toContain("A client cancelled");
    seed({ name: "Katherine Example", preferred_name: "Kit" });
    failClientRead = true;
    await recordAppointmentCancelNotifications(fake as never, { appointmentId: APPT, studioId: STUDIO, reasonLabel: null, actorPractitionerId: null });
    expect(String(inserted[0].body)).toContain("A client cancelled");
    expect(String(inserted[0].body)).not.toContain("Katherine");
  });

  it("a staff cancel names the staff member and the client's display name", async () => {
    seed({ name: "Katherine Example", preferred_name: "Kit" });
    tables.practitioners.push({ id: "55555555-5555-4555-8555-555555555555", studio_id: STUDIO, role: "practitioner", active: true, display_name: "Dana" });
    await recordAppointmentCancelNotifications(fake as never, { appointmentId: APPT, studioId: STUDIO, reasonLabel: null, actorPractitionerId: "55555555-5555-4555-8555-555555555555" });
    expect(String(inserted[0].body)).toContain("Dana cancelled Kit's Consultation");
  });
});

describe("the card-change writer names the client by display name", () => {
  const params = { studioId: STUDIO, clientId: CLIENT, livemode: false, setupIntentId: "seti_1" };

  it("emits the preferred name where one is set", async () => {
    seed({ name: "Katherine Example", preferred_name: "Kit", legal_given_name: "Katherine" });
    await ensureCardChangeNotification(fake as never, params);
    expect(inserted).toHaveLength(1);
    expect(String(inserted[0].body)).toContain("Kit added visa ending in 4242");
    expect(String(inserted[0].body)).not.toContain("Katherine");
  });

  it("reads the client ONCE, and a failed read throws so Stripe retries (never a half-named notice)", async () => {
    seed({ name: "Katherine Example", preferred_name: "Kit" });
    await ensureCardChangeNotification(fake as never, params);
    expect(clientReads).toBe(1);
    seed({ name: "Katherine Example", preferred_name: "Kit" });
    failClientRead = true;
    await expect(ensureCardChangeNotification(fake as never, params)).rejects.toThrow(/card_change_client_lookup_failed/);
    expect(inserted).toHaveLength(0);
  });

  it("falls back to the stored name with no preferred name, and to a generic label for a missing client", async () => {
    seed({ name: "Katherine Example" });
    await ensureCardChangeNotification(fake as never, params);
    expect(String(inserted[0].body)).toContain("Katherine Example added");
    seed({ name: "" });
    tables.clients = [];
    await ensureCardChangeNotification(fake as never, params);
    expect(String(inserted[0].body)).toContain("A client added");
  });
});

describe("the public-flow writers take the preferred name from the client row they already read", () => {
  const read = (f: string) => readFileSync(f, "utf8");

  it("reschedule: the existing client select carries preferred_name and the text uses it; no loader call", () => {
    const src = read("app/reschedule/[token]/actions.ts");
    expect(src).toMatch(/readWithPreferredName\(\(includePreferred\) =>\s*admin\s*\.from\("clients"\)\s*\.select\(`\$\{preferredNameColumn\(includePreferred\)\}name, email, phone, sms_consent_at, sms_opted_out_at`\)\s*\.eq\("id", asserted\.original\.client_id\)\s*\.eq\("studio_id", asserted\.original\.studio_id\)/);
    expect(src).toContain("notificationClientName(clientRow)");
    expect(src).toMatch(/body: `\$\{notificationName\} rescheduled/);
    expect(src).not.toContain("loadCommunicationName");
  });

  it("rebook: the session client select carries preferred_name, it rides in the context, and the text uses it; no loader call", () => {
    const src = read("app/portal/rebook-actions.ts");
    expect(src).toMatch(/\.select\(`\$\{preferredNameColumn\(includePreferred\)\}id, name, email, phone, sms_consent_at, sms_opted_out_at, archived_at`\)/);
    expect(src).toContain("clientPreferredName: clientRow.preferred_name ?? null");
    expect(src).toContain("notificationClientName({ name: clientName, preferred_name: clientPreferredName })");
    expect(src).toMatch(/body: `\$\{notificationName\} booked/);
    expect(src).not.toContain("loadCommunicationName");
  });

  it("intake: ONE client read through readClientNameFields; no loader call", () => {
    const src = read("app/intake/[token]/actions.ts");
    expect(src).toContain("readClientNameFields(admin, existing.studio_id, existing.client_id)");
    expect(src).toContain("clientDisplayName(clientFields)");
    expect(src).not.toContain("loadCommunicationName");
  });

  it("book: an existing client's preferred name comes from the lookup row; the bounded loader runs ONLY when the row was not read here", () => {
    const src = read("app/book/[slug]/actions.ts");
    expect(src).toMatch(/\.select\(`\$\{preferredNameColumn\(includePreferred\)\}id, name, email, phone, sms_consent_at, sms_opted_out_at`\)\s*\.eq\("studio_id", studio\.id\)\s*\.eq\("normalized_email", normalizedEmail\)/);
    expect(src).toContain("clientPreferredName = existingClient.preferred_name ?? null;");
    expect(src).toMatch(/clientPreferredName === undefined\s*\?\s*await loadCommunicationName\(admin, studio\.id, clientId, clientName\)\s*:\s*notificationClientName\(\{ name: clientName, preferred_name: clientPreferredName \}\)/);
    expect(src.match(/loadCommunicationName\(/g)?.length).toBe(1); // exactly one call site: the unknown-row fallback
  });

  it("card-change and cancel contain no separate display-name lookup", () => {
    for (const f of ["lib/billing/card-change-notification.ts", "lib/notifications/appointment-cancel-notification.ts"]) {
      expect(read(f), f).not.toContain("loadCommunicationName");
      expect(read(f), f).toContain("client-name");
    }
  });
});
