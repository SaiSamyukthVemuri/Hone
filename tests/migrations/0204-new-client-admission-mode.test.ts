import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { migrationState } from "./helpers/migration-state";

const VERSION = "0204";

/** The sha256 of the bytes applied to production on 2026-10-01. */
const APPLIED_SHA256 =
  "186fa6cb3154c85d2987f1e75aeee6f7361004f1b535cc44a46a27f96b4db219";

const SQL = readFileSync(
  path.resolve(__dirname, "../../supabase/migrations/0204_new_client_admission_mode.sql"),
  "utf8",
);

/**
 * Executable SQL only.
 *
 * The header explains what this migration deliberately does NOT touch, naming
 * those tables to do so. An absence assertion read over the comments would fail
 * on the sentence promising the absence - so the statements are read alone.
 */
const STATEMENTS = SQL.split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");

// NEW-CLIENT-MODE-01 — source contract for 0204.
//
// A live-database proof of the guard belongs in tests/db; this file pins the
// structure that proof would exercise, so a reviewer can see the contract
// without a database and a silent removal fails here first.

describe("0204 is APPLIED, and holds the HOSTED equality claim", () => {
  it("hosted equals 0204, and the repo has moved above it (migration-first pending)", () => {
    // THE HOSTED EQUALITY STAYS HERE, and that is the half this file owns.
    // Exactly one file may hold it; after the 2026-10-01 apply this is that
    // file, and 0203 was narrowed to a floor in the same change. Nothing in
    // this branch applies anything, so hosted is STILL 0204 and this claim is
    // still exactly true. WHOEVER APPLIES 0205 MOVES IT: narrow 0204 to a floor
    // and let the new head take the equality.
    //
    // WHAT CHANGED IS ONLY THE REPO SIDE. This block also pinned
    // `repo_migration_max`, `repo_equals_hosted`, the whole pending list and the
    // next free number to the PARITY shape — and a branch that authors the next
    // migration is not at parity, it is at MIGRATION-FIRST PENDING, which is the
    // ordinary pre-apply position rather than drift. Pinning parity made this
    // file red for a migration it says nothing about, which is the "trip on the
    // next one" pin CLAUDE.md s2 forbids and the eighteen-file sweep that took
    // 0163, 0164 and 0165 red after push.
    //
    // So the repo side is asserted as the RELATION, which is durable in both
    // shapes: hosted never exceeds repo, and everything pending sits above
    // hosted. The exact pending suffix is proved centrally, against the derived
    // state, by tests/docs/canonical-production-facts.test.ts.
    const state = migrationState();
    expect(state.hosted_migration_max).toBe(VERSION);
    expect(
      Number(state.repo_migration_max),
      "hosted must never exceed the repository: that is a remote-only migration",
    ).toBeGreaterThanOrEqual(Number(state.hosted_migration_max));
    expect(
      state.pending_migrations.every((v) => Number(v) > Number(VERSION)),
      "something at or below this applied migration is listed as pending",
    ).toBe(true);
    expect(
      Number(state.next_free_migration),
      "the next free number must sit above the repository maximum",
    ).toBeGreaterThan(Number(state.repo_migration_max));
  });

  it("is recorded in the ledger's CURRENT block as APPLIED, under its full sha256", () => {
    const ledger = readFileSync(
      path.resolve(__dirname, "../../docs/production/migration-ledger.md"),
      "utf8",
    );
    expect(ledger, "the ledger must carry 0204's COMPLETE sha256").toContain(APPLIED_SHA256);
    // Section-anchored, exactly as 0198-0203 assert it: the match must sit between
    // "## Current state" and the first "## Previous state", so a stale record in a
    // preserved section can never satisfy it.
    expect(ledger, "the ledger's current block must record 0204 as APPLIED").toMatch(
      /## Current state(?:(?!## Previous state)[\s\S])*?0204_new_client_admission_mode\.sql`? \| \*\*APPLIED\*\*/,
    );
  });

  it("the applied bytes are the authorized bytes", () => {
    // An applied migration is FROZEN. If this fails, the file was edited after the
    // apply: restore it and put any correction in a new forward migration.
    const digest = createHash("sha256")
      .update(
        readFileSync(
          path.resolve(__dirname, "../../supabase/migrations/0204_new_client_admission_mode.sql"),
        ),
      )
      .digest("hex");
    expect(digest).toBe(APPLIED_SHA256);
  });
});

describe("the value set is closed by the DATABASE", () => {
  it("the column exists with a CHECK naming exactly the three modes", () => {
    expect(SQL).toMatch(/add column if not exists new_client_admission_mode text not null default 'open'/);
    expect(SQL).toMatch(/check \(new_client_admission_mode in \('open', 'waitlist', 'closed'\)\)/);
  });

  it("the default is 'open', which reproduces today's behaviour", () => {
    // Derived, not guessed: a studio absent from the env list books today.
    expect(SQL).toMatch(/default 'open'/);
  });
});

// Relabelled under #780. The old title was "the command is the only writer",
// which is the claim family that PR withdrew four times: public.studios has no
// INSERT trigger and set_by has no FK, so an INSERT writes either column
// unopposed, and 0205's repair UPDATEs set_at under its own permit. None of the
// tests below ever asserted a monopoly - they prove the guard's SHAPE - so only
// the title was wrong, and a title reads as a finding.
describe("admission-field UPDATEs need the command's row-scoped permit", () => {
  it("a BEFORE UPDATE trigger guards the three admission fields", () => {
    expect(SQL).toMatch(/create trigger studios_admission_mode_guard\s+before update on public\.studios/);
    for (const field of [
      "new_client_admission_mode",
      "new_client_admission_mode_set_at",
      "new_client_admission_mode_set_by",
    ]) {
      expect(SQL, `${field} must be watched`).toContain(field);
    }
  });

  it("the guard is ROW-SCOPED: the permit names the studio being written", () => {
    // Not a generic bypass switch. There is no value of this setting that means
    // "allow anything" - it is compared against the row's own id.
    expect(SQL).toMatch(
      /current_setting\('hone\.admission_mode_studio_id', true\)[\s\S]{0,80}is distinct from new\.id::text/,
    );
  });

  it("the permit is TRANSACTION-LOCAL, so it cannot leak past the command", () => {
    expect(SQL).toMatch(
      /set_config\('hone\.admission_mode_studio_id', p_studio_id::text, true\)/,
    );
  });

  it("an UNRELATED studios update needs no permit", () => {
    // The guard returns early when no admission field changed, so ordinary
    // studios updates are untouched and no privilege surgery was needed.
    expect(SQL).toMatch(/if not v_touches_admission then\s+return new;/);
  });
});

describe("authority is re-derived, never accepted", () => {
  it("owner role comes from is_studio_owner, which reads auth.uid() itself", () => {
    expect(SQL).toMatch(/if not public\.is_studio_owner\(p_studio_id\) then/);
    expect(SQL).toMatch(/'not_authorized'/);
  });

  it("the actor recorded is resolved from the session, not from a parameter", () => {
    expect(SQL).toMatch(/where p\.studio_id = p_studio_id\s+and p\.user_id = auth\.uid\(\)/);
    expect(STATEMENTS).not.toMatch(/p_actor|p_practitioner_id|p_set_by/);
  });

  it("the timestamp is the DATABASE clock", () => {
    expect(SQL).toMatch(/v_now\s+timestamptz := now\(\)/);
    expect(SQL).toMatch(/new_client_admission_mode_set_at = v_now/);
  });

  it("the browser's only influence is the mode intent", () => {
    // TWO parameters, and that is deliberate. A version of this command took the
    // "is this studio still email-only?" fact as a third, defaulted argument
    // computed by the settings action - which protected the UI and nothing else,
    // because the command is granted to `authenticated` and an owner could call
    // it straight through PostgREST and pass `false`. The stamp is read from the
    // ROW instead, so there is no transition fact a caller can assert.
    expect(SQL).toMatch(
      /set_new_client_admission_mode\(\s*p_studio_id uuid,\s*p_mode text\s*\)/,
    );
    expect(SQL).not.toMatch(/p_legacy_email_only\s+boolean/);
    // The mode intent is the ONLY browser-influenced argument.
    expect(SQL).toMatch(/v_mode\s+text := lower\(btrim\(coalesce\(p_mode/);
    // And the block it guards reads the row, under this transaction's own lock.
    expect(SQL).toMatch(/new_client_admission_mode_set_at is null\s*\n?\s*into v_unstamped/);
  });
});

describe("grants follow the 0129 / 0164 lesson", () => {
  it("revokes from public, anon, authenticated AND service_role by name", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(
        SQL,
        `must revoke from ${role} by name`,
      ).toMatch(new RegExp(`revoke all on function public\\.set_new_client_admission_mode\\(uuid, text\\) from ${role};`));
    }
    expect(SQL).toMatch(/grant execute on function public\.set_new_client_admission_mode\(uuid, text\) to authenticated;/);
  });
});

describe("the migration stays inside its own scope", () => {
  it("opens its own transaction with a lock timeout", () => {
    expect(SQL).toMatch(/^begin;/m);
    expect(SQL).toMatch(/set local lock_timeout = '5s';/);
    expect(SQL).toMatch(/^commit;/m);
  });

  it("alters only `studios`, whatever else it composes with", () => {
    // SCOPE GREW BY RULING, and this is the boundary that survived it. The
    // commit-time authority has to live in the same transaction as the write it
    // guards, so this migration now composes with the waitlist join command and
    // creates the client row for an ordinary new-client booking. What it still
    // may NOT do is change the shape of anything but `studios`.
    const altered = [...STATEMENTS.matchAll(/alter table\s+(?:public\.)?(\w+)/gi)].map(
      (m) => m[1].toLowerCase(),
    );
    expect(altered.length).toBeGreaterThan(0);
    expect([...new Set(altered)]).toEqual(["studios"]);
  });

  it("never mutates a waitlist table directly - it DELEGATES to the owning command", () => {
    // The 0185/0188/0195 lifecycle owns those rows. This migration composes with
    // their commands in one transaction and writes none of them itself, so no
    // entry can change state by a route those commands do not control.
    expect(STATEMENTS).not.toMatch(
      /\b(update|insert into|delete from)\s+(public\.)?new_client_waitlist_\w+/i,
    );
    expect(STATEMENTS).toContain("public.join_new_client_waitlist(");
    expect(STATEMENTS).toContain("public.create_waitlist_public_appointment(");
  });

  it("touches EXISTING-client booking only by calling the command it already used", () => {
    // `create_public_appointment` is CALLED, never redefined: existing-client
    // ordinary booking reaches it exactly as before and consults no admission
    // authority. The one `clients` write is the NEW-client row, created inside
    // the locked transaction so a refused request cannot leave an orphan.
    expect(STATEMENTS).not.toMatch(
      /create\s+(or replace\s+)?function\s+public\.create_public_appointment\s*\(/i,
    );
    expect(STATEMENTS).toContain("public.create_public_appointment(");
    const clientWrites = [
      ...STATEMENTS.matchAll(/\b(update|insert into|delete from)\s+(?:public\.)?clients\b/gi),
    ].map((m) => m[1].toLowerCase());
    expect(clientWrites).toEqual(["insert into"]);
    expect(STATEMENTS).not.toMatch(/\bdelete from\s+(public\.)?appointments\b/i);
  });

  it("does not weaken the existing studios update policy", () => {
    expect(STATEMENTS).not.toMatch(/drop policy|alter policy|revoke .*update .*studios/i);
  });
});
