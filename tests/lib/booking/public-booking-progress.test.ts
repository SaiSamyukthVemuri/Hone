import { describe, expect, it } from "vitest";

import {
  publicBookFormSurface,
  publicBookingProgress,
  type PublicBookFormSurface,
} from "@/lib/booking/new-client-admission-surface";

// HON-124 item 8: the public booking journey says which step the client is on,
// out of how many, and only on the surfaces that ARE steps of that journey.

const ALL: PublicBookFormSurface[] = [
  "chooser",
  "existing_no_services",
  "existing_unavailable",
  "existing_portal",
  "closed_notice",
  "unknown_notice",
  "waitlist_journey",
  "no_services_notice",
  "booking_form",
];

describe("publicBookingProgress", () => {
  it("walks the open new-client journey as 1, 2, 3 of 3", () => {
    const open = { newClientAdmission: "open" as const, servicesCount: 1, structurallyBookable: true };
    const first = publicBookingProgress(publicBookFormSurface({ ...open, clientType: null }), false);
    const second = publicBookingProgress(publicBookFormSurface({ ...open, clientType: "new" }), false);
    const third = publicBookingProgress(publicBookFormSurface({ ...open, clientType: "new" }), true);
    expect([first?.step, second?.step, third?.step]).toEqual([1, 2, 3]);
    for (const p of [first, second, third]) expect(p?.total).toBe(3);
  });

  it("shows no indicator on a surface that is not a booking step", () => {
    const stepless = ALL.filter((s) => s !== "chooser" && s !== "booking_form");
    expect(stepless).toHaveLength(7);
    for (const s of stepless) expect(publicBookingProgress(s, false), s).toBeNull();
  });

  it("reports step 3 only from the saved-booking flag, never from a surface", () => {
    for (const s of ALL) expect(publicBookingProgress(s, false)?.step, s).not.toBe(3);
    expect(publicBookingProgress("booking_form", true)?.step).toBe(3);
  });

  it("names every step it shows", () => {
    for (const s of ALL) {
      const p = publicBookingProgress(s, false);
      if (p) expect(p.label.trim().length, s).toBeGreaterThan(0);
    }
  });
});
