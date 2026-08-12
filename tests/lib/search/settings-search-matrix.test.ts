import { describe, expect, it } from "vitest";
import {
  matchNavEntries,
  type NavSearchContext,
} from "@/lib/search/navigation-registry";
import { NAV_RESULT_CAP } from "@/lib/search/global-search";

// Global Search V2-A.1 — the settings search ACCEPTANCE MATRIX.
//
// One table of "what a practitioner types" → "what must come back first",
// drawn from the real, current Settings pages. The coverage contract in
// settings-control-coverage.test.ts proves nothing is MISSING; this proves the
// right thing WINS, which is a different failure mode: a control can be
// registered and still be unreachable behind a better-ranked neighbour.

const OWNER: NavSearchContext = { isOwner: true, googleCalendarEnabled: true };
const PRACTITIONER: NavSearchContext = {
  isOwner: false,
  googleCalendarEnabled: true,
};

function top(query: string, ctx: NavSearchContext = OWNER) {
  return matchNavEntries(query, ctx)[0]?.entry;
}
function titles(query: string, ctx: NavSearchContext = OWNER) {
  return matchNavEntries(query, ctx).map((m) => m.entry.title);
}

// ---------------------------------------------------------------------------
// Booking — the page the reported failure came from
// ---------------------------------------------------------------------------

describe("acceptance matrix — Booking", () => {
  const CASES: Array<[string, string, string]> = [
    // query                        expected title              expected href
    ["booking horizon", "Booking horizon", "/settings/booking#booking-horizon"],
    ["horizon", "Booking horizon", "/settings/booking#booking-horizon"],
    ["how far ahead", "Booking horizon", "/settings/booking#booking-horizon"],
    ["booking window", "Booking horizon", "/settings/booking#booking-horizon"],
    ["advance booking", "Booking horizon", "/settings/booking#booking-horizon"],
    ["months ahead", "Booking horizon", "/settings/booking#booking-horizon"],
    ["timezone", "Timezone", "/settings/booking#timezone"],
    ["time zone", "Timezone", "/settings/booking#timezone"],
    [
      "default duration",
      "Default duration (min)",
      "/settings/booking#default-duration",
    ],
    ["buffer", "Time between appointments", "/settings/booking#buffer"],
    [
      "time between appointments",
      "Time between appointments",
      "/settings/booking#buffer",
    ],
    ["booking link", "Booking link", "/settings/booking#booking-link"],
    ["public address", "Public address", "/settings/booking#public-address"],
    [
      "booking page intro",
      "Booking page intro",
      "/settings/booking#booking-intro",
    ],
    ["slug", "Booking URL slug", "/settings/booking#booking-slug"],
    ["booking", "Booking", "/settings/booking"],
  ];

  for (const [query, title, href] of CASES) {
    it(`"${query}" → ${title}`, () => {
      const entry = top(query);
      expect(entry?.title, `"${query}" ranked ${entry?.title ?? "NOTHING"}`).toBe(
        title,
      );
      expect(entry?.href).toBe(href);
    });
  }

  it("every Booking control is reachable within the visible result cap", () => {
    // A registered control that only ever appears at position 9 is not
    // discoverable in practice. Each must be the FIRST hit for its own name.
    for (const [query] of CASES) {
      expect(
        matchNavEntries(query, OWNER).length,
        `"${query}" returned nothing`,
      ).toBeGreaterThan(0);
      expect(matchNavEntries(query, OWNER).length).toBeLessThanOrEqual(
        NAV_RESULT_CAP * 4,
      );
    }
  });

  it("the generic Booking row survives alongside the precise ones", () => {
    expect(top("booking")?.title).toBe("Booking");
    expect(top("booking")?.href).toBe("/settings/booking");
    // ...and the page row does not suppress its own controls.
    expect(top("booking horizon")?.title).toBe("Booking horizon");
    expect(top("booking link")?.title).toBe("Booking link");
  });
});

// ---------------------------------------------------------------------------
// Representative controls from every other Settings page
// ---------------------------------------------------------------------------

describe("acceptance matrix — every other Settings page", () => {
  const CASES: Array<[string, string]> = [
    // profile
    ["your name", "Your name"],
    ["display name", "Your name"],
    ["calendar color", "Calendar color"],
    ["calendar feed", "Calendar feed"],
    ["ics", "Calendar feed"],
    // studio
    ["studio name", "Studio name"],
    ["legal entity", "Legal entity name"],
    ["time format", "Time format"],
    ["24 hour clock", "Time format"],
    ["birthday", "Birthday reminder color"],
    ["reminder", "Appointment reminders"],
    ["sms", "Appointment reminders"],
    ["send 24 hour reminders", "Appointment reminders"],
    // availability
    ["hours", "Availability"],
    ["weekly hours", "Weekly hours"],
    ["special hours", "Special hours"],
    ["blocked time", "Blocked time"],
    ["vacation", "Blocked time"],
    ["lunch", "Repeating breaks"],
    ["repeating breaks", "Repeating breaks"],
    // services
    ["services", "Services"],
    ["service menu order", "Service menu order"],
    ["price", "Services"],
    // team
    ["team", "Team"],
    ["invite a practitioner", "Invite a practitioner"],
    ["pending invitations", "Pending invitations"],
    // consent
    ["consent", "Consent forms"],
    ["photo consent", "Consent forms"],
    // forms & postcare
    ["intake form preview", "Intake form preview"],
    ["aftercare instructions", "Aftercare instructions"],
    ["postcare contact email", "Postcare contact email"],
    ["cancellation policy", "Cancellation and no-show policy"],
    // payments
    ["payments", "Payments"],
    ["late cancellation fee", "Payments"],
    ["stripe connection", "Payments"],
    // integrations
    ["google calendar", "Google Calendar"],
    ["calendar sync", "Google Calendar"],
    // tracking
    ["marketing", "Marketing & analytics"],
    ["pixel", "Marketing & analytics"],
    // import / data / launch
    ["quick import", "Quick import"],
    ["csv", "Quick import"],
    ["export your data", "Export your data"],
    ["delete all studio data", "Delete all studio data"],
    ["ready for booking checklist", "Launch"],
  ];

  for (const [query, title] of CASES) {
    it(`"${query}" → ${title}`, () => {
      const entry = top(query);
      expect(entry?.title, `"${query}" ranked ${entry?.title ?? "NOTHING"}`).toBe(
        title,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Authorization holds at CONTROL granularity too
// ---------------------------------------------------------------------------

describe("acceptance matrix — authorization", () => {
  it("owner-only controls return nothing for a practitioner", () => {
    for (const query of [
      "booking horizon",
      "horizon",
      "how far ahead",
      "timezone",
      "default duration",
      "public address",
      "booking page intro",
      "slug",
      "studio name",
      "legal entity",
      "time format",
      "birthday",
      "weekly hours",
      "special hours",
      "blocked time",
      "repeating breaks",
      "service menu order",
      "invite a practitioner",
      "pending invitations",
      "aftercare instructions",
      "postcare contact email",
      "late cancellation fee",
      "export your data",
      "delete all studio data",
    ]) {
      expect(
        titles(query, PRACTITIONER),
        `"${query}" leaked an owner-only control to a practitioner`,
      ).toEqual([]);
    }
  });

  it("practitioner-visible controls still resolve for a practitioner", () => {
    for (const [query, title] of [
      ["your name", "Your name"],
      ["calendar color", "Calendar color"],
      ["calendar feed", "Calendar feed"],
      ["intake form preview", "Intake form preview"],
      ["ready for booking checklist", "Launch"],
    ] as Array<[string, string]>) {
      expect(top(query, PRACTITIONER)?.title, query).toBe(title);
    }
  });

  it("case, spacing and punctuation never change the answer", () => {
    for (const variant of [
      "Booking Horizon",
      "BOOKING HORIZON",
      "  booking   horizon  ",
      "booking-horizon",
      "booking_horizon",
    ]) {
      expect(top(variant)?.id, variant).toBe("settings-booking-horizon");
    }
  });
});
