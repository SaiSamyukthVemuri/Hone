// HON-50. The Settings > Booking address control must say where the address
// actually appears. studios.address is rendered on the public booking page AND
// in the client confirmation (html, text and its .ics LOCATION), the 24h and 2h
// reminders, and the appointment-update email (#1089). The old copy named only
// the booking page.
//
// Each claim in the copy is pinned to the code that makes it true, so the copy
// cannot keep promising a surface that stops reading the address (or miss one
// that starts).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NAV_ENTRIES } from "@/lib/search/navigation-registry";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

const page = collapse(read("app/(app)/settings/booking/page.tsx"));

function control(): string {
  const start = page.indexOf('id="public-address"');
  expect(start).toBeGreaterThan(-1);
  const end = page.indexOf("</label>", start);
  return page.slice(start, end);
}

describe("Settings > Booking address copy names every surface", () => {
  it("the label names the booking page and appointment emails", () => {
    expect(control()).toContain(
      "Public address (booking page and appointment emails)",
    );
  });

  it("the help text names each email kind and calendar invites, and keeps the home-studio advice", () => {
    const c = control();
    expect(c).toContain("public booking page");
    expect(c).toMatch(/confirmation, reminder and appointment-update emails/);
    expect(c).toContain("calendar invites");
    expect(c).toContain("For home-based studios, leave this blank");
  });

  it("the old booking-page-only label is gone", () => {
    expect(page).not.toContain("Public address (shown on your booking page)");
  });

  it("the page intro says the address is shown in appointment emails too", () => {
    expect(page).toContain(
      "the address clients see there and in appointment emails",
    );
  });

  it("the search entry describes both surfaces and is findable by an email-oriented query", () => {
    const entry = NAV_ENTRIES.find((e) => e.id === "settings-public-address");
    expect(entry).toBeDefined();
    expect(entry!.description).toBe(
      "The address shown on your booking page and in appointment emails",
    );
    expect(entry!.keywords).toEqual(
      expect.arrayContaining(["address in emails", "address in reminders"]),
    );
  });
});

describe("each surface the copy names really reads studios.address", () => {
  it("public booking page", () => {
    const book = read("app/book/[slug]/page.tsx");
    expect(book).toMatch(/\{studio\.address && \(/);
  });

  it("confirmation email (body) and its calendar invite (.ics LOCATION)", () => {
    const send = read("lib/email/send-appointment.ts");
    expect(send).toMatch(/studioAddress: params\.studio\.address/);
    expect(send).toMatch(/location: params\.studio\.address \?\? undefined/);
  });

  it("24h and 2h reminders", () => {
    const send = read("lib/email/send-appointment.ts");
    expect(send.match(/studioAddress: p\.studio\.address/g)?.length).toBe(2);
  });

  it("appointment-update email", () => {
    const moved = read("lib/email/notify-appointment-moved.ts");
    expect(moved).toMatch(/studio:studios\([^)]*\baddress\b/);
    expect(moved).toMatch(/studioAddress: row\.studio\?\.address \?\? null/);
  });
});
