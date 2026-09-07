import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  ADMISSION_ACTIONS,
  ACTION_LABEL,
  STATUS_MEANING,
  WAITLIST_ENTRY_STATUSES,
  actionAvailability,
} from "@/lib/waitlist/admission-model";
import {
  BRIEF_LABEL_MAP,
  B4_ACTION_LABEL,
  B4_INVITATION_ACTIONS,
  B4_MENU_ACTIONS,
  B4_MENU_LABEL,
  NEXT_N_IS_NOT_SELECTION,
  PENDING_B2_NOTICE,
  STEP_BACKING,
  TTL_HOURS_DEFAULT,
  TTL_HOURS_MAX,
  TTL_HOURS_MIN,
  UNMODELLED_BRIEF_STATES,
  allActionAvailability,
  emptyDraft,
  invitationActionAvailability,
  reviewSummary,
  validateDraft,
  validateTtlHours,
} from "@/lib/waitlist/b4-invitation-draft";

// ===========================================================================
// WAIT-03 B4 — INVITATION DRAFTING, THE HALF NOTHING IS WIRED TO
// ===========================================================================
//
// Split out of the admission model so that the live operator queue and the
// unwired prototype can be reviewed, and shipped, separately. Everything here
// describes a send that cannot happen yet, so the ONE thing that can make it
// dishonest is drifting from the shipped database — the assertions therefore
// derive from the migration rather than comparing two hand-written lists.
//
// The reachability guard at the end is the reason the split exists: if any file
// under `app/` ever imports this module, an operator surface has begun offering
// an action no server action carries.

const ROOT = process.cwd();

const MIGRATION = readFileSync(
  join(ROOT, "supabase/migrations/0188_new_client_waitlist_invitations.sql"),
  "utf8",
);

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

describe("this module is UNREACHABLE from the application", () => {
  it("no file under app/ imports it, directly or by alias", () => {
    const files = walk("app");
    // Non-vacuity: the walk must actually be finding the application.
    expect(files.length).toBeGreaterThan(20);

    const importers = files.filter((rel) =>
      /b4-invitation-draft/.test(readFileSync(join(ROOT, rel), "utf8")),
    );
    expect(
      importers,
      "an app/ surface now reaches invitation drafting, which no server action carries",
    ).toEqual([]);

    // NON-VACUITY for the search itself: the LIVE model IS imported by app/, so
    // a scan that found nothing anywhere would be broken rather than reassuring.
    const liveImporters = files.filter((rel) =>
      /waitlist\/admission-model/.test(readFileSync(join(ROOT, rel), "utf8")),
    );
    expect(liveImporters.length).toBeGreaterThan(0);
  });

  it("the live model no longer carries either sending action", () => {
    // The split's whole point: an unwired action cannot be offered by a surface
    // that only knows about wired ones.
    for (const sending of B4_INVITATION_ACTIONS) {
      expect(ADMISSION_ACTIONS as ReadonlyArray<string>).not.toContain(sending);
    }
  });
});

describe("the brief's vocabulary, and where it disagrees with the database", () => {
  it("`declined` is recorded as unmodelled, because the database has no such concept", () => {
    // 0188 contains no `declin*` token at all: a prospect cannot decline and
    // nothing records that they did. Modelling it would invent a fact the
    // system cannot hold.
    expect(MIGRATION.toLowerCase()).not.toMatch(/declin/);
    expect(UNMODELLED_BRIEF_STATES).toContain("declined");
    expect(Object.keys(BRIEF_LABEL_MAP)).not.toContain("declined");
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

describe("inviting is decided AND explained, on every state", () => {
  it("an unavailable sending action always carries an actionable reason", () => {
    for (const status of WAITLIST_ENTRY_STATUSES) {
      for (const action of B4_INVITATION_ACTIONS) {
        const verdict = invitationActionAvailability(action, status);
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

  it("NON-VACUITY — sending really is available somewhere", () => {
    const available = WAITLIST_ENTRY_STATUSES.flatMap((s) =>
      B4_INVITATION_ACTIONS.filter((a) => invitationActionAvailability(a, s).available),
    );
    expect(available.length).toBeGreaterThan(0);
  });

  it("INVITING REQUIRES `claimed`, and only claimed", () => {
    // 0190: `if v_status <> 'claimed' then return 'not_claimed'`. A merely
    // WAITING entry cannot be invited — offering it would be a control that
    // cannot succeed — and the refusal names the missing step.
    expect(invitationActionAvailability("invite", "claimed").available).toBe(true);
    for (const s of ["waiting", "invited", "expired", "released"] as const) {
      expect(invitationActionAvailability("invite", s).available, s).toBe(false);
    }
    expect(
      (invitationActionAvailability("invite", "waiting") as { reason: string }).reason,
    ).toMatch(/claim them first/i);
  });

  it("a live invitation must be RELEASED before another is sent", () => {
    const invite = invitationActionAvailability("invite", "invited");
    const reinvite = invitationActionAvailability("reinvite", "invited");
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

  it("reinvite carries the SAME prerequisite, and names the path back", () => {
    // Re-inviting IS `issue` again, so it needs a claimed entry too. An expired
    // or released one has to travel back: requeue, then claim.
    expect(invitationActionAvailability("reinvite", "claimed").available).toBe(true);
    for (const s of ["waiting", "invited", "expired", "released"] as const) {
      expect(invitationActionAvailability("reinvite", s).available, s).toBe(false);
    }
    for (const s of ["expired", "released"] as const) {
      expect(
        (invitationActionAvailability("reinvite", s) as { reason: string }).reason,
        s,
      ).toMatch(/return them to the queue and claim them first/i);
    }
  });

  it("a refusal names a LIVE action by its live label, never a stale copy", () => {
    // The two modules must agree on what the operator's next step is called.
    // A second hard-coded "Claim" here is exactly the drift the split risks.
    expect(
      (invitationActionAvailability("invite", "waiting") as { reason: string }).reason,
    ).toContain(ACTION_LABEL.claim);
  });

  it("a closed entry offers nothing, and says which kind of closed it is", () => {
    for (const action of B4_INVITATION_ACTIONS) {
      const booked = invitationActionAvailability(action, "converted");
      const removed = invitationActionAvailability(action, "removed");
      expect(booked.available, action).toBe(false);
      expect(removed.available, action).toBe(false);
      expect((booked as { reason: string }).reason).toMatch(/already booked/i);
      expect((removed as { reason: string }).reason).toMatch(/removed/i);
      expect((booked as { reason: string }).reason).not.toBe(
        (removed as { reason: string }).reason,
      );
    }
  });

  it("PROVES THE PROBE — a closed entry's refusal is action-INDEPENDENT", () => {
    // `invitationActionAvailability` asks the live model about `claim` to get a
    // closed entry's refusal rather than keeping a second copy of the sentence.
    // That is only sound while every live action answers identically, so this
    // asserts the premise instead of assuming it. If a future live action grows
    // its own closed-entry copy, this fails and the delegation must change.
    for (const status of ["converted", "removed"] as const) {
      const verdicts = ADMISSION_ACTIONS.map((a) => actionAvailability(a, status));
      for (const v of verdicts) {
        expect(v, `${status} must refuse every live action`).toEqual(verdicts[0]);
      }
      // …and the B4 answer IS that answer, not a lookalike.
      for (const action of B4_INVITATION_ACTIONS) {
        expect(invitationActionAvailability(action, status)).toEqual(verdicts[0]);
      }
    }
  });
});

describe("the composed menu covers both halves, hiding neither", () => {
  it("lists every LIVE action and every SENDING action, exactly once", () => {
    // DERIVED, not hand-copied: a sixth live action must appear here without
    // anyone remembering to add it, which is the failure this pins.
    expect([...B4_MENU_ACTIONS].sort()).toEqual(
      [...ADMISSION_ACTIONS, ...B4_INVITATION_ACTIONS].sort(),
    );
    expect(new Set(B4_MENU_ACTIONS).size).toBe(B4_MENU_ACTIONS.length);
    // Sending sits immediately after its prerequisite, which is claiming.
    expect(B4_MENU_ACTIONS[0]).toBe("claim");
    expect(B4_MENU_ACTIONS.slice(1, 3)).toEqual([...B4_INVITATION_ACTIONS]);
  });

  it("labels every action from the module that owns it", () => {
    for (const action of ADMISSION_ACTIONS) {
      expect(B4_MENU_LABEL[action], action).toBe(ACTION_LABEL[action]);
    }
    for (const action of B4_INVITATION_ACTIONS) {
      expect(B4_MENU_LABEL[action], action).toBe(B4_ACTION_LABEL[action]);
    }
  });

  it("the menu lists every action WITH its verdict, hiding none", () => {
    for (const status of WAITLIST_ENTRY_STATUSES) {
      const menu = allActionAvailability(status);
      expect(menu.map((m) => m.action)).toEqual([...B4_MENU_ACTIONS]);
      for (const item of menu) expect(item.label).toBe(B4_MENU_LABEL[item.action]);
    }
  });

  it("CONTEXT REACHES THE LIVE ACTIONS, which is the only half that reads it", () => {
    // Release on an `invited` entry is offered or withheld by the invitation
    // facts, so the composed menu must be passing context through rather than
    // dropping it on the way.
    const live = allActionAvailability("invited", { invitationRedeemed: false });
    const used = allActionAvailability("invited", { invitationRedeemed: true });
    expect(live.find((m) => m.action === "release")!.available).toBe(true);
    expect(used.find((m) => m.action === "release")!.available).toBe(false);
    // Sending is decided by status alone, so it does NOT move with context.
    expect(live.find((m) => m.action === "invite")).toEqual(
      used.find((m) => m.action === "invite"),
    );
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

  it("this module implements no ranking of its own", () => {
    // COMMENTS OUT BEFORE SCANNING. This module explains at length why it does
    // NOT rank, so scanning the raw text finds the word "ranking" in the very
    // prose that promises the absence — a parser reading documentation as code.
    const SRC = readFileSync(
      join(process.cwd(), "lib/waitlist/b4-invitation-draft.ts"),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // Ordering is the database's existing FIFO. Nothing here re-sorts a queue.
    expect(SRC).not.toMatch(/\.sort\(|\brank\b|\bscore\b|\bpriority\b/i);
    // Non-vacuity: the stripped source is still real code, not an empty string.
    expect(SRC).toMatch(/export function invitationActionAvailability/);
  });
});
