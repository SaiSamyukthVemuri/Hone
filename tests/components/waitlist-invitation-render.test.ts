import { describe, expect, it } from "vitest";
import { createElement } from "react";
import type { OfferedSlot, OfferPresentation } from "@/lib/waitlist/invitation-offer";
import type { ResolvedInvitation } from "@/lib/booking/waitlist-invitation";

// WAIT-03 B3 — what the recipient's screen actually RENDERS.
//
// Run through react-dom/server, the house pattern, because the properties that
// matter here are about markup a phone receives: that a dead end offers no
// booking control at all, that touch targets clear the floor, and that no
// queue position or other prospect ever appears.

const { renderToStaticMarkup } = await import("react-dom/server");
const { InvitationScreen } = await import(
  "@/app/features/waitlist-invitation/InvitationScreen"
);

// The screen never sees a weekday index: it renders the description the state
// layer already resolved through B2's scope module. That is why this file
// passes `windowDescription` as a string and holds no weekday numbers at all.
const PRESENTATION: OfferPresentation = {
  studioName: "Willow Electrolysis",
  serviceName: "Consultation",
  serviceDurationMinutes: 30,
  studioTimezone: "America/Toronto",
};

const INVITATION: ResolvedInvitation = {
  invitationId: "inv-1",
  studioId: "studio-1",
  entryId: "entry-1",
  scope: {
    serviceId: "svc-1",
    startDate: "2026-09-07",
    endDate: "2026-09-11",
    allowedWeekdays: [1, 3],
  },
  expiresAt: "2026-09-08T12:00:00.000Z",
  recipientContactHash: "hash",
};

const WINDOW_DESCRIPTION = "Mondays, Wednesdays, Sep 7, 2026 – Sep 11, 2026";

const SLOT: OfferedSlot = {
  start: "2026-09-07T13:00:00.000Z",
  end: "2026-09-07T13:30:00.000Z",
  startLabel: "9:00 AM",
};

const noop = () => {};

function render(state: Parameters<typeof InvitationScreen>[0]["state"], over = {}) {
  return renderToStaticMarkup(
    createElement(InvitationScreen, {
      state,
      selectedSlotStart: null,
      onSelectSlot: noop,
      onBook: noop,
      onDecline: noop,
      onRetry: noop,
      onRequestCode: noop,
      onSubmitCode: noop,
      ...over,
    }),
  );
}

describe("the offer screen", () => {
  const html = render({ kind: "offer", invitation: INVITATION, presentation: PRESENTATION, slots: [SLOT], windowDescription: WINDOW_DESCRIPTION, empty: false });

  it("states the offered horizon in words, as the state layer resolved it", () => {
    expect(html).toContain("Times held for you");
    // Rendered verbatim: the screen holds no weekday semantics of its own.
    expect(html).toContain("Mondays, Wednesdays, Sep 7, 2026");
  });

  it("shows the service and studio", () => {
    expect(html).toContain("Consultation");
    expect(html).toContain("Willow Electrolysis");
    expect(html).toContain("30 minutes");
  });

  it("offers the slot and both actions", () => {
    expect(html).toContain("9:00 AM");
    expect(html).toContain("Book this time");
    expect(html).toContain("I can’t make any of these");
  });

  it("every control clears the 44px touch floor", () => {
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b, `control below the touch floor: ${b}`).toContain("min-h-[44px]");
  });

  it("book is disabled until a time is chosen", () => {
    expect(html).toMatch(/Book this time/);
    expect(html).toContain("disabled");
  });

  it("enables book once a slot is selected", () => {
    const chosen = render(
      { kind: "offer", invitation: INVITATION, presentation: PRESENTATION, slots: [SLOT], windowDescription: WINDOW_DESCRIPTION, empty: false },
      { selectedSlotStart: SLOT.start },
    );
    expect(chosen).toContain('aria-pressed="true"');
  });

  it("NEVER shows a queue position or another prospect", () => {
    for (const forbidden of ["position", "queue", "waitlist #", "others", "ahead of you"]) {
      expect(html.toLowerCase(), `leaked: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("is a single column at every width — no horizontal scroll on a phone", () => {
    expect(html).toContain("max-w-md");
    expect(html).not.toContain("md:grid-cols-2");
  });
});

describe("an empty window is not a dead end", () => {
  const html = render({ kind: "offer", invitation: INVITATION, presentation: PRESENTATION, slots: [], windowDescription: WINDOW_DESCRIPTION, empty: true });

  it("explains, and offers a retry rather than a booking control", () => {
    expect(html).toContain("Nothing is open");
    expect(html).toContain("Check again");
    expect(html).not.toContain("Book this time");
  });

  it("still lets the recipient decline", () => {
    expect(html).toContain("I can’t make any of these");
  });
});

describe("terminal states offer nothing to press", () => {
  for (const reason of ["expired", "revoked", "already_redeemed", "declined"] as const) {
    it(`${reason} renders NO booking or decline control at all`, () => {
      const html = render({ kind: "closed", reason, presentation: PRESENTATION });
      // Not a disabled button: a greyed control invites tapping and explains
      // nothing. There is simply no control.
      expect(html).not.toContain("Book this time");
      expect(html).not.toContain("I can’t make any of these");
      expect(html).not.toContain("<button");
    });
  }

  it("expired says so plainly", () => {
    expect(render({ kind: "closed", reason: "expired", presentation: PRESENTATION })).toContain("has expired");
  });

  it("revoked does not blame the recipient", () => {
    const html = render({ kind: "closed", reason: "revoked", presentation: PRESENTATION });
    expect(html).toContain("no longer available");
  });
});

describe("loading, error and declined", () => {
  it("loading announces itself to assistive tech", () => {
    const html = render({ kind: "loading" });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading your invitation");
  });

  it("a retryable error offers a retry; a terminal one does not", () => {
    expect(render({ kind: "error", retryable: true })).toContain("Try again");
    const dead = render({ kind: "error", retryable: false });
    expect(dead).not.toContain("Try again");
    expect(dead).toContain("no longer valid");
  });

  it("an error is announced as an alert", () => {
    expect(render({ kind: "error", retryable: true })).toContain('role="alert"');
  });

  it("declining keeps the recipient on the list, with no queue detail", () => {
    const html = render({ kind: "declined" });
    expect(html).toContain("still on the studio’s list");
    expect(html.toLowerCase()).not.toContain("position");
  });
});

describe("possession shows the offer and no times", () => {
  const html = render({
    kind: "proof",
    presentation: PRESENTATION,
    windowDescription: WINDOW_DESCRIPTION,
    stage: { kind: "required" },
  });

  it("shows WHAT was offered", () => {
    expect(html).toContain("Consultation");
    expect(html).toContain("Times held for you");
    expect(html).toContain("Mondays, Wednesdays");
  });

  it("offers no bookable time and no booking control", () => {
    // A forwarded link reveals the offer's shape and nothing to act on.
    expect(html).not.toContain("9:00 AM");
    expect(html).not.toContain("Book this time");
  });

  it("asks the recipient to confirm identity first", () => {
    expect(html).toContain("Email me a code");
  });

  it("shows the contact MASKED, never raw", () => {
    const sent = render({
      kind: "proof",
      presentation: PRESENTATION,
      windowDescription: WINDOW_DESCRIPTION,
      stage: {
        kind: "sent",
        maskedContact: "s\u2022\u2022\u2022\u2022\u2022@example.com",
        expiresAt: "2026-09-07T13:00:00.000Z",
      },
    });
    expect(sent).toContain("@example.com");
    expect(sent).not.toContain("someone@example.com");
    expect(sent).toContain("one-time-code");
  });

  it("a wrong code keeps the recipient on the code screen with a way forward", () => {
    const failed = render({
      kind: "proof",
      presentation: PRESENTATION,
      windowDescription: WINDOW_DESCRIPTION,
      stage: {
        kind: "failed",
        reason: "wrong_challenge",
        maskedContact: "s\u2022\u2022\u2022@example.com",
        expiresAt: "2026-09-07T13:00:00.000Z",
      },
    });
    expect(failed).toContain("didn\u2019t match");
    expect(failed).toContain("Send a new code");
    expect(failed).toContain("Confirm it\u2019s you");
  });

  it("every proof control clears the touch floor", () => {
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b).toContain("min-h-[44px]");
  });
});
