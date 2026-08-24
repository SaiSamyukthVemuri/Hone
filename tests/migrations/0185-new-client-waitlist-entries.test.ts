import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  countVersion,
  fileForVersion,
  migrationState,
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
  // The "nothing above me" tripwire moved to 0186 when it landed: per
  // CLAUDE.md only the CURRENT repository maximum may assert isRepoMax, so
  // that a new migration does not turn every older per-migration test red.
  // Uniqueness of this version is still this file's own business.
  it("exists exactly once", () => {
    expect(countVersion(VERSION)).toBe(1);
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

// ===========================================================================
// CURRENT HOSTED STATE — 0185 OWNS IT NOW
// ===========================================================================
//
// Inherited from 0184's block at the apply hand-off. Whichever migration is
// the applied head owns these facts; a superseded migration's file must not
// keep deciding them, or it has to be rewritten on every future apply.
//
// 0185 was applied to production on 2026-08-23. It is now FROZEN: any
// correction is a NEW migration.

function canonicalRecord(): {
  hosted_migration_max: string;
  hosted_applied_at: string;
  hosted_applied_at_precision: string;
  hosted_note: string;
} {
  return JSON.parse(
    readFileSync(path.join(ROOT, "docs/production/migration-state.json"), "utf8"),
  );
}

/** The marker that separates the head record from the carried history. */

/**
 * The frozen checksums the carried history must never lose, head to oldest.
 * Exactly the anchors the retired 0184 helper protected. A record that drops
 * one has truncated production apply history, however well-formed its head
 * still reads.
 */
/**
 * THE INTEGRITY BOUNDARY: a digest of the ENTIRE carried 0184 record.
 *
 * Four named anchors were not enough, and the way they failed is worth keeping
 * written down. They closed suffix truncation but said nothing about the middle
 * of the chain: deleting the whole 0180 clause drops 261 characters and that
 * record's checksum while leaving all four anchors present, so an enumeration
 * passed while apply history was gone. `toContain` is also order-blind.
 *
 * Enumerating all thirteen carried records would just be a longer list with the
 * same shape of gap — the next omission would be mine again. So the boundary is
 * now ONE invariant that cannot be partially satisfied: the carried record must
 * be byte-identical to the 0184 `hosted_note` as it existed on this PR's
 * production base, 48f0238900c07bd5d2dfed5c1ebbd832e77fdc50.
 *
 * Derived mechanically from that commit — `git show <base>:docs/production/
 * migration-state.json`, parse `hosted_note`, sha256 the exact UTF-8 bytes. Not
 * copied from prose, not taken from this branch's own suffix, no whitespace
 * normalisation, no trimming.
 *
 * It covers the 0184 narrative and every link behind it — 0183, 0182, 0181,
 * 0180, 0179, 0178, 0177, 0176, 0175, 0174, 0173, 0172 and the 0171 tail —
 * with every checksum, every evidence statement and the exact ordering.
 */
const CARRIED_0184_NOTE_SHA256 =
  "a65f858e18b997279dc56a53161669480881eb525e1674c490554335827c68be";

/**
 * THE ONE DELIMITER. Where the 0185 head stops and the frozen 0184 record
 * begins, used by BOTH the positional current-state guard and the whole-record
 * digest — there is deliberately no second definition.
 *
 * There briefly was. `splitNote` searched the bare prefix "CARRIES THE FULL
 * CHECKSUM CHAIN FORWARD" while the digest searched this full phrase, so the
 * two guards split the note at different points. A stray mention of the bare
 * words inside the head ended `head` early, and a second current-record claim
 * placed after that mention but before the real delimiter fell into neither
 * guard's view: the uniqueness check never saw it, and the digest — reading
 * from the later, real delimiter — was still correct. Two definitions of one
 * boundary is the whole defect, so there is now one.
 *
 * The carried record contains this same phrase (0184 carried its own chain
 * forward), so the FIRST occurrence is the boundary.
 */
const CARRIED_RECORD_BOUNDARY =
  "CARRIES THE FULL CHECKSUM CHAIN FORWARD so no earlier apply record is dropped: ";

/**
 * Readable landmarks only. These are no longer the integrity boundary — the
 * digest above is — but they name what a reader should expect to find, and a
 * failure here is easier to interpret than a digest mismatch.
 */
const CARRIED_CHAIN_ANCHORS: ReadonlyArray<readonly [string, string]> = [
  ["0183", "a7b8926832747319024d7c89213688b68fb363d09e88317e3bba6dbb17c6fbeb"],
  ["0182", "07ee23e1254329168e205f42b47c351205ebb306afc0f7d524b69c8d14ecda57"],
  ["0181", "2f5bcbd5854b1201835f6151debffa940e98035e6a4d88865da1d86fb3da195f"],
  ["0171", "f4e8535093721c6fb9c677925a3e4a8f202e3f2ad56b6d6208da608f5d2a62e6"],
];
const SUPERSESSION = /SUPERSEDES the (\d{4}) record as the CURRENT hosted-state record/;

/**
 * Split the canonical note into the HEAD record and the carried CHAIN.
 *
 * The note is written newest-first: the active record, then the chain-forward
 * marker, then every superseded record verbatim. That ordering is what makes
 * "active" separable from "historical" without rewriting history.
 */
function splitNote(note: string): { head: string; chain: string } {
  const at = note.indexOf(CARRIED_RECORD_BOUNDARY);
  if (at < 0) throw new Error("canonical note carries no 0184 record boundary");
  return { head: note.slice(0, at), chain: note.slice(at) };
}

/** The frozen 0184 record carried inside the current note, exactly. */
function carriedRecord(note: string): string {
  const at = note.indexOf(CARRIED_RECORD_BOUNDARY);
  if (at < 0) throw new Error("canonical note carries no 0184 record boundary");
  return note.slice(at + CARRIED_RECORD_BOUNDARY.length);
}

/** THE integrity boundary. One invariant, impossible to partially satisfy. */
function assertCarriedRecordIntact(note: string): void {
  const digest = createHash("sha256")
    .update(carriedRecord(note), "utf8")
    .digest("hex");
  expect(
    digest,
    "the carried 0184 record is no longer byte-identical to the production-base " +
      "hosted_note: apply history has been edited, truncated or reordered",
  ).toBe(CARRIED_0184_NOTE_SHA256);
}

/**
 * THE ACTIVE-RECORD INVARIANT.
 *
 * Deliberately NOT "the phrase appears exactly once in the note". Historical
 * records may — and now do — truthfully preserve the exact words they used
 * while they were current; 0184's own supersession of 0183 is immutable
 * evidence and must survive verbatim. Counting occurrences globally would
 * force a rewrite of frozen history to satisfy a guard, which is backwards.
 *
 * So the law is positional: the HEAD names exactly one current record, and it
 * is 0185 superseding 0184. Everything after the chain marker is history and
 * may say whatever it truthfully said at the time.
 */
function assertActiveRecordIs(note: string, expectedSuperseded: string): void {
  const { head, chain } = splitNote(note);

  const inHead = [...head.matchAll(new RegExp(SUPERSESSION, "g"))];
  expect(
    inHead.length,
    "the HEAD of the canonical note must name exactly ONE current hosted record",
  ).toBe(1);
  expect(
    inHead[0][1],
    "the active supersession must name the migration being replaced",
  ).toBe(expectedSuperseded);

  // No stray "X is CURRENT" claim in the head beyond that one supersession.
  const currentClaims = head.split("as the CURRENT hosted-state record").length - 1;
  expect(currentClaims, "a second current-record claim in the head").toBe(1);

  // The head must be the record for the migration that is actually applied.
  expect(head).toContain(`${fileForVersion(VERSION)} APPLIED to production`);

  // AND THE CARRIED RECORD MUST BE BYTE-IDENTICAL TO THE FROZEN ORIGINAL.
  // This is the integrity boundary; the anchors below are landmarks.
  assertCarriedRecordIntact(note);

  // Landmarks, kept for readability.
  for (const [label, sha] of CARRIED_CHAIN_ANCHORS) {
    expect(chain, `carried chain lost its ${label} checksum anchor`).toContain(sha);
  }
}

describe("0185 — current hosted state", () => {
  it("is the APPLIED production head", () => {
    const state = migrationState();
    // 0185 is what production has RUN. Whether the repository has since
    // claimed a higher number is a different question and not this file's:
    // migration-first ordering means a claimed-but-unapplied migration is the
    // NORMAL state between merge and apply.
    expect(state.hosted_migration_max).toBe(VERSION);
    expect(state.pending_migrations).not.toContain(VERSION);
    expect(Number(state.repo_migration_max)).toBeGreaterThanOrEqual(
      Number(VERSION),
    );
  });

  it("the canonical apply record is 0185's, and its precision is stated", () => {
    const rec = canonicalRecord();
    expect(rec.hosted_migration_max).toBe(VERSION);
    // Operator-observed close of the apply window, NEVER a server timestamp.
    expect(rec.hosted_applied_at).toBe("2026-08-23T20:31:39Z");
    expect(rec.hosted_applied_at_precision).toMatch(/operator-observed/i);
    expect(rec.hosted_applied_at_precision).toMatch(
      /NOT a server-generated migration timestamp/i,
    );
    expect(rec.hosted_note).toMatch(/PUSH EXIT CODE 0 EXPLICITLY CAPTURED/);
    expect(rec.hosted_note).toMatch(/DRY-RUN EXIT 0/);
  });

  it("carries 0185's production checksum, matching the file on disk", () => {
    const digest = createHash("sha256").update(SQL, "utf8").digest("hex");
    expect(digest).toBe(
      "663a5d826d4c9e610c3bf7ec599dea577772ba521326488add77153f39a14ffc",
    );
    expect(canonicalRecord().hosted_note).toContain(digest);
  });

  it("records the dark-state facts, so a reader cannot infer activation", () => {
    const note = canonicalRecord().hosted_note;
    expect(note).toMatch(/ROW COUNT 0/);
    expect(note).toMatch(/NO synthetic production prospect was inserted/i);
    expect(note).toMatch(/WILLOW IS NOT ENABLED/);
    expect(note).toMatch(/PUBLIC PRIVACY POLICY IS\s+UNCHANGED/);
    expect(note).toMatch(/ABSENT from the Vercel Production environment/i);
  });

  it("THE ACTIVE RECORD IS 0185 SUPERSEDING 0184", () => {
    assertActiveRecordIs(canonicalRecord().hosted_note, "0184");
  });

  it("carried HISTORY may keep its original current-record wording", () => {
    // The point of the positional law. 0184's own supersession of 0183 is
    // frozen evidence living in the chain; it must NOT have to be rewritten,
    // and its presence must NOT fail the guard.
    const { chain } = splitNote(canonicalRecord().hosted_note);
    expect(chain).toContain(
      "SUPERSEDES the 0183 record as the CURRENT hosted-state record",
    );
    expect(() =>
      assertActiveRecordIs(canonicalRecord().hosted_note, "0184"),
    ).not.toThrow();
  });

  it("ANTI-VACUITY: a wrong or duplicated ACTIVE record is caught", () => {
    // Mutates a COPY. The real record is never touched.
    const note = canonicalRecord().hosted_note;
    expect(() => assertActiveRecordIs(note, "0184")).not.toThrow();

    // (a) the active transition naming the wrong migration
    const wrongTarget = note.replace(
      "SUPERSEDES the 0184 record as the CURRENT",
      "SUPERSEDES the 0183 record as the CURRENT",
    );
    expect(wrongTarget).not.toEqual(note);
    expect(() => assertActiveRecordIs(wrongTarget, "0184")).toThrow();

    // (b) a SECOND current-record claim injected into the head
    const doubled = note.replace(
      "SUPERSEDES the 0184 record as the CURRENT hosted-state record",
      "SUPERSEDES the 0184 record as the CURRENT hosted-state record and also " +
        "the 0182 record as the CURRENT hosted-state record",
    );
    expect(doubled).not.toEqual(note);
    expect(() => assertActiveRecordIs(doubled, "0184")).toThrow();

    // (c) the chain truncated away entirely
    const truncated = note.slice(
      0,
      note.indexOf(CARRIED_RECORD_BOUNDARY) + CARRIED_RECORD_BOUNDARY.length + 10,
    );
    expect(() => assertActiveRecordIs(truncated, "0184")).toThrow();
  });

  it("ANTI-VACUITY: truncating the chain after the 0184 -> 0183 handoff is caught", () => {
    // The exact case a character-count threshold missed. Cut the note right
    // after the historical 0184 -> 0183 supersession: the head is untouched,
    // that wording survives, and ~3,500 characters remain — so a length check
    // passes while 0183, 0182, 0181 and 0171 have all been dropped.
    const note = canonicalRecord().hosted_note;
    const clause = "SUPERSEDES the 0183 record as the CURRENT hosted-state record";
    const truncated = note.slice(0, note.indexOf(clause) + clause.length);

    // The truncation really is the shape that used to slip through.
    const { chain } = splitNote(truncated);
    expect(chain.length).toBeGreaterThan(500);
    expect(chain).toContain(clause);
    for (const [, sha] of CARRIED_CHAIN_ANCHORS) {
      expect(truncated).not.toContain(sha);
    }

    // ...and it now fails.
    expect(() => assertActiveRecordIs(truncated, "0184")).toThrow();
  });

  it("CONTROL 0 — a stray mention of the bare phrase cannot hide a second claim", () => {
    // The defect this unification closes, reproduced end to end.
    //
    // When `splitNote` searched the bare prefix and the digest searched the
    // full delimiter, the two guards split the note at DIFFERENT points. Put a
    // bare "CARRIES THE FULL CHECKSUM CHAIN FORWARD" inside the head, then a
    // second current-record claim after it but still before the real
    // delimiter, and that claim landed in the gap: the uniqueness check never
    // saw it, and the digest — reading from the later, real delimiter — was
    // still perfectly correct.
    const note = canonicalRecord().hosted_note;
    const anchor = "0185 IS NOW FROZEN.";
    expect(note).toContain(anchor);
    const injection =
      "This record CARRIES THE FULL CHECKSUM CHAIN FORWARD. It also names " +
      "the 0182 record as the CURRENT hosted-state record. ";
    const mutated = note.replace(anchor, injection + anchor);
    expect(mutated).not.toEqual(note);

    // The mutation really is the reported shape.
    const BARE = "CARRIES THE FULL CHECKSUM CHAIN FORWARD";
    const bareAt = mutated.indexOf(BARE);
    const realAt = mutated.indexOf(CARRIED_RECORD_BOUNDARY);
    expect(bareAt).toBeGreaterThan(-1);
    expect(realAt).toBeGreaterThan(bareAt); // the stray mention comes FIRST

    // (a) THE OLD SPLIT WOULD HAVE HIDDEN IT. Cutting at the bare prefix
    //     produces a head containing ZERO current-record claims, while two are
    //     genuinely present before the real delimiter.
    const oldHead = mutated.slice(0, bareAt);
    const trueHead = mutated.slice(0, realAt);
    expect(oldHead.split("as the CURRENT hosted-state record").length - 1).toBe(0);
    expect(trueHead.split("as the CURRENT hosted-state record").length - 1).toBe(2);

    // (b) THE CARRIED DIGEST IS UNAFFECTED, which is why the digest alone could
    //     never have caught this.
    expect(() => assertCarriedRecordIntact(mutated)).not.toThrow();
    for (const [, sha] of CARRIED_CHAIN_ANCHORS) {
      expect(mutated).toContain(sha);
    }

    // (c) THE UNIFIED BOUNDARY SEES IT. Both guards now split at the same
    //     delimiter, so the second claim is inside HEAD and is rejected.
    expect(splitNote(mutated).head).toBe(trueHead);
    expect(() => assertActiveRecordIs(mutated, "0184")).toThrow();
  });

  it("CONTROL 3 — the real carried record matches the frozen digest", () => {
    const note = canonicalRecord().hosted_note;
    const carried = carriedRecord(note);
    expect(carried.length).toBe(6101);
    expect(createHash("sha256").update(carried, "utf8").digest("hex")).toBe(
      CARRIED_0184_NOTE_SHA256,
    );
    expect(() => assertCarriedRecordIntact(note)).not.toThrow();
  });

  it("CONTROL 1 — MID-CHAIN DELETION is caught (the exact reported case)", () => {
    // Codex's reproduction: remove the whole 0180 clause. All four landmark
    // anchors survive, so the enumeration this replaced still passed while that
    // record's checksum and evidence were gone.
    const note = canonicalRecord().hosted_note;
    const from = note.indexOf("the 0180 record (");
    const to = note.indexOf("the 0179 record (");
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const mutated = note.slice(0, from) + note.slice(to);

    // It really is the reported shape: shorter, 0180's checksum gone, and every
    // landmark anchor still present.
    expect(mutated.length).toBeLessThan(note.length);
    expect(mutated).not.toContain(
      "d5d8271da38588a89e0727ce7a2a5c417ee8e079ad283acdc1fa55f90727eb8d",
    );
    for (const [, sha] of CARRIED_CHAIN_ANCHORS) {
      expect(mutated).toContain(sha);
    }

    // ...and the digest catches it.
    expect(() => assertCarriedRecordIntact(mutated)).toThrow();
    expect(() => assertActiveRecordIs(mutated, "0184")).toThrow();
  });

  it("CONTROL 2 — REORDERING carried links is caught", () => {
    // Same bytes, different order. Every anchor is present and nothing is
    // missing, so no containment check could ever see this.
    const note = canonicalRecord().hosted_note;
    const a = "the 0177 record (";
    const b = "the 0176 record (";
    const c = "the 0175 record (";
    const ia = note.indexOf(a), ib = note.indexOf(b), ic = note.indexOf(c);
    expect(ia).toBeGreaterThan(-1);
    expect(ib).toBeGreaterThan(ia);
    expect(ic).toBeGreaterThan(ib);
    const swapped =
      note.slice(0, ia) + note.slice(ib, ic) + note.slice(ia, ib) + note.slice(ic);

    // Nothing lost — identical length, and every anchor still present.
    expect(swapped.length).toBe(note.length);
    expect(swapped).not.toEqual(note);
    for (const [, sha] of CARRIED_CHAIN_ANCHORS) {
      expect(swapped).toContain(sha);
    }

    // ...and the digest catches it.
    expect(() => assertCarriedRecordIntact(swapped)).toThrow();
  });

  it("each carried anchor is load-bearing on its own", () => {
    // Dropping any SINGLE checksum must fail, not just wholesale truncation.
    const note = canonicalRecord().hosted_note;
    for (const [label, sha] of CARRIED_CHAIN_ANCHORS) {
      const without = note.split(sha).join("REMOVED");
      expect(without, label).not.toEqual(note);
      expect(
        () => assertActiveRecordIs(without, "0184"),
        `losing the ${label} anchor went undetected`,
      ).toThrow();
    }
  });

  it("the positional law is NOT a global phrase count", () => {
    // What separates the positional law from counting: the real record already
    // contains a SECOND "as the CURRENT hosted-state record" — 0184's own
    // supersession of 0183, frozen inside the carried chain — and the guard
    // passes anyway. A global count would fail here and would force frozen
    // history to be rewritten on every apply.
    const note = canonicalRecord().hosted_note;
    expect(note.split("as the CURRENT hosted-state record").length - 1).toBeGreaterThan(1);
    expect(() => assertActiveRecordIs(note, "0184")).not.toThrow();

    // (Appending to the chain is no longer a legitimate operation to tolerate:
    // the carried record is byte-frozen by digest, and the controls below prove
    // that any edit to it — deletion, reordering — is caught.)
  });
});
