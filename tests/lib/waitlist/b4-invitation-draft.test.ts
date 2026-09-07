import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  WAITLIST_ENTRY_STATUSES,
  actionAvailability,
  type AdmissionContext,
  type WaitlistEntryStatus,
} from "@/lib/waitlist/admission-model";
import {
  ALLOWED_DAYS_PRESET_VALUES,
  BOOKING_WINDOW_PRESETS,
  INVITE_TO_BOOK_STATUSES,
  PRACTITIONER_ACTIONS,
  PRACTITIONER_ACTION_LABEL,
  PRACTITIONER_STATUS_LABEL,
  TTL_PRESETS,
  UNKNOWN_INVITATION_FAILS_CLOSED,
  WEEKDAYS_IN_DISPLAY_ORDER,
  activeAllowedDaysPreset,
  activeTtlPreset,
  activeWindowPreset,
  controlState,
  delegateFor,
  draftToInviteInput,
  emptyDraft,
  entryActionSurface,
  practitionerActionAvailability,
  practitionerStatusLabel,
  readyToBind,
  sendState,
  validateDraft,
  type InviteDraft,
  type PractitionerActionItem,
} from "@/lib/waitlist/b4-invitation-draft";

// ===========================================================================
// WAIT-03 B4 — the practitioner surface, and the rules it must NOT own
// ===========================================================================
//
// Two things are proved here and they pull in opposite directions.
//
// THE PRODUCT RULING is that the waitlist state machine is invisible: no Claim,
// no Claim next, no Reinvite, and no screen that asks a practitioner which
// internal transition they meant. That is asserted directly against the
// exported vocabulary, because a ruling that lives only in a comment is one
// refactor from being undone.
//
// THE ENGINEERING RULING is that hiding the state machine must not mean
// re-deriving it. Every verdict this module renders is delegated to the live
// `admission-model`, and the delegation is EXECUTED here rather than described:
// the surface is walked at every status under every invitation context and each
// verdict compared against its delegate's. The one permitted divergence is
// refusing where the live model permits. Permitting where it refuses would
// offer a control the database is guaranteed to reject, which is the exact
// failure the live model exists to prevent.

const ROOT = process.cwd();

/** Every .ts/.tsx file under a directory, recursively. Node 20 has no
 *  `fs.globSync`, and this is the walk the repo's other dormancy proofs use. */
function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(ROOT, dir));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) {
      if (name === "node_modules" || name === ".next") continue;
      out.push(...walk(rel));
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Every invitation context a caller can actually hand us, including the
 * combinations that should not occur.
 *
 * `{ elapsed: true, unknown: true }` is contradictory — the window cannot be
 * known to have passed on facts that could not be read — and it is in the
 * matrix on purpose. A surface that behaves sensibly only on coherent input is
 * a surface that fails on the day a read half-succeeds.
 */
const CONTEXTS: ReadonlyArray<{ name: string; context: AdmissionContext }> = [
  { name: "no invitation facts", context: {} },
  { name: "live, unused", context: { invitationElapsed: false, invitationRedeemed: false } },
  { name: "elapsed", context: { invitationElapsed: true, invitationRedeemed: false } },
  { name: "redeemed", context: { invitationRedeemed: true } },
  { name: "facts unreadable", context: { invitationFactsUnknown: true } },
  {
    name: "elapsed AND unreadable (incoherent input)",
    context: { invitationElapsed: true, invitationFactsUnknown: true },
  },
];

function surfaceItems(
  status: WaitlistEntryStatus,
  context: AdmissionContext,
): PractitionerActionItem[] {
  const surface = entryActionSurface(status, context);
  return [...(surface.primary ? [surface.primary] : []), ...surface.secondary];
}

// ---------------------------------------------------------------------------

describe("this module is UNREACHABLE from the application", () => {
  it("no file under app/ imports the prototype or its contract", () => {
    const files = walk("app");
    // Non-vacuity: the walk must actually be finding the application.
    expect(files.length).toBeGreaterThan(20);

    const sources = files.map((rel) => ({
      rel,
      text: readFileSync(join(ROOT, rel), "utf8"),
    }));

    for (const moduleName of ["b4-invitation-draft", "invite-to-book-contract"]) {
      expect(
        sources.filter((f) => f.text.includes(moduleName)).map((f) => f.rel),
        `an app/ surface now reaches ${moduleName}, which no server action carries`,
      ).toEqual([]);
    }

    // NON-VACUITY for the search itself: the LIVE model IS imported by app/, so
    // a scan that found nothing anywhere would be broken rather than reassuring.
    expect(
      sources.filter((f) => f.text.includes("waitlist/admission-model")).length,
    ).toBeGreaterThan(0);
  });

  it("no adapter implementation exists anywhere in the repository", () => {
    // "Do not fake a working Send invitation" is only enforceable if there is
    // nothing to fake with. A stub that can be called is a stub that can be
    // wired by accident, so the contract ships a null sentinel and no class.
    const sources = [...walk("app"), ...walk("lib"), ...walk("components")];
    const implementors = sources.filter((rel) =>
      /implements\s+WaitlistInvitationAdapter/.test(readFileSync(join(ROOT, rel), "utf8")),
    );
    expect(implementors).toEqual([]);
  });
});

describe("the state machine is invisible", () => {
  it("offers no Claim, Claim next or Reinvite, by any spelling", () => {
    const vocabulary = [
      ...PRACTITIONER_ACTIONS,
      ...Object.values(PRACTITIONER_ACTION_LABEL),
      ...Object.values(PRACTITIONER_STATUS_LABEL),
    ]
      .join(" ")
      .toLowerCase();

    for (const forbidden of ["claim", "reinvite", "re-invite"]) {
      expect(vocabulary, `"${forbidden}" is a database word, not a practitioner's`).not.toContain(
        forbidden,
      );
    }
  });

  it("never names an internal status in anything a practitioner reads", () => {
    // The database's own words for four of the seven states. A practitioner
    // sees none of them — not in a label, not in a refusal sentence.
    const internal = ["claimed", "released", "converted", "requeue"];
    const rendered: string[] = [...Object.values(PRACTITIONER_STATUS_LABEL)];
    for (const status of WAITLIST_ENTRY_STATUSES) {
      for (const { context } of CONTEXTS) {
        rendered.push(practitionerStatusLabel(status, context));
        for (const action of PRACTITIONER_ACTIONS) {
          const verdict = practitionerActionAvailability(action, status, context);
          if (!verdict.available) rendered.push(verdict.reason);
        }
      }
    }
    const text = rendered.join(" ").toLowerCase();
    for (const word of internal) {
      expect(text, `"${word}" leaked into practitioner-facing copy`).not.toContain(word);
    }
  });

  it("an elapsed invitation reads as expired, though the entry is still `invited`", () => {
    // Recording the expiry is bookkeeping the database performs. Whether it has
    // happened yet is not a fact a practitioner should be able to observe, and
    // certainly not one they should have to fix with a button.
    expect(practitionerStatusLabel("invited", { invitationElapsed: true })).toBe(
      "Invitation expired",
    );
    expect(practitionerStatusLabel("invited", { invitationElapsed: false })).toBe(
      "Invitation sent",
    );
    // A REDEEMED invitation is not expired even after its window passes: they
    // used it, and the entry is waiting on a booking record, not on a clock.
    expect(
      practitionerStatusLabel("invited", {
        invitationElapsed: true,
        invitationRedeemed: true,
      }),
    ).toBe("Invitation sent");
  });

  it("a previously invited person who is eligible again gets the ordinary invite", () => {
    // Finding A, closed by removing the choice rather than by answering it.
    // There is no second action to tell apart from the first, so no caller needs
    // invitation history to decide which control to render.
    for (const status of INVITE_TO_BOOK_STATUSES) {
      const surface = entryActionSurface(status);
      expect(surface.primary?.action).toBe("invite_to_book");
      expect(surface.primary?.label).toBe("Invite to book");
    }
    // And nothing anywhere renders a second sending action beside it.
    const everySendingControl = WAITLIST_ENTRY_STATUSES.flatMap((status) =>
      CONTEXTS.flatMap(({ context }) =>
        surfaceItems(status, context).filter((i) => i.action === "invite_to_book"),
      ),
    );
    expect(new Set(everySendingControl.map((i) => i.label)).size).toBeLessThanOrEqual(1);
  });
});

describe("every verdict is the live model's, not a second copy of it", () => {
  it("never offers a control the live model refuses", () => {
    let compared = 0;
    for (const status of WAITLIST_ENTRY_STATUSES) {
      for (const { name, context } of CONTEXTS) {
        for (const item of surfaceItems(status, context)) {
          const delegate = delegateFor(item.action, status);
          if (delegate === null) continue;
          const live = actionAvailability(delegate, status, context);
          compared += 1;
          expect(
            !item.available || live.available,
            `${item.action}@${status} (${name}) is offered while ${delegate} refuses it`,
          ).toBe(true);
        }
      }
    }
    // Non-vacuity: the walk must actually be reaching delegated controls.
    expect(compared).toBeGreaterThan(20);
  });

  it("diverges from the live verdict ONLY where it fails closed, and only there", () => {
    const divergences: string[] = [];
    for (const status of WAITLIST_ENTRY_STATUSES) {
      for (const { context } of CONTEXTS) {
        for (const item of surfaceItems(status, context)) {
          const delegate = delegateFor(item.action, status);
          if (delegate === null) continue;
          const live = actionAvailability(delegate, status, context);
          if (item.available !== live.available) {
            divergences.push(`${item.action}@${status}`);
          }
        }
      }
    }
    // The single documented case: "Return to waitlist" on an `invited` entry
    // whose invitation could not be READ. `expire` folds "not elapsed" and
    // "could not look" into one branch, which is safe where it is offered and
    // unsafe here — so unknown refuses, the way `release` already does.
    expect(new Set(divergences)).toEqual(new Set(["return_to_waitlist@invited"]));
  });

  it("fails closed on an unreadable invitation rather than guessing", () => {
    const verdict = practitionerActionAvailability("return_to_waitlist", "invited", {
      invitationFactsUnknown: true,
      invitationElapsed: true,
    });
    expect(verdict.available).toBe(false);
    expect(verdict.available === false && verdict.reason).toBe(
      UNKNOWN_INVITATION_FAILS_CLOSED,
    );
  });

  it("reads a closed entry's refusal from the live model rather than restating it", () => {
    for (const status of ["converted", "removed"] as const) {
      for (const action of PRACTITIONER_ACTIONS) {
        const ours = practitionerActionAvailability(action, status);
        const live = actionAvailability("claim", status);
        expect(ours).toEqual(live);
      }
      // The premise that delegation rests on: every live action refuses a
      // closed entry identically, so `claim` is a sound probe for all of them.
      const viaClaim = actionAvailability("claim", status);
      for (const live of ["expire", "release", "requeue", "remove"] as const) {
        expect(actionAvailability(live, status)).toEqual(viaClaim);
      }
    }
  });
});

describe("`Invite to book` accepts exactly the statuses the database can reach", () => {
  it("derives its domain from 0188's own transition table", () => {
    const sql = readFileSync(
      join(ROOT, "supabase/migrations/0188_new_client_waitlist_invitations.sql"),
      "utf8",
    );
    // The guard's legal-edge list, verbatim: ('waiting',  'claimed'), …
    const edges = [...sql.matchAll(/\(\s*'(\w+)'\s*,\s*'(\w+)'\s*\)/g)].map((m) => [
      m[1],
      m[2],
    ]);
    expect(edges.length).toBeGreaterThan(10);

    // `issue` requires `claimed`. So the compound command's domain is every
    // status that reaches `claimed` in at most one studio-driven hop.
    const reachesClaimed = WAITLIST_ENTRY_STATUSES.filter(
      (s) => s === "claimed" || edges.some(([from, to]) => from === s && to === "claimed"),
    );
    expect(new Set(INVITE_TO_BOOK_STATUSES)).toEqual(new Set(reachesClaimed));
  });

  it("sends `expired` and `released` back to the queue instead", () => {
    for (const status of ["expired", "released"] as const) {
      const surface = entryActionSurface(status);
      expect(surface.primary?.action).toBe("return_to_waitlist");
      const invite = practitionerActionAvailability("invite_to_book", status);
      expect(invite.available).toBe(false);
    }
  });
});

describe("the row's action surface", () => {
  it("gives a closed entry nothing at all", () => {
    // Not five greyed buttons under someone who has already booked: on a
    // terminal entry no control will ever become available, so there is nothing
    // for a disabled one to teach.
    for (const status of ["converted", "removed"] as const) {
      expect(entryActionSurface(status)).toEqual({ primary: null, secondary: [] });
    }
  });

  it("leaves a live invitation with no primary action", () => {
    // The studio is not the one deciding — the invitee is. Inventing a primary
    // control here pushes a practitioner to interfere with someone mid-decision.
    const surface = entryActionSurface("invited", { invitationElapsed: false });
    expect(surface.primary).toBeNull();
    expect(surface.secondary.map((i) => i.action)).toEqual([
      "resend_invitation",
      "cancel_invitation",
      "remove_from_waitlist",
    ]);
  });

  it("promotes `Return to waitlist` once the invitation has run out", () => {
    const surface = entryActionSurface("invited", { invitationElapsed: true });
    expect(surface.primary?.action).toBe("return_to_waitlist");
    // Cancelling an invitation that has already expired is a distinction only
    // the state machine cares about.
    expect(surface.secondary.map((i) => i.action)).not.toContain("cancel_invitation");
  });

  it("never leaves a legacy held entry without a way out", () => {
    // `claimed` is unreachable by any action on this surface but exists in the
    // data, put there by the older screen. Both exits stay open.
    const actions = surfaceItems("claimed", {}).map((i) => i.action);
    expect(actions).toContain("invite_to_book");
    expect(actions).toContain("return_to_waitlist");
  });

  it("names the exit the row actually offers when removal is blocked", () => {
    // A refusal that says "cancel it first" on a row whose invitation has
    // already expired points at a control that is not there — the same defect
    // as explaining a disabled Remove with a sentence about sending.
    const removeReason = (context: AdmissionContext) => {
      const item = surfaceItems("invited", context).find(
        (i) => i.action === "remove_from_waitlist",
      )!;
      return item.available === false ? item.reason : null;
    };

    expect(removeReason({ invitationElapsed: false })).toContain("Cancel their invitation");
    expect(removeReason({ invitationElapsed: true })).toContain("Return them to the waitlist");

    // The refusal's ACTIONABLE VERB must belong to a control the same row is
    // showing. Comparing whole labels is too strict — the sentence reads
    // "Cancel their invitation" where the button reads "Cancel invitation" —
    // and comparing nothing is the defect itself.
    for (const [context, verb] of [
      [{ invitationElapsed: false }, "Cancel"],
      [{ invitationElapsed: true }, "Return"],
    ] as const) {
      const reason = removeReason(context)!;
      expect(reason).toContain(verb);
      const shown = surfaceItems("invited", context).map((i) => i.label);
      expect(
        shown.some((label) => label.startsWith(verb)),
        `"${reason}" points at a control this row does not show: ${shown.join(", ")}`,
      ).toBe(true);
    }
  });

  it("does not send a redeemed entry chasing a control that will refuse it too", () => {
    // The known lifecycle gap: someone who used their invitation and never
    // booked has no operator exit at all. Naming Cancel here would send a
    // practitioner to a control that answers `already_redeemed`.
    const item = surfaceItems("invited", { invitationRedeemed: true }).find(
      (i) => i.action === "remove_from_waitlist",
    )!;
    expect(item.available).toBe(false);
    const reason = item.available === false ? item.reason : "";
    expect(reason).toContain("already used their invitation");
    expect(reason).not.toContain("Cancel their invitation first");
  });

  it("marks exactly the two irreversible actions destructive", () => {
    const destructive = new Set(
      WAITLIST_ENTRY_STATUSES.flatMap((s) =>
        CONTEXTS.flatMap(({ context }) =>
          surfaceItems(s, context).filter((i) => i.destructive).map((i) => i.action),
        ),
      ),
    );
    expect(destructive).toEqual(new Set(["cancel_invitation", "remove_from_waitlist"]));
  });
});

describe("wiring state is not eligibility", () => {
  it("explains an unwired control by naming that control", () => {
    // Finding C. The earlier revision applied one sentence about SENDING to
    // every unwired action, including three that send nothing.
    for (const item of surfaceItems("waiting", {})) {
      const state = controlState(item, null);
      expect(state.disabled).toBe(true);
      expect(state.reason).toContain(item.label);
      expect(state.reason?.toLowerCase()).not.toContain("sending is not available");
    }
  });

  it("keeps the eligibility reason when the entry itself forbids the action", () => {
    // "They have already used their invitation" stays true whether or not the
    // invitation service exists, and is the more useful of the two sentences.
    const item = surfaceItems("invited", { invitationRedeemed: true }).find(
      (i) => i.action === "resend_invitation",
    )!;
    expect(item.available).toBe(false);
    expect(controlState(item, null).reason).toBe(
      item.available === false ? item.reason : null,
    );
  });

  it("is not ready to bind, because no adapter exists", () => {
    expect(readyToBind(null)).toBe(false);
    expect(readyToBind({
      enforcesScope: false,
      canResend: true,
      canCancel: true,
      canReturnToWaitlist: true,
      canRemove: true,
    })).toBe(false);
    expect(readyToBind({
      enforcesScope: true,
      canResend: true,
      canCancel: true,
      canReturnToWaitlist: true,
      canRemove: true,
    })).toBe(true);
  });
});

describe("the composer's draft", () => {
  const draft = (over: Partial<InviteDraft> = {}): InviteDraft => ({
    ...emptyDraft(),
    ...over,
  });

  it("treats no service as a real answer and no permitted day as an error", () => {
    // `null` weekdays means every day. `[]` means no day is permitted, which is
    // an invitation that opens onto an empty calendar.
    expect(validateDraft(draft({ serviceId: null })).ok).toBe(true);
    expect(validateDraft(draft({ allowedWeekdays: null })).ok).toBe(true);
    const empty = validateDraft(draft({ allowedWeekdays: [] }));
    expect(empty.ok).toBe(false);
    expect(empty.ok === false && empty.errors.days).toBeTruthy();
  });

  it("refuses an expiry the shipped command would refuse, rather than clamping it", () => {
    // 1 hour .. 7 days, and out of range is REFUSED — a clamped window is one
    // the caller did not ask for and cannot see.
    expect(validateDraft(draft({ expiresInHours: 1 })).ok).toBe(true);
    expect(validateDraft(draft({ expiresInHours: 168 })).ok).toBe(true);
    for (const bad of [0, 169, 2.5, Number.NaN]) {
      expect(validateDraft(draft({ expiresInHours: bad })).ok, `${bad}`).toBe(false);
    }
  });

  it("bounds the booking window", () => {
    expect(validateDraft(draft({ windowDays: 1 })).ok).toBe(true);
    expect(validateDraft(draft({ windowDays: 365 })).ok).toBe(true);
    for (const bad of [0, 366, 7.5]) {
      expect(validateDraft(draft({ windowDays: bad })).ok, `${bad}`).toBe(false);
    }
  });

  it("hands the adapter nothing at all for an invalid draft", () => {
    // A partially-repaired payload is the one thing worse than no payload.
    expect(draftToInviteInput("e1", draft({ expiresInHours: 999 }))).toBeNull();
    expect(draftToInviteInput("e1", draft())).toEqual({
      entryId: "e1",
      scope: { serviceId: null, windowDays: 7, allowedWeekdays: null },
      expiresInHours: 72,
    });
  });

  it("derives the pressed preset from the value, so the two cannot disagree", () => {
    expect(activeWindowPreset(7)).toBe(7);
    expect(activeWindowPreset(9)).toBe("custom");
    expect(activeTtlPreset(72)).toBe(72);
    expect(activeTtlPreset(5)).toBe("custom");
    expect(activeAllowedDaysPreset(null)).toBe("every");
    expect(activeAllowedDaysPreset([1, 2, 3, 4, 5])).toBe("weekdays");
    // Order must not matter; a set is a set.
    expect(activeAllowedDaysPreset([5, 4, 3, 2, 1])).toBe("weekdays");
    expect(activeAllowedDaysPreset([6, 0])).toBe("weekends");
    expect(activeAllowedDaysPreset([1, 3])).toBe("custom");
    // Every preset round-trips through its own value.
    for (const [preset, value] of Object.entries(ALLOWED_DAYS_PRESET_VALUES)) {
      expect(activeAllowedDaysPreset(value)).toBe(preset);
    }
  });

  it("renders weekdays Monday-first while keeping Sunday at index 0", () => {
    // Display order and value travel together: selecting "Mon–Fri" by position
    // must not quietly select Sunday–Thursday.
    expect(WEEKDAYS_IN_DISPLAY_ORDER.map((d) => d.label)).toEqual([
      "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun",
    ]);
    expect(WEEKDAYS_IN_DISPLAY_ORDER.map((d) => d.index)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(WEEKDAYS_IN_DISPLAY_ORDER.find((d) => d.label === "Sun")?.index).toBe(0);
  });

  it("blocks the send for a fixable field before blaming the missing service", () => {
    // A fixable draft must not look permanently broken.
    const broken = sendState(draft({ expiresInHours: 999 }), null);
    expect(broken.disabled).toBe(true);
    expect(broken.reason).toContain("highlighted");

    const unbound = sendState(draft(), null);
    expect(unbound.disabled).toBe(true);
    expect(unbound.reason).toContain("Invite to book");

    const unscoped = sendState(draft(), {
      enforcesScope: false,
      canResend: true,
      canCancel: true,
      canReturnToWaitlist: true,
      canRemove: true,
    });
    expect(unscoped.disabled).toBe(true);
    expect(unscoped.reason).toContain("booking window");
  });

  it("offers presets that are all inside the bounds they claim", () => {
    for (const preset of TTL_PRESETS) {
      expect(validateDraft(draft({ expiresInHours: preset.hours })).ok).toBe(true);
    }
    for (const preset of BOOKING_WINDOW_PRESETS) {
      expect(validateDraft(draft({ windowDays: preset.days })).ok).toBe(true);
    }
  });
});
