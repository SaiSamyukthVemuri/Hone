import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// What the page actually produces: no client name of any kind in the HTML, and no schedule identity in the initial booking
// controls. Synthetic fixtures.

const STORED = "Zeta Stored-Surname";
const PREFERRED = "Preferred-Zeta";
const state: { rows: unknown; error: unknown } = { rows: [], error: null };

vi.mock("server-only", () => ({}));
vi.mock("@/lib/desk/guard", () => ({ requireReceptionistWithStudio: async () => ({ studioId: "studio-1", receptionistId: "r1", displayName: "Desk" }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc: async () => ({ data: state.rows, error: state.error }) }),
}));

import DeskSchedulePage from "@/app/(desk)/desk/page";

const base = {
  appointment_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  starts_at: "2099-01-01T15:00:00.000Z",
  ends_at: "2099-01-01T16:00:00.000Z",
  status: "confirmed",
  practitioner_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  practitioner_display_name: "Practitioner One",
  service_name: "Consultation",
  client_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  duration_minutes: 60,
  studio_timezone: "America/Toronto",
};
const html = async () => renderToStaticMarkup(await DeskSchedulePage());

beforeEach(() => {
  state.rows = [];
  state.error = null;
});

describe("the desk schedule page", () => {
  it("shows the booking facts and the fixed words, and no client name of any kind", async () => {
    state.rows = [
      { ...base, display_name: STORED, name_on_file: true },
      { ...base, client_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", display_name: PREFERRED, name_on_file: false },
    ];
    const out = await html();
    expect(out).toContain("Consultation");
    expect(out).toContain("Practitioner One");
    expect(out).toContain("(60 min)");
    expect(out.match(/Name on file/g)?.length).toBeGreaterThanOrEqual(2);
    expect(out.includes("Stored-Surname")).toBe(false);
    expect(out.includes("Preferred-Zeta")).toBe(false);
    for (const id of ["aaaaaaaa", "bbbbbbbb", "cccccccc", "dddddddd"]) expect(out.includes(id), id).toBe(false);
  });

  it("renders the studio clock, and says so when it cannot be read", async () => {
    state.rows = [{ ...base, display_name: STORED, name_on_file: true, studio_timezone: "Not/AZone" }];
    expect(await html()).toMatch(/clock could not be read/);
  });

  it("says plainly when the schedule cannot be read, with nothing from the database", async () => {
    state.error = { message: `denied for ${STORED}` };
    const out = await html();
    expect(out).toMatch(/schedule is unavailable/i);
    expect(out.includes("Stored-Surname")).toBe(false);
  });

  it("says plainly when there is nothing in the window", async () => {
    expect(await html()).toMatch(/No appointments in this window/);
  });

  it("offers an on-demand booking entry without preloading a client search", async () => {
    state.rows = [{ ...base, display_name: STORED, name_on_file: true }];
    const out = await html();
    expect(out).toMatch(/>Find time<\/button>/);
    expect(out).not.toMatch(/<(a|form|input|select|textarea)\b/);
  });

  it("a saturated response shows an explicit incomplete state and no partial list; just below the cap renders normally", async () => {
    state.rows = Array.from({ length: 1000 }, () => ({ ...base, display_name: STORED, name_on_file: true }));
    const full = await html();
    expect(full).toMatch(/Schedule incomplete/);
    expect(full).not.toMatch(/Consultation|Practitioner One/);
    expect(full.includes("Stored-Surname")).toBe(false);
    state.rows = Array.from({ length: 999 }, () => ({ ...base, display_name: STORED, name_on_file: true }));
    const below = await html();
    expect(below).not.toMatch(/Schedule incomplete/);
    expect(below.match(/Consultation/g)).toHaveLength(999);
  });
});
