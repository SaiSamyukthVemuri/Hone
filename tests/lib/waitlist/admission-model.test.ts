import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ACTION_LABEL,
  ACTION_RESULT_STATUS,
  ADMISSION_ACTIONS,
  STATUS_LABEL,
  STATUS_MEANING,
  WAITLIST_ENTRY_STATUSES,
  actionAvailability,
  actionHelp,
  actionLabel,
  statusMeaning,
  type AdmissionAction,
  type WaitlistEntryStatus,
} from "@/lib/waitlist/admission-model";

// ===========================================================================
// THE WAITLIST LIFECYCLE A STUDIO CAN ACTUALLY DRIVE
// ===========================================================================
//
// Every action this model decides is wired to a shipped command, so the ONE
// thing that can make it dishonest is drifting from the shipped database. The
// first block therefore derives the lifecycle vocabulary FROM THE MIGRATION
// rather than comparing two hand-written lists — a list that certifies itself
// proves nothing.
//
// Invitation drafting — invite, reinvite, TTL bounds, the draft apparatus and
// the brief-vocabulary map — is NOT here, and is not in this repository state
// at all. It reaches no server action, so it left with the WAIT-03 B4 prototype
// to `feat/wait03-b4-admission-prototype` (draft PR #683) and is proved there.
// Nothing below may import it; the assertion that ADMISSION_ACTIONS is exactly
// the five wired commands is what keeps that from drifting back in silently.

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase/migrations/0188_new_client_waitlist_invitations.sql"),
  "utf8",
);

describe("the vocabulary is the DATABASE's, derived not copied", () => {
  it("matches the shipped status CHECK exactly", () => {
    const m = MIGRATION.match(/check \(status in \(([^)]*)\)\)/);
    expect(m, "0188 no longer declares a status CHECK in the expected shape").toBeTruthy();
    const shipped = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);

    // Non-vacuity: a regex that matched nothing would make this pass trivially.
    expect(shipped.length).toBeGreaterThanOrEqual(5);
    expect([...WAITLIST_ENTRY_STATUSES].sort()).toEqual([...shipped].sort());
  });

  it("every shipped status has a label and an operational meaning", () => {
    for (const s of WAITLIST_ENTRY_STATUSES) {
      expect(STATUS_LABEL[s], s).toBeTruthy();
      expect(STATUS_MEANING[s], s).toBeTruthy();
      // The meaning must not merely restate the label.
      expect(STATUS_MEANING[s].toLowerCase()).not.toBe(STATUS_LABEL[s].toLowerCase());
    }
  });

  it("`declined` is NOT a status, because the database has no such concept", () => {
    // 0188 contains no `declin*` token at all: a prospect cannot decline and
    // nothing records that they did. Modelling it would invent a fact the
    // system cannot hold.
    expect(MIGRATION.toLowerCase()).not.toMatch(/declin/);
    expect(WAITLIST_ENTRY_STATUSES).not.toContain("declined" as WaitlistEntryStatus);
  });

  it("`released` and `removed` stay distinguishable", () => {
    // Both are studio-initiated returns and they are NOT synonyms — one is
    // requeueable, the other terminal. A surface that collapsed them would tell
    // an owner they could bring someone back when they could not.
    expect(STATUS_MEANING.released).not.toBe(STATUS_MEANING.removed);
    expect(STATUS_LABEL.released).not.toBe(STATUS_LABEL.removed);
  });
});

describe("the model offers only actions a studio can actually perform", () => {
  it("is exactly the five wired lifecycle commands", () => {
    // THE INVARIANT THE MODULE SPLIT EXISTS TO CREATE. Inviting mints a token
    // that must reach a real recipient, so it has no server action and cannot
    // be offered. Keeping it out of this list is what makes that unreachable
    // rather than merely unrendered.
    expect([...ADMISSION_ACTIONS]).toEqual([
      "claim",
      "expire",
      "release",
      "requeue",
      "remove",
    ]);
    for (const unwired of ["invite", "reinvite"]) {
      expect(ADMISSION_ACTIONS as ReadonlyArray<string>).not.toContain(unwired);
      expect(Object.keys(ACTION_LABEL)).not.toContain(unwired);
    }
  });

  it("this module implements no ranking of its own", () => {
    // COMMENTS OUT BEFORE SCANNING. This module explains at length why it does
    // NOT rank, so scanning the raw text finds the word "ranking" in the very
    // prose that promises the absence — a parser reading documentation as code.
    const SRC = readFileSync(join(process.cwd(), "lib/waitlist/admission-model.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // Ordering is the database's existing FIFO. Nothing here re-sorts a queue.
    expect(SRC).not.toMatch(/\.sort\(|\brank\b|\bscore\b|\bpriority\b/i);
    // Non-vacuity: the stripped source is still real code, not an empty string.
    expect(SRC).toMatch(/export function actionAvailability/);
  });
});

/**
 * Every label a practitioner can actually be shown, grouped by the state the
 * underlying command leaves the entry in.
 *
 * Only OFFERABLE pairs count: an action the model refuses on a status has no
 * button and therefore no label. `claim` is skipped because the page never
 * renders it at all, which the queue suite proves separately.
 */
function labelOutcomes(
  label: (a: AdmissionAction, s: WaitlistEntryStatus) => string,
): Map<string, Set<WaitlistEntryStatus>> {
  const byLabel = new Map<string, Set<WaitlistEntryStatus>>();
  for (const status of WAITLIST_ENTRY_STATUSES) {
    for (const action of ADMISSION_ACTIONS) {
      if (action === "claim") continue;
      // `expire` is only offered once the clock has actually run out.
      if (!actionAvailability(action, status, { invitationElapsed: true }).available) {
        continue;
      }
      const key = label(action, status);
      if (!byLabel.has(key)) byLabel.set(key, new Set());
      byLabel.get(key)!.add(ACTION_RESULT_STATUS[action]);
    }
  }
  return byLabel;
}

describe("the practitioner's vocabulary is not the implementation's", () => {
  it("`claimed` is shown as READY TO INVITE, never as a claim or a hold", () => {
    // "Claim" describes how the queue moves an entry out of general contention.
    // It is not a job a studio owner sets out to do, and shipping the word made
    // the surface read like an implementation detail.
    expect(STATUS_LABEL.claimed).toBe("Ready to invite");
    expect(STATUS_LABEL.claimed).not.toMatch(/claim(?!$)|held/i);
    expect(STATUS_MEANING.claimed).not.toMatch(/\bclaim|\bheld\b/i);
  });

  it("NO rendered state vocabulary leaks an internal transition word", () => {
    // Every string in these two maps reaches a practitioner. `claimed` is a
    // database word; none of them may say it.
    for (const status of WAITLIST_ENTRY_STATUSES) {
      expect(STATUS_LABEL[status], status).not.toMatch(/\bclaim/i);
      expect(STATUS_MEANING[status], status).not.toMatch(/\bclaim/i);
    }
    // NON-VACUITY: the maps really do hold the strings being scanned.
    expect(Object.keys(STATUS_LABEL)).toHaveLength(WAITLIST_ENTRY_STATUSES.length);
    expect(STATUS_LABEL.claimed.length).toBeGreaterThan(3);
  });

  it("RELEASE READS DIFFERENTLY depending on what it ends", () => {
    // One command, two materially different acts. On a ready-to-invite entry it
    // gives up a hold nobody outside the studio ever saw; on an invited one it
    // ends an invitation that has ALREADY REACHED SOMEONE.
    expect(actionLabel("release", "claimed")).toBe("Set aside");
    expect(actionLabel("release", "invited")).toBe("Cancel invitation");
    expect(actionLabel("release", "claimed")).not.toBe(
      actionLabel("release", "invited"),
    );
  });

  it("RELEASE NEVER CLAIMS TO RETURN ANYONE TO THE WAITLIST", () => {
    // THE DEFECT THIS PINS, and it shipped in a review round. Release does not
    // reach `waiting` — it lands the entry in `released`, and only requeue goes
    // the rest of the way. A release control labelled "Return to waitlist" let
    // an owner press it, watch the person leave the section, and reasonably
    // conclude they were back in the queue while they had been dropped out of
    // it — with a SECOND button of the same name waiting in Released.
    expect(ACTION_RESULT_STATUS.release).toBe("released");
    expect(ACTION_RESULT_STATUS.requeue).toBe("waiting");
    for (const status of WAITLIST_ENTRY_STATUSES) {
      expect(actionLabel("release", status), status).not.toMatch(/return to waitlist/i);
    }
    // The phrase belongs to the transition that earns it, and only that one.
    expect(actionLabel("requeue", "released")).toBe("Return to waitlist");
  });

  it("the outcome table AGREES WITH THE SHIPPED SQL, derived not asserted", () => {
    // A hand-written table that certifies itself proves nothing, and this one is
    // load-bearing: every label check below trusts it.
    const m0189 = readFileSync(
      join(process.cwd(), "supabase/migrations/0189_waitlist_invitation_wall_clock_expiry.sql"),
      "utf8",
    );
    const release = m0189.slice(
      m0189.indexOf("function public.release_new_client_waitlist_entry"),
    );
    expect(release.length).toBeGreaterThan(200);
    expect(release).toMatch(/set status = 'released'/);
    expect(release).not.toMatch(/set status = 'waiting'/);

    const requeue = MIGRATION.slice(
      MIGRATION.indexOf("function public.requeue_new_client_waitlist_entry"),
    );
    expect(requeue.length).toBeGreaterThan(200);
    expect(requeue).toMatch(/set status\s+= 'waiting'/);
  });

  it("TWO CONTROLS THAT DO DIFFERENT THINGS CAN NEVER SHARE A LABEL", () => {
    // The general rule the P1 was one instance of. Group every label a
    // practitioner can be shown by the state it actually produces; a label used
    // by two different outcomes is a lie to at least one of them.
    const outcomesByLabel = labelOutcomes((a, s) => actionLabel(a, s));
    for (const [label, outcomes] of outcomesByLabel) {
      expect(
        [...outcomes],
        `"${label}" is shown on controls that leave the entry in different states`,
      ).toHaveLength(1);
    }
    // NON-VACUITY: real labels were grouped, not an empty map.
    expect(outcomesByLabel.size).toBeGreaterThan(2);
    expect([...outcomesByLabel.keys()]).toContain("Return to waitlist");
  });

  it("NEGATIVE CONTROL — the OLD labelling is caught by that rule", () => {
    // Re-runs the identical check against the copy this PR replaced, where
    // release-on-claimed also read "Return to waitlist". If the rule cannot fail
    // here it is not enforcing anything.
    const oldLabel = (a: AdmissionAction, s: WaitlistEntryStatus) =>
      a === "release" && s === "claimed" ? "Return to waitlist" : actionLabel(a, s);

    const outcomesByLabel = labelOutcomes(oldLabel);
    const shared = outcomesByLabel.get("Return to waitlist")!;
    expect(shared, "the old copy must collide, or this control proves nothing").toBeDefined();
    // `released` (from release) and `waiting` (from requeue) under one label.
    expect([...shared].sort()).toEqual(["released", "waiting"]);
  });

  it("requeue reads as returning someone to the waitlist", () => {
    for (const status of ["expired", "released"] as const) {
      expect(actionLabel("requeue", status)).toBe("Return to waitlist");
    }
  });

  it("SET ASIDE carries the consequence its verb does not", () => {
    // The round trip back is two steps, and a terse label cannot say so alone.
    const help = actionHelp("release", "claimed");
    expect(help).toBeTruthy();
    expect(help).toMatch(/ready to invite/i);
    expect(help).toMatch(/return them to the waitlist later/i);
    // Only where the verb genuinely needs it — not decoration on every control.
    expect(actionHelp("requeue", "released")).toBeNull();
    expect(actionHelp("release", "invited")).toBeNull();
  });

  it("no label a practitioner can ACTUALLY BE SHOWN says `claim` or `release`", () => {
    // Scoped to pairs the surface can genuinely render — an action the model
    // refuses on a status has no button and therefore no label. Asserting over
    // every pair would instead be testing `ACTION_LABEL`'s fallback, which is
    // the raw command word on purpose and reaches nobody.
    const rendered: string[] = [];
    for (const status of WAITLIST_ENTRY_STATUSES) {
      for (const action of ADMISSION_ACTIONS) {
        // Claiming is never rendered regardless of availability — the page does
        // not ask for it. Proved page-side in the queue suite.
        if (action === "claim") continue;
        // `expire` needs the clock to have run out before it is offered at all.
        const verdict = actionAvailability(action, status, { invitationElapsed: true });
        if (!verdict.available) continue;
        const label = actionLabel(action, status);
        rendered.push(`${action}/${status}=${label}`);
        expect(label, `${action}/${status}`).not.toMatch(/\bclaim|\brelease\b/i);
      }
    }
    // NON-VACUITY: real, status-dependent labels were produced and scanned —
    // not an empty loop that satisfies the assertion by never running.
    expect(rendered.length).toBeGreaterThan(4);
    expect(rendered).toContain("release/invited=Cancel invitation");
    expect(rendered).toContain("release/claimed=Set aside");
  });

  it("THE WIRING IS UNTOUCHED — claim is still a modelled, available action", () => {
    // This change removed a control, not a capability. If claim ever stops
    // being modelled, restoring the UI stops being a rendering change.
    expect(ADMISSION_ACTIONS as ReadonlyArray<string>).toContain("claim");
    expect(actionAvailability("claim", "waiting").available).toBe(true);
    expect(ACTION_LABEL.claim).toBe("Claim");
  });
});

describe("every action, on every state, is decided AND explained", () => {
  it("an unavailable action always carries an actionable reason", () => {
    for (const status of WAITLIST_ENTRY_STATUSES) {
      for (const action of ADMISSION_ACTIONS) {
        const verdict = actionAvailability(action, status);
        if (verdict.available) continue;
        expect(verdict.reason, `${action}/${status}`).toBeTruthy();
        expect(verdict.reason.length, `${action}/${status}`).toBeGreaterThan(15);
        // Written for a practitioner: no status codes, no identifiers.
        expect(verdict.reason, `${action}/${status}`).not.toMatch(
          /invalid_input|not_owner|entry_id|null|undefined/,
        );
        expect(verdict.reason.trim().endsWith("."), `${action}/${status}`).toBe(true);
      }
    }
  });

  it("NON-VACUITY — some actions really are available", () => {
    // A model that refused everything would satisfy the assertion above.
    const available = WAITLIST_ENTRY_STATUSES.flatMap((s) =>
      ADMISSION_ACTIONS.filter((a) => actionAvailability(a, s).available),
    );
    expect(available.length).toBeGreaterThan(5);
  });

  it("EXPIRE IS NOT CANCELLATION — it is withheld until the clock has run out", () => {
    // The operator's way to end a live invitation early is `release`. `expire`
    // records a fact the clock already established, so it may only be offered
    // once `expires_at` has elapsed.
    const live = actionAvailability("expire", "invited", { invitationElapsed: false });
    expect(live.available).toBe(false);
    expect((live as { reason: string }).reason).toMatch(/has not run out yet/i);
    // IT NAMES THE CONTROL THE ROW ACTUALLY SHOWS. An `invited` row's release
    // control reads "Cancel invitation", so the refusal points there — sending
    // an owner to look for "Release" would name a button that is not on screen.
    expect((live as { reason: string }).reason).toContain(
      actionLabel("release", "invited"),
    );
    expect((live as { reason: string }).reason).toMatch(/cancel invitation/i);

    // Unknown elapsed-ness withholds the control rather than offering one the
    // database would refuse.
    expect(actionAvailability("expire", "invited").available).toBe(false);

    expect(
      actionAvailability("expire", "invited", { invitationElapsed: true }).available,
    ).toBe(true);
  });

  it("expire is never offered where there is no invitation at all", () => {
    for (const s of ["waiting", "claimed", "expired", "released"] as const) {
      const v = actionAvailability("expire", s, { invitationElapsed: true });
      expect(v.available, s).toBe(false);
      expect((v as { reason: string }).reason, s).toMatch(/no invitation/i);
    }
  });

  it("claim is offered only on a waiting entry", () => {
    expect(actionAvailability("claim", "waiting").available).toBe(true);
    for (const s of ["claimed", "invited", "expired", "released"] as const) {
      expect(actionAvailability("claim", s).available, s).toBe(false);
    }
  });

  it("REDEEMED withholds Release, even though the entry is still `invited`", () => {
    // Redemption stamps the invitation and leaves the entry at `invited` until
    // a conversion is recorded, so status alone would keep offering Release for
    // that whole interval — and `release_new_client_waitlist_entry` guards on
    // `redeemed_at is null`, so the control could only ever return
    // `already_redeemed`.
    const live = actionAvailability("release", "invited", { invitationRedeemed: false });
    expect(live.available).toBe(true);

    const used = actionAvailability("release", "invited", { invitationRedeemed: true });
    expect(used.available).toBe(false);
    expect((used as { reason: string }).reason).toMatch(/already been used/i);
  });

  it("REDEEMED also withholds Record expired", () => {
    const used = actionAvailability("expire", "invited", {
      invitationElapsed: true,
      invitationRedeemed: true,
    });
    expect(used.available).toBe(false);
    expect((used as { reason: string }).reason).toMatch(/already been used/i);
  });

  it("UNKNOWN invitation facts withhold Release — unknown is not `not redeemed`", () => {
    // FAILS CLOSED. An unread invitation might be redeemed, and `release` would
    // then answer `already_redeemed`. Treating unknown as "not redeemed" offers
    // a control that cannot succeed.
    const unknown = actionAvailability("release", "invited", {
      invitationFactsUnknown: true,
    });
    expect(unknown.available).toBe(false);
    expect((unknown as { reason: string }).reason).toMatch(/could not be checked/i);

    // NON-VACUITY: known-not-redeemed still offers it.
    expect(
      actionAvailability("release", "invited", { invitationRedeemed: false }).available,
    ).toBe(true);
  });

  it("UNKNOWN invitation facts withhold Record expired too", () => {
    expect(
      actionAvailability("expire", "invited", { invitationFactsUnknown: true }).available,
    ).toBe(false);
  });

  it("Remove is withheld where the command would answer release_required", () => {
    // `remove_new_client_waitlist_entry` refuses a held or invited entry and
    // changes nothing, so offering the confirm disclosure there produces an
    // avoidable error rather than an outcome.
    for (const s of ["claimed", "invited"] as const) {
      const v = actionAvailability("remove", s);
      expect(v.available, s).toBe(false);
      expect((v as { reason: string }).reason, s).toMatch(/release it first/i);
    }
    // …and IS offered everywhere the command accepts it.
    for (const s of ["waiting", "expired", "released"] as const) {
      expect(actionAvailability("remove", s).available, s).toBe(true);
    }
  });

  it("release ends a hold or a live invitation, and nothing else", () => {
    expect(actionAvailability("release", "invited").available).toBe(true);
    expect(actionAvailability("release", "claimed").available).toBe(true);
    for (const s of ["waiting", "expired", "released"] as const) {
      expect(actionAvailability("release", s).available, s).toBe(false);
    }
  });

  it("requeue is refused where they are already queued, with that reason", () => {
    const v = actionAvailability("requeue", "waiting");
    expect(v.available).toBe(false);
    expect((v as { reason: string }).reason).toMatch(/already in the queue/i);
    expect(actionAvailability("requeue", "released").available).toBe(true);
    expect(actionAvailability("requeue", "expired").available).toBe(true);
  });

  it("a closed entry offers nothing, and says which kind of closed it is", () => {
    for (const action of ADMISSION_ACTIONS) {
      const booked = actionAvailability(action, "converted");
      const removed = actionAvailability(action, "removed");
      expect(booked.available, action).toBe(false);
      expect(removed.available, action).toBe(false);
      expect((booked as { reason: string }).reason).toMatch(/already booked/i);
      expect((removed as { reason: string }).reason).toMatch(/removed/i);
      // The two closures are distinguishable, not one generic refusal.
      expect((booked as { reason: string }).reason).not.toBe(
        (removed as { reason: string }).reason,
      );
    }
  });

  it("every action carries the label the page renders", () => {
    for (const action of ADMISSION_ACTIONS) {
      expect(ACTION_LABEL[action], action).toBeTruthy();
    }
  });
});

describe("the status sentence never contradicts the row's own controls", () => {
  it("a REDEEMED invited entry is not described as unused", () => {
    // `redeem` leaves the entry at `invited` until conversion is recorded, so a
    // status-only sentence would say "has not yet been used" precisely while
    // the controls have correctly recognised it as used.
    const used = statusMeaning("invited", { invitationRedeemed: true });
    expect(used).toMatch(/has been used/i);
    expect(used).not.toMatch(/not yet been used/i);
  });

  it("an ELAPSED invitation says so", () => {
    expect(statusMeaning("invited", { invitationElapsed: true })).toMatch(/ran out/i);
  });

  it("UNKNOWN says it could not be checked, and claims nothing else", () => {
    const unknown = statusMeaning("invited", { invitationFactsUnknown: true });
    expect(unknown).toMatch(/could not be checked/i);
    expect(unknown).not.toMatch(/has been used|not yet been used|ran out/i);
  });

  it("a live invitation keeps the plain sentence", () => {
    expect(statusMeaning("invited", { invitationRedeemed: false })).toMatch(
      /has not yet been used/i,
    );
  });

  it("the no-context default is NEUTRAL, so it cannot be wrong", () => {
    // Callers without invitation facts must not assert usage either way.
    expect(STATUS_MEANING.invited).not.toMatch(/used/i);
  });

  it("every other status is unchanged by context", () => {
    for (const s of WAITLIST_ENTRY_STATUSES) {
      if (s === "invited") continue;
      expect(statusMeaning(s, { invitationRedeemed: true }), s).toBe(STATUS_MEANING[s]);
    }
  });
});
