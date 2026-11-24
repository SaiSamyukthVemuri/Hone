import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const OTHER = "Other studios client";
const PREFERRED = "Preferred-Zeta";
const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const state: { rows: unknown[]; error: unknown; optionsOk: boolean } = { rows: [], error: null, optionsOk: true };
const options = {
  studioId: "studio-1", timezone: "America/Toronto", services: [],
  practitioners: [{ id, name: "Practitioner One" }, { id: "pr2", name: "Practitioner Two" }],
};
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/desk/guard", () => ({ requireReceptionistWithStudio: async () => ({ studioId: "studio-1", receptionistId: "r1", displayName: "Desk" }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc: async () => ({ data: state.rows, error: state.error }) }) }));
vi.mock("@/app/(desk)/desk/booking-actions", () => ({ getDeskBookingOptionsAction: async () => state.optionsOk ? { ...options, ok: true } : { ok: false } }));

import DeskSchedulePage from "@/app/(desk)/desk/page";
const base = {
  appointment_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", starts_at: "2099-01-01T15:00:00Z", ends_at: "2099-01-01T16:00:00Z",
  status: "confirmed", practitioner_id: id, practitioner_display_name: "Practitioner One", service_name: "Consultation",
  client_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", duration_minutes: 60, studio_timezone: "America/Toronto",
  display_name: PREFERRED, email: "private@example.com", phone: "123456789",
};
const html = async (view = "month") => renderToStaticMarkup(await DeskSchedulePage({ searchParams: Promise.resolve({ date: "2099-01-01", view }) }));
beforeEach(() => { state.rows = []; state.error = null; state.optionsOk = true; });

describe("receptionist schedule", () => {
  it.each(["day","week","month"])("shows returned client names and withholds contact details in %s", async view => {
    state.rows = [base,
      { ...base, display_name: "Robin Vale", appointment_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab" },
      { ...base, display_name: "", appointment_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac" }];
    const out = await html(view);
    expect(out).toContain(PREFERRED);
    expect(out).toContain("Name on file");
    expect(out).toContain("Consultation");
    expect(out).toContain("Robin Vale");
    expect(out).not.toContain(base.email);
    expect(out).not.toContain(base.phone);
    expect(out).not.toContain(base.client_id);
  });
  it("counts visits for each practitioner, including zero, and omits cancellations", async () => {
    state.rows = [base,{ ...base, appointment_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab", status:"cancelled" }];
    expect(await html()).toContain("January 1, 2099, 1 visit, Practitioner One 1, Practitioner Two 0");
  });
  it("uses the studio-local date for appointments near UTC midnight", async () => {
    state.rows = [{ ...base, starts_at:"2099-01-02T01:00:00Z", ends_at:"2099-01-02T02:00:00Z" }];
    expect(await html()).toContain("January 1, 2099, 1 visit");
  });
  it("identifies the fallback UTC clock when booking settings could not load", async () => {
    state.optionsOk = false; state.rows = [base];
    expect(await html()).toMatch(/clock could not be read/);
  });
  it("offers booking with an empty calendar without preloading client contacts", async () => {
    const out = await html();
    expect(out).toContain("No appointments on this day");
    expect(out).toContain("Find an opening");
    expect(out).not.toContain("Find an existing client");
  });
  it("shows a fixed error without leaking underlying database details", async () => {
    state.error = { message: OTHER }; const out = await html();
    expect(out).toMatch(/schedule is unavailable/i); expect(out).not.toContain(OTHER);
  });
  it("shows no partial schedule when a single day saturates the database cap", async () => {
    state.rows=Array.from({length:1000},()=>base);const out=await html("day");
    expect(out).toContain("Schedule incomplete");expect(out).not.toContain(PREFERRED);
  });
});
