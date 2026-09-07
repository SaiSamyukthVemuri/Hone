import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ACTION_LABEL,
  ADMISSION_ACTIONS,
  STATUS_LABEL,
  STATUS_MEANING,
  WAITLIST_ENTRY_STATUSES,
  actionAvailability,
  statusMeaning,
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
// the brief-vocabulary map — is NOT here. It reaches no server action and lives
// in lib/waitlist/b4-invitation-draft.ts, proved by its own file.

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
    expect((live as { reason: string }).reason).toMatch(/release/i);

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
