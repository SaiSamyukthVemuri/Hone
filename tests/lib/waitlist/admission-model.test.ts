import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ACTION_LABEL,
  ADMISSION_ACTIONS,
  BRIEF_LABEL_MAP,
  NEXT_N_IS_NOT_SELECTION,
  PENDING_B2_NOTICE,
  STATUS_LABEL,
  STATUS_MEANING,
  STEP_BACKING,
  TTL_HOURS_DEFAULT,
  TTL_HOURS_MAX,
  TTL_HOURS_MIN,
  UNMODELLED_BRIEF_STATES,
  WAITLIST_ENTRY_STATUSES,
  actionAvailability,
  allActionAvailability,
  emptyDraft,
  reviewSummary,
  validateDraft,
  validateTtlHours,
  type WaitlistEntryStatus,
} from "@/lib/waitlist/admission-model";

// ===========================================================================
// WAIT-03 B4 — the admission UI state model
// ===========================================================================
//
// This model is fixture-driven and pre-B2, so the ONE thing that can make it
// dishonest is drifting from the shipped database. The first block therefore
// derives the lifecycle vocabulary FROM THE MIGRATION rather than comparing two
// hand-written lists — a list that certifies itself proves nothing.

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
    expect(UNMODELLED_BRIEF_STATES).toContain("declined");
  });

  it("the brief's words map onto real states, and `revoked` is not collapsed", () => {
    for (const shipped of Object.values(BRIEF_LABEL_MAP)) {
      expect(WAITLIST_ENTRY_STATUSES).toContain(shipped);
    }
    // `released` and `removed` are both studio-initiated returns and are NOT
    // synonyms — one is requeueable, the other terminal.
    expect(BRIEF_LABEL_MAP.revoked).toBe("released");
    expect(STATUS_MEANING.released).not.toBe(STATUS_MEANING.removed);
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

  it("invite is offered exactly where an entry can receive a first invitation", () => {
    expect(actionAvailability("invite", "waiting").available).toBe(true);
    expect(actionAvailability("invite", "claimed").available).toBe(true);
    expect(actionAvailability("invite", "invited").available).toBe(false);
    expect(actionAvailability("invite", "expired").available).toBe(false);
  });

  it("a live invitation must be RELEASED before another is sent", () => {
    const invite = actionAvailability("invite", "invited");
    const reinvite = actionAvailability("reinvite", "invited");
    expect(invite.available).toBe(false);
    expect(reinvite.available).toBe(false);
    // Both name the remedy rather than merely refusing — and the remedy is
    // RELEASE, which is the command that ends a live invitation early. It is
    // deliberately not "expire": expiry records that the clock ran out, it does
    // not cause it, so offering it here would name an action that cannot run.
    expect((invite as { reason: string }).reason).toMatch(/release/i);
    expect((reinvite as { reason: string }).reason).toMatch(/release/i);
    expect((invite as { reason: string }).reason).not.toMatch(/expire/i);
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

  it("reinvite is offered only where a previous invitation is no longer live", () => {
    expect(actionAvailability("reinvite", "expired").available).toBe(true);
    expect(actionAvailability("reinvite", "released").available).toBe(true);
    expect(actionAvailability("reinvite", "waiting").available).toBe(false);
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

  it("the menu lists every action WITH its verdict, hiding none", () => {
    for (const status of WAITLIST_ENTRY_STATUSES) {
      const menu = allActionAvailability(status);
      expect(menu.map((m) => m.action)).toEqual([...ADMISSION_ACTIONS]);
      for (const item of menu) expect(item.label).toBe(ACTION_LABEL[item.action]);
    }
  });
});

describe("expiry is the one draft field the server actually carries", () => {
  it("mirrors the command's bounds", () => {
    // 0188: "1 hour .. 7 days. Out of range is REFUSED, never silently clamped".
    expect(MIGRATION).toMatch(/1 hour \.\. 7 days/);
    expect(TTL_HOURS_MIN).toBe(1);
    expect(TTL_HOURS_MAX).toBe(168);
    expect(MIGRATION).toMatch(/p_ttl_hours\s+integer\s+default\s+72/);
    expect(TTL_HOURS_DEFAULT).toBe(72);
  });

  it("REFUSES out of range rather than clamping", () => {
    for (const bad of [0, -1, 169, 1000]) {
      const v = validateTtlHours(bad);
      expect(v.ok, String(bad)).toBe(false);
    }
    // The refusal must not quietly hand back a corrected number.
    const over = validateTtlHours(1000);
    expect(over).not.toHaveProperty("hours");
  });

  it("accepts the boundaries themselves", () => {
    expect(validateTtlHours(TTL_HOURS_MIN)).toEqual({ ok: true, hours: 1 });
    expect(validateTtlHours(TTL_HOURS_MAX)).toEqual({ ok: true, hours: 168 });
  });

  it("rejects non-integers and junk", () => {
    for (const bad of [1.5, "abc", "", null, undefined, NaN]) {
      expect(validateTtlHours(bad as unknown).ok, String(bad)).toBe(false);
    }
    expect(validateTtlHours(" 48 ")).toEqual({ ok: true, hours: 48 });
  });
});

describe("the draft never pretends unbacked intent will be enforced", () => {
  it("declares which steps reach a server contract", () => {
    expect(STEP_BACKING.select).toBe("server-backed");
    expect(STEP_BACKING.expiry).toBe("server-backed");
    // No shipped command carries any of these.
    expect(STEP_BACKING.service).toBe("pending-b2");
    expect(STEP_BACKING.horizon).toBe("pending-b2");
    expect(STEP_BACKING.days).toBe("pending-b2");
  });

  it("and the migration agrees — no such parameters exist", () => {
    const issue = MIGRATION.slice(
      MIGRATION.indexOf("function public.issue_new_client_waitlist_invitation"),
      MIGRATION.indexOf("returns table (result text, raw_token text"),
    );
    expect(issue.length).toBeGreaterThan(40);
    expect(issue).toMatch(/p_ttl_hours/);
    for (const absent of ["p_service", "p_horizon", "p_weekday", "p_date"]) {
      expect(issue, `${absent} unexpectedly present`).not.toMatch(new RegExp(absent));
    }
  });

  it("an unbacked field can never block a send", () => {
    // Blocking on it would invent a requirement the server does not have.
    const draft = { ...emptyDraft(), entryIds: ["e1"], serviceId: null, horizonDays: null };
    expect(validateDraft(draft).ok).toBe(true);
  });

  it("but a nonsense unbacked value is still refused", () => {
    const bad = { ...emptyDraft(), entryIds: ["e1"], horizonDays: 0 };
    const v = validateDraft(bad);
    expect(v.ok).toBe(false);
    expect((v as { errors: Record<string, string> }).errors.horizon).toBeTruthy();
  });

  it("a server-backed field DOES block a send", () => {
    expect(validateDraft(emptyDraft()).ok).toBe(false);
    const noTtl = { ...emptyDraft(), entryIds: ["e1"], ttlHours: 9999 };
    const v = validateDraft(noTtl);
    expect(v.ok).toBe(false);
    expect((v as { errors: Record<string, string> }).errors.expiry).toBeTruthy();
  });

  it("review separates what WILL happen from what is only noted", () => {
    const draft = {
      ...emptyDraft(),
      entryIds: ["e1", "e2"],
      ttlHours: 48,
      serviceId: "svc-1",
      horizonDays: 30,
      weekdays: [2, 4],
      dates: ["2026-09-10"],
    };
    const { enforced, notEnforced } = reviewSummary(draft);
    expect(enforced.join(" ")).toMatch(/2 people/);
    expect(enforced.join(" ")).toMatch(/48 hours/);
    // Everything unbacked is in the OTHER list, never mixed into `enforced`.
    expect(notEnforced).toHaveLength(4);
    for (const line of enforced) {
      expect(line).not.toMatch(/service|window|days of the week|specific dates/i);
    }
  });

  it("the not-enforced notice says so in words", () => {
    expect(PENDING_B2_NOTICE).toMatch(/not yet enforced/i);
  });

  it("a draft with only backed fields produces NO not-enforced lines", () => {
    // Non-vacuity for the split above.
    const { notEnforced } = reviewSummary({ ...emptyDraft(), entryIds: ["e1"] });
    expect(notEnforced).toEqual([]);
  });
});

describe("invite-next-N is a different operation from multi-select", () => {
  it("is recorded as such, and the bulk command takes a COUNT", () => {
    expect(NEXT_N_IS_NOT_SELECTION).toBe(true);
    // The end marker must be searched FROM the start marker: the same `returns
    // table` signature appears earlier in the file for `join_new_client_waitlist`,
    // so a bare indexOf returns a position BEFORE the slice begins and yields "".
    const from = MIGRATION.indexOf("function public.claim_new_client_waitlist_entries");
    expect(from).toBeGreaterThan(-1);
    const bulk = MIGRATION.slice(
      from,
      MIGRATION.indexOf("returns table (result text, entry_id uuid)", from),
    );
    expect(bulk.length).toBeGreaterThan(40);
    expect(bulk).toMatch(/p_count\s+integer/);
    // It does NOT accept a list of ids — so "these five" and "the next five"
    // cannot be one control without the UI choosing queue order itself.
    expect(bulk).not.toMatch(/uuid\[\]/);
  });

  it("this slice implements no ranking of its own", () => {
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
