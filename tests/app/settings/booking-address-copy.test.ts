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
  it("the label is neutral (HON-50 decision B: the help names every destination)", () => {
    expect(control()).toContain('<span className="text-sm font-medium">Studio address</span>');
  });

  it("the help text names each email kind and calendar invites, and keeps the home-studio advice", () => {
    const c = control();
    expect(c).toContain("public booking page");
    expect(c).toMatch(/confirmation, reminder and appointment-update emails/);
    expect(c).toContain("calendar invites");
    expect(c).toContain("For home-based studios, leave this blank");
  });

  it("both help variants disclose the team calendar feed and that connected calendar services can keep a copy", () => {
    const c = control();
    expect(c.match(/calendar\s+subscription feed/g)?.length).toBe(2);
    expect(c.match(/can keep a copy/g)?.length).toBe(2);
    expect(c).not.toMatch(/email only|emails only/i);
  });

  it("the old booking-page-only label is gone", () => {
    expect(page).not.toContain("Public address (shown on your booking page)");
  });

  it("the page intro mentions the address and where it is shown", () => {
    expect(page).toContain("your studio address and where it is shown");
  });

  it("the search entry describes both surfaces and is findable by an email-oriented query", () => {
    const entry = NAV_ENTRIES.find((e) => e.id === "settings-public-address");
    expect(entry).toBeDefined();
    expect(entry!.title).toBe("Studio address");
    expect(entry!.description).toBe("Your studio address, and where it is shown");
    expect(entry!.keywords).toEqual(
      expect.arrayContaining(["address in emails", "address in reminders"]),
    );
  });
});

describe("each surface the copy names really reads studios.address", () => {
  // HON-50 PR B routes every surface through lib/booking/studio-location.ts,
  // which applies the owner's address visibility.
  it("public booking page", () => {
    const book = read("app/book/[slug]/page.tsx");
    expect(book).toMatch(/const studio = forPublicBookingPage\(studioRow\)/);
    expect(book).toMatch(/\{studio\.address && \(/);
  });

  it("confirmation email (body) and its calendar invite (.ics LOCATION)", () => {
    const send = read("lib/email/send-appointment.ts");
    expect(send).toMatch(/params = \{ \.\.\.params, studio: forAppointmentEmail\(params\.studio\) \};/);
    expect(send).toMatch(/studioAddress: params\.studio\.address/);
    expect(send).toMatch(/location: params\.studio\.address \?\? undefined/);
  });

  it("24h and 2h reminders", () => {
    const send = read("lib/email/send-appointment.ts");
    expect(send.match(/p = \{ \.\.\.p, studio: forAppointmentEmail\(p\.studio\) \};/g)?.length).toBe(2);
    expect(send.match(/studioAddress: p\.studio\.address/g)?.length).toBe(2);
  });

  it("appointment-update email", () => {
    const moved = read("lib/email/notify-appointment-moved.ts");
    expect(moved).toMatch(/MOVED_STUDIO_COLUMNS_WITH_LOCATION =\s*"[^"]*\baddress\b/);
    expect(moved).toMatch(/studioAddress: row\.studio \? appointmentEmailAddress\(row\.studio\) : null/);
  });
});
