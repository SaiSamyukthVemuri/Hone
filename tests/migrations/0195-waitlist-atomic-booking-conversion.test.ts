import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileForVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// 0195 — WAIT-03 atomic invitation booking + conversion.
//
// SOURCE CONTRACT ONLY. Behaviour is proved against a real database in
// tests/db/waitlist-atomic-booking-conversion.db.test.ts; this file pins the
// properties that are decidable from the migration text.

const ROOT = path.resolve(__dirname, "../..");
const VERSION = "0195";
const FILE = fileForVersion(VERSION);
const SQL = readFileSync(path.join(ROOT, "supabase/migrations", FILE), "utf8");

/** Comment-stripped, so a rule NAMED in prose never satisfies an assertion. */
const CODE = SQL.replace(/^\s*--.*$/gm, " ");

describe("0195 position in the chain", () => {
  it("is the repository maximum", () => {
    // Per CLAUDE.md only the CURRENT max asserts this, so a future migration
    // does not turn this file red. Whoever adds 0196 moves it.
    expect(isRepoMax(VERSION)).toBe(true);
  });

  it("has nothing above it", () => {
    expect(versionsAbove(VERSION)).toEqual([]);
  });
});

describe("transaction and lock posture", () => {
  it("opens its own transaction and bounds the lock", () => {
    // `supabase db push` does not wrap a file in a transaction, so a bare
    // SET LOCAL emits 25P01 and never arms.
    expect(CODE).toMatch(/^begin;/m);
    expect(CODE).toMatch(/^commit;/m);
    expect(CODE).toMatch(/set local lock_timeout/);
  });
});

describe("it composes the existing authorities and redefines neither", () => {
  it("calls both shipped commands", () => {
    expect(CODE).toMatch(/from public\.create_public_appointment\(/);
    expect(CODE).toMatch(/public\.record_new_client_waitlist_conversion\(/);
  });

  it("does NOT redefine create_public_appointment or the conversion command", () => {
    expect(CODE).not.toMatch(
      /create\s+or\s+replace\s+function\s+public\.create_public_appointment\s*\(/,
    );
    expect(CODE).not.toMatch(
      /create\s+or\s+replace\s+function\s+public\.record_new_client_waitlist_conversion\s*\(/,
    );
  });

  it("changes no foreign key, trigger, constraint or existing grant", () => {
    expect(CODE).not.toMatch(/\bdrop\s+(constraint|trigger)\b/i);
    expect(CODE).not.toMatch(/\balter\s+table\b/i);
    expect(CODE).not.toMatch(/\bcreate\s+trigger\b/i);
  });
});

describe("the measured lock policy is present and in order", () => {
  it("takes the studio as NO KEY UPDATE, never FOR UPDATE", () => {
    // FOR UPDATE would block the KEY SHARE that the entry-event trigger's FK
    // insert needs — the measured 40P01. 0193 chose the same mode for the same
    // reason.
    expect(CODE).toMatch(
      /perform\s+1\s+from\s+public\.studios\s+where\s+id\s*=\s*p_studio_id\s+for\s+no\s+key\s+update;/,
    );
    const studioLocks = CODE.match(/from\s+public\.studios[\s\S]{0,120}?for\s+(no key )?update/gi) ?? [];
    for (const l of studioLocks) expect(l.toLowerCase()).toContain("no key update");
  });

  it("takes the target entry BEFORE create_public_appointment runs", () => {
    const entryLock = CODE.search(/from\s+public\.new_client_waitlist_entries[\s\S]{0,120}?for\s+update;/i);
    const apptCall = CODE.search(/from\s+public\.create_public_appointment\(/);
    expect(entryLock).toBeGreaterThan(-1);
    expect(apptCall).toBeGreaterThan(-1);
    // Without this order the transaction holds the studio FOR UPDATE (taken
    // inside create_public_appointment) and only then wants the entry, while a
    // concurrent conversion holds the entry and waits for its studio KEY SHARE.
    expect(entryLock).toBeLessThan(apptCall);
  });

  it("locks the studio before the entry", () => {
    expect(CODE.search(/public\.studios/)).toBeLessThan(
      CODE.search(/from\s+public\.new_client_waitlist_entries/i),
    );
  });
});

describe("the conversion is bound to the redeemed recipient", () => {
  // An independent review found the command took p_client_id on trust: the
  // downstream conversion checks only that the client is in the same STUDIO,
  // which is not the same PERSON. These pin the repair in the source; the
  // behaviour itself is proved in the .db suite.

  it("compares the two generated normalized-email columns, and invents no rule", () => {
    expect(CODE).toMatch(/e\.email_normalized/);
    expect(CODE).toMatch(/c\.normalized_email/);
    // No hand-rolled normalization and no name-based identity.
    expect(CODE).not.toMatch(/lower\s*\(\s*(btrim|trim)\s*\(/i);
    expect(CODE).not.toMatch(/\bc\.name\b/);
  });

  it("scopes BOTH the entry and the client by studio", () => {
    expect(CODE).toMatch(
      /from\s+public\.new_client_waitlist_entries\s+e\s+where\s+e\.id\s*=\s*p_entry_id\s+and\s+e\.studio_id\s*=\s*p_studio_id/i,
    );
    expect(CODE).toMatch(
      /from\s+public\.clients\s+c\s+where\s+c\.id\s*=\s*p_client_id\s+and\s+c\.studio_id\s*=\s*p_studio_id/i,
    );
  });

  it("inspects FOUND rather than discarding the lookup", () => {
    // The original used PERFORM for the entry and never checked FOUND, so the
    // guard read as a tenancy check while enforcing nothing.
    expect(CODE).not.toMatch(/perform\s+1\s+from\s+public\.new_client_waitlist_entries/i);
    expect((CODE.match(/if\s+not\s+found\s+then/gi) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("takes the bound client FOR SHARE — not KEY SHARE, which would not block an email change", () => {
    expect(CODE).toMatch(/from\s+public\.clients\s+c[\s\S]{0,160}?for\s+share;/i);
    expect(CODE).not.toMatch(/from\s+public\.clients[\s\S]{0,160}?for\s+key\s+share/i);
  });

  it("enforces the binding BEFORE any appointment work", () => {
    const mismatch = CODE.search(/recipient_mismatch/);
    const apptCall = CODE.search(/from\s+public\.create_public_appointment\(/);
    expect(mismatch).toBeGreaterThan(-1);
    expect(apptCall).toBeGreaterThan(-1);
    expect(mismatch).toBeLessThan(apptCall);
  });

  it("locks the client AFTER the entry, keeping one global order", () => {
    const entryLock = CODE.search(/from\s+public\.new_client_waitlist_entries\s+e/i);
    const clientLock = CODE.search(/from\s+public\.clients\s+c/i);
    expect(entryLock).toBeGreaterThan(-1);
    expect(clientLock).toBeGreaterThan(entryLock);
  });

  it("refuses through closed result codes, never raw database text", () => {
    for (const code of ["entry_not_found", "client_not_found", "recipient_mismatch"]) {
      expect(CODE).toContain(`'${code}'::text`);
    }
  });

});

describe("the booking is held to the invitation's stored offer scope", () => {
  // THIS REPLACES A FALSE ASSERTION. The previous version pinned that 0195 made
  // NO scope claim, on the reading that the schema had no authority to check
  // against. That reading came from 0188's CREATE TABLE; 0192 §2 ALTERs the same
  // table and adds the scope columns. The contract below is the real one.

  it("re-reads all four scope columns from 0192", () => {
    for (const col of [
      "scope_service_id", "scope_start_date", "scope_end_date", "scope_allowed_weekdays",
    ]) {
      expect(CODE).toContain(col);
    }
  });

  it("selects the invitation by REDEEMED state, not by ordering", () => {
    // A `latest row` heuristic would silently enforce the wrong permission.
    expect(CODE).toMatch(/redeemed_at\s+is\s+not\s+null/i);
    expect(CODE).not.toMatch(/order\s+by[\s\S]{0,60}\blimit\b/i);
  });

  it("refuses an ambiguous history instead of choosing a row", () => {
    expect(CODE).toContain("'scope_ambiguous'::text");
    expect(CODE).toMatch(/v_scope_count\s*>\s*1/);
  });

  it("refuses when ZERO redeemed invitations are visible", () => {
    expect(CODE).toMatch(/v_scope_count\s*=\s*0/);
    expect(CODE).toContain("'not_redeemed'::text");
  });

  it("ORDERS the guards ahead of appointment work — the READ COMMITTED contract", () => {
    // Executable source only: CODE is comment-stripped, so prose cannot satisfy
    // this. If the zero-count guard is ever deleted or moved below the booking,
    // this goes red — which is the point. Falling through on zero lets a
    // redemption that commits AFTER this read reach a conversion whose scope was
    // never checked.
    const scopeSelect = CODE.search(/select\s+count\(\*\)::int\s+into\s+v_scope_count/i);
    const zeroGuard   = CODE.search(/v_scope_count\s*=\s*0/);
    const ambiguity   = CODE.search(/v_scope_count\s*>\s*1/);
    const scopeCheck  = CODE.search(/v_scope_svc\s+is\s+not\s+null/i);
    const apptCall    = CODE.search(/from\s+public\.create_public_appointment\(/);

    for (const [label, at] of Object.entries({ scopeSelect, zeroGuard, ambiguity, scopeCheck, apptCall })) {
      expect(at, `${label} not found in executable source`).toBeGreaterThan(-1);
    }
    expect(scopeSelect).toBeLessThan(zeroGuard);
    expect(zeroGuard).toBeLessThan(ambiguity);
    expect(ambiguity).toBeLessThan(scopeCheck);
    expect(scopeCheck).toBeLessThan(apptCall);
  });

  it("returns the zero-count refusal rather than falling through", () => {
    // A bare `if v_scope_count = 0 then ... end if;` with no RETURN would order
    // correctly and still be wrong.
    const zero = CODE.search(/v_scope_count\s*=\s*0/);
    const appt = CODE.search(/from\s+public\.create_public_appointment\(/);
    const between = CODE.slice(zero, appt);
    expect(between).toMatch(/'not_redeemed'::text[\s\S]{0,200}?\breturn\s*;/);
  });

  it("treats an all-null (legacy) scope as unscoped, via the all-or-nothing CHECK", () => {
    expect(CODE).toMatch(/v_scope_svc\s+is\s+not\s+null/i);
  });

  it("judges the day in STUDIO-LOCAL time, the same direction as 0170", () => {
    expect(CODE).toMatch(/p_starts_at\s+at\s+time\s+zone\s+v_tz/i);
    expect(CODE).toMatch(/v_local_start::date/i);
    // NULL instant or timezone must refuse, not compare as in-range.
    expect(CODE).toMatch(/v_local_date\s+is\s+null/i);
  });

  it("uses an INCLUSIVE range and 0=Sunday weekdays, only when weekdays are set", () => {
    expect(CODE).toMatch(/v_local_date\s*<\s*v_scope_from/);
    expect(CODE).toMatch(/v_local_date\s*>\s*v_scope_to/);
    expect(CODE).toMatch(/extract\s*\(\s*dow\s+from\s+v_local_start\s*\)/i);
    expect(CODE).toMatch(/v_scope_dows\s+is\s+not\s+null/i);
  });

  it("enforces scope BEFORE any appointment work, with closed codes", () => {
    const apptCall = CODE.search(/from\s+public\.create_public_appointment\(/);
    for (const code of [
      "scope_service_not_offered", "scope_date_out_of_range", "scope_weekday_not_allowed",
    ]) {
      expect(CODE).toContain(`'${code}'::text`);
      expect(CODE.search(new RegExp(code))).toBeLessThan(apptCall);
    }
  });

  it("invents no exact-slot restriction and no new scope storage", () => {
    expect(CODE).not.toMatch(/scope_starts_at|scope_slot|offered_starts_at/);
  });

  it("adds no lock for the scope read — a redeemed scope is immutable", () => {
    // 0192 stamps scope only on rows that are still live, so the established
    // lock policy does not change. If that ever stops being true, this
    // assertion should be replaced by a lock and a race proof — not deleted.
    expect(CODE).not.toMatch(
      /from\s+public\.new_client_waitlist_invitations[\s\S]{0,200}?for\s+(update|share|no\s+key\s+update)/i,
    );
  });
});

describe("rollback is raised, not returned", () => {
  it("uses a private sentinel distinct from 0193's WA001", () => {
    expect(CODE).toMatch(/errcode\s*=\s*'WA002'/);
    expect(CODE).not.toMatch(/errcode\s*=\s*'WA001'/);
  });

  it("raises on a conversion refusal rather than returning", () => {
    // A plain RETURN would leave the appointment inserts in the transaction.
    expect(CODE).toMatch(/raise\s+exception\s+'conversion:%'[\s\S]{0,80}WA002/);
  });

  it("converts the sentinel back into a closed result", () => {
    expect(CODE).toMatch(/when\s+sqlstate\s+'WA002'\s+then/);
    expect(CODE).toMatch(/SQLERRM::text/);
  });
});

describe("grants", () => {
  const SIG = "uuid, uuid, uuid, timestamptz, text, uuid, text, text";
  for (const role of ["public", "anon", "authenticated", "service_role"]) {
    it(`revokes execute from ${role} by name`, () => {
      // Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon,
      // authenticated AND service_role at create time — the omission that
      // shipped in 0129 (anon) and again in 0164 (service_role).
      expect(CODE).toContain(
        `revoke execute on function public.create_waitlist_public_appointment(${SIG}) from ${role};`,
      );
    });
  }

  it("grants execute to service_role only", () => {
    expect(CODE).toContain(
      `grant  execute on function public.create_waitlist_public_appointment(${SIG}) to service_role;`,
    );
    expect(CODE).not.toMatch(/grant\s+execute[\s\S]{0,160}to\s+(anon|authenticated)\b/);
  });

  it("is security definer with a pinned search_path", () => {
    expect(CODE).toMatch(/security definer/);
    expect(CODE).toMatch(/set search_path = pg_catalog, pg_temp/);
  });
});
