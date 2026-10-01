import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

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

describe("the command is the only writer", () => {
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
    // THREE parameters now, and the browser supplies exactly one of them. The
    // studio is server-resolved, and `p_legacy_email_only` is a SERVER-DERIVED
    // transition fact - the database cannot read the env lists - which is why it
    // has to be passed rather than looked up. It is retired with the bridge.
    expect(SQL).toMatch(
      /set_new_client_admission_mode\(\s*p_studio_id uuid,\s*p_mode text,[\s\S]*?p_legacy_email_only boolean default false\s*\)/,
    );
    // The mode intent is the ONLY browser-influenced argument.
    expect(SQL).toMatch(/v_mode\s+text := lower\(btrim\(coalesce\(p_mode/);
  });
});

describe("grants follow the 0129 / 0164 lesson", () => {
  it("revokes from public, anon, authenticated AND service_role by name", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(
        SQL,
        `must revoke from ${role} by name`,
      ).toMatch(new RegExp(`revoke all on function public\\.set_new_client_admission_mode\\(uuid, text, boolean\\) from ${role};`));
    }
    expect(SQL).toMatch(/grant execute on function public\.set_new_client_admission_mode\(uuid, text, boolean\) to authenticated;/);
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
