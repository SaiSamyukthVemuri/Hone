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
  invitationHasRunOut,
  normalizeInvitationContext,
  practitionerStatusDetail,
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
  type PractitionerAction,
  type PractitionerActionItem,
} from "@/lib/waitlist/b4-invitation-draft";
import type { AdapterCapabilities } from "@/lib/waitlist/invite-to-book-contract";

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
  it("offers no Claim, Claim next, Reinvite or Record expired — by any spelling", () => {
    // THE ACTION VOCABULARY is where the state machine would show through. It
    // must contain none of the database's verbs, `expire` included: recording
    // an expiry is bookkeeping the database performs, not a button.
    const actionVocabulary = [
      ...PRACTITIONER_ACTIONS,
      ...Object.values(PRACTITIONER_ACTION_LABEL),
    ]
      .join(" ")
      .toLowerCase();
    for (const forbidden of ["claim", "reinvite", "re-invite", "expire"]) {
      expect(
        actionVocabulary,
        `"${forbidden}" is a database verb, not a practitioner's action`,
      ).not.toContain(forbidden);
    }

    // THE STATUS VOCABULARY may say "Invitation expired", because that is the
    // state a practitioner genuinely observes — it is the ACT of recording it
    // that must not exist. So the ban here is on the control's name, not on the
    // adjective.
    const everythingRendered = [
      ...Object.values(PRACTITIONER_STATUS_LABEL),
      ...Object.values(PRACTITIONER_ACTION_LABEL),
    ]
      .join(" ")
      .toLowerCase();
    for (const forbidden of ["record expired", "claim", "reinvite"]) {
      expect(everythingRendered, `"${forbidden}" reached the practitioner`).not.toContain(
        forbidden,
      );
    }
    expect(Object.values(PRACTITIONER_STATUS_LABEL)).toContain("Invitation expired");
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
    expect(practitionerStatusLabel("invited", { invitationElapsed: true, invitationRedeemed: false })).toBe(
      "Invitation expired",
    );
    expect(practitionerStatusLabel("invited", { invitationElapsed: false, invitationRedeemed: false })).toBe(
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
    // THE KEY CARRIES THE CONTEXT, and that is load-bearing. An earlier
    // revision keyed on `action@status` alone and compared Sets, so the
    // unreadable case already contributed `return_to_waitlist@invited` and a
    // NEW divergence at the same action and status — one that stranded an
    // ordinary readable, elapsed invitation — would have collapsed into the
    // same set element and passed. The exception has to be scoped to the exact
    // context it was granted for, or it is not scoped at all.
    const divergences: string[] = [];
    let inspected = 0;
    for (const status of WAITLIST_ENTRY_STATUSES) {
      for (const { name, context } of CONTEXTS) {
        for (const item of surfaceItems(status, context)) {
          const delegate = delegateFor(item.action, status);
          if (delegate === null) continue;
          const live = actionAvailability(delegate, status, context);
          inspected += 1;
          if (item.available !== live.available) {
            divergences.push(`${item.action}@${status}@${name}`);
          }
        }
      }
    }
    // The single documented case: "Return to waitlist" on an `invited` entry
    // whose window is reported elapsed on facts that could not be READ.
    // `expire` folds "not elapsed" and "could not look" into one branch, which
    // is safe where it is offered and unsafe here — so unknown refuses, the way
    // `release` already does one branch above.
    // TWO ENTRIES, BOTH IN THE SAFE DIRECTION, BOTH FROM ONE CAUSE.
    //
    // The comparison above deliberately uses the RAW context, which is what the
    // live model sees. On an `invited` entry with NO invitation facts at all,
    // the live model reads the absent flags as false and answers "available";
    // this surface normalises that same absence to `invitationFactsUnknown` and
    // refuses. We are strictly stricter, which is the only divergence direction
    // permitted — offering a control the database will reject is the failure
    // this whole delegation exists to prevent, and refusing one it might have
    // accepted costs a practitioner a retry.
    //
    // Scoped to the exact context, so a divergence appearing under any OTHER
    // context — or on any other action — fails here rather than hiding behind
    // an already-accepted key.
    expect(divergences.sort()).toEqual([
      "cancel_invitation@invited@no invitation facts",
      "resend_invitation@invited@no invitation facts",
    ]);
    // NON-VACUITY: the walk must actually be reaching delegated controls, or an
    // empty result would mean the loop found nothing rather than that nothing
    // diverged.
    expect(inspected).toBeGreaterThan(20);
  });

  it("fails closed on an unreadable invitation rather than guessing", () => {
    // Still the model's ruling for any direct caller, even though the surface
    // no longer routes here — unknown facts now render the live shape.
    const verdict = practitionerActionAvailability("return_to_waitlist", "invited", {
      invitationFactsUnknown: true,
      invitationElapsed: true,
    });
    expect(verdict.available).toBe(false);
    expect(verdict.available === false && verdict.reason).toBe(
      UNKNOWN_INVITATION_FAILS_CLOSED,
    );
  });

  it("treats a MISSING invitation context as unknown, not as a live invitation", () => {
    // `AdmissionEntry.invitation` is optional and documented as "absent means
    // not known", but an absent object was reaching the rulings as `{}`, where
    // `invitationFactsUnknown` and `invitationRedeemed` both read as false. The
    // row then claimed the link was live and unused, and once an adapter is
    // bound it would advertise Resend and Cancel on an invitation the database
    // may already have marked redeemed — both returning `already_redeemed`.
    for (const raw of [undefined, {}]) {
      expect(normalizeInvitationContext("invited", raw)).toEqual({
        invitationFactsUnknown: true,
      });

      const actions = surfaceItems("invited", raw as AdmissionContext);
      const resend = actions.find((i) => i.action === "resend_invitation")!;
      const cancel = actions.find((i) => i.action === "cancel_invitation")!;
      expect(resend.available, "Resend offered on unknown facts").toBe(false);
      expect(cancel.available, "Cancel offered on unknown facts").toBe(false);
      expect(actions.map((i) => i.action)).not.toContain("return_to_waitlist");

      // And it SAYS so, rather than describing a live link.
      expect(practitionerStatusDetail("invited", raw as AdmissionContext)).toContain(
        "could not be checked",
      );
      expect(practitionerStatusLabel("invited", raw as AdmissionContext)).toBe(
        "Invitation sent",
      );
    }

    // A caller that genuinely KNOWS the invitation is live keeps its controls —
    // otherwise the fix would simply disable the feature.
    const known = { invitationElapsed: false, invitationRedeemed: false };
    const live = surfaceItems("invited", known);
    expect(live.find((i) => i.action === "resend_invitation")!.available).toBe(true);
    expect(live.find((i) => i.action === "cancel_invitation")!.available).toBe(true);
  });

  it("treats PARTIAL invitation facts as unknown, not as a live invitation", () => {
    // Key count was the wrong question. `{ invitationElapsed: false }` has a
    // key, so it passed through unchanged, `invitationRedeemed` stayed absent
    // and read as false, and the row went back to announcing a live, unused
    // link — a claim about redemption the caller never made. A key whose value
    // is `undefined` failed the same way, because it still counts as a key.
    const partial: ReadonlyArray<[string, AdmissionContext]> = [
      ["elapsed only", { invitationElapsed: false }],
      ["elapsed only, true", { invitationElapsed: true }],
      ["a key with no fact", { invitationElapsed: undefined }],
      // THE CASE THAT DISCRIMINATES `typeof ... === "boolean"` FROM `"x" in c`.
      // Redemption IS stated here, so the check reaches the elapsed half; only
      // a real boolean may satisfy it. A presence test would call this complete
      // and read the absent elapsed value as "not elapsed".
      [
        "redemption stated, elapsed present but undefined",
        { invitationRedeemed: false, invitationElapsed: undefined },
      ],
      ["not-redeemed only", { invitationRedeemed: false }],
      ["facts-unknown explicitly false, nothing else", { invitationFactsUnknown: false }],
    ];
    for (const [label, context] of partial) {
      expect(
        normalizeInvitationContext("invited", context),
        `${label} was accepted as complete`,
      ).toEqual({ invitationFactsUnknown: true });

      const actions = surfaceItems("invited", context);
      for (const action of ["resend_invitation", "cancel_invitation"] as const) {
        expect(
          actions.find((i) => i.action === action)!.available,
          `${label}: ${action} was offered on incomplete facts`,
        ).toBe(false);
      }
      expect(practitionerStatusDetail("invited", context)).toContain("could not be checked");
    }
  });

  it("accepts the three shapes that ARE complete, and keeps their controls", () => {
    // Or the fix would just be disabling the feature.
    //
    // REDEEMED IS COMPLETE ON ITS OWN: it is terminal and settles every ruling
    // — it has not run out, it cannot be released, cancelled or resent, and the
    // entry waits on a booking record. Nothing else needs to be known.
    const complete: ReadonlyArray<[string, AdmissionContext]> = [
      ["explicitly unreadable", { invitationFactsUnknown: true }],
      ["redeemed", { invitationRedeemed: true }],
      ["live and unused", { invitationElapsed: false, invitationRedeemed: false }],
      ["run out, unused", { invitationElapsed: true, invitationRedeemed: false }],
    ];
    for (const [label, context] of complete) {
      expect(
        normalizeInvitationContext("invited", context),
        `${label} was discarded as incomplete`,
      ).toEqual(context);
    }

    // And a genuinely live invitation still offers both controls.
    const live = surfaceItems("invited", {
      invitationElapsed: false,
      invitationRedeemed: false,
    });
    expect(live.find((i) => i.action === "resend_invitation")!.available).toBe(true);
    expect(live.find((i) => i.action === "cancel_invitation")!.available).toBe(true);
    // A run-out one still promotes the return, rather than being frozen unknown.
    expect(
      entryActionSurface("invited", { invitationElapsed: true, invitationRedeemed: false })
        .primary?.action,
    ).toBe("return_to_waitlist");
  });

  it("discards every flag that accompanies an unknown invitation", () => {
    // A flag sitting beside `invitationFactsUnknown` came from the SAME read
    // that failed, so it is a claim sourced from the thing that just said it
    // could not be sourced. It had a reachable consequence: the removal refusal
    // tested `invitationRedeemed` first and announced "they have already used
    // their invitation" one line under a row saying the state could not be
    // checked.
    const CANONICAL = { invitationFactsUnknown: true };
    const cases: ReadonlyArray<[string, AdmissionContext]> = [
      ["unknown + redeemed", { invitationFactsUnknown: true, invitationRedeemed: true }],
      ["unknown + elapsed", { invitationFactsUnknown: true, invitationElapsed: true }],
      [
        "unknown + both",
        {
          invitationFactsUnknown: true,
          invitationRedeemed: true,
          invitationElapsed: true,
        },
      ],
      ["unknown alone", { invitationFactsUnknown: true }],
    ];

    for (const [label, context] of cases) {
      expect(
        normalizeInvitationContext("invited", context),
        `${label} kept a companion flag`,
      ).toEqual(CANONICAL);

      const detail = practitionerStatusDetail("invited", context);
      expect(detail).toContain("could not be checked");
      expect(detail, `${label}: claimed the invitation was used`).not.toContain("have used");
      expect(detail, `${label}: claimed the invitation ran out`).not.toContain("ran out");
      expect(practitionerStatusLabel("invited", context)).not.toBe("Invitation expired");

      for (const item of surfaceItems("invited", context)) {
        expect(item.available, `${label}: ${item.action} was offered`).toBe(false);
        const reason = item.available === false ? item.reason : "";
        expect(reason, `${label}: ${item.action} asserted a fact`).toContain(
          "could not be checked",
        );
      }
      expect(surfaceItems("invited", context).map((i) => i.action)).not.toContain(
        "return_to_waitlist",
      );
    }

    // Applied at every status, so there is ONE shape of unknown in the system.
    for (const status of WAITLIST_ENTRY_STATUSES) {
      expect(
        normalizeInvitationContext(status, {
          invitationFactsUnknown: true,
          invitationRedeemed: true,
        }),
      ).toEqual(CANONICAL);
    }
  });

  it("preserves a READABLE redeemed or elapsed invitation, unchanged", () => {
    // The other half of the law: discarding companions must not flatten facts
    // that were genuinely read. Without this the fix would just be "never
    // believe anything".
    const redeemed = { invitationRedeemed: true };
    expect(normalizeInvitationContext("invited", redeemed)).toEqual(redeemed);
    expect(practitionerStatusDetail("invited", redeemed)).toContain("have used");
    const removeOnRedeemed = surfaceItems("invited", redeemed).find(
      (i) => i.action === "remove_from_waitlist",
    )!;
    expect(
      removeOnRedeemed.available === false ? removeOnRedeemed.reason : "",
    ).toContain("already used their invitation");

    const elapsed = { invitationElapsed: true, invitationRedeemed: false };
    expect(normalizeInvitationContext("invited", elapsed)).toEqual(elapsed);
    expect(practitionerStatusLabel("invited", elapsed)).toBe("Invitation expired");
    expect(entryActionSurface("invited", elapsed).primary?.action).toBe(
      "return_to_waitlist",
    );
  });

  it("discards the partial fact rather than carrying it beside the unknown flag", () => {
    // A half-known state produced this defect twice — once as a missing object,
    // once as a partial one. Keeping the fragment invites a third reading of it.
    expect(normalizeInvitationContext("invited", { invitationElapsed: true })).toEqual({
      invitationFactsUnknown: true,
    });
    expect(
      normalizeInvitationContext("invited", { invitationElapsed: true }),
    ).not.toHaveProperty("invitationElapsed");
  });

  it("does not give a non-invited row invitation semantics", () => {
    // A waiting or released entry has no invitation for facts to be unknown
    // ABOUT, and marking one unknown would withhold controls whose safety does
    // not depend on an invitation at all.
    for (const status of WAITLIST_ENTRY_STATUSES) {
      if (status === "invited") continue;
      expect(normalizeInvitationContext(status, undefined)).toEqual({});
      expect(normalizeInvitationContext(status, {})).toEqual({});
    }
    expect(entryActionSurface("waiting").primary?.action).toBe("invite_to_book");
    expect(entryActionSurface("waiting").primary?.available).toBe(true);
    expect(entryActionSurface("released").primary?.available).toBe(true);
  });

  it("lets unreadable facts beat a stale elapsed flag, everywhere at once", () => {
    // An unreadable invitation may already have been REDEEMED, and a redeemed
    // one has not expired. So a `invitationElapsed` bit we could not verify may
    // not be used to claim expiry, hide the live controls, or contradict the
    // sentence underneath the pill — which is exactly what happened when the
    // label, the detail and the surface each read the flags independently.
    const unreadable = { invitationFactsUnknown: true, invitationElapsed: true };

    expect(invitationHasRunOut(unreadable)).toBe(false);
    expect(practitionerStatusLabel("invited", unreadable)).toBe("Invitation sent");
    expect(practitionerStatusDetail("invited", unreadable)).toContain("could not be checked");

    // The row keeps the LIVE shape, where every control refuses with a
    // could-not-check sentence rather than vanishing.
    const actions = surfaceItems("invited", unreadable).map((i) => i.action);
    expect(actions).toContain("cancel_invitation");
    expect(actions).toContain("resend_invitation");
    for (const item of surfaceItems("invited", unreadable)) {
      if (item.action === "remove_from_waitlist") continue;
      expect(item.available, `${item.action} was offered on unreadable facts`).toBe(false);
    }

    // NEGATIVE CONTROL: a READABLE elapsed invitation still reads as expired.
    const readable = {
      invitationFactsUnknown: false,
      invitationElapsed: true,
      invitationRedeemed: false,
    };
    expect(invitationHasRunOut(readable)).toBe(true);
    expect(practitionerStatusLabel("invited", readable)).toBe("Invitation expired");
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
    const surface = entryActionSurface("invited", { invitationElapsed: false, invitationRedeemed: false });
    expect(surface.primary).toBeNull();
    expect(surface.secondary.map((i) => i.action)).toEqual([
      "resend_invitation",
      "cancel_invitation",
      "remove_from_waitlist",
    ]);
  });

  it("promotes `Return to waitlist` once the invitation has run out", () => {
    const surface = entryActionSurface("invited", { invitationElapsed: true, invitationRedeemed: false });
    expect(surface.primary?.action).toBe("return_to_waitlist");
    // Cancelling an invitation that has already expired is a distinction only
    // the state machine cares about.
    expect(surface.secondary.map((i) => i.action)).not.toContain("cancel_invitation");
  });

  it("renders an elapsed invitation EXACTLY as the expired entry it becomes", () => {
    // The `invited` -> `expired` bookkeeping transition is invisible to a
    // practitioner. If the two rows offered different actions, the moment it
    // happened would show as a control appearing or vanishing on its own —
    // which is the state machine leaking through the one seam this design
    // closes. Resend used to sit on one and not the other.
    const elapsed = entryActionSurface("invited", { invitationElapsed: true, invitationRedeemed: false });
    const expired = entryActionSurface("expired");
    const shape = (s: ReturnType<typeof entryActionSurface>) => ({
      primary: s.primary?.action ?? null,
      secondary: s.secondary.map((i) => i.action),
    });
    expect(shape(elapsed)).toEqual(shape(expired));
    // And they read the same, so nothing distinguishes them on screen at all.
    expect(practitionerStatusLabel("invited", { invitationElapsed: true, invitationRedeemed: false })).toBe(
      practitionerStatusLabel("expired"),
    );
  });

  it("refuses to resend into a window that has already closed", () => {
    // Resending starts with `release`, so it would stamp an invitation that RAN
    // OUT as one the studio CANCELLED, and the entry's own history would then
    // disagree with what happened.
    const verdict = practitionerActionAvailability("resend_invitation", "invited", {
      invitationElapsed: true,
      invitationRedeemed: false,
    });
    expect(verdict.available).toBe(false);
    expect(verdict.available === false && verdict.reason).toContain("Return them to the waitlist");
    // Still offered on a live invitation, or the refusal above proves nothing.
    expect(
      practitionerActionAvailability("resend_invitation", "invited", {
        invitationElapsed: false,
        invitationRedeemed: false,
      }).available,
    ).toBe(true);
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

    expect(removeReason({ invitationElapsed: false, invitationRedeemed: false })).toContain("Cancel their invitation");
    expect(removeReason({ invitationElapsed: true, invitationRedeemed: false })).toContain("Return them to the waitlist");

    // The refusal's ACTIONABLE VERB must belong to a control the same row is
    // showing. Comparing whole labels is too strict — the sentence reads
    // "Cancel their invitation" where the button reads "Cancel invitation" —
    // and comparing nothing is the defect itself.
    for (const [context, verb] of [
      [{ invitationElapsed: false, invitationRedeemed: false }, "Cancel"],
      [{ invitationElapsed: true, invitationRedeemed: false }, "Return"],
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

  it("applies the unknown-over-elapsed precedence to the removal reason too", () => {
    // The precedence was established for the label, the detail and the action
    // surface, then bypassed here by a raw `context.invitationElapsed` read. On
    // unreadable facts the row keeps the LIVE shape — no "Return to waitlist"
    // anywhere on it — while this sentence told the practitioner to use exactly
    // that absent control.
    const unreadable = { invitationFactsUnknown: true, invitationElapsed: true };
    const shown = surfaceItems("invited", unreadable);
    expect(shown.map((i) => i.action)).not.toContain("return_to_waitlist");

    const remove = shown.find((i) => i.action === "remove_from_waitlist")!;
    expect(remove.available).toBe(false);
    const reason = remove.available === false ? remove.reason : "";
    expect(reason).not.toContain("Return them to the waitlist");
    expect(reason).toContain("could not be checked");

    // NEGATIVE CONTROL: with the facts READABLE and elapsed, "Return to
    // waitlist" IS on the row, so naming it is correct there.
    const readable = { invitationElapsed: true, invitationRedeemed: false };
    expect(surfaceItems("invited", readable).map((i) => i.action)).toContain(
      "return_to_waitlist",
    );
    const removeReadable = surfaceItems("invited", readable).find(
      (i) => i.action === "remove_from_waitlist",
    )!;
    expect(
      removeReadable.available === false ? removeReadable.reason : "",
    ).toContain("Return them to the waitlist");
  });

  it("never names a control the row is not showing, at any status or context", () => {
    // The general form of the defect class that has now recurred five times.
    // Every refusal sentence that names an action must name one this row
    // actually renders.
    const VERBS: ReadonlyArray<[string, PractitionerAction]> = [
      ["Cancel their invitation", "cancel_invitation"],
      ["Return them to the waitlist", "return_to_waitlist"],
    ];
    for (const status of WAITLIST_ENTRY_STATUSES) {
      for (const { name, context } of CONTEXTS) {
        const shown = surfaceItems(status, context);
        const actions = new Set(shown.map((i) => i.action));
        for (const item of shown) {
          if (item.available) continue;
          for (const [phrase, action] of VERBS) {
            if (!item.reason.includes(phrase)) continue;
            expect(
              actions.has(action),
              `${status} (${name}): "${item.label}" points at ${action}, which this row does not show`,
            ).toBe(true);
          }
        }
      }
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

  it("withholds resend from an adapter that cannot carry the scope it sends", () => {
    // `resendInvitation` takes a scope for the same reason `inviteToBook` does:
    // it mints a NEW invitation rather than re-delivering the old one. An
    // adapter reporting `{ canResend: true, enforcesScope: false }` — which the
    // contract permits as an intermediate state — must not light this control.
    const item = surfaceItems("invited", { invitationElapsed: false, invitationRedeemed: false }).find(
      (i) => i.action === "resend_invitation",
    )!;
    expect(item.available).toBe(true);

    const halfWired = controlState(item, {
      enforcesScope: false,
      canResend: true,
      canCancel: true,
      canReturnToWaitlist: true,
      canRemove: true,
    });
    expect(halfWired.disabled).toBe(true);
    expect(halfWired.reason).toContain("booking window");

    // NEGATIVE CONTROL: with scope enforcement the identical control enables.
    expect(
      controlState(item, {
        enforcesScope: true,
        canResend: true,
        canCancel: true,
        canReturnToWaitlist: true,
        canRemove: true,
      }).disabled,
    ).toBe(false);
  });

  it("gates each action on the capabilities it actually needs — the full matrix", () => {
    const caps = (over: Partial<AdapterCapabilities> = {}): AdapterCapabilities => ({
      enforcesScope: true,
      canResend: true,
      canCancel: true,
      canReturnToWaitlist: true,
      canRemove: true,
      ...over,
    });
    const find = (
      status: WaitlistEntryStatus,
      context: AdmissionContext,
      action: PractitionerAction,
    ) => surfaceItems(status, context).find((i) => i.action === action)!;

    const live = { invitationElapsed: false, invitationRedeemed: false };
    const resend = find("invited", live, "resend_invitation");
    const cancel = find("invited", live, "cancel_invitation");
    const invite = find("waiting", {}, "invite_to_book");
    const requeue = find("released", {}, "return_to_waitlist");
    const remove = find("waiting", {}, "remove_from_waitlist");

    // RESEND NEEDS BOTH. It mints a NEW invitation with a newly supplied scope,
    // so an adapter that can resend but cannot carry a scope would either drop
    // what the practitioner chose or silently reuse the old one.
    expect(controlState(resend, caps({ canResend: true, enforcesScope: false })).disabled).toBe(true);
    expect(controlState(resend, caps({ canResend: false, enforcesScope: true })).disabled).toBe(true);
    expect(controlState(resend, caps()).disabled).toBe(false);

    // INVITE TO BOOK OPENS THE COMPOSER and carries no scope itself, so it must
    // stay reachable in the half-wired state the contract permits — otherwise
    // the composer's own "form visible, Send disabled" state is unreachable.
    expect(controlState(invite, caps({ enforcesScope: false })).disabled).toBe(false);
    expect(controlState(invite, null).disabled).toBe(true);

    // The single-capability actions are gated on theirs, and NOT on scope.
    expect(controlState(cancel, caps({ canCancel: false })).disabled).toBe(true);
    expect(controlState(cancel, caps({ enforcesScope: false })).disabled).toBe(false);
    expect(controlState(requeue, caps({ canReturnToWaitlist: false })).disabled).toBe(true);
    expect(controlState(requeue, caps({ enforcesScope: false })).disabled).toBe(false);
    expect(controlState(remove, caps({ canRemove: false })).disabled).toBe(true);
    expect(controlState(remove, caps({ enforcesScope: false })).disabled).toBe(false);
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

  it("refuses a service that is no longer selectable instead of widening the scope", () => {
    // The composer renders the chosen service by looking it up. When the lookup
    // misses — deleted service, or the list refreshed under an open composer —
    // the summary read "any service" while the payload still carried the stale
    // id, so the practitioner confirmed one scope and sent another.
    const withService = draft({ serviceId: "svc-gone" });
    // With no service list supplied the draft is unjudged, as before.
    expect(validateDraft(withService).ok).toBe(true);

    const judged = validateDraft(withService, { serviceIds: ["svc-1", "svc-2"] });
    expect(judged.ok).toBe(false);
    expect(judged.ok === false && judged.errors.service).toBeTruthy();

    // And nothing reaches the adapter.
    expect(draftToInviteInput("e1", withService, { serviceIds: ["svc-1"] })).toBeNull();
    expect(sendState(withService, null, { serviceIds: ["svc-1"] }).disabled).toBe(true);

    // NEGATIVE CONTROL: a service that IS in the list passes the identical call.
    expect(validateDraft(withService, { serviceIds: ["svc-gone"] }).ok).toBe(true);
    // "Any service" is still a real answer and is never judged missing.
    expect(validateDraft(draft({ serviceId: null }), { serviceIds: [] }).ok).toBe(true);
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
