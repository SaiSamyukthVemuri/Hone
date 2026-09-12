import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { ReactElement } from "react";
import { isConsultationService } from "@/lib/booking/consultation";

import { InviteComposer } from "@/components/waitlist/invite-composer";
import {
  BOOKING_WINDOW_PRESETS,
  TTL_PRESETS,
  WEEKDAYS_IN_DISPLAY_ORDER,
  emptyDraft,
  waitlistDomId,
  type InviteDraft,
} from "@/lib/waitlist/b4-invitation-draft";
import type { AdapterCapabilities } from "@/lib/waitlist/invite-to-book-contract";
import {
  COMPOSER_FIELD_NAMES,
  inviteSubmissionFromFormData,
  type InviteComposerAction,
} from "@/lib/waitlist/b4-invitation-draft";

// ===========================================================================
// WAIT-03 B4 — the composer renders against NON-AUTHORITATIVE fixtures
// ===========================================================================
//
// No adapter exists. These fixtures are invented, live only in this file, and
// are not exported from any runtime module.

const SERVICES = [
  // Both are CONSULTATIONS, by the canonical predicate: svc-1 through its
  // modality, svc-2 through the name fallback lib/booking/consultation.ts uses
  // when a studio has not set one. The composer filters with that predicate, so
  // a fixture that was not bookable would simply vanish from the select and
  // every assertion about it would fail for the wrong reason.
  { id: "svc-1", name: "Electrolysis consultation", modality: "consultation" },
  { id: "svc-2", name: "Laser consultation — full leg", modality: null },
];

const CONNECTED: AdapterCapabilities = {
  enforcesScope: true,
  canResend: true,
  canCancel: true,
  canReturnToWaitlist: true,
  canRemove: true,
};

const render = (el: ReactElement) => renderToStaticMarkup(el);

/** Expected ids are DERIVED, not spelled out: the encoding is the factory's
 *  business, and hard-coding it here made every fixture stale the moment the
 *  escaping changed to become injective. */
const ENTRY_ID = "entry-1";
const errId = (field: string) => waitlistDomId(ENTRY_ID, `composer-error-${field}`);
const labelId = (field: string) => waitlistDomId(ENTRY_ID, `composer-label-${field}`);

const draft = (over: Partial<InviteDraft> = {}): InviteDraft => ({
  ...emptyDraft(),
  ...over,
});

/** A stand-in for #689's server action. It is never invoked by a static render;
 *  its presence is what makes the send bindable at all. */
const NOOP_ACTION = async (_formData: FormData) => {};

const compose = (
  over: Partial<InviteDraft> = {},
  capabilities: AdapterCapabilities | null = null,
  action: InviteComposerAction | null = NOOP_ACTION,
) =>
  render(
    InviteComposer({
      entryId: ENTRY_ID,
      entryName: "Sarah",
      draft: draft(over),
      services: SERVICES,
      capabilities,
      action,
    }),
  );

/** The VISIBLE pill for a control whose input is `sr-only`. The input carries
 *  the value; the span beside it carries the look, so styling assertions have
 *  to read the span. */
function pillFor(html: string, testId: string): string {
  const at = html.indexOf(`data-testid="${testId}"`);
  if (at === -1) throw new Error(`no control rendered for "${testId}"`);
  const spanAt = html.indexOf("<span", at);
  if (spanAt === -1) throw new Error(`no pill rendered for "${testId}"`);
  return html.slice(spanAt, html.indexOf(">", spanAt) + 1);
}

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
      `aria-labelledby="${labelId("service")}"`,
    );
    expect(html).toContain(`id="${labelId("service")}"`);
    expect(html).not.toContain('<span class="sr-only">Service</span>');
    // Exactly one element carries that id, or `aria-labelledby` resolves to
    // whichever came first.
    expect(html.split(`id="${labelId("service")}"`).length - 1).toBe(1);
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

  it("marks the selected preset by CHECKING it, not by colour alone", () => {
    // It was `aria-pressed` on a `type="button"` that submitted nothing. The
    // selection is now the radio's own checked state, so what the practitioner
    // sees and what the browser sends cannot disagree.
    const html = compose({ windowDays: 14 });
    expect(controlTag(html, "composer-window-14")).toContain('checked=""');
    expect(controlTag(html, "composer-window-7")).not.toContain('checked=""');
    expect(controlTag(html, "composer-window-14")).toContain('type="radio"');
    // Still not colour alone: the border carries it too.
    expect(pillFor(html, "composer-window-14")).toContain("peer-checked:border-accent");
  });

  it("always renders the custom field, and checks Custom when off-preset", () => {
    // IT USED TO APPEAR ONLY FOR AN OFF-PRESET VALUE, which was possible because
    // nothing here submitted anything. Without client JavaScript a radio cannot
    // reveal a field, so a practitioner who picks Custom would have had nowhere
    // to type. It is always present and read ONLY when Custom is selected —
    // proved in the payload tests, not here.
    expect(compose({ windowDays: 7 })).toContain('data-testid="composer-window-days"');
    const custom = compose({ windowDays: 45 });
    expect(custom).toContain('data-testid="composer-window-days"');
    expect(controlTag(custom, "composer-window-custom")).toContain('checked=""');
    expect(controlTag(compose({ windowDays: 7 }), "composer-window-custom")).not.toContain(
      'checked=""',
    );
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

  it("derives the checked preset from the value rather than a second field", () => {
    expect(controlTag(compose(), "composer-days-every")).toContain('checked=""');
    expect(
      controlTag(compose({ allowedWeekdays: [1, 2, 3, 4, 5] }), "composer-days-weekdays"),
    ).toContain('checked=""');
    expect(
      controlTag(compose({ allowedWeekdays: [0, 6] }), "composer-days-weekends"),
    ).toContain('checked=""');
  });

  it("always renders the weekday toggles, Monday first", () => {
    // Same reason as the custom day count: a preset radio cannot reveal a group
    // without client JavaScript, and toggles that appear only after a round trip
    // are toggles nobody can reach.
    expect(compose()).toContain('data-testid="composer-weekdays"');
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

    expect(controlTag(html, "composer-weekday-1")).toContain('checked=""');
    expect(controlTag(html, "composer-weekday-2")).not.toContain('checked=""');
    expect(controlTag(html, "composer-weekday-1")).toContain('type="checkbox"');
  });

  it("gives the three-letter toggles a width floor as well as a height one", () => {
    // A 44px-tall box around "Mon" is taller than it is wide and reads as a
    // mis-render rather than as a target.
    const tag = pillFor(compose({ allowedWeekdays: [1] }), "composer-weekday-1");
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
    expect(select).toContain(`aria-describedby="${errId("service")}"`);
    expect(html).toContain(`id="${errId("service")}"`);
  });

  it("2 — an out-of-range window points the window control at its error", () => {
    const html = compose({ windowDays: 900 }, CONNECTED);
    const input = tagFor(html, "composer-window-days");
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain(`aria-describedby="${errId("window")}"`);
    expect(html).toContain(`id="${errId("window")}"`);
  });

  it("3 — an empty weekday set points the GROUP at its error, not seven buttons", () => {
    const html = compose({ allowedWeekdays: [] }, CONNECTED);
    const group = tagFor(html, "composer-weekday-group");
    expect(group).toContain('role="group"');
    expect(group).toContain(`aria-describedby="${errId("days")}"`);
    // NOT `aria-invalid`: ARIA supports it on widget roles, not on `group`, so
    // assistive tech ignores it and the repo's a11y lint rejects it. The error
    // reaches the user through the description, which is what they hear on
    // entering the group.
    expect(group).not.toContain("aria-invalid");
    expect(html).toContain(`id="${errId("days")}"`);
    // The message belongs to the SET, so it must not be repeated on each
    // toggle — that announces one error seven times and still names no remedy.
    expect(html.split(`aria-describedby="${errId("days")}"`).length - 1).toBe(1);
  });

  it("3b — an out-of-range expiry points the expiry control at its error", () => {
    const html = compose({ expiresInHours: 999 }, CONNECTED);
    const input = tagFor(html, "composer-expiry-hours");
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain(`aria-describedby="${errId("expiry")}"`);
    expect(html).toContain(`id="${errId("expiry")}"`);
  });

  it("4 — a corrected field leaves no stale invalid state and no dangling reference", () => {
    const html = compose({ serviceId: "svc-1", windowDays: 14, expiresInHours: 48 }, CONNECTED);
    expect(tagFor(html, "composer-service")).not.toContain("aria-invalid");
    expect(tagFor(html, "composer-service")).not.toContain("aria-describedby");
    expect(html).not.toContain(`id="${errId("service")}"`);
    expect(html).not.toContain(errId("window"));
    expect(html).not.toContain(errId("expiry"));
    expect(html).not.toContain(errId("days"));
    // NEGATIVE CONTROL: the same expressions DO find the association when the
    // field is invalid, so the absences above are not vacuous.
    const broken = compose({ serviceId: "svc-deleted" }, CONNECTED);
    expect(tagFor(broken, "composer-service")).toContain("aria-invalid");
    expect(broken).toContain(`id="${errId("service")}"`);
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
      expect(tag).toContain(errId(field));
      for (const [, other] of pairs) {
        if (other === field) continue;
        expect(tag, `${testId} also references the ${other} error`).not.toContain(
          errId(other),
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
    expect(html).toContain("Laser consultation — full leg");
    expect(html).toContain("next 2 weeks");
    expect(html).toContain("Mon, Tue");
    // Future tense only. Nothing here may read as a receipt.
    expect(html).not.toContain("has been sent");
    expect(html).not.toContain("Invitation created");
    // The composer must not claim delivery under EITHER spelling — the old
    // wording is kept here so a revert cannot pass this test.
    expect(html).not.toContain("Invitation sent");
  });
});

describe("the service list is the BOOKING surface's list", () => {
  // lib/booking/consultation.ts exists so the visible service filter and the
  // server-side guard cannot drift apart — its own header says so. An
  // invitation is an offer to book through exactly that surface, so a separate
  // rule here would let a practitioner scope an invitation to a service the
  // invitee's own booking page will never show them.
  //
  // The composer therefore applies `isConsultationService` itself rather than
  // trusting a caller to have pre-filtered, which is why the prop carries
  // `modality`: a `{ id, name }` shape could not express the question.

  const MIXED = [
    { id: "svc-1", name: "Electrolysis consultation", modality: "consultation" },
    { id: "svc-2", name: "Laser — full leg", modality: "laser" },
    { id: "svc-3", name: "New client consultation", modality: null },
  ];

  function renderWith(
    services: ReadonlyArray<{ id: string; name: string; modality: string | null }>,
    draft = emptyDraft(),
  ) {
    return renderToStaticMarkup(
      createElement(InviteComposer, {
        entryId: "e1",
        entryName: "Ada",
        draft,
        services,
      }),
    );
  }

  it("offers only services the predicate accepts", () => {
    const html = renderWith(MIXED);
    expect(html).toContain("Electrolysis consultation");
    // Modality "laser" is not a consultation, and the NAME fallback does not
    // apply because a modality was set.
    expect(html).not.toContain("Laser — full leg");
    // No modality set, but the name carries it — the documented fallback.
    expect(html).toContain("New client consultation");
  });

  it("agrees with isConsultationService, service by service", () => {
    // Pinned against the predicate itself rather than against a hand-listed
    // expectation, so the two cannot drift as the predicate evolves.
    const html = renderWith(MIXED);
    for (const s of MIXED) {
      expect(html.includes(s.name), `${s.name}`).toBe(isConsultationService(s));
    }
  });

  it("a draft naming an EXCLUDED service is invalid, not silently 'any service'", () => {
    // Rendering and validation read the same filtered list. If they disagreed,
    // the summary could say "any service" while the payload still carried the
    // excluded id.
    const html = renderWith(MIXED, { ...emptyDraft(), serviceId: "svc-2" });
    expect(html).not.toContain("Laser — full leg");
    expect(html).toContain("composer-error-service");
  });
});

// ===========================================================================
// THE BINDING — can a real caller actually submit these four answers?
// ===========================================================================
//
// There is no jsdom here, so nothing can click. What CAN be done, and is more
// honest than a hand-written payload, is to build the FormData FROM THE RENDERED
// FORM the way a browser would: read the named controls, take the selected
// option, the checked radios and checkboxes, and the typed values. If a control
// loses its name or stops being a real input, this derivation stops finding it
// and every payload assertion below fails — which is exactly the coupling a
// hand-written FormData would throw away.

/** Serialize a rendered form the way a browser would on submit. */
function formDataFrom(html: string): FormData {
  const formData = new FormData();

  for (const tag of html.matchAll(/<input\b[^>]*>/g)) {
    const el = tag[0];
    const name = /name="([^"]*)"/.exec(el)?.[1];
    if (!name) continue;
    const type = /type="([^"]*)"/.exec(el)?.[1] ?? "text";
    const value = /value="([^"]*)"/.exec(el)?.[1] ?? "";
    // Unchecked radios and checkboxes submit NOTHING, which is the behaviour
    // that makes an empty weekday group mean "any day".
    if ((type === "radio" || type === "checkbox") && !el.includes('checked=""')) continue;
    if (type === "number") {
      const typed = /defaultvalue="([^"]*)"/i.exec(el)?.[1] ?? value;
      formData.append(name, typed);
      continue;
    }
    formData.append(name, value);
  }

  // <select> submits its selected option.
  for (const sel of html.matchAll(/<select\b[^>]*>([\s\S]*?)<\/select>/g)) {
    const name = /name="([^"]*)"/.exec(sel[0])?.[1];
    if (!name) continue;
    const selected =
      /<option[^>]*selected[^>]*value="([^"]*)"/.exec(sel[1])?.[1] ??
      /value="([^"]*)"[^>]*selected/.exec(sel[1])?.[1] ??
      /<option[^>]*value="([^"]*)"/.exec(sel[1])?.[1] ??
      "";
    formData.append(name, selected);
  }
  return formData;
}

/** What a submit of this rendered composer would hand the bound action. */
function submissionOf(html: string) {
  return inviteSubmissionFromFormData(formDataFrom(html));
}

describe("a real caller can bind this composer and receive the draft", () => {
  it("A. accepts a binding, and carries it onto a real form", () => {
    const html = compose({}, CONNECTED);
    expect(html).toContain("<form");
    // React renders a function action as its own sentinel plus a replay script.
    // An unbound composer renders neither, so this distinguishes "wired" from
    // "looks wired".
    expect(html).toContain("React form unexpectedly submitted");
    expect(compose({}, CONNECTED, null)).not.toContain("React form unexpectedly submitted");
  });

  it("B. offers exactly one submit control for the invitation", () => {
    const html = compose({}, CONNECTED);
    const send = controlTag(html, "composer-send");
    expect(send).toContain('type="submit"');
    expect(send).not.toContain('disabled=""');
    // One send, not two. A second submit would make "exactly one submission"
    // untrue no matter what the binding does.
    const submits = [...html.matchAll(/<button[^>]*type="submit"[^>]*>/g)].filter((m) =>
      m[0].includes('data-testid="composer-send"'),
    );
    expect(submits).toHaveLength(1);
  });

  it("C. submits exactly the practitioner's four current selections", () => {
    const html = compose(
      { serviceId: "svc-1", windowDays: 14, allowedWeekdays: [1, 3], expiresInHours: 24 },
      CONNECTED,
    );
    expect(submissionOf(html)).toEqual({
      entryId: ENTRY_ID,
      serviceId: "svc-1",
      windowDays: 14,
      allowedWeekdays: [1, 3],
      expiresInHours: 24,
    });
  });

  it("D. changing ANY of the four changes what would be submitted", () => {
    const base = submissionOf(compose({ serviceId: "svc-1" }, CONNECTED));

    const service = submissionOf(compose({ serviceId: "svc-2" }, CONNECTED));
    expect(service.serviceId).toBe("svc-2");
    expect(service.serviceId).not.toBe(base.serviceId);

    const window = submissionOf(compose({ serviceId: "svc-1", windowDays: 30 }, CONNECTED));
    expect(window.windowDays).toBe(30);
    expect(window.windowDays).not.toBe(base.windowDays);

    const days = submissionOf(
      compose({ serviceId: "svc-1", allowedWeekdays: [2, 4] }, CONNECTED),
    );
    expect(days.allowedWeekdays).toEqual([2, 4]);
    expect(days.allowedWeekdays).not.toEqual(base.allowedWeekdays);

    // 24, deliberately: the default draft already expires in 72 hours, so
    // asserting 72 "changed" would have passed without anything changing.
    const expiry = submissionOf(
      compose({ serviceId: "svc-1", expiresInHours: 24 }, CONNECTED),
    );
    expect(expiry.expiresInHours).toBe(24);
    expect(expiry.expiresInHours).not.toBe(base.expiresInHours);
  });

  it("D2. an off-preset value travels through the custom field", () => {
    // The custom input is always rendered, so the ONE rule that keeps it
    // unambiguous is that it is read only when Custom is the checked radio.
    const custom = compose({ serviceId: "svc-1", windowDays: 45 }, CONNECTED);
    expect(submissionOf(custom).windowDays).toBe(45);

    // ...and ignored when a preset is chosen, however it is filled in.
    const preset = formDataFrom(compose({ serviceId: "svc-1", windowDays: 14 }, CONNECTED));
    preset.set(COMPOSER_FIELD_NAMES.windowDaysCustom, "999");
    expect(inviteSubmissionFromFormData(preset).windowDays).toBe(14);
  });

  it("E. an invalid draft has no usable submit control", () => {
    // The send is the only way in, and it is disabled — the server revalidates
    // regardless, because a disabled button is a courtesy, not a guarantee.
    const vanished = compose({ serviceId: "svc-deleted" }, CONNECTED);
    expect(controlTag(vanished, "composer-send")).toContain('disabled=""');
  });

  it("F. no binding and no capability each disable the send on their own", () => {
    // Two independent gates. Correct copy did not make the button live, and
    // neither does a binding without the capability.
    expect(controlTag(compose({}, CONNECTED, null), "composer-send")).toContain('disabled=""');
    expect(controlTag(compose({}, null, NOOP_ACTION), "composer-send")).toContain('disabled=""');
    expect(controlTag(compose({}, CONNECTED, NOOP_ACTION), "composer-send")).not.toContain(
      'disabled=""',
    );
  });

  it("G. the browser cannot supply authority, only intent", () => {
    // Nothing in the rendered form names a studio, an actor, a role, a round,
    // an allowance or a claim state.
    const html = compose({}, CONNECTED);
    const names = [...html.matchAll(/name="([^"]*)"/g)].map((m) => m[1]);
    expect(new Set(names)).toEqual(new Set(Object.values(COMPOSER_FIELD_NAMES)));
    for (const forbidden of [
      "studio_id", "studio", "actor_id", "actor", "role", "round_id", "round",
      "allowance", "claim_state", "claimed", "practitioner_id", "proof",
    ]) {
      expect(names, `${forbidden} is a browser-supplied authority field`).not.toContain(
        forbidden,
      );
    }

    // And a crafted payload cannot smuggle them through the reader: it is a
    // projection of five names, so extra keys have nowhere to land.
    const crafted = formDataFrom(html);
    for (const [key, value] of [
      ["studio_id", "other-studio"], ["actor_id", "someone-else"], ["role", "owner"],
      ["round_id", "round-9"], ["allowance", "999"], ["claim_state", "claimed"],
    ] as const) {
      crafted.set(key, value);
    }
    expect(inviteSubmissionFromFormData(crafted)).toEqual(submissionOf(html));
  });

  it("H. no Claim vocabulary reaches the practitioner", () => {
    const html = compose({}, CONNECTED);
    expect(html).not.toMatch(/\bclaim(ed|ing|s)?\b/i);
  });

  it("no visible control is inert", () => {
    // EVERY control either submits or is disabled. A button that looks live and
    // does nothing is the defect this whole change exists to remove.
    const html = compose({}, CONNECTED);
    for (const tag of html.matchAll(/<button\b[^>]*>/g)) {
      const el = tag[0];
      expect(
        el.includes('type="submit"') || el.includes('disabled=""'),
        `inert control: ${el}`,
      ).toBe(true);
    }
    // Cancel with nothing behind it is disabled rather than decorative.
    expect(controlTag(html, "composer-cancel")).toContain('disabled=""');
    const withCancel = render(
      InviteComposer({
        entryId: ENTRY_ID,
        entryName: "Sarah",
        draft: draft({}),
        services: SERVICES,
        capabilities: CONNECTED,
        action: NOOP_ACTION,
        cancelAction: NOOP_ACTION,
      }),
    );
    expect(controlTag(withCancel, "composer-cancel")).not.toContain('disabled=""');
  });
});
