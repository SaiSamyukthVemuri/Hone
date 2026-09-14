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

  it("does not pretend to enforce a booking scope the schema cannot express", () => {
    // new_client_waitlist_invitations records no offered service and no offered
    // slot, so there is nothing to check against. If a future migration adds
    // one, this assertion should be replaced by a real check — not deleted.
    expect(CODE).not.toMatch(/offered_service_id|offered_starts_at/);
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
