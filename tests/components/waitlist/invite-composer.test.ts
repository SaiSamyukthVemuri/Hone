import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

import { InviteComposer } from "@/components/waitlist/invite-composer";
import {
  BOOKING_WINDOW_PRESETS,
  TTL_PRESETS,
  WEEKDAYS_IN_DISPLAY_ORDER,
  emptyDraft,
  type InviteDraft,
} from "@/lib/waitlist/b4-invitation-draft";
import type { AdapterCapabilities } from "@/lib/waitlist/invite-to-book-contract";

// ===========================================================================
// WAIT-03 B4 — the composer renders against NON-AUTHORITATIVE fixtures
// ===========================================================================
//
// No adapter exists. These fixtures are invented, live only in this file, and
// are not exported from any runtime module.

const SERVICES = [
  { id: "svc-1", name: "Electrolysis consultation" },
  { id: "svc-2", name: "Laser — full leg" },
];

const CONNECTED: AdapterCapabilities = {
  enforcesScope: true,
  canResend: true,
  canCancel: true,
  canReturnToWaitlist: true,
  canRemove: true,
};

const render = (el: ReactElement) => renderToStaticMarkup(el);

const draft = (over: Partial<InviteDraft> = {}): InviteDraft => ({
  ...emptyDraft(),
  ...over,
});

const compose = (over: Partial<InviteDraft> = {}, capabilities: AdapterCapabilities | null = null) =>
  render(
    InviteComposer({
      entryId: "entry-1",
      entryName: "Sarah",
      draft: draft(over),
      services: SERVICES,
      capabilities,
    }),
  );

/** The whole opening tag carrying one test id — see the note in the row test
 *  about why a forward slice from the test id is vacuous. */
function controlTag(html: string, testId: string): string {
  const tag = [...html.matchAll(/<(?:button|input|select)[^>]*>/g)]
    .map((m) => m[0])
    .find((t) => t.includes(`data-testid="${testId}"`));
  if (!tag) throw new Error(`no control rendered for "${testId}"`);
  return tag;
}

// ---------------------------------------------------------------------------

describe("the composer is one screen, not a wizard", () => {
  const html = compose();

  it("names the person it is inviting", () => {
    expect(html).toContain("Invite Sarah to book");
  });

  it("shows all four questions at once", () => {
    for (const field of ["service", "window", "days", "expiry"]) {
      expect(html, `field ${field} is missing`).toContain(
        `data-testid="composer-field-${field}"`,
      );
    }
  });

  it("has no step rail, no step numbers and no review step", () => {
    // The earlier revision wrapped four decisions in six numbered steps, and a
    // practitioner could not see what they had chosen without walking back.
    expect(html).not.toContain("composer-rail");
    expect(html).not.toContain("composer-step");
    expect(html).not.toContain("Review");
  });

  it("does not ask who, because the row already answered", () => {
    // Choosing people inside the composer is what made "invite these five" and
    // "invite the next five" look like one control, when they are two different
    // commands and only one of them accepts a list of people.
    expect(html).not.toContain("Who to invite");
    expect(html).not.toContain("people chosen");
  });

  it("never offers Claim, Claim next or Reinvite", () => {
    for (const forbidden of ["Claim", "Reinvite", "Send a new invitation"]) {
      expect(html, `"${forbidden}" reached the composer`).not.toContain(forbidden);
    }
  });
});

describe("the service selector", () => {
  const html = compose();

  it("lists the studio's services and treats no preference as an answer", () => {
    expect(html).toContain("Any service");
    for (const service of SERVICES) expect(html).toContain(service.name);
  });

  it("takes its accessible name from the visible heading, once", () => {
    // An `sr-only` copy of the section title made a screen reader announce
    // "Service" twice for one control.
    expect(controlTag(html, "composer-service")).toContain(
      'aria-labelledby="wl-entry-1-composer-label-service"',
    );
    expect(html).toContain('id="wl-entry-1-composer-label-service"');
    expect(html).not.toContain('<span class="sr-only">Service</span>');
    // Exactly one element carries that id, or `aria-labelledby` resolves to
    // whichever came first.
    expect(html.match(/id="wl-entry-1-composer-label-service"/g)).toHaveLength(1);
  });

  it("uses the field primitive, so iOS cannot zoom the viewport on focus", () => {
    // 16px on any coarse pointer; 14px only where the pointer is precise.
    const tag = controlTag(html, "composer-service");
    expect(tag).toContain("text-base");
    expect(tag).toContain("pointer-fine:text-sm");
    expect(tag).toContain("min-h-[44px]");
  });
});

describe("booking window", () => {
  it("offers the product's three presets plus custom", () => {
    const html = compose();
    expect(html).toContain("Next 7 days");
    expect(html).toContain("Next 2 weeks");
    expect(html).toContain("Next 30 days");
    expect(html).toContain('data-testid="composer-window-custom"');
    for (const preset of BOOKING_WINDOW_PRESETS) {
      expect(html).toContain(`data-testid="composer-window-${preset.days}"`);
    }
  });

  it("marks the selected preset with aria-pressed, not colour alone", () => {
    const html = compose({ windowDays: 14 });
    expect(controlTag(html, "composer-window-14")).toContain('aria-pressed="true"');
    expect(controlTag(html, "composer-window-7")).toContain('aria-pressed="false"');
  });

  it("reveals the number field only when the value is off-preset", () => {
    expect(compose({ windowDays: 7 })).not.toContain('data-testid="composer-window-days"');
    const custom = compose({ windowDays: 45 });
    expect(custom).toContain('data-testid="composer-window-days"');
    expect(controlTag(custom, "composer-window-custom")).toContain('aria-pressed="true"');
  });
});

describe("allowed days", () => {
  it("offers every day, weekdays, weekends and custom", () => {
    const html = compose();
    for (const preset of ["every", "weekdays", "weekends", "custom"]) {
      expect(html).toContain(`data-testid="composer-days-${preset}"`);
    }
    expect(html).toContain("Every day");
    expect(html).toContain("Weekdays");
    expect(html).toContain("Weekends");
  });

  it("derives the pressed preset from the value rather than a second field", () => {
    expect(controlTag(compose(), "composer-days-every")).toContain('aria-pressed="true"');
    expect(
      controlTag(compose({ allowedWeekdays: [1, 2, 3, 4, 5] }), "composer-days-weekdays"),
    ).toContain('aria-pressed="true"');
    expect(
      controlTag(compose({ allowedWeekdays: [0, 6] }), "composer-days-weekends"),
    ).toContain('aria-pressed="true"');
  });

  it("shows the weekday toggles only for a custom set, Monday first", () => {
    expect(compose()).not.toContain('data-testid="composer-weekdays"');
    const html = compose({ allowedWeekdays: [1, 3] });
    expect(html).toContain('data-testid="composer-weekdays"');

    // MONDAY FIRST, WHICH IS NOT INDEX ORDER. Selecting "Mon–Fri" by position
    // must not quietly select Sunday–Thursday, so the rendered ORDER is checked
    // rather than merely the presence of seven buttons.
    const order = [...html.matchAll(/data-testid="composer-weekday-(\d)"/g)].map((m) =>
      Number(m[1]),
    );
    expect(order).toEqual(WEEKDAYS_IN_DISPLAY_ORDER.map((d) => d.index));
    expect(order).toEqual([1, 2, 3, 4, 5, 6, 0]);

    expect(controlTag(html, "composer-weekday-1")).toContain('aria-pressed="true"');
    expect(controlTag(html, "composer-weekday-2")).toContain('aria-pressed="false"');
  });

  it("gives the three-letter toggles a width floor as well as a height one", () => {
    // A 44px-tall box around "Mon" is taller than it is wide and reads as a
    // mis-render rather than as a target.
    const tag = controlTag(compose({ allowedWeekdays: [1] }), "composer-weekday-1");
    expect(tag).toContain("min-h-[44px]");
    expect(tag).toContain("min-w-[3.25rem]");
  });
});

describe("invitation expiry", () => {
  it("offers presets that are all inside the command's own bounds", () => {
    const html = compose();
    for (const preset of TTL_PRESETS) {
      expect(html).toContain(`data-testid="composer-expiry-${preset.hours}"`);
      expect(html).toContain(preset.label);
    }
  });

  it("states the bound where a custom value is entered", () => {
    // The command REFUSES an out-of-range window rather than clamping it, so a
    // practitioner who types 200 needs to know why nothing happened.
    const html = compose({ expiresInHours: 5 });
    expect(html).toContain('data-testid="composer-expiry-hours"');
    expect(html).toContain("1 hour to 7 days");
    expect(controlTag(html, "composer-expiry-hours")).toContain('max="168"');
  });
});

describe("two composers on one page cannot cross-reference each other", () => {
  it("namespaces every id per entry", () => {
    // The row learned this after ids collided across rows; the composer was
    // then written with global constants — `composer-error-service`,
    // `composer-label-days`, `composer-send-reason` — and collided across
    // instances. The second composer's `aria-labelledby` and
    // `aria-describedby` resolved to the FIRST one's content, so a screen
    // reader could announce another person's validation error.
    const draftA: Partial<InviteDraft> = { serviceId: "svc-deleted" };
    const a = render(
      InviteComposer({
        entryId: "entry-A",
        entryName: "Sarah",
        draft: { ...emptyDraft(), ...draftA },
        services: SERVICES,
        capabilities: null,
      }),
    );
    const b = render(
      InviteComposer({
        entryId: "entry-B",
        entryName: "Nadia",
        draft: { ...emptyDraft(), ...draftA },
        services: SERVICES,
        capabilities: null,
      }),
    );

    const ids = (html: string) => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    const idsA = ids(a);
    const idsB = ids(b);
    // Non-vacuity: both must actually emit ids, and the same number of them.
    expect(idsA.length).toBeGreaterThan(2);
    expect(idsA.length).toBe(idsB.length);
    for (const id of idsA) {
      expect(idsB, `id "${id}" is shared between two composers`).not.toContain(id);
    }

    // And every reference still resolves WITHIN its own instance — the point
    // of namespacing is not merely that the ids differ.
    for (const html of [a, b]) {
      const own = new Set(ids(html));
      const refs = [
        ...html.matchAll(/aria-(?:describedby|labelledby|errormessage)="([^"]+)"/g),
      ].flatMap((m) => m[1].split(/\s+/).filter(Boolean));
      expect(refs.length).toBeGreaterThan(2);
      for (const ref of refs) {
        expect(own.has(ref), `reference "${ref}" escapes its own composer`).toBe(true);
      }
    }

    // A composer whose entry id is not id-safe still emits usable ids.
    const odd = render(
      InviteComposer({
        entryId: "weird id/with:chars",
        entryName: "X",
        draft: emptyDraft(),
        services: SERVICES,
        capabilities: null,
      }),
    );
    for (const id of ids(odd)) {
      expect(id, `"${id}" is not a usable HTML id`).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
    }
  });
});

describe("every validation error is wired to the control it explains", () => {
  /** The opening tag of the element carrying a test id — any element, so a
   *  role="group" wrapper is found alongside inputs and selects. */
  function tagFor(html: string, testId: string): string {
    const tag = [...html.matchAll(/<[a-z]+[^>]*>/g)]
      .map((m) => m[0])
      .find((t) => t.includes(`data-testid="${testId}"`));
    if (!tag) throw new Error(`nothing rendered with test id "${testId}"`);
    return tag;
  }

  /** Every id referenced by aria-describedby / aria-errormessage / labelledby. */
  function references(html: string): string[] {
    return [
      ...html.matchAll(/aria-(?:describedby|errormessage|labelledby)="([^"]+)"/g),
    ].flatMap((m) => m[1].split(/\s+/));
  }

  it("1 — a service that vanished marks the select invalid and points at its error", () => {
    const html = compose({ serviceId: "svc-deleted" }, CONNECTED);
    const select = tagFor(html, "composer-service");
    expect(select).toContain('aria-invalid="true"');
    expect(select).toContain('aria-describedby="wl-entry-1-composer-error-service"');
    expect(html).toContain('id="wl-entry-1-composer-error-service"');
  });

  it("2 — an out-of-range window points the window control at its error", () => {
    const html = compose({ windowDays: 900 }, CONNECTED);
    const input = tagFor(html, "composer-window-days");
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain('aria-describedby="wl-entry-1-composer-error-window"');
    expect(html).toContain('id="wl-entry-1-composer-error-window"');
  });

  it("3 — an empty weekday set points the GROUP at its error, not seven buttons", () => {
    const html = compose({ allowedWeekdays: [] }, CONNECTED);
    const group = tagFor(html, "composer-weekday-group");
    expect(group).toContain('role="group"');
    expect(group).toContain('aria-describedby="wl-entry-1-composer-error-days"');
    // NOT `aria-invalid`: ARIA supports it on widget roles, not on `group`, so
    // assistive tech ignores it and the repo's a11y lint rejects it. The error
    // reaches the user through the description, which is what they hear on
    // entering the group.
    expect(group).not.toContain("aria-invalid");
    expect(html).toContain('id="wl-entry-1-composer-error-days"');
    // The message belongs to the SET, so it must not be repeated on each
    // toggle — that announces one error seven times and still names no remedy.
    expect(html.match(/aria-describedby="wl-entry-1-composer-error-days"/g)).toHaveLength(1);
  });

  it("3b — an out-of-range expiry points the expiry control at its error", () => {
    const html = compose({ expiresInHours: 999 }, CONNECTED);
    const input = tagFor(html, "composer-expiry-hours");
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain('aria-describedby="wl-entry-1-composer-error-expiry"');
    expect(html).toContain('id="wl-entry-1-composer-error-expiry"');
  });

  it("4 — a corrected field leaves no stale invalid state and no dangling reference", () => {
    const html = compose({ serviceId: "svc-1", windowDays: 14, expiresInHours: 48 }, CONNECTED);
    expect(tagFor(html, "composer-service")).not.toContain("aria-invalid");
    expect(tagFor(html, "composer-service")).not.toContain("aria-describedby");
    expect(html).not.toContain('id="wl-entry-1-composer-error-service"');
    expect(html).not.toContain("wl-entry-1-composer-error-window");
    expect(html).not.toContain("wl-entry-1-composer-error-expiry");
    expect(html).not.toContain("wl-entry-1-composer-error-days");
    // NEGATIVE CONTROL: the same expressions DO find the association when the
    // field is invalid, so the absences above are not vacuous.
    const broken = compose({ serviceId: "svc-deleted" }, CONNECTED);
    expect(tagFor(broken, "composer-service")).toContain("aria-invalid");
    expect(broken).toContain('id="wl-entry-1-composer-error-service"');
  });

  it("5 — every aria reference resolves inside the same composer instance", () => {
    // A dangling reference announces that an explanation exists and then has
    // none to give, which is worse than no association at all.
    const cases: Array<Partial<InviteDraft>> = [
      {},
      { serviceId: "svc-deleted" },
      { windowDays: 900 },
      { allowedWeekdays: [] },
      { expiresInHours: 999 },
      { serviceId: "svc-deleted", windowDays: 0, allowedWeekdays: [], expiresInHours: 0 },
      { serviceId: "svc-1", windowDays: 45, allowedWeekdays: [1, 3], expiresInHours: 5 },
    ];
    let checked = 0;
    for (const over of cases) {
      for (const caps of [null, CONNECTED]) {
        const html = compose(over, caps);
        const ids = new Set(
          [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]),
        );
        for (const ref of references(html)) {
          checked += 1;
          expect(ids.has(ref), `aria reference "${ref}" resolves to nothing`).toBe(true);
        }
      }
    }
    // Non-vacuity: the sweep must actually have found references to check.
    expect(checked).toBeGreaterThan(10);
  });

  it("attaches each message ONLY to the field it explains", () => {
    // Every field invalid at once: each control must reference its own error
    // and no other.
    const html = compose(
      { serviceId: "svc-deleted", windowDays: 0, allowedWeekdays: [], expiresInHours: 0 },
      CONNECTED,
    );
    const pairs: Array<[string, string]> = [
      ["composer-service", "service"],
      ["composer-window-days", "window"],
      ["composer-weekday-group", "days"],
      ["composer-expiry-hours", "expiry"],
    ];
    for (const [testId, field] of pairs) {
      const tag = tagFor(html, testId);
      expect(tag).toContain(`wl-entry-1-composer-error-${field}`);
      for (const [, other] of pairs) {
        if (other === field) continue;
        expect(tag, `${testId} also references the ${other} error`).not.toContain(
          `wl-entry-1-composer-error-${other}`,
        );
      }
    }
  });
});

describe("the send control", () => {
  it("is disabled and says which control is unconnected", () => {
    const html = compose();
    expect(controlTag(html, "composer-send")).toContain('disabled=""');
    expect(html).toContain("“Invite to book” is not connected yet");
    // FINDING C: no generic sentence about sending in the abstract.
    expect(html.toLowerCase()).not.toContain("sending is not available");
  });

  it("blames a fixable field before blaming the missing service", () => {
    const html = compose({ expiresInHours: 999 });
    expect(html).toContain("Fix the highlighted fields");
    expect(html).toContain('data-testid="composer-error-expiry"');
    expect(controlTag(html, "composer-expiry-hours")).toContain('aria-invalid="true"');
  });

  it("refuses to send a scope the adapter cannot carry", () => {
    // Sending anyway would produce an invitation that ignores the service and
    // window just chosen, which the invitee then books outside of.
    const html = compose({}, { ...CONNECTED, enforcesScope: false });
    expect(controlTag(html, "composer-send")).toContain('disabled=""');
    expect(html).toContain("cannot apply a service or booking window");
  });

  it("enables only once an adapter reports it can carry the scope", () => {
    const html = compose({}, CONNECTED);
    expect(controlTag(html, "composer-send")).not.toContain('disabled=""');
    // NEGATIVE CONTROL: the identical expression must find it disabled when no
    // adapter is bound, or the assertion above proves nothing.
    expect(controlTag(compose(), "composer-send")).toContain('disabled=""');
  });

  it("is full width and comes before Cancel in the DOM", () => {
    const html = compose({}, CONNECTED);
    expect(controlTag(html, "composer-send")).toContain("w-full");
    // On a phone the primary is the control a thumb reaches for; ordering
    // Cancel first to place it visually left on a desktop would put it under
    // the thumb on every phone.
    expect(html.indexOf('data-testid="composer-send"')).toBeLessThan(
      html.indexOf('data-testid="composer-cancel"'),
    );
    expect(html).toContain("Send invitation");
    expect(html).toContain("Cancel");
  });

  it("refuses a service that vanished instead of quietly widening the scope", () => {
    // The composer renders the chosen service by looking it up in `services`.
    // When the lookup misses — deleted service, or the list refreshed under an
    // open composer — the summary used to read "any service" while the payload
    // still carried the stale id, so the practitioner confirmed one scope and
    // sent another.
    const html = compose({ serviceId: "svc-deleted" }, CONNECTED);
    expect(controlTag(html, "composer-send")).toContain('disabled=""');
    expect(html).toContain('data-testid="composer-error-service"');
    expect(html).toContain("no longer available");
    // The summary is withheld rather than describing a scope the send will not
    // carry — it must not claim "any service".
    expect(html).not.toContain('data-testid="composer-summary"');

    // NEGATIVE CONTROL: the identical call with the service present sends.
    const ok = compose({ serviceId: "svc-1" }, CONNECTED);
    expect(controlTag(ok, "composer-send")).not.toContain('disabled=""');
    expect(ok).toContain('data-testid="composer-summary"');
  });

  it("summarises the scope without claiming anything has been sent", () => {
    const html = compose({ serviceId: "svc-2", windowDays: 14, allowedWeekdays: [1, 2] });
    expect(html).toContain("Laser — full leg");
    expect(html).toContain("next 2 weeks");
    expect(html).toContain("Mon, Tue");
    // Future tense only. Nothing here may read as a receipt.
    expect(html).not.toContain("has been sent");
    expect(html).not.toContain("Invitation sent");
  });
});
