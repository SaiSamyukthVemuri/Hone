import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

import {
  AdmissionActions,
  AdmissionRow,
  waitingLabel,
  type AdmissionEntry,
} from "@/components/waitlist/admission-row";
import { WAITLIST_ENTRY_STATUSES } from "@/lib/waitlist/admission-model";
import {
  PRACTITIONER_ACTIONS,
  entryActionSurface,
} from "@/lib/waitlist/b4-invitation-draft";
import type { AdapterCapabilities } from "@/lib/waitlist/invite-to-book-contract";

// ===========================================================================
// WAIT-03 B4 — the row renders against NON-AUTHORITATIVE fixtures
// ===========================================================================
//
// No adapter exists, so there is no server interface to render against. These
// fixtures are invented, live only in this file, and are deliberately NOT
// exported from any runtime module — a fixture importable by `app/` is a
// fixture that can reach a studio.
//
// Rendered through `react-dom/server` against the REAL components, because this
// repo has no DOM harness and a source grep would prove only that a string
// exists somewhere in the file rather than that it reaches the output.

const ENTRY: AdmissionEntry = {
  id: "entry-1",
  name: "Sarah Jones",
  email: "sarah@example.test",
  availabilityLabel: "Weekday availability",
  waitingDays: 41,
  status: "waiting",
};

const CONNECTED: AdapterCapabilities = {
  enforcesScope: true,
  canResend: true,
  canCancel: true,
  canReturnToWaitlist: true,
  canRemove: true,
};

// `AdmissionActions` returns null for a terminal entry, which is the whole
// point of it — a booked row shows no controls. The renderer's signature does
// not accept null, so the fixture narrows it rather than the component widening
// its return type to suit a test.
const render = (el: ReactElement | null) =>
  el === null ? "" : renderToStaticMarkup(el);

/**
 * The WHOLE opening tag carrying one action's test id.
 *
 * Slicing FORWARD from the test id does not work and silently passes: React
 * emits attributes in JSX order, so `disabled` lands BEFORE `data-testid` and a
 * forward slice can never see it. An assertion written that way is vacuous in
 * exactly the direction that matters. Matching the whole tag also means the
 * `<summary>` controls are found alongside the `<button>` ones.
 */
function controlTag(html: string, action: string): string {
  const tag = [...html.matchAll(/<(?:button|summary)[^>]*>/g)]
    .map((m) => m[0])
    .find((t) => t.includes(`data-testid="admission-action-${action}"`));
  if (!tag) throw new Error(`no control rendered for action "${action}"`);
  return tag;
}

function hasControl(html: string, action: string): boolean {
  return html.includes(`data-testid="admission-action-${action}"`);
}

// ---------------------------------------------------------------------------

describe("the waiting row a practitioner reads", () => {
  const html = render(AdmissionRow({ entry: ENTRY }));

  it("shows the name, their availability and how long they have waited", () => {
    expect(html).toContain("Sarah Jones");
    expect(html).toContain("Weekday availability");
    expect(html).toContain("Waiting 41 days");
  });

  it("offers exactly one action, and it is Invite to book", () => {
    expect(html).toContain("Invite to book");
    expect(hasControl(html, "invite_to_book")).toBe(true);
    // The whole product ruling, asserted on rendered output rather than on the
    // model: no Claim, no Claim next, no Reinvite reaches the screen.
    for (const forbidden of ["Claim", "Claim next", "Reinvite", "Send a new invitation"]) {
      expect(html, `"${forbidden}" reached the row`).not.toContain(forbidden);
    }
  });

  it("counts the days honestly at both edges", () => {
    expect(waitingLabel(0)).toBe("Joined today");
    expect(waitingLabel(1)).toBe("Waiting 1 day");
    expect(waitingLabel(41)).toBe("Waiting 41 days");
    // Negative days cannot happen from a server-side count, but a row reading
    // "Waiting -1 days" would be worse than one reading "Joined today".
    expect(waitingLabel(-3)).toBe("Joined today");
  });

  it("renders the primary control full width for a thumb", () => {
    const tag = controlTag(html, "invite_to_book");
    expect(tag).toContain("w-full");
    // The 44px floor comes from the primitive and travels with `inline-flex`,
    // which CSS min-height needs in order to apply at all.
    expect(tag).toContain("min-h-[44px]");
    expect(tag).toContain("inline-flex");
  });
});

describe("accessible ids are namespaced per entry", () => {
  it("does not collide across rows", () => {
    // FINDING B. The earlier revision emitted `id="reason-remove"` on every
    // row, so `aria-describedby` resolved to the FIRST match in the document
    // and a screen reader announced another person's prerequisite here.
    const first = render(AdmissionRow({ entry: { ...ENTRY, id: "entry-1" } }));
    const second = render(AdmissionRow({ entry: { ...ENTRY, id: "entry-2" } }));

    const ids = (html: string) =>
      [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);

    const firstIds = ids(first);
    const secondIds = ids(second);
    // Non-vacuity: the rows must actually be emitting ids to compare.
    expect(firstIds.length).toBeGreaterThan(0);
    expect(firstIds.length).toBe(secondIds.length);
    for (const id of firstIds) {
      expect(secondIds, `id "${id}" is shared between two rows`).not.toContain(id);
    }
  });

  it("points every describedby at an id that exists on the same row", () => {
    // A dangling `aria-describedby` is worse than none: the control announces
    // that it has an explanation and then has none to give.
    for (const status of WAITLIST_ENTRY_STATUSES) {
      const html = render(
        AdmissionRow({ entry: { ...ENTRY, status, invitation: { invitationElapsed: false } } }),
      );
      const described = [...html.matchAll(/aria-describedby="([^"]+)"/g)].map((m) => m[1]);
      for (const target of described) {
        expect(html, `${status}: nothing carries id="${target}"`).toContain(`id="${target}"`);
      }
    }
  });

  it("survives an entry id that is not id-safe", () => {
    const html = render(AdmissionRow({ entry: { ...ENTRY, id: "weird id/with:chars" } }));
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id, `"${id}" is not a usable HTML id`).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
    }
  });
});

describe("what each state offers", () => {
  it("gives a booked or removed row no controls at all", () => {
    for (const status of ["converted", "removed"] as const) {
      const html = render(AdmissionRow({ entry: { ...ENTRY, status } }));
      expect(html).not.toContain("data-testid=\"admission-actions\"");
      for (const action of PRACTITIONER_ACTIONS) {
        expect(hasControl(html, action), `${status} offered ${action}`).toBe(false);
      }
      // The row still explains itself.
      expect(html).toContain("Sarah Jones");
    }
  });

  it("offers resend and cancel on a live invitation, and no primary", () => {
    const html = render(
      AdmissionRow({
        entry: { ...ENTRY, status: "invited", invitation: { invitationElapsed: false } },
      }),
    );
    expect(html).toContain("Resend invitation");
    expect(html).toContain("Cancel invitation");
    expect(hasControl(html, "invite_to_book")).toBe(false);
    expect(html).toContain("Invitation sent");
  });

  it("offers Return to waitlist once the invitation has run out", () => {
    const html = render(
      AdmissionRow({
        entry: { ...ENTRY, status: "invited", invitation: { invitationElapsed: true } },
      }),
    );
    expect(html).toContain("Return to waitlist");
    // The entry is still `invited` in the database, and says nothing of the
    // sort on screen.
    expect(html).toContain("Invitation expired");
    expect(html).not.toContain("Cancel invitation");
  });

  it("renders every rendered control the model put in the surface, and no other", () => {
    for (const status of WAITLIST_ENTRY_STATUSES) {
      const context = { invitationElapsed: false };
      const html = render(AdmissionRow({ entry: { ...ENTRY, status, invitation: context } }));
      const surface = entryActionSurface(status, context);
      const expected = new Set(
        [...(surface.primary ? [surface.primary] : []), ...surface.secondary].map(
          (i) => i.action,
        ),
      );
      for (const action of PRACTITIONER_ACTIONS) {
        expect(
          hasControl(html, action),
          `${status}: ${action} rendered=${hasControl(html, action)} expected=${expected.has(action)}`,
        ).toBe(expected.has(action));
      }
    }
  });
});

describe("nothing is connected, and every control says so in its own words", () => {
  it("disables every control while no adapter is bound", () => {
    const html = render(AdmissionRow({ entry: ENTRY }));
    // `disabled=""` rather than a bare "disabled" substring: the class string
    // contains Tailwind's `disabled:` variants, which match the loose form and
    // make the assertion pass in the wrong direction.
    expect(controlTag(html, "invite_to_book")).toContain('disabled=""');
  });

  it("explains the refusal by naming the control, not by talking about sending", () => {
    // FINDING C. The earlier revision applied one sentence about SENDING to
    // every unwired control, including Remove, which sends nothing.
    const html = render(AdmissionRow({ entry: ENTRY }));
    expect(html).toContain("“Invite to book” is not connected yet");
    expect(html).toContain("“Remove from waitlist” is not connected yet");
    expect(html.toLowerCase()).not.toContain("sending is not available");
  });

  it("enables the controls once an adapter reports the capability", () => {
    const html = render(AdmissionRow({ entry: ENTRY, capabilities: CONNECTED }));
    expect(controlTag(html, "invite_to_book")).not.toContain('disabled=""');
    // NEGATIVE CONTROL for the assertion above: with the capability withheld,
    // the identical expression must find the control disabled again.
    const partial = render(
      AdmissionRow({ entry: ENTRY, capabilities: { ...CONNECTED, enforcesScope: false } }),
    );
    expect(controlTag(partial, "invite_to_book")).toContain('disabled=""');
  });

  it("keeps the eligibility reason over the wiring one", () => {
    // "They have already used their invitation" stays true whether or not the
    // invitation service exists, and is the more useful of the two sentences.
    const html = render(
      AdmissionActions({
        entryId: ENTRY.id,
        entryName: ENTRY.name,
        status: "invited",
        context: { invitationRedeemed: true },
        capabilities: null,
      }),
    );
    expect(html).toContain("already used their invitation");
    expect(html).not.toContain("“Resend invitation” is not connected yet");
  });
});

describe("resending tells the truth about the link it replaces", () => {
  it("warns while a working link exists", () => {
    // Only the raw token's DIGEST is stored, so resending cannot re-deliver the
    // existing link — it mints a new one and restarts the window. The invitee
    // may already be holding the old one.
    const html = render(
      AdmissionRow({
        entry: { ...ENTRY, status: "invited", invitation: { invitationElapsed: false } },
        capabilities: CONNECTED,
      }),
    );
    expect(html).toContain('data-testid="admission-note-resend_invitation"');
    expect(html).toContain("stops working");
  });

  it("stays quiet once there is nothing left to break", () => {
    // NEGATIVE CONTROL for the assertion above: on an expired invitation the
    // old link already does not work, and the warning would be noise.
    const html = render(
      AdmissionRow({
        entry: { ...ENTRY, status: "invited", invitation: { invitationElapsed: true } },
        capabilities: CONNECTED,
      }),
    );
    expect(html).not.toContain('data-testid="admission-note-resend_invitation"');
  });
});

describe("destructive actions are confirmed, and say what they cost", () => {
  it("puts removal behind a disclosure that names the consequence", () => {
    const html = render(AdmissionRow({ entry: ENTRY, capabilities: CONNECTED }));
    expect(html).toContain('data-testid="admission-confirm-remove_from_waitlist"');
    expect(html).toContain("loses their place in the queue");
    expect(html).toContain("cannot be undone");
    // The person is named in the confirmation, so a mis-tapped row is caught
    // before it is confirmed rather than after.
    expect(html).toContain("Sarah Jones is taken off the waitlist");
  });

  it("tells the truth about cancelling: the link dies, the place does not", () => {
    const html = render(
      AdmissionRow({
        entry: { ...ENTRY, status: "invited", invitation: { invitationElapsed: false } },
        capabilities: CONNECTED,
      }),
    );
    expect(html).toContain("booking link stops working straight away");
    expect(html).toContain("They keep their place");
  });

  it("does not leave a disabled destructive control looking pressable", () => {
    // `disabled` does nothing on a <summary>, so an unavailable one must be
    // made inert rather than merely styled.
    const html = render(AdmissionRow({ entry: ENTRY, capabilities: null }));
    expect(controlTag(html, "remove_from_waitlist")).toContain("pointer-events-none");
  });
});
