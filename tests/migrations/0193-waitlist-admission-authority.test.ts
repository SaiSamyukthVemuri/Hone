import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileForVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// 0193 — prospect preference vs studio admission policy (WAIT-ADMIT-01).
//
// THIS FILE IS THE SOURCE CONTRACT. It proves what the migration SAYS. The
// behavioural half lives in tests/db/waitlist-admission-authority.db.test.ts and
// proves what it DOES. Neither is sufficient alone: a behavioural test cannot
// prove a grant line was WRITTEN rather than inherited from Supabase's
// create-time defaults, and SQL text cannot prove a member is actually refused.
//
// THE NAMED MUTATIONS THIS FILE EXISTS TO CATCH:
//   * move admission policy onto `studios` -> the no-studios-column assertion
//     fails. That is the disproved model: ALTER DEFAULT PRIVILEGES gives anon
//     and authenticated table-level UPDATE across all of studios' columns, and
//     a column-level revoke cannot remove a table-level grant;
//   * grant a table-level SELECT on the grants table -> the token_hash
//     assertion fails, and an authenticated owner could read a live verifier
//     because RLS scopes rows, not columns;
//   * add an insert/update/delete POLICY to any new table -> the read-only
//     assertion fails, and a browser session would have a write path;
//   * forget one of the four grantees in a revoke -> the privilege assertions
//     fail, which is the 0129 / 0164 failure class;
//   * relax the unconditional joined_at stamp for the PUBLIC path -> the
//     trigger assertion fails, and an anonymous submitter could forge an
//     earlier queue position;
//   * drop `source` from the trigger's condition -> a legacy import's real
//     join date silently becomes today, which is the fabrication
//     joined_at_provenance exists to prevent.

const ROOT = path.resolve(__dirname, "../..");
const VERSION = "0193";
const FILE = fileForVersion(VERSION);
const SQL = readFileSync(path.join(ROOT, "supabase/migrations", FILE), "utf8");

// Negative assertions must never be satisfied by PROSE. This migration's header
// names the very things it forbids, so every "does not contain" assertion runs
// against comment-stripped SQL rather than the raw file.
const CODE = SQL.split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");

const TABLES = [
  "public.new_client_waitlist_entry_preferences",
  "public.new_client_waitlist_preference_grants",
  "public.studio_waitlist_admission_policy",
] as const;

const COMMANDS: readonly [string, string][] = [
  // THE PRIMARY ENTRYPOINT, AND THE ONE THIS MATRIX USED TO OMIT. Its absence
  // meant a drift in its revoke/grant posture would have left every privilege
  // test green while the admission command quietly became browser-callable —
  // and `pg_default_acl` grants anon and authenticated EXECUTE at function
  // create time, so that drift is one forgotten REVOKE away, not a hypothetical.
  // Same trap CLAUDE.md records being missed in 0129 (anon) and 0164
  // (service_role). The completeness guard below is what stops a tenth command
  // repeating it.
  ["public.admit_new_client_waitlist_entry", "uuid, uuid, uuid, uuid, date, date, smallint[], integer"],
  ["public.create_practitioner_waitlist_entry", "uuid, uuid, text, text, text, text"],
  ["public.import_legacy_waitlist_entry", "uuid, uuid, text, text, timestamptz, text, text"],
  ["public.set_waitlist_entry_availability", "uuid, uuid, uuid, text"],
  ["public.issue_waitlist_preference_grant", "uuid, uuid, uuid, integer"],
  ["public.revoke_waitlist_preference_grant", "uuid, uuid, uuid"],
  ["public.redeem_waitlist_preference_grant", "text, text"],
  ["public.set_studio_waitlist_admission_policy", "uuid, uuid, jsonb, integer, integer"],
  ["public.claim_new_client_waitlist_entries_ordered", "uuid, uuid, uuid[]"],
];

describe("0193 position in the chain", () => {
  it("is the repository maximum", () => {
    expect(isRepoMax(VERSION)).toBe(true);
  });

  it("has nothing above it", () => {
    expect(versionsAbove(VERSION)).toEqual([]);
  });
});

describe("transaction and lock posture", () => {
  it("opens its own transaction and arms a lock timeout inside it", () => {
    // `supabase db push` does not wrap a file, so a bare SET LOCAL outside a
    // transaction emits 25P01 and never arms.
    const begin = CODE.indexOf("begin;");
    const lock = CODE.indexOf("set local lock_timeout");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(begin);
    expect(CODE.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("keeps every identifier within PostgreSQL's 63-character limit", () => {
    // A longer name is silently TRUNCATED, so `drop constraint if exists` stops
    // matching and the migration is no longer idempotent.
    const overlong = Array.from(SQL.matchAll(/[a-z_]{40,}/g))
      .map((m) => m[0])
      .filter((id) => id.length > 63);
    expect(Array.from(new Set(overlong))).toEqual([]);
  });
});

describe("the disproved privilege model is not reintroduced", () => {
  it("adds NO column to public.studios", () => {
    expect(/alter\s+table\s+public\.studios/i.test(CODE)).toBe(false);
  });

  it("keeps admission policy in its own table", () => {
    expect(CODE).toContain("create table if not exists public.studio_waitlist_admission_policy");
  });

  it("does not create 0192's admission-rounds table, though it does use it", () => {
    // That object belongs to 0192. Creating it here would collide; LOCKING it
    // is required, because the admission command must take the canonical
    // studios -> open round -> entry order before it claims anything.
    expect(CODE).not.toMatch(/create table[^;]*studio_waitlist_admission_rounds/i);
    expect(CODE).toContain("from public.studio_waitlist_admission_rounds r");
  });

  it("locks the OPEN round, not every round the studio has ever had", () => {
    // THE ASSERTION THIS REPLACES WAS NEARLY VACUOUS. It paired the table name
    // with a bare `toContain("for update")` -- a string this file contains in a
    // dozen unrelated commands -- so it stayed green through exactly the drift
    // it existed to catch. `studio_id` was this table's primary key when that
    // guard was written, which made "the studio's round" and "the studio's
    // rounds" the same set. 0192 then made rounds a durable ledger keyed by
    // `id`: closed rounds persist, and only the partial unique index
    // `(studio_id) where closed_at is null` makes "the current round" singular.
    //
    // So the predicate is pinned as ONE statement, not as three independent
    // substrings that could each be satisfied somewhere else in the file.
    const lock = CODE.match(
      /perform 1 from public\.studio_waitlist_admission_rounds r\s*\n\s*where r\.studio_id = p_studio_id\s*\n\s*and r\.closed_at is null\s*\n\s*for update;/,
    );
    expect(lock, "the admission round lock must name the OPEN round").not.toBeNull();

    // AND THE MODE, WHICH IS NOT THE STUDIO'S. The studios row above is taken
    // FOR NO KEY UPDATE so it stays compatible with the KEY SHARE the lifecycle
    // writers' FK checks request. The round row is the opposite case: it is the
    // TARGET of the invitation's composite (admission_round_id, studio_id) FK,
    // so a competing issuance needs KEY SHARE on it and FOR UPDATE is what
    // excludes them. NO KEY UPDATE here would let two issuances share a seat.
    expect(lock?.[0]).toContain("for update;");
    expect(lock?.[0]).not.toContain("for no key update");

    // The same predicate 0192's issuer uses, so this lock names the row that
    // command will re-select. A lock on a different row proves nothing.
    expect(CODE).toContain("and r.closed_at is null");
  });

  it("still delegates the no_round_open verdict to 0192", () => {
    // The lock is LOCK-ONLY on purpose: it takes no `found` check and returns
    // no code. `no_round_open` is the issuer's word, carried out through the
    // WA001 handler. A second copy of that decision here is a second place for
    // the quota authority to drift.
    const body = CODE.slice(
      CODE.indexOf("create or replace function public.admit_new_client_waitlist_entry"),
    );
    const admit = body.slice(0, body.indexOf("\n$$;"));
    expect(admit).not.toContain("'no_round_open'");
    expect(admit).toContain("public.issue_scoped_new_client_waitlist_invitation(");
  });
});

/**
 * THE PRIVILEGE FRONTIER, DERIVED FROM THE MIGRATION ITSELF.
 *
 * 0193 declares its own frontier: every command reachable by the server is
 * named, WITH ITS SIGNATURE, in a `grant execute ... to service_role` statement.
 * That is the authoritative list, so the matrix above is checked AGAINST it
 * rather than trusted. A hand-maintained list is exactly how the ninth command
 * went missing.
 *
 * Signature-aware on purpose: a bare name would let an overload be added — same
 * name, new argument list, no revoke — and pass. That is the drift 0193's own
 * lock-audit test already had to be rewritten to catch once.
 */
const GRANTED_TO_SERVICE_ROLE: readonly [string, string][] = (() => {
  const re = /grant execute on function (public\.[a-z_]+)\(([^)]*)\) to service_role;/g;
  const found: [string, string][] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(CODE)) !== null) found.push([m[1]!, m[2]!.trim()]);
  return found;
})();

/** Signatures differ only by spacing between the two files; compare on content. */
const sigKey = (fn: string, args: string) =>
  `${fn}(${args.split(",").map((a) => a.trim()).join(",")})`;

describe("the privilege matrix covers every command 0193 exposes", () => {
  it("finds the grant statements at all", () => {
    // Anti-vacuity: a regex that matched nothing would make the equality below
    // pass while proving that no command exists.
    expect(GRANTED_TO_SERVICE_ROLE.length).toBeGreaterThanOrEqual(9);
  });

  it("the matrix and the migration's own grants are the SAME set, signature for signature", () => {
    const declared = GRANTED_TO_SERVICE_ROLE.map(([fn, args]) => sigKey(fn, args)).sort();
    const asserted = COMMANDS.map(([fn, args]) => sigKey(fn, args)).sort();
    // Both directions: a command granted but unasserted is the defect that
    // prompted this; a command asserted but no longer granted means the matrix
    // is testing something the migration stopped doing.
    expect(asserted, "every service_role-granted command must be in the matrix").toEqual(declared);
  });

  it("names the admission command specifically, so its omission cannot recur silently", () => {
    expect(COMMANDS.map(([fn]) => fn)).toContain("public.admit_new_client_waitlist_entry");
    expect(GRANTED_TO_SERVICE_ROLE.map(([fn]) => fn)).toContain(
      "public.admit_new_client_waitlist_entry",
    );
  });
});


describe("privileges are explicit, never inherited", () => {
  it.each(TABLES)("revokes all four grantees on %s", (table) => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(CODE).toContain(`revoke all on ${table} from ${role};`);
    }
  });

  it.each(TABLES)("grants %s no write privilege to any role", (table) => {
    const writes = new RegExp(
      `grant\\s+(insert|update|delete|all)[^;]*on\\s+${table.replace(".", "\\.")}`,
      "i",
    );
    expect(writes.test(CODE)).toBe(false);
  });

  it("grants SELECT by COLUMN LIST, never whole-table, on every new table", () => {
    for (const table of TABLES) {
      expect(CODE).toMatch(new RegExp(`grant select \\([^)]+\\) on ${table.replace(".", "\\.")} to authenticated;`));
      expect(CODE).not.toContain(`grant select on ${table} to authenticated;`);
    }
  });

  it("never grants a table privilege to service_role", () => {
    // A SECURITY DEFINER command executes as its owner, so the server's most
    // privileged client can run the commands and cannot dump the tables.
    for (const table of TABLES) {
      expect(CODE).not.toMatch(new RegExp(`grant[^;]*on ${table.replace(".", "\\.")} to service_role`, "i"));
    }
  });

  it("never grants anything to anon", () => {
    expect(CODE).not.toMatch(/grant[^;]*to anon\b/i);
  });

  it("excludes token_hash from the readable column list", () => {
    const grant = CODE.match(
      /grant select \(([^)]+)\) on public\.new_client_waitlist_preference_grants to authenticated;/,
    );
    expect(grant).not.toBeNull();
    const columns = grant![1].split(",").map((c) => c.trim());
    expect(columns).not.toContain("token_hash");
    expect(columns).toContain("expires_at");
  });

  it.each(COMMANDS)("revokes EXECUTE on %s from all four grantees by name", (fn, args) => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(CODE).toContain(`revoke execute on function ${fn}(${args}) from ${role};`);
    }
    expect(CODE).toContain(`grant execute on function ${fn}(${args}) to service_role;`);
  });

  it("writes the grant statements literally, never through format()", () => {
    // The grant guards read these textually; a DO-block would hide them.
    expect(CODE).not.toMatch(/execute\s+format\([^)]*grant/i);
  });
});

describe("RLS is read-only and owner-scoped", () => {
  it.each(TABLES)("enables row level security on %s", (table) => {
    expect(CODE).toContain(`alter table ${table} enable row level security;`);
  });

  it("declares only FOR SELECT policies, all TO authenticated", () => {
    const policies = Array.from(CODE.matchAll(/create policy[\s\S]*?;/g)).map((m) => m[0]);
    expect(policies).toHaveLength(3);
    for (const p of policies) {
      expect(p).toContain("for select to authenticated");
      expect(p).toContain("public.is_studio_owner(");
      // is_studio_member would be the broader, lazier predicate.
      expect(p).not.toContain("is_studio_member");
    }
  });

  it("declares no insert, update or delete policy anywhere", () => {
    expect(CODE).not.toMatch(/create policy[\s\S]{0,200}for\s+(insert|update|delete|all)\b/i);
  });
});

describe("structural tenancy", () => {
  it("binds every child row to its parent by COMPOSITE (id, studio_id)", () => {
    // A single-column FK would let a row reference a parent in another studio
    // even if a policy were wrong.
    for (const ref of [
      "references public.new_client_waitlist_entries (id, studio_id)",
      "references public.practitioners (id, studio_id)",
    ]) {
      expect(CODE).toContain(ref);
    }
  });

  it("carries studio_id on every new table", () => {
    expect(CODE).toMatch(/create table if not exists public\.new_client_waitlist_entry_preferences[\s\S]*?studio_id\s+uuid not null/);
    expect(CODE).toMatch(/create table if not exists public\.new_client_waitlist_preference_grants[\s\S]*?studio_id\s+uuid not null/);
  });
});

describe("provenance vocabulary and its coherence rules", () => {
  it("widens source to exactly the three accepted origins", () => {
    expect(CODE).toContain("check (source in ('public_booking', 'practitioner', 'legacy_import'))");
  });

  it("names the three join-date provenances", () => {
    expect(CODE).toContain("check (joined_at_provenance in ('form', 'operator_supplied', 'unknown'))");
  });

  it("lets only the public form claim 'form'", () => {
    expect(CODE).toContain("(source = 'public_booking' and joined_at_provenance = 'form')");
    expect(CODE).toContain("joined_at_provenance in ('operator_supplied', 'unknown')");
  });

  it("requires a named creator for operator-originated entries, both directions", () => {
    expect(CODE).toContain("(source = 'public_booking' and created_by_practitioner_id is null)");
    expect(CODE).toContain("(source <> 'public_booking' and created_by_practitioner_id is not null)");
  });

  it("does not relax the name constraint or add a name provenance", () => {
    expect(CODE).not.toContain("name_provenance");
    expect(CODE).not.toMatch(/drop constraint[^;]*name_check/i);
  });
});

describe("preference vocabulary and the two timestamps", () => {
  it("stores exactly the weekday/weekend/both vocabulary", () => {
    expect(CODE).toContain("check (preference in ('weekdays', 'weekends', 'both'))");
  });

  it("keeps stated_at and confirmed_at as separate NOT NULL columns", () => {
    expect(CODE).toMatch(/stated_at\s+timestamptz not null/);
    expect(CODE).toMatch(/confirmed_at\s+timestamptz not null/);
    expect(CODE).toContain("check (confirmed_at >= stated_at)");
  });

  it("names a practitioner only for a practitioner-recorded preference", () => {
    expect(CODE).toContain("(source = 'practitioner' and recorded_by_practitioner_id is not null)");
    expect(CODE).toContain("(source <> 'practitioner' and recorded_by_practitioner_id is null)");
  });
});

describe("the token is stored only as a hash", () => {
  it("declares no raw-token column", () => {
    expect(CODE).not.toMatch(/\braw_token\s+text\s+not null/);
    expect(CODE).toContain("token_hash                text not null");
  });

  it("pins the verifier shape and generates the token in the database", () => {
    expect(CODE).toContain("check (token_hash ~ '^[a-f0-9]{64}$')");
    expect(CODE).toContain("encode(extensions.gen_random_bytes(32), 'hex')");
  });

  it("permits at most one live grant per entry", () => {
    expect(CODE).toContain("where redeemed_at is null and revoked_at is null");
  });
});

describe("the server-timestamp trigger repair", () => {
  it("still forces joined_at for the public path", () => {
    expect(CODE).toContain("if new.source = 'public_booking' or new.joined_at is null then");
    expect(CODE).toContain("new.joined_at := now();");
  });

  it("stamps updated_at unconditionally", () => {
    expect(CODE).toMatch(/new\.updated_at := now\(\);\s*\n\s*return new;/);
  });

  it("revokes the replaced trigger function from all four grantees", () => {
    expect(CODE).toContain(
      "revoke all privileges on function public.new_client_waitlist_entries_server_timestamps()\n  from public, anon, authenticated, service_role;",
    );
  });
});

describe("the ordered claim keeps what the FIFO claim owns", () => {
  it("keeps contention and the single decision instant in the database", () => {
    expect(CODE).toContain("for update of e skip locked");
    expect(CODE).toContain("candidates as materialized");
    expect(CODE).toContain("decision as materialized");
    expect(CODE).toContain("select clock_timestamp() as decision_at from candidates limit 1");
  });

  it("preserves the caller's order rather than re-sorting", () => {
    expect(CODE).toContain("unnest(p_entry_ids) with ordinality");
    expect(CODE).toContain("order by r.ord");
  });

  it("bounds every element and refuses a matrix outright", () => {
    // `uuid[]` admits multidimensional values; array_length(x,1) sees only the
    // first dimension while unnest processes them all, so both the 1..100 bound
    // and invite_batch_max were undercountable. cardinality() counts every
    // element; the ndims gate refuses a shape whose ranking nobody expressed.
    expect(CODE).toContain("if coalesce(array_ndims(p_entry_ids), 1) <> 1 then");
    expect(CODE).toContain("v_n := coalesce(cardinality(p_entry_ids), 0);");
    expect(CODE).not.toContain("array_length(p_entry_ids, 1)");
  });

  it("lets a configured batch ceiling only tighten the existing bound", () => {
    expect(CODE).toContain("if v_n < 1 or v_n > 100 then");
    expect(CODE).toContain("if v_cap is not null and v_n > v_cap then");
  });
});

describe("the prospect link is bound to a live entry and to one mint instant", () => {
  // Static companions to the runtime proofs in
  // tests/db/waitlist-admission-authority.db.test.ts. They pin the SHAPE of two
  // repairs whose absence is invisible in ordinary use: the behaviour is proved
  // there, the text is pinned here so a future edit cannot quietly drop either.

  it("re-resolves the grant against the entry's lifecycle, not the grant alone", () => {
    // Removal leaves the grant's own columns valid, so a predicate reading only
    // those columns kept honouring a link on a prospect who had been taken off
    // the list. `removed` and `converted` are the only statuses 0188's
    // transition guard gives no outgoing edge.
    expect(CODE).toContain("join public.new_client_waitlist_entries e");
    expect(CODE).toContain("and e.status not in ('removed', 'converted')");
  });

  it("locks the grant row only, leaving the entry lock to the canonical order", () => {
    expect(CODE).toContain("for update of g;");
  });

  it("refuses an OPERATOR availability write for a terminal entry, same rule", () => {
    // The third writer to the preference table. Same predicate and same word as
    // the issuer, refused before the clock is read so nothing is created and no
    // stated_at / confirmed_at moves.
    const fn = CODE.slice(CODE.indexOf("create or replace function public.set_waitlist_entry_availability("));
    const body = fn.slice(0, fn.indexOf("\n$$;"));
    expect(body).toContain("select e.status into v_status");
    expect(body).toContain("if v_status in ('removed', 'converted') then");
    expect(body).toContain("return 'entry_closed';");
    expect(body.indexOf("'entry_closed'")).toBeLessThan(body.indexOf("v_now := clock_timestamp();"));
    expect(body.indexOf("'entry_closed'")).toBeLessThan(body.indexOf("insert into public.new_client_waitlist_entry_preferences"));
  });

  it("refuses to ISSUE for a terminal entry, on the same derivation", () => {
    // The pair must share one rule: redemption refuses `removed`/`converted`,
    // so minting a token for one hands back a dead credential AND parks it in
    // the one-live-grant slot. `entry_closed` is a RESULT code, not a lifecycle
    // state — `entry_not_found` would be a lie to an owner looking at the
    // entry, and admit_'s `not_admissible` names a different set (it also
    // excludes invited, expired and released, which stay issuable here).
    expect(CODE).toContain("select e.status into v_status");
    expect(CODE).toContain("if v_status in ('removed', 'converted') then");
    expect(CODE).toContain("return query select 'entry_closed'::text, null::text, null::timestamptz;");
  });

  it("decides the lifecycle BEFORE reading the clock, so a refusal mutates nothing", () => {
    // The refusal returns ahead of the expired-grant retirement and the insert.
    const issuer = CODE.slice(CODE.indexOf("create or replace function public.issue_waitlist_preference_grant("));
    const body = issuer.slice(0, issuer.indexOf("\n$$;"));
    expect(body.indexOf("'entry_closed'")).toBeGreaterThan(-1);
    expect(body.indexOf("'entry_closed'")).toBeLessThan(body.indexOf("v_now := clock_timestamp();"));
    expect(body.indexOf("'entry_closed'")).toBeLessThan(body.indexOf("insert into public.new_client_waitlist_preference_grants"));
  });

  it("writes issued_at from the post-lock mint rather than the column default", () => {
    // `default now()` is transaction start; expires_at comes from the post-lock
    // clock_timestamp() in v_now. Defaulting the column makes
    // expires_at - issued_at longer than the TTL that was actually granted.
    expect(CODE).toContain("(studio_id, entry_id, token_hash, issued_at, expires_at,");
    expect(CODE).toContain("       issued_by_practitioner_id)");
    expect(CODE).toContain("values (p_studio_id, p_entry_id, v_hash, v_now, v_expires, v_actor);");
  });
});

describe("every command re-derives owner authority in the database", () => {
  it.each(COMMANDS.filter(([fn]) => !fn.includes("redeem")))(
    "%s resolves the actor through new_client_waitlist_resolve_owner",
    (fn) => {
      const body = CODE.slice(CODE.indexOf(`create or replace function ${fn}(`));
      expect(body.slice(0, 4000)).toContain("new_client_waitlist_resolve_owner");
    },
  );

  it("the prospect path takes NO actor and NO studio from its caller", () => {
    // Authority is the token alone, so there is no id to forge.
    expect(CODE).toContain("public.redeem_waitlist_preference_grant(\n  p_raw_token  text,\n  p_preference text\n)");
  });

  it("declares every command SECURITY DEFINER with a pinned search_path", () => {
    const defs = Array.from(CODE.matchAll(/create or replace function public\.[a-z_]+\([\s\S]*?\$\$;/g));
    expect(defs.length).toBeGreaterThanOrEqual(COMMANDS.length);
    for (const d of defs) {
      expect(d[0]).toContain("security definer");
      expect(d[0]).toContain("set search_path = pg_catalog, pg_temp");
    }
  });
});

// ===========================================================================
// THE LOCK-DISCIPLINE AUDIT — mechanical, not a checklist
// ===========================================================================
//
// FIVE ROUNDS OF REVIEW FOUND FOUR SEPARATE LOCK DEFECTS IN THIS FILE, each one
// created by the repair before it, and each found by a human reading the SQL
// rather than by anything that could fail on its own. The last round is the
// reason this block exists: an exact-head review caught ONE command missing the
// studio lock, and a mechanical sweep of every command then found THREE MORE
// that were equally exposed and that nobody had flagged.
//
// So the rule is enforced here instead of remembered:
//
//   A 0193 command that writes a table carrying a `studios` foreign key MUST
//   take `studios ... for no key update` FIRST.
//
// WHY THE WRITE IMPLIES A STUDIO LOCK. Writing such a table takes an FK KEY
// SHARE lock on `studios` whether or not the command asks for one. Without an
// explicit lock the order is decided by whichever statement happens to run
// last, which is how the command ended up holding an entry and then reaching
// for the studio -- the exact inversion 0192's issuer deadlocks against.
//
// WHY `no key update` AND NOT `for update`. FOR UPDATE conflicts with KEY
// SHARE, so a studio-first FOR UPDATE moves the cycle rather than closing it:
// the 0185/0188 lifecycle writers hold an entry and then request KEY SHARE
// through their status-event trigger. NO KEY UPDATE is compatible with KEY
// SHARE and still excludes another NO KEY UPDATE, so cooperating writers
// serialise and FK checks pass. Measured, not assumed -- see the matrix
// assertion in tests/db/waitlist-admission-authority.db.test.ts.
//
// The transitive case is the one a reader misses: writing
// new_client_waitlist_entries fires 0185's record_event trigger, which inserts
// into new_client_waitlist_entry_events -- a table with its own studios FK.
// THE LOCK-DISCIPLINE AUDIT LIVES IN tests/db/waitlist-lock-discipline.db.test.ts.
//
// It began here, as a text parser over this file. Review found FIVE holes in it
// across two rounds, every one the same shape -- a valid PostgreSQL spelling the
// matcher did not recognise: a delegating command whose writes were all in its
// callees, a hard-coded list of studios-FK tables, `MERGE INTO`, overloads
// collapsed by bare name, and an ordering check that skipped any command which
// wrote before locking.
//
// A text matcher will always have another spelling it does not know, so the
// audit now derives its facts from pg_constraint, pg_proc and pg_trigger. That
// costs it a migrated database, and buys a guard that cannot be walked around by
// rewriting a statement. What remains HERE is the source contract: what this
// migration SAYS. What it DOES under concurrency is proved next door.
