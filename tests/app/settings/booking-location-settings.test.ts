// HON-50 PR B. The owner's Settings > Booking save writes address visibility
// and arrival instructions, and ONLY when the form offered them: the page shows
// the two controls once the studio row carries the columns, so a save made
// before the migration never names a column the database does not have.
// All values are synthetic.

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const updates = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const role = vi.hoisted(() => ({ value: "owner" }));

class RedirectSignal extends Error {
  constructor(public url: string) {
    super(url);
  }
}

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { role: role.value },
    studio: { id: "00000000-0000-4000-8000-0000000000a1", slug: "synthetic" },
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      update: (payload: Record<string, unknown>) => {
        updates.push(payload);
        return { eq: async () => ({ error: null }) };
      },
    }),
  }),
}));

const { updateStudioBookingPrefsAction } = await import("@/app/(app)/settings/booking/actions");

function form(extra: Record<string, string> = {}): FormData {
  const f = new FormData();
  const base: Record<string, string> = {
    timezone: "America/Toronto",
    default_appointment_duration_minutes: "60",
    buffer_minutes: "0",
    public_booking_horizon_months: "3",
    slug: "synthetic",
    address: "100 Synthetic Avenue",
    booking_description: "",
  };
  for (const [k, v] of Object.entries({ ...base, ...extra })) f.set(k, v);
  return f;
}

async function save(f: FormData): Promise<string> {
  try {
    await updateStudioBookingPrefsAction(f);
  } catch (e) {
    if (e instanceof RedirectSignal) return e.url;
    throw e;
  }
  throw new Error("the action did not redirect");
}

beforeEach(() => {
  updates.length = 0;
  role.value = "owner";
});

describe("updateStudioBookingPrefsAction: location settings", () => {
  it("a form without the two controls (pre-migration page) writes neither column", async () => {
    expect(await save(form())).toBe("/settings/booking?saved=1");
    expect(updates).toHaveLength(1);
    expect(updates[0]).not.toHaveProperty("address_visibility");
    expect(updates[0]).not.toHaveProperty("arrival_instructions");
    expect(updates[0].address).toBe("100 Synthetic Avenue");
  });

  it.each(["booking_page", "emails", "both"])("writes visibility %s", async (v) => {
    await save(form({ address_visibility: v }));
    expect(updates[0].address_visibility).toBe(v);
  });

  it("refuses a visibility outside the closed set and writes nothing", async () => {
    const url = await save(form({ address_visibility: "everyone" }));
    expect(url).toMatch(/^\/settings\/booking\?error=/);
    expect(decodeURIComponent(url)).toContain("Choose where the address is shown.");
    expect(updates).toHaveLength(0);
  });

  it("writes trimmed arrival instructions", async () => {
    await save(form({ arrival_instructions: "  Side door, buzzer 2.\n" }));
    expect(updates[0].arrival_instructions).toBe("Side door, buzzer 2.");
  });

  it.each(["", "   ", "\n\t"])("blank arrival instructions (%j) are stored as null (no section)", async (v) => {
    await save(form({ arrival_instructions: v }));
    expect(updates[0]).toHaveProperty("arrival_instructions", null);
  });

  // Agreement with 0251's CHECK (arrival_instructions ~ '\S'): every character
  // the database can classify as [[:space:]] (the ASCII six, plus the Unicode
  // spaces glibc's UTF-8 locales list) is removed by the app's trim, so a value
  // the database would refuse as blank is always stored as NULL instead. The
  // app's set is the larger one (it also trims U+00A0, U+2007, U+202F, U+FEFF).
  const DB_SPACE_CHARS = [
    " ", "\t", "\n", "\v", "\f", "\r",
    "\u1680", "\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005", "\u2006",
    "\u2008", "\u2009", "\u200a", "\u2028", "\u2029", "\u205f", "\u3000",
  ];
  it("any value made only of characters the database calls whitespace is stored as null", async () => {
    await save(form({ arrival_instructions: DB_SPACE_CHARS.join("") }));
    expect(updates[0]).toHaveProperty("arrival_instructions", null);
    for (const ch of DB_SPACE_CHARS) expect(ch.trim(), JSON.stringify(ch)).toBe("");
  });

  it("refuses instructions over 1000 characters and writes nothing", async () => {
    const url = await save(form({ arrival_instructions: "x".repeat(1001) }));
    expect(decodeURIComponent(url)).toContain("1000 characters or fewer");
    expect(updates).toHaveLength(0);
    await save(form({ arrival_instructions: "x".repeat(1000) }));
    expect(updates[0].arrival_instructions).toHaveLength(1000);
  });

  it("does not touch booking_description (the booking-page intro is not repurposed)", async () => {
    await save(form({ arrival_instructions: "Park behind.", booking_description: "Intro copy" }));
    expect(updates[0].booking_description).toBe("Intro copy");
    expect(updates[0].arrival_instructions).toBe("Park behind.");
  });

  it("a non-owner cannot save", async () => {
    role.value = "practitioner";
    const url = await save(form({ address_visibility: "emails" }));
    expect(decodeURIComponent(url)).toContain("Only studio owners");
    expect(updates).toHaveLength(0);
  });
});

describe("Settings > Booking page offers the controls only once the columns exist", () => {
  const page = readFileSync("app/(app)/settings/booking/page.tsx", "utf8");

  it("gates both controls on the loaded row carrying address_visibility", () => {
    expect(page).toMatch(/const hasLocationSettings = "address_visibility" in studio;/);
    const gate = page.indexOf("{hasLocationSettings && (");
    expect(gate).toBeGreaterThan(-1);
    expect(page.indexOf('name="address_visibility"')).toBeGreaterThan(gate);
    expect(page.indexOf('name="arrival_instructions"')).toBeGreaterThan(gate);
  });

  it("offers exactly the three visibility values, defaulting from the helper", () => {
    for (const v of ["both", "booking_page", "emails"]) {
      expect(page).toContain(`<option value="${v}">`);
    }
    expect(page).toMatch(/defaultValue=\{addressVisibilityOf\(studio\)\}/);
  });

  it("caps the textarea at the database limit", () => {
    expect(page).toMatch(/maxLength=\{ARRIVAL_INSTRUCTIONS_MAX_LENGTH\}/);
  });
});
