import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  countVersion,
  fileForVersion,
  isRepoMax,
  versionsAbove,
} from "./helpers/migration-state";

// 0185 — the durable, studio-scoped new-client waitlist (WAIT-02).
//
// THIS FILE IS THE SOURCE CONTRACT. It proves what the migration SAYS. The
// behavioural half — that the duplicate rule actually holds under concurrent
// submissions, that a studio cannot read another's rows, that removal is a
// transition rather than a delete — runs against the REAL migrated database in
// tests/db/new-client-waitlist-entries.db.test.ts. Neither is sufficient alone:
// SQL text cannot prove a race, and a behavioural test cannot prove that a
// grant line was written rather than inherited.
//
// TWO NAMED MUTATIONS THIS FILE IS BUILT TO CATCH (see §24 of the brief):
//   * drop `studio_id` from the uniqueness rule -> the index assertion fails
//     here, and the cross-studio behavioural test fails in the db lane;
//   * turn the join into check-then-insert -> the ON CONFLICT assertion fails
//     here, and the deterministic interleaving test fails in the db lane.

const ROOT = path.resolve(__dirname, "../..");
const VERSION = "0185";
const FILE = fileForVersion(VERSION);
const SQL = readFileSync(path.join(ROOT, "supabase/migrations", FILE), "utf8");

// The header discusses at length what this migration must NOT do (and names
// tables it deliberately leaves alone), so every negative assertion runs
// against EXECUTABLE SQL only.
const CODE = SQL.split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");

/**
 * CODE with every SQL string literal blanked out.
 *
 * `comment on ... is '...'` is executable SQL, so a table NAMED IN PROSE inside
 * one is indistinguishable from a table the migration operates on if you scan
 * CODE alone — and this migration's comments deliberately name `public.waitlist`
 * to say it is a DIFFERENT product concept. Assertions about what the file
 * TOUCHES therefore run against this projection; assertions about what it SAYS
 * run against CODE.
 */
const STATEMENTS = CODE.replace(/'(?:[^']|'')*'/g, "''");

const TABLE = "public.new_client_waitlist_entries";

describe("0185 — migration state", () => {
  it("is the current repository maximum, exactly once, with nothing above it", () => {
    expect(isRepoMax(VERSION)).toBe(true);
    expect(countVersion(VERSION)).toBe(1);
    expect(versionsAbove(VERSION)).toEqual([]);
  });

  it("is named for what it creates", () => {
    expect(FILE).toBe("0185_new_client_waitlist_entries.sql");
  });
});

describe("0185 — transactional envelope", () => {
  it("opens its own transaction and sets a lock timeout INSIDE it", () => {
    // `supabase db push` does not wrap a file in a transaction, so a bare
    // SET LOCAL emits 25P01 and never arms. The order matters: begin first.
    const begin = CODE.indexOf("begin;");
    const lock = CODE.indexOf("set local lock_timeout");
    const commit = CODE.lastIndexOf("commit;");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(begin);
    expect(commit).toBeGreaterThan(lock);
  });

  it("is re-runnable — every create/drop is guarded", () => {
    expect(CODE).toContain(`create table if not exists ${TABLE}`);
    for (const stmt of CODE.matchAll(/create (unique )?index (?!if not exists)/g)) {
      throw new Error(`unguarded index creation: ${stmt[0]}`);
    }
    for (const stmt of CODE.matchAll(/^create trigger/gm)) {
      expect(stmt.index).toBeGreaterThan(0);
    }
    // Every trigger and policy is dropped before it is created.
    const created = [...CODE.matchAll(/create trigger (\w+)/g)].map((m) => m[1]);
    expect(created.length).toBeGreaterThan(0);
    for (const trigger of created) {
      expect(CODE, `${trigger} must be dropped before creation`).toContain(
        `drop trigger if exists ${trigger}`,
      );
    }
    const policies = [...CODE.matchAll(/create policy "(\w+)"/g)].map((m) => m[1]);
    for (const policy of policies) {
      expect(CODE).toContain(`drop policy if exists "${policy}"`);
    }
  });
});

describe("0185 — tenancy is structural", () => {
  it("every row belongs to exactly one studio, by NOT NULL foreign key", () => {
    expect(CODE).toMatch(
      /studio_id uuid not null\s*\n\s*references public\.studios\(id\) on delete cascade/,
    );
  });

  it("THE DUPLICATE RULE IS STUDIO-SCOPED AND STATUS-SCOPED", () => {
    // NAMED MUTATION: removing `studio_id` here would make one studio's list
    // constrain another's, and stop the same person from waiting at two
    // unrelated studios. The behavioural proof is in the db lane.
    expect(CODE).toMatch(
      /create unique index if not exists new_client_waitlist_entries_one_waiting_per_email\s*\n\s*on public\.new_client_waitlist_entries \(studio_id, email_normalized\)\s*\n\s*where status = 'waiting'/,
    );
  });

  it("carries NO global uniqueness of any kind", () => {
    // `public.waitlist` (0004) is globally unique on email. This table must
    // never be: two studios' prospect lists are unrelated data.
    const uniques = [...CODE.matchAll(/create unique index[^;]+;/g)].map((m) => m[0]);
    for (const idx of uniques) {
      expect(idx, `unique index without studio scope: ${idx}`).toContain("studio_id");
    }
    expect(CODE).not.toMatch(/email text not null unique/);
    expect(CODE).not.toMatch(/unique \(email\)/);
  });

  it("the actor column is studio-scoped by composite FK, per the 0179 doctrine", () => {
    expect(CODE).toMatch(
      /foreign key \(removed_by_practitioner_id, studio_id\)\s*\n\s*references public\.practitioners \(id, studio_id\) on delete restrict/,
    );
  });
});

describe("0185 — normalization is the database's, not the application's", () => {
  it("email_normalized is a STORED GENERATED column, defined once here", () => {
    expect(CODE).toContain(
      "email_normalized text generated always as (lower(btrim(email))) stored",
    );
  });

  it("the uniqueness rule is expressed over the generated column", () => {
    // If uniqueness were over the raw `email`, the normalization would only be
    // as good as whatever the caller happened to send.
    const index = CODE.match(/create unique index[^;]+one_waiting_per_email[^;]+;/s)?.[0] ?? "";
    expect(index).toContain("email_normalized");
    expect(index).not.toMatch(/\(studio_id, email\)/);
  });
});

describe("0185 — the join command is atomic, not check-then-insert", () => {
  const joinFn = CODE.slice(
    CODE.indexOf("create or replace function public.join_new_client_waitlist"),
    CODE.indexOf("create or replace function public.remove_new_client_waitlist_entry"),
  );

  it("resolves the duplicate inside ONE statement, against the partial index", () => {
    // NAMED MUTATION: replacing this with `if exists (...) then return
    // already_waiting; end if; insert ...` would let two concurrent callers
    // both pass the check. The db lane proves the interleaving.
    expect(joinFn).toMatch(
      /insert into public\.new_client_waitlist_entries[\s\S]*?on conflict \(studio_id, email_normalized\) where status = 'waiting'\s*\n\s*do nothing\s*\n\s*returning id into v_id;/,
    );
  });

  it("never pre-checks for an existing entry BEFORE inserting", () => {
    const insertAt = joinFn.indexOf("insert into public.new_client_waitlist_entries");
    const preamble = joinFn.slice(0, insertAt);
    expect(preamble).not.toMatch(/from public\.new_client_waitlist_entries/);
  });

  it("is SECURITY DEFINER with a pinned search_path, and VOLATILE", () => {
    expect(joinFn).toContain("security definer");
    expect(joinFn).toContain("set search_path = pg_catalog, pg_temp");
    // A STABLE function would take the CALLING query's snapshot, so the
    // read-back after a conflict could never see the winner's committed row.
    expect(joinFn).toContain("volatile");
  });

  it("validates and normalizes its own input rather than trusting the caller", () => {
    expect(joinFn).toContain("lower(btrim(coalesce(p_email, '')))");
    expect(joinFn).toContain("btrim(coalesce(p_name, ''))");
    expect(joinFn).toContain("invalid_input");
  });

  it("returns CLOSED result codes and raises no exception for a business refusal", () => {
    for (const code of [
      "created",
      "already_waiting",
      "invalid_input",
      "studio_not_found",
      "unknown",
    ]) {
      expect(joinFn).toContain(`'${code}'::text`);
    }
    expect(joinFn).not.toMatch(/raise exception/);
  });

  it("writes exactly ONE table and reads only `studios`", () => {
    const writes = [...joinFn.matchAll(/(insert into|update|delete from)\s+public\.(\w+)/g)];
    expect(writes.map((m) => m[2])).toEqual(["new_client_waitlist_entries"]);
    const reads = new Set(
      [...joinFn.matchAll(/from public\.(\w+)/g)].map((m) => m[1]),
    );
    expect([...reads].sort()).toEqual(["new_client_waitlist_entries", "studios"]);
  });
});

describe("0185 — the removal command derives its own authority", () => {
  const removeFn = CODE.slice(
    CODE.indexOf("create or replace function public.remove_new_client_waitlist_entry"),
  );

  it("re-derives membership AND owner role from (studio_id, actor user id)", () => {
    expect(removeFn).toMatch(
      /from public\.practitioners p\s*\n\s*where p\.studio_id = p_studio_id\s*\n\s*and p\.user_id\s+= p_actor_user_id\s*\n\s*and p\.active\s+= true/,
    );
    expect(removeFn).toContain("return 'not_a_member'");
    expect(removeFn).toContain("if v_role <> 'owner' then");
    expect(removeFn).toContain("return 'not_owner'");
  });

  it("takes NO role parameter — the caller cannot claim one", () => {
    const signature = removeFn.slice(0, removeFn.indexOf(")"));
    expect(signature).not.toMatch(/role/i);
    expect(signature).toContain("p_studio_id     uuid");
    expect(signature).toContain("p_entry_id      uuid");
    expect(signature).toContain("p_actor_user_id uuid");
  });

  it("scopes the entry by BOTH id and studio, and locks it", () => {
    expect(removeFn).toMatch(/where e\.id = p_entry_id\s*\n\s*and e\.studio_id = p_studio_id\s*\n\s*for update/);
    expect(removeFn).toMatch(/where id\s+= p_entry_id\s*\n\s*and studio_id = p_studio_id\s*\n\s*and status\s+= 'waiting'/);
  });

  it("NEVER deletes — removal is a transition that records who and when", () => {
    expect(removeFn).not.toMatch(/delete from/);
    expect(removeFn).toContain("set status                     = 'removed'");
    expect(removeFn).toContain("removed_at                 = now()");
    expect(removeFn).toContain("removed_by_practitioner_id = v_practitioner_id");
  });
});

describe("0185 — lifecycle law", () => {
  it("declares exactly three states", () => {
    expect(CODE).toMatch(/check \(status in \('waiting', 'removed', 'converted'\)\)/);
  });

  it("permits ONLY waiting -> removed, so nothing can convert itself", () => {
    expect(CODE).toMatch(
      /if new\.status is distinct from old\.status\s*\n\s*and not \(old\.status = 'waiting' and new\.status = 'removed'\) then/,
    );
  });

  it("stores NO conversion evidence, because nothing can produce it yet", () => {
    // A nullable column no path can fill is a promise, not a record. The slice
    // that performs a real conversion adds these with its own writer.
    expect(CODE).not.toMatch(/converted_at/);
    expect(CODE).not.toMatch(/converted_client_id/);
  });

  it("freezes identity, tenancy, provenance, join time and contact details", () => {
    expect(CODE).toMatch(
      /if new\.id is distinct from old\.id\s*\n\s*or new\.studio_id is distinct from old\.studio_id\s*\n\s*or new\.joined_at is distinct from old\.joined_at\s*\n\s*or new\.source is distinct from old\.source then/,
    );
    expect(CODE).toMatch(
      /if new\.name is distinct from old\.name\s*\n\s*or new\.email is distinct from old\.email\s*\n\s*or new\.phone is distinct from old\.phone then/,
    );
  });

  it("makes joined_at server-owned rather than merely defaulted", () => {
    // `default now()` applies only when the caller OMITS the column, and
    // joined_at is the ordering key of the whole operator surface.
    expect(CODE).toContain("new.joined_at := now();");
    expect(CODE).toMatch(/before insert on public\.new_client_waitlist_entries/);
  });

  it("freezes removal evidence OUTSIDE the transition that records it", () => {
    // Guarding only the status COLUMN leaves a hole: an UPDATE on an
    // already-removed row that leaves `status` alone changes no other guarded
    // field, satisfies the all-or-nothing CHECK, and satisfies the composite FK
    // for any same-studio practitioner. Attribution the file calls durable
    // would then be rewritable — the 0183 shape, a contract stated in prose and
    // enforced over a narrower set.
    expect(CODE).toMatch(
      /if not \(old\.status = 'waiting' and new\.status = 'removed'\)\s*\n\s*and \(new\.removed_at is distinct from old\.removed_at\s*\n\s*or new\.removed_by_practitioner_id is distinct from old\.removed_by_practitioner_id\) then/,
    );
  });

  it("requires removal evidence to be all-or-nothing", () => {
    expect(CODE).toMatch(
      /check \(\s*\n\s*\(status = 'removed'\s*\n\s*and removed_at is not null\s*\n\s*and removed_by_practitioner_id is not null\)/,
    );
  });
});

describe("0185 — privilege", () => {
  it("REVOKES ALL on the table from every default grantee before granting back", () => {
    // 0183 stated an allowlist and enforced a denylist; PostgreSQL 17's
    // MAINTAIN survived because no by-name list could have contained it, and
    // 0184 had to repair it in production. REVOKE ALL cannot fail that way.
    expect(CODE).toMatch(
      /revoke all on public\.new_client_waitlist_entries\s*\n\s*from public, anon, authenticated, service_role;/,
    );
  });

  it("grants the table to `authenticated` for SELECT and NOTHING else", () => {
    expect(CODE).toContain(`grant select on ${TABLE} to authenticated;`);
    const grants = [...CODE.matchAll(new RegExp(`grant [^;]*on ${TABLE.replace(".", "\\.")}[^;]*;`, "g"))];
    expect(grants).toHaveLength(1);
    for (const verb of ["insert", "update", "delete", "truncate"]) {
      expect(grants[0][0]).not.toContain(verb);
    }
  });

  it("gives anon and service_role NO table privilege at all", () => {
    // service_role calls the SECURITY DEFINER commands, which run as the table
    // owner, so it needs nothing on the table itself — and therefore cannot
    // read or dump the contact details directly even with the key.
    expect(CODE).not.toMatch(new RegExp(`grant [^;]*on ${TABLE.replace(".", "\\.")}[^;]*to (anon|service_role)`));
  });

  it("revokes EXECUTE from all four grantees on both commands, then grants service_role", () => {
    const commands = [
      "public.join_new_client_waitlist(uuid, text, text, text)",
      "public.remove_new_client_waitlist_entry(uuid, uuid, uuid)",
    ];
    for (const fn of commands) {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(
          CODE,
          `${fn} must revoke EXECUTE from ${role} by name`,
        ).toContain(`revoke execute on function ${fn} from ${role};`);
      }
      expect(CODE).toContain(`grant execute on function ${fn} to service_role;`);
      for (const role of ["anon", "authenticated", "public"]) {
        expect(CODE).not.toContain(`grant execute on function ${fn} to ${role};`);
      }
    }
  });

  it("revokes the inert trigger-function grants too, matching 0184", () => {
    for (const fn of [
      "public.new_client_waitlist_entries_server_timestamps()",
      "public.new_client_waitlist_entries_transition_guard()",
    ]) {
      expect(CODE).toMatch(
        new RegExp(
          `revoke all privileges on function ${fn.replace(/[().]/g, "\\$&")}\\s*\\n\\s*from public, anon, authenticated, service_role;`,
        ),
      );
    }
  });
});

describe("0185 — RLS", () => {
  it("enables row level security", () => {
    expect(CODE).toContain(`alter table ${TABLE} enable row level security;`);
  });

  it("has EXACTLY ONE policy, and it is a read gated on studio OWNERSHIP", () => {
    const policies = [...CODE.matchAll(/create policy "([^"]+)"\s*\n\s*on public\.new_client_waitlist_entries for (\w+)/g)];
    expect(policies.map((m) => [m[1], m[2]])).toEqual([
      ["new_client_waitlist_entries_owner_select", "select"],
    ]);
    expect(CODE).toContain(
      "using (public.is_studio_owner(new_client_waitlist_entries.studio_id))",
    );
  });

  it("qualifies the policy column, avoiding the 0126 tautology", () => {
    expect(CODE).not.toMatch(/using \(public\.is_studio_owner\(studio_id\)\)/);
  });
});

describe("0185 — blast radius", () => {
  it("creates ONE table and writes no other", () => {
    const created = [...CODE.matchAll(/create table (?:if not exists )?public\.(\w+)/g)].map((m) => m[1]);
    expect(created).toEqual(["new_client_waitlist_entries"]);

    const dml = [...STATEMENTS.matchAll(/(insert into|update|delete from)\s+public\.(\w+)/g)].map((m) => m[2]);
    expect([...new Set(dml)]).toEqual(["new_client_waitlist_entries"]);
  });

  it("does not touch the MARKETING waitlist table", () => {
    // public.waitlist (0004) is a different product concept with global email
    // uniqueness and no studio ownership. The migration's PROSE names it on
    // purpose, to say exactly that — so the check runs over statements with
    // string literals blanked, not over the raw text.
    expect(STATEMENTS).not.toMatch(/public\.waitlist\b/);
    // ...and the projection is not vacuous: real statements survive it.
    expect(STATEMENTS).toContain("create table if not exists public.new_client_waitlist_entries");
    expect(STATEMENTS).toContain("grant select on public.new_client_waitlist_entries to authenticated;");
    // The prose reference the executable check must tolerate really is there.
    expect(CODE).toMatch(/public\.waitlist \(0004\)/);
  });

  it("creates no client, appointment, intake or session state", () => {
    for (const table of [
      "clients",
      "appointments",
      "sessions",
      "client_intake_forms",
      "practitioner_notifications",
    ]) {
      expect(
        STATEMENTS,
        `0185 must not write public.${table}`,
      ).not.toMatch(new RegExp(`(insert into|update|delete from)\\s+public\\.${table}\\b`));
    }
  });

  it("alters, drops and truncates nothing that already exists", () => {
    const altered = [...STATEMENTS.matchAll(/alter table public\.(\w+)/g)].map((m) => m[1]);
    expect([...new Set(altered)]).toEqual(["new_client_waitlist_entries"]);
    expect(STATEMENTS).not.toMatch(/drop table/);
    expect(STATEMENTS).not.toMatch(/truncate/);
    // It reuses the shared 0015 helper rather than redefining it.
    expect(CODE).toContain("execute function public.set_updated_at()");
    expect(CODE).not.toMatch(/create or replace function public\.set_updated_at/);
  });
});
