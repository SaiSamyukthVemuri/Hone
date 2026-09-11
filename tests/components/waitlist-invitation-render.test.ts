import { describe, expect, it } from "vitest";
import { createElement } from "react";
import type { OfferedSlot, OfferPresentation } from "@/lib/waitlist/invitation-offer";

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

const WINDOW_DESCRIPTION = "Mondays, Wednesdays, Sep 7, 2026 – Sep 11, 2026";


const SLOT2: OfferedSlot = {
  start: "2026-09-09T13:00:00.000Z",
  end: "2026-09-09T13:30:00.000Z",
  startLabel: "9:00 AM",
};

const SLOT: OfferedSlot = {
  start: "2026-09-07T13:00:00.000Z",
  end: "2026-09-07T13:30:00.000Z",
  startLabel: "9:00 AM",
};

const OFFER_STATE = {
  kind: "offer" as const,
  presentation: PRESENTATION,
  days: [{ date: "2026-09-07", dateLabel: "Mon, Sep 7", slots: [SLOT] as const }],
  windowDescription: WINDOW_DESCRIPTION,
};

const noop = () => {};

/**
 * MATCH THE ATTRIBUTE, NOT THE CLASS.
 *
 * Every control here carries `disabled:opacity-60` in its class list, so
 * `toContain("disabled")` passes whether or not the control is actually
 * disabled. One assertion in this file was written that way and would have held
 * with its `disabled={…}` prop removed; rather than fix that one, the matcher
 * is shared so the next one cannot be written loosely either.
 */
const DISABLED_ATTR = /\sdisabled(=|\s|>)/;

/** The rendered tag for a button whose visible label matches. */
function buttonWithLabel(html: string, label: string): string {
  const tags = html.match(/<button[^>]*>/g) ?? [];
  const idx = html.indexOf(label);
  const found = tags.filter((t) => {
    const at = html.indexOf(t);
    return at < idx && html.indexOf("</button>", at) > idx;
  });
  return found[found.length - 1] ?? "";
}

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
  const html = render({ kind: "offer", presentation: PRESENTATION, days: [{ date: "2026-09-07", dateLabel: "Mon, Sep 7", slots: [SLOT] as const }], windowDescription: WINDOW_DESCRIPTION });

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

  it("book is DISABLED until a time is chosen", () => {
    const tag = buttonWithLabel(html, "Book this time");
    expect(tag, "no Book button found to check").not.toBe("");
    expect(tag, `Book was enabled with no slot chosen: ${tag}`).toMatch(DISABLED_ATTR);
  });

  it("book becomes ENABLED once a slot is selected", () => {
    // The pair is the point: neither state alone proves the button changes.
    const chosen = render(OFFER_STATE, { selectedSlotStart: SLOT.start });
    const tag = buttonWithLabel(chosen, "Book this time");
    expect(tag).not.toBe("");
    expect(tag, `Book stayed disabled with a slot chosen: ${tag}`).not.toMatch(DISABLED_ATTR);
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
  const html = render({ kind: "offer", presentation: PRESENTATION, days: [], windowDescription: WINDOW_DESCRIPTION });

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
  for (const reason of [
    "expired",
    "revoked",
    "already_redeemed",
    "consumed_without_booking",
    "unsupported_offer",
    "declined",
  ] as const) {
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

  // P2-A. An offer naming a service the booking path cannot accept.
  describe("unsupported_offer", () => {
    const html = render({
      kind: "closed",
      reason: "unsupported_offer",
      presentation: PRESENTATION,
    });

    it("says the link cannot book it, and points at the studio", () => {
      expect(html).toContain("can’t be booked online");
      expect(html).toContain("contact the studio");
    });

    it("makes NO claim the studio withdrew the offer", () => {
      // `revoked` copy would assert an operator action nothing here knows about,
      // and the invitation is in fact still live.
      expect(html).not.toContain("withdrawn");
    });

    it("does not invite a retry that cannot help", () => {
      expect(html).not.toContain("Check again");
      expect(html).not.toContain("Try again");
    });

    it("still names the service the recipient was actually offered", () => {
      // No substitution: they see what the invitation said, not a service
      // silently swapped in behind it.
      expect(html).toContain(PRESENTATION.serviceName);
    });
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

  it("declining says what happened, with no queue detail", () => {
    const html = render({ kind: "declined" });
    expect(html).toContain("declined this appointment");
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

describe("a multi-day offer is unambiguous", () => {
  const html = render({
    kind: "offer",
    presentation: PRESENTATION,
    days: [
      { date: "2026-09-07", dateLabel: "Mon, Sep 7", slots: [SLOT] as const },
      { date: "2026-09-09", dateLabel: "Wed, Sep 9", slots: [SLOT2] as const },
    ],
    windowDescription: WINDOW_DESCRIPTION,
  });

  it("names each day as a heading", () => {
    expect(html).toContain("Mon, Sep 7");
    expect(html).toContain("Wed, Sep 9");
  });

  it("two 9:00 AM buttons are distinguishable to a screen reader too", () => {
    // Same visible label on both days; the accessible name carries the day.
    expect(html).toContain('aria-label="Mon, Sep 7 at 9:00 AM"');
    expect(html).toContain('aria-label="Wed, Sep 9 at 9:00 AM"');
  });
});

describe("the proof code field accepts the credential B1.5c mints", () => {
  const html = render({
    kind: "proof",
    presentation: PRESENTATION,
    windowDescription: WINDOW_DESCRIPTION,
    stage: {
      kind: "sent",
      maskedContact: "s\u2022\u2022\u2022@example.com",
      expiresAt: "2026-09-07T13:00:00.000Z",
    },
  });

  it("does NOT ask for a digits-only keyboard", () => {
    // The challenge is ^[a-f0-9]{64}$ -- nearly every one contains a-f.
    expect(html).not.toContain('inputMode="numeric"');
    expect(html).toContain('inputMode="text"');
  });

  it("does not fight the recipient with autocorrect or capitalisation", () => {
    expect(html).toContain('autoCapitalize="none"');
    expect(html).toContain('autoCorrect="off"');
  });
});

describe("a terminal proof outcome renders no live controls", () => {
  const html = render({
    kind: "proof",
    presentation: PRESENTATION,
    windowDescription: WINDOW_DESCRIPTION,
    stage: { kind: "unavailable", retryable: false },
  });

  it("says so and offers nothing to press", () => {
    expect(html).toContain("no longer available");
    expect(html).not.toContain("Confirm it\u2019s you");
    expect(html).not.toContain("Send a new code");
    expect(html).not.toContain("Try again");
  });
});

describe("declining promises only what decline does", () => {
  it("does not claim continued list membership or future contact", () => {
    const html = render({ kind: "declined" });
    // Decline releases the entry; only a practitioner-authorised requeue puts
    // it back. Promising automatic follow-up would be untrue.
    expect(html.toLowerCase()).not.toContain("still on the studio");
    expect(html.toLowerCase()).not.toContain("be in touch");
    expect(html).toContain("contact them directly");
  });
});

// ---------------------------------------------------------------------------
// REVIEW P2 — `verifying` had no branch, so it fell through to "start over".
// A recipient who had just submitted saw "Email me a code" again, enabled, and
// pressing it minted a fresh challenge that destroyed the verification in
// flight (`begin_` overwrites the challenge hash in place).
// ---------------------------------------------------------------------------
describe("verifying is busy and non-interactive", () => {
  const html = render({
    kind: "proof",
    presentation: PRESENTATION,
    windowDescription: WINDOW_DESCRIPTION,
    stage: {
      kind: "verifying",
      maskedContact: "s\u2022\u2022\u2022@example.com",
      expiresAt: "2026-09-07T13:00:00.000Z",
      submittedCode: "a1b2c3d4",
    },
  });

  it("says what is happening and announces it", () => {
    expect(html).toContain("Checking your code");
    expect(html).toContain('aria-busy="true"');
  });

  it("keeps the submitted code visible", () => {
    expect(html).toContain("a1b2c3d4");
  });

  it("offers NO way to request a new code while a check is running", () => {
    // The defect: a new challenge here invalidates the verification in flight.
    expect(html).not.toContain("Email me a code");
    expect(html).not.toContain("Send a new code");
  });

  it("renders no interactive control at all", () => {
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
  });

  it("still shows what was offered", () => {
    expect(html).toContain("Times held for you");
    expect(html).toContain("Consultation");
  });
});

// ---------------------------------------------------------------------------
// REVIEW P2 — a booking in flight must not have its slot changed underneath it.
// Book and Decline were disabled while `pending`; the times were not.
// ---------------------------------------------------------------------------
describe("slot selection freezes while a booking is pending", () => {
  const offerState = {
    kind: "offer" as const,
    presentation: PRESENTATION,
    days: [
      { date: "2026-09-07", dateLabel: "Mon, Sep 7", slots: [SLOT] as const },
      { date: "2026-09-09", dateLabel: "Wed, Sep 9", slots: [SLOT2] as const },
    ],
    windowDescription: WINDOW_DESCRIPTION,
  };

  // MATCH THE ATTRIBUTE, NOT THE CLASS. The button carries
  // `disabled:opacity-60` in its class list, so a substring check for
  // "disabled" passes whether or not the control is actually disabled -- the
  // pending assertion below would have held with `disabled={pending}` removed.
  const DISABLED_ATTR = /\sdisabled(=|\s|>)/;

  function slotButtons(html: string): string[] {
    return html.match(/<button[^>]*aria-label="[^"]*at [^"]*"[^>]*>/g) ?? [];
  }

  it("every slot control is disabled while pending", () => {
    const buttons = slotButtons(render(offerState, { selectedSlotStart: SLOT.start, pending: true }));
    expect(buttons.length, "no slot buttons found to check").toBe(2);
    for (const b of buttons) expect(b, `slot stayed clickable: ${b}`).toMatch(DISABLED_ATTR);
  });

  it("slots stay clickable when nothing is in flight", () => {
    const buttons = slotButtons(render(offerState, { selectedSlotStart: SLOT.start, pending: false }));
    expect(buttons.length).toBe(2);
    for (const b of buttons) expect(b, `slot disabled with nothing in flight: ${b}`).not.toMatch(DISABLED_ATTR);
  });
});

// ===========================================================================
// THE PHONE FIELD — shown only where the studio has no number
// ===========================================================================
//
// Joining a waitlist makes a phone optional; booking requires one. Without this
// field an entry that joined without a number reached a Book button that could
// only ever answer "Please enter a phone number", with nowhere to enter it.

describe("the phone the booking engine requires", () => {
  const needsPhone = { ...OFFER_STATE, phoneRequired: true as const };

  it("is asked for BEFORE the attempt, not after a refusal", () => {
    const html = render(needsPhone);
    expect(html).toContain("Your phone number");
    expect(html).toContain("The studio needs a number to confirm this appointment.");
    expect(html).toContain('type="tel"');
  });

  it("is NOT asked for when the studio already holds one", () => {
    // The rule that keeps this from becoming a form: a stored number is the
    // invited person's own datum and must never be re-requested.
    const html = render(OFFER_STATE);
    expect(html).not.toContain("Your phone number");
    expect(html).not.toContain('type="tel"');
  });

  it("GATES the Book control until a number is typed", () => {
    // An enabled button that cannot succeed is the defect being removed.
    const empty = render(needsPhone, { selectedSlotStart: SLOT.start, typedPhone: "" });
    expect(buttonWithLabel(empty, "Book this time")).toMatch(DISABLED_ATTR);

    const blank = render(needsPhone, { selectedSlotStart: SLOT.start, typedPhone: "   " });
    expect(buttonWithLabel(blank, "Book this time")).toMatch(DISABLED_ATTR);
  });

  it("RELEASES the Book control once one is", () => {
    // Non-vacuity for the gate: it is the phone doing this, not the slot.
    const typed = render(needsPhone, {
      selectedSlotStart: SLOT.start,
      typedPhone: "416 555 0000",
    });
    expect(buttonWithLabel(typed, "Book this time")).not.toMatch(DISABLED_ATTR);
  });

  it("does not gate an entry that HAS a stored number", () => {
    const html = render(OFFER_STATE, { selectedSlotStart: SLOT.start, typedPhone: "" });
    expect(buttonWithLabel(html, "Book this time")).not.toMatch(DISABLED_ATTR);
  });
});
