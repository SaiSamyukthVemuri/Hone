import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

import {
  AdmissionActions,
  AdmissionRow,
  type AdmissionEntry,
} from "@/components/waitlist/admission-row";
import {
  ADMISSION_ACTIONS,
  STATUS_LABEL,
  STATUS_MEANING,
  WAITLIST_ENTRY_STATUSES,
  actionAvailability,
  type WaitlistEntryStatus,
} from "@/lib/waitlist/admission-model";

// ===========================================================================
// WAIT-03 B4 — the admission row renders against NON-AUTHORITATIVE fixtures
// ===========================================================================
//
// B2 is not frozen, so there is no server interface to render against. These
// fixtures are invented, live only in this file, and are deliberately NOT
// exported from any runtime module — a fixture importable by `app/` is a
// fixture that can reach a studio.
//
// Rendered through `react-dom/server` against the REAL components, because this
// repo has no DOM harness and a source grep would prove only that a string
// exists somewhere in the file rather than that it reaches the output.

const ENTRY: AdmissionEntry = {
  id: "fixture-entry-1",
  name: "A Waiting Person",
  email: "waiting@example.test",
  joinedLabel: "12 August 2026",
  status: "waiting",
};

const render = (el: ReactElement) => renderToStaticMarkup(el);

/**
 * The WHOLE `<button …>` tag carrying one action's test id.
 *
 * Slicing FORWARD from the test id does not work and silently passes: React
 * emits attributes in JSX order, so `disabled` lands BEFORE `data-testid` and a
 * forward slice can never see it. An assertion written that way is vacuous in
 * the direction that matters.
 */
function buttonTag(html: string, action: string): string {
  const tag = [...html.matchAll(/<button[^>]*>/g)]
    .map((m) => m[0])
    .find((t) => t.includes(`data-testid="admission-action-${action}"`));
  if (!tag) throw new Error(`no control rendered for action "${action}"`);
  return tag;
}

describe("the row states WHO is waiting and WHAT state they are in", () => {
  it("renders identity, joined date, status and its meaning", () => {
    const html = render(AdmissionRow({ entry: ENTRY }) as ReactElement);
    expect(html).toContain("A Waiting Person");
    expect(html).toContain("waiting@example.test");
    expect(html).toContain("12 August 2026");
    expect(html).toContain(STATUS_LABEL.waiting);
    expect(html).toContain(STATUS_MEANING.waiting);
  });

  it("every status renders its own label AND meaning, not a code", () => {
    for (const status of WAITLIST_ENTRY_STATUSES) {
      const html = render(
        AdmissionRow({ entry: { ...ENTRY, status } }) as ReactElement,
      );
      expect(html, status).toContain(STATUS_LABEL[status]);
      expect(html, status).toContain(STATUS_MEANING[status]);
      expect(html, status).toContain(`data-status="${status}"`);
    }
  });

  it("`Returned to queue` and `Removed` are never rendered identically", () => {
    // Two studio-initiated returns with different consequences. Collapsing them
    // would tell a practitioner an entry is recoverable when it is not.
    const released = render(
      AdmissionRow({ entry: { ...ENTRY, status: "released" } }) as ReactElement,
    );
    const removed = render(
      AdmissionRow({ entry: { ...ENTRY, status: "removed" } }) as ReactElement,
    );
    expect(released).not.toBe(removed);
    expect(released).toContain(STATUS_MEANING.released);
    expect(removed).toContain(STATUS_MEANING.removed);
  });

  it("names are wrapped, never clipped", () => {
    // A truncated name on the one surface whose job is telling two waiting
    // people apart is a misidentification risk.
    const html = render(AdmissionRow({ entry: ENTRY }) as ReactElement);
    expect(html).toContain("break-words");
    expect(html).not.toContain("truncate");
    expect(html).not.toContain("line-clamp");
  });

  it("renders no `Declined` anywhere, because no such state exists", () => {
    for (const status of WAITLIST_ENTRY_STATUSES) {
      const html = render(
        AdmissionRow({ entry: { ...ENTRY, status } }) as ReactElement,
      );
      expect(html.toLowerCase(), status).not.toContain("declin");
    }
  });
});

describe("every action is shown, and every refusal explains itself", () => {
  it("all five actions render for every status — none is hidden", () => {
    for (const status of WAITLIST_ENTRY_STATUSES) {
      const html = render(AdmissionActions({ status }) as ReactElement);
      for (const action of ADMISSION_ACTIONS) {
        expect(html, `${status}/${action}`).toContain(
          `data-testid="admission-action-${action}"`,
        );
      }
    }
  });

  it("a lifecycle refusal renders the model's exact reason", () => {
    const html = render(AdmissionActions({ status: "invited" }) as ReactElement);
    const invite = actionAvailability("invite", "invited");
    expect(invite.available).toBe(false);
    expect(html).toContain((invite as { reason: string }).reason);
    expect(html).toContain('data-testid="admission-reason-invite"');
  });

  it("the reason is associated with its control for assistive tech", () => {
    const html = render(AdmissionActions({ status: "invited" }) as ReactElement);
    expect(html).toContain('aria-describedby="reason-invite"');
    expect(html).toContain('id="reason-invite"');
  });

  it("the reason is TEXT beside the control, never a tooltip", () => {
    // A tooltip is unreachable by touch, which is the pointer this surface is
    // most used with.
    const html = render(AdmissionActions({ status: "converted" }) as ReactElement);
    expect(html).not.toContain("title=");
    expect(html).toContain('data-testid="admission-reason-release"');
  });
});

describe("pre-B2: available actions still refuse, for a DIFFERENT reason", () => {
  it("an available action is disabled while nothing is connected", () => {
    // `waiting` legitimately permits CLAIM, so this is the case that separates
    // "not yet wired" from "not permitted in this state". (It does NOT permit
    // invite: 0190 answers `not_claimed` for anything but `claimed`.)
    expect(actionAvailability("claim", "waiting").available).toBe(true);
    const html = render(AdmissionActions({ status: "waiting" }) as ReactElement);
    expect(html).toContain("Sending is not available in this release yet.");
  });

  it("and that sentence is NOT a lifecycle refusal", () => {
    // Collapsing "you cannot do this yet" into "you cannot do this to someone
    // in this state" is the same conflation rejected elsewhere in this project.
    const html = render(AdmissionActions({ status: "waiting" }) as ReactElement);
    const converted = render(AdmissionActions({ status: "converted" }) as ReactElement);
    expect(html).not.toContain("already booked");
    expect(converted).toContain("already booked");
    expect(converted).not.toContain("not available in this release");
  });

  it("connected: a permitted action becomes enabled, a refused one does not", () => {
    const html = render(
      AdmissionActions({ status: "waiting", connected: true }) as ReactElement,
    );
    // The claim control loses `disabled`; release keeps it and keeps its reason.
    // `disabled=""` — the ATTRIBUTE. A bare "disabled" substring also matches
    // the `disabled:` Tailwind variants inside the class string, which made an
    // earlier version of this assertion true in both directions.
    expect(buttonTag(html, "claim")).not.toContain('disabled=""');
    expect(buttonTag(html, "release")).toContain('disabled=""');
    expect(html).toContain((actionAvailability("release", "waiting") as { reason: string }).reason);
  });

  it("NON-VACUITY — the unconnected render really does disable that control", () => {
    // Without this pair the assertion above passes for a control that was
    // never disabled in either state.
    const html = render(AdmissionActions({ status: "waiting" }) as ReactElement);
    expect(buttonTag(html, "claim")).toContain('disabled=""');
  });
});

describe("mobile and tablet layout", () => {
  it("stacks on a phone and only splits at sm:", () => {
    const html = render(AdmissionRow({ entry: ENTRY }) as ReactElement);
    expect(html).toContain("flex-col");
    expect(html).toContain("sm:flex-row");
    // No md:/lg: step — an iPad in portrait is 768px and still a thumb, so the
    // touch floor must not be dropped at a width breakpoint.
    expect(html).not.toMatch(/\bmd:/);
    expect(html).not.toMatch(/\blg:/);
  });

  it("every action control carries the 44px touch floor", () => {
    const html = render(AdmissionActions({ status: "waiting" }) as ReactElement);
    expect([...html.matchAll(/<button[^>]*>/g)]).toHaveLength(ADMISSION_ACTIONS.length);
    for (const action of ADMISSION_ACTIONS) {
      // From the shared primitive, which ships min-height WITH inline-flex —
      // min-height has no effect on an inline box.
      const tag = buttonTag(html, action);
      expect(tag, action).toContain("min-h-[44px]");
      expect(tag, action).toContain("inline-flex");
    }
  });

  it("controls are full width on a phone and intrinsic from sm:", () => {
    const html = render(AdmissionActions({ status: "waiting" }) as ReactElement);
    expect(html).toContain("w-full");
    expect(html).toContain("sm:w-auto");
  });
});
