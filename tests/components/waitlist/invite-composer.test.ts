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
  composerReducer,
  initialComposerState,
  composerIdentity,
  inviteSubmissionFromFormData,
  scopeSummary,
  sendState,
  validateDraft,
  type ComposerEvent,
  type ComposerState,
  type InviteComposerAction,
} from "@/lib/waitlist/b4-invitation-draft";
import { InviteComposerView } from "@/components/waitlist/invite-composer";

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
  // See the note in the lib suite: Invite-to-book needs a concrete service, so
  // the default fixture names one and the "not chosen" case is asserted
  // explicitly where it belongs.
  serviceId: "svc-1",
  ...over,
});

/** A stand-in for #689's server action. It is never invoked by a static render;
 *  its presence is what makes the send bindable at all. */
const NOOP_ACTION = async (_formData: FormData) => {};

const CUSTOM = "custom" as const;

const compose = (
  over: Partial<InviteDraft> = {},
  capabilities: AdapterCapabilities | null = null,
  action: InviteComposerAction | null = NOOP_ACTION,
) =>
  render(
    createElement(InviteComposer, {
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

  it("lists the studio's services behind a PROMPT, not an any-service answer", () => {
    expect(html).toContain("Choose a service");
    // The old wording was a real, sendable answer. There is no unscoped
    // invitation for the authority to mint, so it must not be offered at all.
    expect(html).not.toContain("Any service");
    expect(html).not.toContain("any service");
    for (const service of SERVICES) expect(html).toContain(service.name);
  });

  it("an unchosen service is invalid and the send is shut", () => {
    const unchosen = compose({ serviceId: null }, CONNECTED);
    expect(unchosen).toContain("Choose a service");
    expect(unchosen).toContain('data-testid="composer-error-service"');
    expect(controlTag(unchosen, "composer-send")).toContain('disabled=""');
    // No scope is described for a draft that cannot be sent.
    expect(unchosen).not.toContain('data-testid="composer-summary"');
    // The placeholder is not auto-resolved to the first service.
    expect(controlTag(unchosen, "composer-service")).toContain("required");
  });

  it("choosing a service repairs it, and returning to the prompt breaks it again", () => {
    const chosen = composerReducer(initialComposerState(draft({ serviceId: null })), {
      type: "service",
      serviceId: "svc-2",
    });
    expect(answers(chosen).validation.ok).toBe(true);
    expect(answers(chosen).sendDisabled).toBe(false);
    expect(answers(chosen).submitted.serviceId).toBe("svc-2");
    expect(answers(chosen).visibleSummary).toContain("Laser consultation");

    const backToPrompt = composerReducer(chosen, { type: "service", serviceId: null });
    expect(answers(backToPrompt).validation.ok).toBe(false);
    expect(answers(backToPrompt).sendDisabled).toBe(true);
    expect(answers(backToPrompt).submitted.serviceId).toBeNull();
  });

  it("with NO eligible services, the send is impossible", () => {
    const none = render(
      createElement(InviteComposer, {
        entryId: ENTRY_ID,
        entryName: "Sarah",
        draft: draft({ serviceId: null }),
        services: [],
        capabilities: CONNECTED,
        action: NOOP_ACTION,
      }),
    );
    expect(controlTag(none, "composer-send")).toContain('disabled=""');
    expect(none).toContain("Choose a service");
    expect(none).not.toContain("Any service");
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

  it("renders the custom field only while Custom is selected", () => {
    // An inactive number field is not just clutter: its min/max join the
    // browser's own constraint validation, so a stale out-of-range value would
    // block a submit the practitioner has since repaired — and block Cancel
    // with it. Selecting Custom re-renders and brings the field with it.
    expect(compose({ windowDays: 7 })).not.toContain('data-testid="composer-window-days"');
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

  it("renders the weekday toggles only for a custom set, Monday first", () => {
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
    createElement(InviteComposer, {
        entryId: "entry-A",
        entryName: "Sarah",
        draft: { ...emptyDraft(), ...draftA },
        services: SERVICES,
        capabilities: null,
      }),
    );
    const b = render(
    createElement(InviteComposer, {
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
    createElement(InviteComposer, {
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

/**
 * Serialize a rendered form the way a browser actually would.
 *
 * SUCCESSFUL CONTROLS ONLY, and getting that wrong is not a detail — the first
 * version of this helper read the `selected` option without checking whether it
 * was DISABLED. A disabled option contributes nothing, so a real browser omits
 * `service_id` for a vanished service while this helper reported it, and the
 * test agreed with a browser that does not exist.
 *
 * The rules modelled here, all of them load-bearing for this form:
 *   - a disabled control contributes nothing;
 *   - a hidden input contributes;
 *   - an unchecked radio or checkbox contributes nothing;
 *   - a select contributes its selected option UNLESS that option is disabled;
 *   - a select with nothing marked selected falls back to its first ENABLED
 *     option, which is what the browser displays.
 */
function formDataFrom(html: string): FormData {
  const formData = new FormData();
  const attr = (tag: string, name: string): string | null =>
    new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
  const isDisabled = (tag: string): boolean => /\bdisabled(=""|\s|>|\/)/.test(tag);

  for (const match of html.matchAll(/<input\b[^>]*>/g)) {
    const el = match[0];
    const name = attr(el, "name");
    if (!name || isDisabled(el)) continue;
    const type = attr(el, "type") ?? "text";
    if ((type === "radio" || type === "checkbox") && !el.includes('checked=""')) continue;
    formData.append(name, attr(el, "value") ?? "");
  }

  for (const sel of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const openTag = `<select${sel[1]}>`;
    const name = attr(openTag, "name");
    if (!name || isDisabled(openTag)) continue;

    const options = [...sel[2].matchAll(/<option\b([^>]*)>/g)].map((m) => ({
      tag: `<option${m[1]}>`,
      value: attr(`<option${m[1]}>`, "value") ?? "",
      disabled: isDisabled(`<option${m[1]}>`),
      selected: /\bselected(=""|\s|>|\/)/.test(`<option${m[1]}>`),
    }));

    const chosen = options.find((o) => o.selected) ?? options.find((o) => !o.disabled);
    // A DISABLED SELECTED OPTION SUBMITS NOTHING. This is the whole finding.
    if (!chosen || chosen.disabled) continue;
    formData.append(name, chosen.value);
  }
  return formData;
}

/** What a submit of this rendered composer would hand the bound action.
 *  Throws rather than papering over a refusal — a test that silently accepted
 *  one would be asserting about a payload that does not exist. */
function submissionOf(html: string) {
  const result = inviteSubmissionFromFormData(formDataFrom(html));
  if (!result.ok) throw new Error(`parser refused: ${result.reason}`);
  return result.submission;
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
    const parsed = inviteSubmissionFromFormData(preset);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.submission.windowDays).toBe(14);
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
    // A SUBSET, because the custom fields and the weekday group are rendered
    // only while their mode is selected. Nothing outside the contract appears.
    for (const name of names) {
      expect(Object.values(COMPOSER_FIELD_NAMES), `${name} is not a contract field`).toContain(
        name,
      );
    }
    expect(names.length).toBeGreaterThan(3);
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
    const craftedResult = inviteSubmissionFromFormData(crafted);
    expect(craftedResult.ok).toBe(true);
    if (craftedResult.ok) expect(craftedResult.submission).toEqual(submissionOf(html));
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
      createElement(InviteComposer, {
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

// ===========================================================================
// LIVE INTERACTION — visible == validated == submitted, after every change
// ===========================================================================
//
// HARNESS LIMIT, STATED RATHER THAN PAPERED OVER: this repo ships no jsdom and
// no testing-library (several suites say so in their own comments), so a real
// click cannot be dispatched here and none was added — a shared test dependency
// is not something to slip into a review cycle.
//
// What is proved instead is stronger than a source pin and covers all four
// findings. Every interaction IS `composerReducer`, which is pure; the view is
// pure too. So an interaction script runs the reducer, renders the state it
// produced, and then checks the three answers that used to disagree:
//
//     what the practitioner SEES   (summary, checked controls, Send state)
//     what VALIDATES               (validateDraft on the live draft)
//     what would be SUBMITTED      (FormData derived from that same markup)
//
// The one link this cannot reach is React's own onChange plumbing.

// THE SAME PREDICATE THE COMPOSER USES, not a lookalike. Filtering on
// `modality !== null` dropped svc-2 — which is bookable through the name
// fallback — so a repaired draft read as invalid and the assertion failed for
// a reason that had nothing to do with the code under test.
const CONTEXT = {
  serviceIds: SERVICES.filter((svc) => isConsultationService(svc)).map((svc) => svc.id),
};

/** Run an interaction script from an opening draft. */
function interact(over: Partial<InviteDraft>, events: ReadonlyArray<ComposerEvent>): ComposerState {
  return events.reduce(composerReducer, initialComposerState(draft(over)));
}

/** Render exactly the state an interaction produced. */
function view(state: ComposerState, capabilities: AdapterCapabilities | null = CONNECTED) {
  return render(
    createElement(InviteComposerView, {
      entryId: ENTRY_ID,
      entryName: "Sarah",
      // DELIBERATELY THE OPENING DRAFT, not the live one. The prop is what the
      // composer was mounted with; the state is what the practitioner has since
      // chosen. Passing the live draft here would hide a view that still read
      // the prop — which is precisely the bug this suite exists to catch.
      draft: draft({}),
      services: SERVICES,
      capabilities,
      action: NOOP_ACTION,
      state,
      dispatch: () => {},
    }),
  );
}

/** The three answers, for one state. They must agree. */
function answers(state: ComposerState, capabilities: AdapterCapabilities | null = CONNECTED) {
  const html = view(state, capabilities);
  const summaryMatch = /data-testid="composer-summary"[^>]*>([^<]*)</.exec(html);
  return {
    html,
    visibleSummary: summaryMatch?.[1] ?? null,
    sendDisabled: controlTag(html, "composer-send").includes('disabled=""'),
    validation: validateDraft(state.draft, CONTEXT),
    submitted: submissionOf(html),
  };
}

describe("one live draft drives everything", () => {
  it("1. SERVICE: changing it moves the confirmation AND the payload", () => {
    const before = answers(interact({ serviceId: "svc-1" }, []));
    const after = answers(
      interact({ serviceId: "svc-1" }, [{ type: "service", serviceId: "svc-2" }]),
    );
    expect(after.submitted.serviceId).toBe("svc-2");
    expect(after.visibleSummary).not.toBe(before.visibleSummary);
    expect(after.visibleSummary).toContain("Laser consultation");
  });

  it("2. WINDOW: 7 -> 30 changes the confirmation AND the payload together", () => {
    const state = interact({ serviceId: "svc-1" }, [{ type: "windowPreset", preset: 30 }]);
    const { visibleSummary, submitted } = answers(state);
    expect(submitted.windowDays).toBe(30);
    expect(visibleSummary).toContain("next 30 days");
    // THE DEFECT, NAMED: the summary used to keep saying 7 while the form sent
    // 30. Both halves are asserted from the SAME render.
    expect(visibleSummary).not.toContain("next 7 days");
  });

  it("3. CUSTOM WINDOW: selecting Custom activates the field and carries its value", () => {
    const state = interact({ serviceId: "svc-1" }, [
      { type: "windowPreset", preset: CUSTOM },
      { type: "windowCustom", days: 45 },
    ]);
    const { html, submitted, visibleSummary } = answers(state);
    expect(html).toContain('data-testid="composer-window-days"');
    expect(submitted.windowDays).toBe(45);
    expect(visibleSummary).toContain("45");
  });

  it("4. LEAVING CUSTOM: an invalid leftover cannot block a repaired draft", () => {
    const state = interact({ serviceId: "svc-1" }, [
      { type: "windowPreset", preset: CUSTOM },
      { type: "windowCustom", days: 9999 }, // out of range
      { type: "windowPreset", preset: 14 }, // ...then repaired by leaving Custom
    ]);
    const { html, sendDisabled, submitted, validation } = answers(state);
    // The field is GONE, so its min/max cannot join constraint validation.
    expect(html).not.toContain('data-testid="composer-window-days"');
    expect(validation.ok).toBe(true);
    expect(sendDisabled).toBe(false);
    expect(submitted.windowDays).toBe(14);
  });

  it("5. WEEKDAYS: custom with nothing ticked is [] — never every day", () => {
    // THE P1. `null` is the WIDEST scope there is. A practitioner who unticked
    // every day must not be read as one who allowed all of them.
    const state = interact({ serviceId: "svc-1" }, [{ type: "daysPreset", preset: "custom" }]);
    expect(state.draft.allowedWeekdays).toEqual([]);

    const { sendDisabled, submitted, validation, html } = answers(state);
    expect(submitted.allowedWeekdays).toEqual([]);
    expect(submitted.allowedWeekdays).not.toBeNull();
    expect(validation.ok).toBe(false);
    expect(sendDisabled).toBe(true);
    expect(html).toContain("Choose at least one day");

    // ...and the same through a tick-then-untick, which is how it happens.
    const emptied = interact({ serviceId: "svc-1", allowedWeekdays: [1] }, [
      { type: "weekday", index: 1, checked: false },
    ]);
    expect(emptied.draft.allowedWeekdays).toEqual([]);
    expect(answers(emptied).submitted.allowedWeekdays).toEqual([]);
  });

  it("6. REPAIR: ticking Monday re-enables Send and submits Monday only", () => {
    const state = interact({ serviceId: "svc-1" }, [
      { type: "daysPreset", preset: "custom" },
      { type: "weekday", index: 1, checked: true },
    ]);
    const { sendDisabled, submitted, validation, visibleSummary } = answers(state);
    expect(validation.ok).toBe(true);
    expect(sendDisabled).toBe(false);
    expect(submitted.allowedWeekdays).toEqual([1]);
    expect(visibleSummary).toContain("Mon");
  });

  it("7. EXPIRY: an invalid custom value cannot block after switching to a preset", () => {
    const state = interact({ serviceId: "svc-1" }, [
      { type: "expiryPreset", preset: CUSTOM },
      { type: "expiryCustom", hours: 9999 },
      { type: "expiryPreset", preset: 48 },
    ]);
    const { html, sendDisabled, submitted } = answers(state);
    expect(html).not.toContain('data-testid="composer-expiry-hours"');
    expect(sendDisabled).toBe(false);
    expect(submitted.expiresInHours).toBe(48);
  });

  it("8. INITIAL INVALID: repairing it interactively enables Send, no refresh", () => {
    // The composer opens on a service that has since been deleted.
    const opened = initialComposerState(draft({ serviceId: "svc-deleted" }));
    expect(answers(opened).sendDisabled).toBe(true);

    const repaired = composerReducer(opened, { type: "service", serviceId: "svc-1" });
    const after = answers(repaired);
    expect(after.validation.ok).toBe(true);
    // THE P2: Send used to stay disabled because it read the INITIAL prop.
    expect(after.sendDisabled).toBe(false);
    expect(after.submitted.serviceId).toBe("svc-1");
  });

  it("9. CONFIRMATION: visible scope and submitted scope agree for EVERY mutation", () => {
    const scripts: ReadonlyArray<ReadonlyArray<ComposerEvent>> = [
      [],
      [{ type: "service", serviceId: "svc-2" }],
      [{ type: "windowPreset", preset: 30 }],
      [{ type: "windowPreset", preset: CUSTOM }, { type: "windowCustom", days: 21 }],
      [{ type: "daysPreset", preset: "weekdays" }],
      [{ type: "daysPreset", preset: "weekends" }],
      [{ type: "daysPreset", preset: "custom" }, { type: "weekday", index: 3, checked: true }],
      [{ type: "expiryPreset", preset: 24 }],
      [{ type: "expiryPreset", preset: CUSTOM }, { type: "expiryCustom", hours: 100 }],
      [
        { type: "service", serviceId: "svc-2" },
        { type: "windowPreset", preset: 14 },
        { type: "daysPreset", preset: "custom" },
        { type: "weekday", index: 2, checked: true },
        { type: "weekday", index: 5, checked: true },
        { type: "expiryPreset", preset: 168 },
      ],
    ];

    for (const script of scripts) {
      const state = interact({ serviceId: "svc-1" }, script);
      const { visibleSummary, submitted, validation } = answers(state);
      // The payload IS the live draft — not the prop the composer opened on.
      expect(submitted.windowDays, JSON.stringify(script)).toBe(state.draft.windowDays);
      expect(submitted.serviceId, JSON.stringify(script)).toBe(state.draft.serviceId);
      expect(submitted.expiresInHours, JSON.stringify(script)).toBe(state.draft.expiresInHours);
      expect(submitted.allowedWeekdays ?? null, JSON.stringify(script)).toEqual(
        state.draft.allowedWeekdays ?? null,
      );
      // ...and the sentence above Send describes that same draft.
      if (validation.ok) {
        const selected = SERVICES.find((svc) => svc.id === state.draft.serviceId) ?? null;
        expect(visibleSummary).toBe(
          `They will be able to book ${scopeSummary(state.draft, selected?.name ?? null)}.`,
        );
      }
    }
  });

  it("10. EXACTLY ONE submit control, and it is a real one", () => {
    const html = view(interact({ serviceId: "svc-1" }, []));
    expect(
      [...html.matchAll(/<button[^>]*data-testid="composer-send"[^>]*>/g)],
    ).toHaveLength(1);
    expect(controlTag(html, "composer-send")).toContain('type="submit"');
    expect(html).toContain("React form unexpectedly submitted");
  });

  it("capability authority still beats every interaction", () => {
    // A perfectly repaired draft cannot talk its way past a missing capability.
    const state = interact({ serviceId: "svc-1" }, [{ type: "windowPreset", preset: 30 }]);
    expect(answers(state, null).sendDisabled).toBe(true);
    expect(sendState(state.draft, null, CONTEXT).disabled).toBe(true);
    expect(answers(state, CONNECTED).sendDisabled).toBe(false);
  });
});

// ===========================================================================
// THE THREE CONTROLLED-FORM REPAIRS
// ===========================================================================

describe("the composer resets when its target changes", () => {
  const props = (entryId: string, over: Partial<InviteDraft>) => ({
    entryId,
    entryName: "Sarah",
    draft: draft(over),
    services: SERVICES,
    capabilities: CONNECTED,
    action: NOOP_ACTION,
  });

  /** The key React will actually reconcile on. `InviteComposer` holds no hooks
   *  itself, so calling it returns the element it builds and the key can be
   *  read directly — a real assertion about reconciliation, not a source pin. */
  const keyOf = (p: ReturnType<typeof props>) =>
    (InviteComposer(p) as unknown as { key: string | null }).key;

  it("remounts for a different entry, so no draft can cross between people", () => {
    // THE DEFECT: useReducer reads its initial argument ONCE. Reused for another
    // person's row, the component would show B's name above A's scope — and a
    // submit in that state invites the wrong person to the wrong thing.
    const personA = props("entry-A", { serviceId: "svc-1", windowDays: 7 });
    const personB = props("entry-B", { serviceId: "svc-2", windowDays: 30 });
    expect(keyOf(personA)).not.toBe(keyOf(personB));
    expect(keyOf(personA)).toBe(composerIdentity("entry-A", personA.draft));

    // THE CASE THAT ACTUALLY LEAKS, and the first version of this test missed
    // it: two people whose drafts are IDENTICAL. Both open on the default, so
    // only the entry distinguishes them — and if the key ignored the entry, the
    // second person would inherit whatever the first had typed.
    const sameDraftA = props("entry-A", {});
    const sameDraftB = props("entry-B", {});
    expect(sameDraftA.draft).toEqual(sameDraftB.draft);
    expect(
      keyOf(sameDraftA),
      "two entries sharing a draft must still be different composers",
    ).not.toBe(keyOf(sameDraftB));
  });

  it("remounts when the SAME entry's authoritative draft is refreshed", () => {
    const before = props("entry-A", { serviceId: "svc-1", windowDays: 7 });
    const after = props("entry-A", { serviceId: "svc-1", windowDays: 30 });
    expect(keyOf(before)).not.toBe(keyOf(after));
    // ...and the state that mounts starts from the refreshed draft.
    expect(initialComposerState(after.draft).draft.windowDays).toBe(30);
  });

  it("does NOT erase a half-finished composition for unrelated prop churn", () => {
    // Keying on services/capabilities/action would remount on every parent
    // render and throw away what the practitioner was typing.
    const base = props("entry-A", { serviceId: "svc-1" });
    expect(
      composerIdentity("entry-A", base.draft),
      "identity must not depend on services, capabilities or the action",
    ).toBe(composerIdentity("entry-A", draft({ serviceId: "svc-1" })));
  });

  it("the reset is SYNCHRONOUS — a key, not an effect", () => {
    // A post-paint effect would leave a frame in which the new row carries the
    // old scope. The key makes the reset part of the same commit.
    const el = InviteComposer(props("entry-A", {})) as unknown as { key: string | null };
    expect(el.key).not.toBeNull();
    expect(el.key).toBe(composerIdentity("entry-A", draft({})));
  });
});

describe("a vanished service stays visibly wrong, and is repairable", () => {
  const vanished = () => compose({ serviceId: "svc-deleted" }, CONNECTED);

  it("never masquerades as Any service", () => {
    const html = vanished();
    // The stale id is the select's value AND has its own option, so the browser
    // cannot fall back to displaying the first one.
    expect(html).toContain('value="svc-deleted"');
    expect(html).toContain("Previously selected service is unavailable");
    // "Any service" must NOT be the selected option here.
    expect(html).not.toMatch(/<option value=""[^>]*selected/);
    // ...and it is visibly invalid, not silently widened.
    expect(html).toContain('data-testid="composer-error-service"');
    expect(controlTag(html, "composer-send")).toContain('disabled=""');
  });

  it("does not silently submit Any service in place of the dead id", () => {
    // Silently normalising to null would widen the scope without the
    // practitioner choosing to.
    expect(submissionOf(vanished()).serviceId).toBe("svc-deleted");
    expect(submissionOf(vanished()).serviceId).not.toBeNull();
  });

  it("returning to the prompt clears the stale id WITHOUT becoming valid", () => {
    // The dead id must go — but "not chosen" is not a repair, it is the start
    // of one. Send stays shut until a real service is picked.
    const cleared = composerReducer(
      initialComposerState(draft({ serviceId: "svc-deleted" })),
      { type: "service", serviceId: null },
    );
    const html = view(cleared);
    expect(html).not.toContain("Previously selected service is unavailable");
    expect(html).not.toContain('data-testid="composer-service-stale"');

    const after = answers(cleared);
    expect(after.submitted.serviceId).toBeNull();
    expect(after.validation.ok).toBe(false);
    expect(after.sendDisabled).toBe(true);
  });

  it("choosing another real service repairs it too", () => {
    const repaired = composerReducer(
      initialComposerState(draft({ serviceId: "svc-deleted" })),
      { type: "service", serviceId: "svc-2" },
    );
    const after = answers(repaired);
    expect(after.validation.ok).toBe(true);
    expect(after.submitted.serviceId).toBe("svc-2");
  });

  it("stays visible and repairable when no service is selectable", () => {
    const html = render(
      createElement(InviteComposer, {
        entryId: ENTRY_ID,
        entryName: "Sarah",
        draft: draft({ serviceId: "svc-deleted" }),
        services: [],
        capabilities: CONNECTED,
        action: NOOP_ACTION,
      }),
    );
    expect(html).toContain("Previously selected service is unavailable");
    // The prompt is still there to return to; it just cannot complete a draft.
    expect(html).toContain("Choose a service");
    expect(html).not.toContain("Any service");
  });
});

describe("an unreadable weekday preset can never mean every day", () => {
  const withPreset = (value: string | null) => {
    const formData = formDataFrom(compose({ serviceId: "svc-1" }, CONNECTED));
    if (value === null) formData.delete(COMPOSER_FIELD_NAMES.allowedDaysPreset);
    else formData.set(COMPOSER_FIELD_NAMES.allowedDaysPreset, value);
    return inviteSubmissionFromFormData(formData);
  };

  it("refuses a missing preset", () => {
    // `null` is the WIDEST scope this product can express, so a defaulting
    // lookup would turn every unreadable input into "any day".
    const result = withPreset(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unrecognised_allowed_days_preset");
  });

  it("refuses an unrecognised preset, however plausible", () => {
    for (const junk of ["garbage", "EVERY", "every ", "weekday", "all", "", "__proto__", "toString"]) {
      const result = withPreset(junk);
      expect(result.ok, `"${junk}" must not be accepted`).toBe(false);
    }
  });

  it("only the literal `every` maps to null", () => {
    const result = withPreset("every");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.submission.allowedWeekdays).toBeNull();
  });

  it("custom with zero boxes is [] and invalid — not null, not refused", () => {
    const formData = formDataFrom(compose({ serviceId: "svc-1" }, CONNECTED));
    formData.set(COMPOSER_FIELD_NAMES.allowedDaysPreset, "custom");
    formData.delete(COMPOSER_FIELD_NAMES.allowedWeekdays);
    const result = inviteSubmissionFromFormData(formData);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.submission.allowedWeekdays).toEqual([]);
      expect(result.submission.allowedWeekdays).not.toBeNull();
      // [] is deliberately invalid rather than a refusal: the practitioner DID
      // answer, and the answer is one the product will not send.
      expect(
        validateDraft({ ...draft({ serviceId: "svc-1" }), allowedWeekdays: [] }, CONTEXT).ok,
      ).toBe(false);
    }
  });

  it("the recognised presets still map to their canonical sets", () => {
    for (const [preset, expected] of [
      ["weekdays", [1, 2, 3, 4, 5]],
      ["weekends", [0, 6]],
    ] as const) {
      const result = withPreset(preset);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.submission.allowedWeekdays).toEqual(expected);
    }
  });
});

// ===========================================================================
// THE VANISHED SERVICE MUST SURVIVE SERIALIZATION
// ===========================================================================

describe("a stale service stays stale all the way to the payload", () => {
  const serviceValues = (html: string) =>
    formDataFrom(html).getAll(COMPOSER_FIELD_NAMES.serviceId);

  it("the harness itself obeys successful-control rules", () => {
    // NON-VACUITY FOR EVERY ASSERTION BELOW. If this helper still serialized a
    // disabled selected option, it would be describing a browser that does not
    // exist and the cases after it would prove nothing.
    const disabledSelected =
      '<select name="s"><option value="dead" disabled selected="">Gone</option>' +
      '<option value="">Any</option></select>';
    expect(formDataFrom(disabledSelected).getAll("s")).toEqual([]);

    const enabledSelected =
      '<select name="s"><option value="a">A</option><option value="b" selected="">B</option></select>';
    expect(formDataFrom(enabledSelected).get("s")).toBe("b");

    // Nothing marked selected: the browser shows — and submits — the first
    // enabled option.
    const noneSelected =
      '<select name="s"><option value="x" disabled>X</option><option value="y">Y</option></select>';
    expect(formDataFrom(noneSelected).get("s")).toBe("y");

    expect(formDataFrom('<input type="hidden" name="h" value="v"/>').get("h")).toBe("v");
    expect(formDataFrom('<input name="d" value="v" disabled=""/>').getAll("d")).toEqual([]);
  });

  it("CASE A: a vanished service serializes as the stale id, never as null", () => {
    const html = compose({ serviceId: "svc-deleted" }, CONNECTED);

    // Visible: its own words, not "Any service".
    expect(html).toContain("Previously selected service is unavailable");
    // Validated: still invalid, and the send is shut.
    expect(validateDraft(draft({ serviceId: "svc-deleted" }), CONTEXT).ok).toBe(false);
    expect(controlTag(html, "composer-send")).toContain('disabled=""');
    // Submitted: the SAME stale id — exactly once.
    expect(serviceValues(html)).toEqual(["svc-deleted"]);
    expect(submissionOf(html).serviceId).toBe("svc-deleted");
    expect(submissionOf(html).serviceId).not.toBeNull();
  });

  it("CASE B: returning to the prompt leaves nothing stale behind", () => {
    const repaired = composerReducer(
      initialComposerState(draft({ serviceId: "svc-deleted" })),
      { type: "service", serviceId: null },
    );
    const html = view(repaired);

    expect(html).not.toContain("Previously selected service is unavailable");
    expect(html).not.toContain('data-testid="composer-service-stale"');
    // Exactly one service value, and it is the canonical Any-service one.
    expect(serviceValues(html)).toEqual([""]);
    expect(submissionOf(html).serviceId).toBeNull();

    // Cleared, but NOT valid: the practitioner still has to choose one.
    const after = answers(repaired);
    expect(after.validation.ok).toBe(false);
    expect(after.sendDisabled).toBe(true);
  });

  it("CASE C: choosing a real service repairs it and leaves nothing stale behind", () => {
    const repaired = composerReducer(
      initialComposerState(draft({ serviceId: "svc-deleted" })),
      { type: "service", serviceId: "svc-2" },
    );
    const html = view(repaired);

    expect(html).not.toContain('data-testid="composer-service-stale"');
    expect(serviceValues(html)).toEqual(["svc-2"]);
    expect(submissionOf(html).serviceId).toBe("svc-2");
    expect(answers(repaired).visibleSummary).toContain("Laser consultation");
    expect(answers(repaired).validation.ok).toBe(true);
  });

  it("never emits two service values, in any of the three states", () => {
    // A stale bridge left in place after a repair would hand the server two
    // answers and let it pick.
    for (const state of [
      initialComposerState(draft({ serviceId: "svc-deleted" })),
      composerReducer(initialComposerState(draft({ serviceId: "svc-deleted" })), {
        type: "service",
        serviceId: null,
      }),
      composerReducer(initialComposerState(draft({ serviceId: "svc-deleted" })), {
        type: "service",
        serviceId: "svc-1",
      }),
    ]) {
      expect(serviceValues(view(state))).toHaveLength(1);
    }
  });
});
