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

describe("no database word reaches the rendered markup, anywhere", () => {
  it("scans every status, every invitation context, both capability states", () => {
    // THE MODEL-LEVEL VOCABULARY TEST IS NOT ENOUGH. It walks the label and
    // action maps, so it cannot see a word that reaches the page some other
    // way — and one did: `data-status={status}` put "claimed" into the markup
    // of every held row. Invisible to a reader, unannounced by a screen
    // reader, consumed by nothing, and still the exact word the product ruling
    // removes. This scans the OUTPUT instead of the inputs.
    let markup = "";
    let rendered = 0;
    for (const status of WAITLIST_ENTRY_STATUSES) {
      for (const invitation of [
        {},
        { invitationElapsed: true, invitationRedeemed: false },
        { invitationElapsed: false, invitationRedeemed: false },
        { invitationRedeemed: true },
        { invitationFactsUnknown: true },
        { invitationFactsUnknown: true, invitationElapsed: true },
      ]) {
        for (const capabilities of [null, CONNECTED]) {
          markup += render(
            AdmissionRow({ entry: { ...ENTRY, status, invitation }, capabilities }),
          );
          rendered += 1;
        }
      }
    }
    // Non-vacuity: the sweep must have produced real pages.
    expect(rendered).toBe(WAITLIST_ENTRY_STATUSES.length * 6 * 2);
    expect(markup.length).toBeGreaterThan(10_000);

    const lower = markup.toLowerCase();
    for (const word of ["claim", "reinvite", "re-invite", "record expired", "released", "converted", "requeue"]) {
      expect(lower, `"${word}" reached the rendered markup`).not.toContain(word);
    }
    // Non-vacuity for the scan itself: words that SHOULD be there, are.
    expect(lower).toContain("invite to book");
    expect(lower).toContain("invitation expired");
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

  it("keeps two rows apart when their ids differ only in unsafe characters", () => {
    // THE PAIR THAT USED TO COLLIDE. `a/b` and `a:b` both sanitised to
    // `wl-a-b-…`, so rendering them together recreated the very duplication the
    // per-entry namespace was introduced to remove — the collision simply moved
    // from "every row shares one id" to "these two rows share one id".
    const pairs = [
      ["a/b", "a:b"],
      ["x y", "x-y"],
      ["caf\u00e9", "cafe"],
      ["e#1", "e@1"],
    ];
    for (const [left, right] of pairs) {
      const a = render(AdmissionRow({ entry: { ...ENTRY, id: left }, capabilities: null }));
      const b = render(AdmissionRow({ entry: { ...ENTRY, id: right }, capabilities: null }));
      const ids = (html: string) => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
      const idsA = ids(a);
      const idsB = ids(b);
      expect(idsA.length, `${left} emitted no ids`).toBeGreaterThan(0);
      for (const id of idsA) {
        expect(idsB, `"${left}" and "${right}" share the id ${id}`).not.toContain(id);
      }
      // And every reference still resolves inside its OWN row.
      for (const [html, own] of [
        [a, new Set(idsA)],
        [b, new Set(idsB)],
      ] as const) {
        const refs = [...html.matchAll(/aria-describedby="([^"]+)"/g)].flatMap((m) =>
          m[1].split(/\s+/).filter(Boolean),
        );
        for (const ref of refs) {
          expect(own.has(ref), `reference "${ref}" escapes its own row`).toBe(true);
        }
      }
    }
  });

  it("points every describedby at an id that exists on the same row", () => {
    // A dangling `aria-describedby` is worse than none: the control announces
    // that it has an explanation and then has none to give.
    for (const status of WAITLIST_ENTRY_STATUSES) {
      const html = render(
        AdmissionRow({ entry: { ...ENTRY, status, invitation: { invitationElapsed: false, invitationRedeemed: false } } }),
      );
      // SPLIT ON WHITESPACE. `aria-describedby` is a LIST of ids, and this
      // assertion previously treated the whole attribute value as one id — so
      // the moment a control was described by both its refusal and its warning,
      // it looked for an element whose id was the two ids joined by a space.
      const described = [...html.matchAll(/aria-describedby="([^"]+)"/g)].flatMap((m) =>
        m[1].split(/\s+/).filter(Boolean),
      );
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
        entry: { ...ENTRY, status: "invited", invitation: { invitationElapsed: false, invitationRedeemed: false } },
      }),
    );
    expect(html).toContain("Replace invitation");
    // "Resend" claimed a previous send the row cannot prove. Kept as a
    // tripwire so a revert fails here rather than passing quietly.
    expect(html).not.toContain("Resend invitation");
    expect(html).toContain("Cancel invitation");
    expect(hasControl(html, "invite_to_book")).toBe(false);
    expect(html).toContain("Invitation created");
  });

  it("offers Return to waitlist once the invitation has run out", () => {
    const html = render(
      AdmissionRow({
        entry: { ...ENTRY, status: "invited", invitation: { invitationElapsed: true, invitationRedeemed: false } },
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
      const context = { invitationElapsed: false, invitationRedeemed: false };
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

  it("enables the controls once an adapter is bound", () => {
    const html = render(AdmissionRow({ entry: ENTRY, capabilities: CONNECTED }));
    expect(controlTag(html, "invite_to_book")).not.toContain('disabled=""');
    // NEGATIVE CONTROL for the assertion above: with no adapter at all, the
    // identical expression must find the control disabled again.
    expect(controlTag(render(AdmissionRow({ entry: ENTRY })), "invite_to_book")).toContain(
      'disabled=""',
    );
  });

  it("keeps the composer opener reachable in the half-wired state", () => {
    // "Invite to book" OPENS the composer and carries no scope itself. Gating
    // it on `enforcesScope` made the composer's own supported state — form
    // visible, only Send disabled — unreachable, because nobody could get in.
    const halfWired = render(
      AdmissionRow({ entry: ENTRY, capabilities: { ...CONNECTED, enforcesScope: false } }),
    );
    expect(controlTag(halfWired, "invite_to_book")).not.toContain('disabled=""');
    // Resend is different and stays gated: it sends immediately, with a scope.
    const invited = render(
      AdmissionRow({
        entry: { ...ENTRY, status: "invited", invitation: { invitationElapsed: false, invitationRedeemed: false } },
        capabilities: { ...CONNECTED, enforcesScope: false },
      }),
    );
    expect(controlTag(invited, "resend_invitation")).toContain('disabled=""');
  });

  it("fails closed when the entry supplies NO invitation facts at all", () => {
    // `AdmissionEntry.invitation` is optional and documented as "absent means
    // not known". It was reaching the rulings as `{}`, where the absent flags
    // read as false, so the row claimed the link was live and unused — and once
    // an adapter is bound it would advertise Resend and Cancel on an invitation
    // the database may already have marked redeemed.
    // Built WITHOUT the key, not with it set to undefined — the point is an
    // entry a caller never filled in.
    const withoutFacts: AdmissionEntry = {
      id: ENTRY.id,
      name: ENTRY.name,
      email: ENTRY.email,
      availabilityLabel: ENTRY.availabilityLabel,
      waitingDays: ENTRY.waitingDays,
      status: "invited",
    };
    const html = render(AdmissionRow({ entry: withoutFacts, capabilities: CONNECTED }));

    expect(hasControl(html, "resend_invitation")).toBe(true);
    expect(hasControl(html, "cancel_invitation")).toBe(true);
    // ...rendered, but REFUSED — hiding them would say the controls do not
    // exist on a row where they do.
    expect(controlTag(html, "resend_invitation")).toContain('disabled=""');
    expect(controlTag(html, "cancel_invitation")).toContain('disabled=""');
    expect(html).toContain("could not be checked");

    // No action derived from a guessed invitation state.
    expect(hasControl(html, "return_to_waitlist")).toBe(false);
    // And no claim that a working link exists.
    expect(html).not.toContain('data-testid="admission-note-resend_invitation"');

    // NEGATIVE CONTROL: an entry that DOES state the invitation is live keeps
    // both controls enabled, so the refusals above are not vacuous.
    const known = render(
      AdmissionRow({
        entry: {
          ...ENTRY,
          status: "invited",
          invitation: { invitationElapsed: false, invitationRedeemed: false },
        },
        capabilities: CONNECTED,
      }),
    );
    expect(controlTag(known, "resend_invitation")).not.toContain('disabled=""');
    expect(controlTag(known, "cancel_invitation")).not.toContain('disabled=""');
  });

  it("asserts nothing about an unreadable invitation, whatever flags came with it", () => {
    // The rendered form of the same law. `{ factsUnknown, redeemed }` used to
    // put "They have already used their invitation" on the Remove control one
    // line under a row saying the state could not be checked.
    for (const invitation of [
      { invitationFactsUnknown: true },
      { invitationFactsUnknown: true, invitationRedeemed: true },
      { invitationFactsUnknown: true, invitationElapsed: true },
      { invitationFactsUnknown: true, invitationRedeemed: true, invitationElapsed: true },
    ]) {
      const html = render(
        AdmissionRow({
          entry: { ...ENTRY, status: "invited", invitation },
          capabilities: CONNECTED,
        }),
      );
      const what = JSON.stringify(invitation);
      expect(html, `${what}: claimed the invitation was used`).not.toContain("have used");
      expect(html, `${what}: claimed it already used`).not.toContain(
        "already used their invitation",
      );
      expect(html, `${what}: claimed it ran out`).not.toContain("ran out");
      expect(html, `${what}: read as expired`).not.toContain("Invitation expired");
      expect(html).toContain("could not be checked");
      expect(controlTag(html, "resend_invitation")).toContain('disabled=""');
      expect(controlTag(html, "cancel_invitation")).toContain('disabled=""');
      expect(hasControl(html, "return_to_waitlist")).toBe(false);
    }

    // NEGATIVE CONTROL: a READABLE redeemed invitation still says so, so the
    // absences above are about unreadability rather than about the copy.
    const readable = render(
      AdmissionRow({
        entry: { ...ENTRY, status: "invited", invitation: { invitationRedeemed: true } },
        capabilities: CONNECTED,
      }),
    );
    expect(readable).toContain("have used their invitation");
    expect(readable).not.toContain("could not be checked");
  });

  it("fails closed on PARTIAL invitation facts too, not just missing ones", () => {
    // `{ invitationElapsed: false }` has a key, so a key-count test let it
    // through with `invitationRedeemed` absent — read as false — and the row
    // went back to offering Resend and Cancel on an invitation that may already
    // have been redeemed.
    for (const invitation of [
      { invitationElapsed: false },
      { invitationElapsed: true },
      { invitationRedeemed: false },
      { invitationRedeemed: false, invitationElapsed: undefined },
    ]) {
      const html = render(
        AdmissionRow({
          entry: { ...ENTRY, status: "invited", invitation },
          capabilities: CONNECTED,
        }),
      );
      expect(
        controlTag(html, "resend_invitation"),
        `${JSON.stringify(invitation)}: Resend was enabled`,
      ).toContain('disabled=""');
      expect(
        controlTag(html, "cancel_invitation"),
        `${JSON.stringify(invitation)}: Cancel was enabled`,
      ).toContain('disabled=""');
      expect(html).toContain("could not be checked");
      expect(html).not.toContain("is active and has not been used");
      // The retired wording is kept as a tripwire: a revert must not pass.
      expect(html).not.toContain("live booking link");
    }

    // NEGATIVE CONTROL: complete facts keep both controls, so the refusals
    // above are about incompleteness rather than about the row.
    const complete = render(
      AdmissionRow({
        entry: {
          ...ENTRY,
          status: "invited",
          invitation: { invitationElapsed: false, invitationRedeemed: false },
        },
        capabilities: CONNECTED,
      }),
    );
    expect(controlTag(complete, "resend_invitation")).not.toContain('disabled=""');
    expect(controlTag(complete, "cancel_invitation")).not.toContain('disabled=""');
    expect(complete).toContain("is active and has not been used");
  });

  it("does not give a non-invited row invitation semantics when facts are omitted", () => {
    // A waiting or released entry has no invitation for facts to be unknown
    // about; withholding its controls would disable a feature for no reason.
    for (const status of ["waiting", "released", "expired"] as const) {
      const html = render(
        AdmissionRow({ entry: { ...ENTRY, status, invitation: undefined }, capabilities: CONNECTED }),
      );
      const primary = status === "waiting" ? "invite_to_book" : "return_to_waitlist";
      expect(controlTag(html, primary), `${status} primary was disabled`).not.toContain(
        'disabled=""',
      );
      expect(html).not.toContain("could not be checked");
    }
  });

  it("keeps the live-invitation shape when the facts could not be read", () => {
    // An unreadable invitation may already have been redeemed, so a stale
    // elapsed bit may not be used to claim expiry or hide Cancel.
    const html = render(
      AdmissionRow({
        entry: {
          ...ENTRY,
          status: "invited",
          invitation: { invitationFactsUnknown: true, invitationElapsed: true },
        },
      }),
    );
    expect(html).toContain("Invitation created");
    expect(html).not.toContain("Invitation expired");
    expect(html).toContain("could not be checked");
    expect(hasControl(html, "cancel_invitation")).toBe(true);
    expect(hasControl(html, "return_to_waitlist")).toBe(false);
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
    expect(html).not.toContain("“Replace invitation” is not connected yet");
  });
});

describe("resending tells the truth about the link it replaces", () => {
  it("warns while a working link exists", () => {
    // Only the raw token's DIGEST is stored, so resending cannot re-deliver the
    // existing link — it mints a new one and restarts the window. The invitee
    // may already be holding the old one.
    const html = render(
      AdmissionRow({
        entry: { ...ENTRY, status: "invited", invitation: { invitationElapsed: false, invitationRedeemed: false } },
        capabilities: CONNECTED,
      }),
    );
    expect(html).toContain('data-testid="admission-note-resend_invitation"');
    expect(html).toContain("stops working");
  });

  it("names the warning in the button's own description", () => {
    // The note renders only when Resend is ENABLED, which is exactly when
    // `state.reason` is null — so the one situation carrying a material
    // consequence was the one where the button had no description at all. A
    // screen-reader user could activate it, invalidating a link the invitee may
    // be holding, without ever hearing that.
    const html = render(
      AdmissionRow({
        entry: {
          ...ENTRY,
          status: "invited",
          invitation: { invitationElapsed: false, invitationRedeemed: false },
        },
        capabilities: CONNECTED,
      }),
    );
    const tag = controlTag(html, "resend_invitation");
    const described = /aria-describedby="([^"]+)"/.exec(tag)?.[1];
    expect(described, "the enabled Resend button has no description").toBeTruthy();

    // The reference resolves, and resolves to the WARNING specifically.
    const noteId = /<span id="([^"]+)"[^>]*data-testid="admission-note-resend_invitation"/.exec(
      html,
    )?.[1];
    expect(noteId, "the warning carries no id").toBeTruthy();
    expect(described!.split(/\s+/)).toContain(noteId);
    expect(html).toContain(`id="${noteId}"`);
  });

  it("describes a control by BOTH its refusal and its warning when both apply", () => {
    // `aria-describedby` takes a list; a control that has something to explain
    // and something to warn about must not drop one of them.
    const html = render(
      AdmissionRow({
        entry: {
          ...ENTRY,
          status: "invited",
          invitation: { invitationElapsed: false, invitationRedeemed: false },
        },
        capabilities: { ...CONNECTED, canResend: false },
      }),
    );
    const tag = controlTag(html, "resend_invitation");
    const ids = (/aria-describedby="([^"]+)"/.exec(tag)?.[1] ?? "").split(/\s+/).filter(Boolean);
    expect(ids.length, "expected both a refusal and a warning id").toBeGreaterThan(1);
    for (const id of ids) expect(html).toContain(`id="${id}"`);
  });

  it("every aria-describedby on a row resolves within that row", () => {
    // The general form, so the next control that grows adjacent prose cannot
    // repeat this. Third recurrence of the class: composer errors, this
    // warning, and the namespaced reason ids before them.
    let checked = 0;
    for (const status of WAITLIST_ENTRY_STATUSES) {
      for (const invitation of [
        undefined,
        { invitationElapsed: false, invitationRedeemed: false },
        { invitationElapsed: true, invitationRedeemed: false },
        { invitationRedeemed: true },
        { invitationFactsUnknown: true },
      ]) {
        for (const capabilities of [null, CONNECTED]) {
          const html = render(
            AdmissionRow({ entry: { ...ENTRY, status, invitation }, capabilities }),
          );
          const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
          for (const ref of [...html.matchAll(/aria-describedby="([^"]+)"/g)].flatMap((m) =>
            m[1].split(/\s+/),
          )) {
            checked += 1;
            expect(ids.has(ref), `${status}: aria-describedby "${ref}" resolves to nothing`).toBe(
              true,
            );
          }
        }
      }
    }
    expect(checked, "the sweep found no descriptions to check").toBeGreaterThan(20);
  });

  it("stays quiet once there is nothing left to break", () => {
    // NEGATIVE CONTROL for the assertion above: on an expired invitation the
    // old link already does not work, and the warning would be noise.
    const html = render(
      AdmissionRow({
        entry: { ...ENTRY, status: "invited", invitation: { invitationElapsed: true, invitationRedeemed: false } },
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

  it("tells the truth about cancelling: the link dies AND they leave the queue", () => {
    // This assertion previously pinned the opposite claim — "They keep their
    // place" — which read as reassurance and was wrong: `cancelInvitation` ends
    // at `released`, and returning them is a second, explicit act. A
    // practitioner who stopped after cancelling would have left the person
    // silently out of the active queue.
    const html = render(
      AdmissionRow({
        entry: { ...ENTRY, status: "invited", invitation: { invitationElapsed: false, invitationRedeemed: false } },
        capabilities: CONNECTED,
      }),
    );
    expect(html).toContain("booking link stops working straight away");
    expect(html).toContain("set aside");
    expect(html).toContain("will not be active on the waitlist");
    expect(html).toContain("until you return them to it");
    expect(html).not.toContain("They keep their place");
  });

  it("agrees with the row the person lands on after cancelling", () => {
    // The confirmation and the resulting row are two statements about the same
    // transition, written in different places. They contradicted each other.
    const confirm = render(
      AdmissionRow({
        entry: { ...ENTRY, status: "invited", invitation: { invitationElapsed: false, invitationRedeemed: false } },
        capabilities: CONNECTED,
      }),
    );
    const landed = render(AdmissionRow({ entry: { ...ENTRY, status: "released" } }));
    // Both must say the person is not active until returned, in their own words.
    expect(confirm).toContain("will not be active on the waitlist");
    expect(landed.toLowerCase()).toContain("out of the queue");
    expect(landed).toContain("Return to waitlist");
  });

  it("makes an unavailable destructive control inert for EVERY input method", () => {
    // `pointer-events-none` blocks only the pointer. A native <summary> stays
    // keyboard-focusable and Enter/Space still opens it, so the previous
    // revision let keyboard users open and confirm a control the surface had
    // declared unavailable — with no adapter bound, that was every destructive
    // control on the page. It also ASSERTED inertness while testing only the
    // pointer half, which is how it survived.
    const html = render(AdmissionRow({ entry: ENTRY, capabilities: null }));

    // No disclosure exists at all in the disabled state.
    expect(html).not.toContain('data-testid="admission-confirm-remove_from_waitlist"');
    expect(html).not.toContain("<details");
    expect(html).not.toContain("<summary");

    // What is rendered is a genuinely disabled <button>, which browsers make
    // unfocusable and unactivatable by pointer AND keyboard.
    const tag = controlTag(html, "remove_from_waitlist");
    expect(tag).toMatch(/^<button/);
    expect(tag).toContain('disabled=""');

    // NEGATIVE CONTROL: with the capability present the disclosure comes back,
    // or the assertions above would pass on an empty page.
    const enabled = render(AdmissionRow({ entry: ENTRY, capabilities: CONNECTED }));
    expect(enabled).toContain('data-testid="admission-confirm-remove_from_waitlist"');
    expect(enabled).toContain("<summary");
  });

  it("never renders a summary that claims to be disabled", () => {
    // `disabled` is not a valid attribute on <summary> and does nothing there.
    // Wherever a summary IS rendered, it must be genuinely available.
    for (const status of WAITLIST_ENTRY_STATUSES) {
      for (const caps of [null, CONNECTED]) {
        const html = render(
          AdmissionRow({
            entry: { ...ENTRY, status, invitation: { invitationElapsed: false, invitationRedeemed: false } },
            capabilities: caps,
          }),
        );
        for (const tag of html.match(/<summary[^>]*>/g) ?? []) {
          // `disabled[=\s>]`, never a bare "disabled": the class string carries
          // Tailwind's `disabled:cursor-not-allowed` and `disabled:opacity-50`
          // variants, which match the loose form and would make this assertion
          // fire on every correctly-rendered summary.
          expect(tag, `${status}: a summary carries a disabled attribute`).not.toMatch(
            /\sdisabled[=\s>]/,
          );
          expect(tag, `${status}: a summary is only pointer-inert`).not.toContain(
            "pointer-events-none",
          );
        }
      }
    }
  });
});
