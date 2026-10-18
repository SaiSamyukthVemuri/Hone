import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  countVersion,
  fileForVersion,
  isRepoMax,
  versionsAbove,
} from "./helpers/migration-state";

// ===========================================================================
// Migration 0223 — machine inventory, the remembered selection, and versioned
// treatment-setup readings (MPX-02, #829). SOURCE CONTRACT.
//
// BEHAVIOUR IS PROVED AGAINST A REAL DATABASE in
// tests/db/machine-setup-storage.db.test.ts, which CALLS all four commands.
// That division matters here more than usual: 0204 shipped a command writing
// to a column that did not exist, and it applied clean, passed its source test
// and had never once succeeded. A source test cannot see inside a plpgsql body.
//
// WHAT THIS FILE PINS is what a behavioural test cannot: that the grant posture
// names every role explicitly, that the write path is the only write path, that
// no existing applied migration is touched, and that the catalogue's profile
// ids are NOT frozen into applied SQL - because activation is a reviewed
// evidence decision, and a CHECK listing today's ids would make it a schema
// change instead.
// ===========================================================================

const VERSION = "0223";
const FILE = "0223_machine_inventory_and_setup_readings.sql";
const SQL = readFileSync(
  path.join(process.cwd(), "supabase/migrations", FILE),
  "utf8",
);
// LINE comments first: a block-comment-first strip eats real code, and the
// prose here legitimately names tables it must not write to.
//
// `comment on ... ;` is then stripped too, and that is not cosmetic: those
// strings are REAL SQL, so the phrase "A UI default only" inside one of them
// satisfied a negative assertion about column DEFAULTS. Comment text must
// neither satisfy nor break a code assertion.
const CODE = SQL.replace(/^\s*--.*$/gm, " ").replace(/comment on [\s\S]*?;/gi, " ");

const COMMANDS = [
  "public.register_studio_machine(uuid, text, integer, text, text[])",
  "public.retire_studio_machine(uuid)",
  "public.set_own_default_machine(uuid, uuid, text)",
  // +text: `p_new_group_ref`, the caller's own placeholder for a group it
  // is creating. Identities are ISSUED (Codex, #860 4305780322).
  "public.record_treatment_setup_group(uuid, uuid, text, text, smallint[], jsonb, uuid, uuid, text)",
  // ONE SAVE of every settings group, atomically. An ENTRY POINT - granted to
  // `authenticated` - so every posture rule below applies to it unchanged.
  "public.record_treatment_setup_submission(uuid, uuid, text, text, jsonb, uuid, uuid)",
  // THE INITIAL SAVE: the treatment area AND its machine settings, in one
  // transaction. Also an entry point, and the long signature is the price of
  // DELEGATING the area to 0166's command instead of writing a second path to
  // `session_blocks` - see the guard below.
  "public.create_block_with_initial_setup(uuid, uuid, jsonb, jsonb, jsonb, boolean, text, text[], text, uuid, text, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric, uuid, text, text, jsonb)",
] as const;

// THE TWO SHARED BUILDING BLOCKS, which are deliberately NOT entry points.
//
// `record_treatment_setup_group` and `record_treatment_setup_submission` need
// identical answers to identical questions - whose studio, is it live, is the
// caller a member, is this machine in service, what does the contract say
// about this field - and a validation rule that exists twice is one that will
// eventually disagree with itself. So the rules live in these two, and both
// commands call them.
//
// They are listed separately because the posture rules for them are DIFFERENT,
// not absent: all four roles revoked, and granted back to NOTHING.
const INTERNALS = [
  "public.assert_setup_scope(uuid, uuid, uuid, uuid)",
  // +boolean: `p_group_is_new`, REQUIRED, so both doors must state whether
  // the key they pass is a new identity or one being revised.
  "public.record_setup_group_in_scope(uuid, uuid, uuid, uuid, text, integer, text[], text, text, smallint[], jsonb, uuid, text[], boolean)",
] as const;

/**
 * 0223's code with the DELEGATING WRAPPER removed.
 *
 * `create_block_with_initial_setup` creates the treatment area and records the
 * machine settings in one transaction, and it does that by CALLING 0166's
 * `create_block_with_entry` rather than writing a block itself - so
 * `session_blocks` keeps a single write path. Forwarding that command means
 * DECLARING its twenty-six parameters, whose names are the legacy schema's
 * vocabulary: `p_apilus_modality`, `p_energy_level`, `p_machine_frequency`.
 *
 * Two raw-text bans in this file trip on those names: "0223 reads and
 * rewrites no existing clinical column", and "no model id belongs in applied
 * SQL" (which bans the substring `apilus`). Neither is being violated - a
 * forwarded parameter name is not a read, a write, or a frozen model id - but
 * a substring ban cannot tell the difference.
 *
 * SO THE EXEMPTION IS NARROW AND PAID FOR. The two bans skip this one
 * function, and in exchange the suite below asserts the thing they were
 * PROXIES for, directly and more strictly: the wrapper performs no DML at all
 * against any existing clinical table, and reaches the block only through
 * 0166's command.
 */
function codeWithoutWrapper(): string {
  const at = CODE.indexOf(
    "create or replace function public.create_block_with_initial_setup(",
  );
  if (at === -1) return CODE;
  const end = CODE.indexOf("$$;", at);
  expect(end, "the wrapper must be a complete function body").toBeGreaterThan(at);
  return CODE.slice(0, at) + CODE.slice(end + 3);
}

/**
 * One SQL statement, in one spelling.
 *
 * Collapses whitespace runs to a single space and removes it around `( ) , ;`
 * so that `f(uuid, text)`, `f(uuid,text)` and a signature split across lines
 * are all the same string. Applied to BOTH the source and the needle, or the
 * normalisation would just move the mismatch.
 */
function squash(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\s*([(),;])\s*/g, "$1");
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The body of one `create or replace function` in the migration. */
function bodyOf(name: string): string {
  const at = CODE.indexOf(`create or replace function public.${name}`);
  expect(at, `${name} is not in the migration`).toBeGreaterThan(-1);
  return CODE.slice(at).split("$$;")[0]!;
}

describe("0223 sits correctly in the migration sequence", () => {
  it("is no longer the repository maximum", () => {
    // HANDED OFF in the Fett composition (integration/fett-composed-824): 0224
    // (Audit) sits above it, and only the CURRENT max's own test may assert
    // isRepoMax (CLAUDE.md §2). On #860's own branch 0223 is still the max.
    // DERIVED, NOT PINNED.
    expect(isRepoMax(VERSION)).toBe(false);
    const above = versionsAbove(VERSION);
    expect(above.length, "nothing sits above this older migration").toBeGreaterThan(0);
    expect(above.every((v) => Number(v) > Number(VERSION))).toBe(true);
  });

  it("is allocated exactly once, at the number the census derived", () => {
    expect(countVersion(VERSION)).toBe(1);
    expect(fileForVersion(VERSION)).toBe(FILE);
  });

  it("opens its own transaction with a lock timeout", () => {
    // `supabase db push` does NOT wrap a file in a transaction, so a bare
    // `SET LOCAL` emits 25P01 and never arms. See CLAUDE.md §5.
    expect(CODE).toMatch(/^begin;/m);
    expect(CODE).toMatch(/^commit;/m);
    expect(CODE).toMatch(/^set local lock_timeout = '5s';/m);
  });

  it("records WHY it sits above a gap, rather than leaving it to be discovered", () => {
    // 0211-0222 were claimed by other lanes when this was authored, so the
    // contiguous-pending-suffix guard cannot be satisfied from this tree alone.
    // The file says so in prose; this pins that it keeps saying so.
    expect(SQL).toMatch(/contiguous/i);
    expect(SQL).toMatch(/0211-0222/);
  });
});

describe("0223 is additive, and touches no existing value", () => {
  it("creates its seven tables and alters only practitioners", () => {
    expect(CODE).toMatch(/create table if not exists public\.studio_machines/);
    expect(CODE).toMatch(
      /create table if not exists public\.treatment_setup_readings/,
    );
    // The field contract, added when authoritative validation moved into the
    // command's authority boundary.
    expect(CODE).toMatch(
      /create table if not exists public\.machine_profile_field_contract/,
    );
    // The MODE-level half, separate so a field cannot disagree with its own
    // mode about how many channels exist.
    expect(CODE).toMatch(
      /create table if not exists public\.machine_profile_mode_contract/,
    );
    // The CAPTURE: one atomic act of recording a settings group. Readings hang
    // off it, which is what makes a retrieved setup one real thing rather than
    // a per-field composite.
    expect(CODE).toMatch(
      /create table if not exists public\.treatment_setup_captures/,
    );
    // THE SAVE: one press of Save, tying together the groups it produced.
    // Without it, several groups were several independent calls and three
    // invariants were unreachable - atomicity, cross-group channel
    // exclusivity, and a safe retry after a lost response
    // (Codex, #860 6157725545).
    expect(CODE).toMatch(
      /create table if not exists public\.treatment_setup_submissions/,
    );
    // And the capture's link back to it is NULLABLE, which is load-bearing: a
    // capture recorded before submissions existed has none, and that is a
    // historical fact rather than missing data. A NOT NULL here would have
    // forced a backfill that guesses which captures were once saved together.
    expect(CODE).toMatch(
      /add column if not exists setup_submission_id uuid\s*\n?\s*references public\.treatment_setup_submissions/,
    );
    // THE CREATE CLAIM: the receipt that makes the INITIAL save repeatable.
    // The submission command's retry key is unique per BLOCK and this command
    // creates the block, so a repeat had nothing to collide with and a lost
    // answer produced a second treatment area - measured on a real database
    // before this table existed, not reasoned about.
    expect(CODE).toMatch(
      /create table if not exists public\.treatment_area_create_claims/,
    );
    // UNIQUE PER (SESSION, KEY), which is the whole mechanism: the anchor has
    // to be something that PRE-EXISTS the thing the key protects, and the
    // session is the only such row here.
    expect(CODE).toMatch(
      /constraint treatment_area_create_claims_key_uniq\s*\n?\s*unique \(session_id, idempotency_key\)/,
    );
    // AND 0166 STAYS FROZEN. The earlier note in this migration predicted the
    // fix would need an idempotency key on `create_block_with_entry` itself;
    // it did not, and nothing here may edit that command.
    expect(CODE).not.toMatch(/create or replace function public\.create_block_with_entry/);

    const alters = CODE.match(/^alter table public\.(\w+)/gm) ?? [];
    const altered = new Set(
      alters.map((a) => a.replace(/^alter table public\./, "")),
    );
    // `alter table` also covers `enable row level security` on the new tables,
    // which is expected; what matters is that no OTHER existing table is in it.
    altered.delete("studio_machines");
    altered.delete("treatment_setup_readings");
    altered.delete("machine_profile_field_contract");
    altered.delete("machine_profile_mode_contract");
    altered.delete("treatment_setup_captures");
    altered.delete("treatment_setup_submissions");
    altered.delete("treatment_area_create_claims");
    expect([...altered]).toEqual(["practitioners"]);
  });

  it("creates the field contract EMPTY, naming no model", () => {
    // The table exists so the command can validate against it, but populating
    // it from a migration would turn model ACTIVATION - an evidence review -
    // into a schema fact. Rows arrive at runtime from the application
    // catalogue through the owner-gated sync command.
    // Scoped to MIGRATION TOP LEVEL. The sync function must of course insert
    // into the table - that is how rows arrive - so the function bodies are
    // stripped first and the claim is about what the migration itself writes
    // when it runs. A blunt whole-file ban fails on the function and would
    // have to be deleted, losing the guarantee entirely.
    const topLevel = CODE.replace(
      /create or replace function[\s\S]*?\$\$;/g,
      "",
    );
    expect(topLevel).not.toMatch(
      /insert into public\.machine_profile_field_contract/,
    );
    expect(CODE).toMatch(
      /create or replace function public\.sync_machine_profile_contract/,
    );
    // AND IT IS NOT GRANTED TO A USER ROLE. This is the cross-tenant hole:
    // the contract is global, so a studio owner authoring one changes what
    // every other studio records against. EXECUTE goes to service_role -
    // deployment authority - and `authenticated` is revoked and never granted
    // back.
    const sig =
      "public.sync_machine_profile_contract(text, integer, text, smallint, text, jsonb)";
    expect(CODE).toContain(`revoke execute on function ${sig} from authenticated;`);
    expect(CODE).toContain(`grant execute on function ${sig} to service_role;`);
    expect(CODE).not.toContain(`grant execute on function ${sig} to authenticated;`);
    // And no real model name reaches the migration through this table either.
    for (const name of ["Apilus", "Silhouet", "Permanence", "Dectro", "GEMM"]) {
      expect(topLevel, `${name} must not appear in the migration`).not.toContain(
        name,
      );
    }
  });

  it("makes the recording command FAIL CLOSED without a published contract", () => {
    // The bypass this closes is "do not sync": if a missing contract meant
    // "skip validation", the check would be decorative.
    //
    // THIS READS THE SHARED WRITER, NOT THE COMMAND, and the move is the point
    // rather than a weakening of it. Every rule below used to sit inline in
    // `record_treatment_setup_group`; it now sits in
    // `record_setup_group_in_scope`, which that command and
    // `record_treatment_setup_submission` both call - so one definition, two
    // callers, and no path on which a clinical rule can quietly not apply.
    //
    // The callers are pinned at the bottom of this test. Without that, the
    // extraction could be hollowed out - a wrapper that stopped calling the
    // writer would leave every assertion here passing against code nothing
    // executes.
    const fn = /create or replace function public\.record_setup_group_in_scope[\s\S]*?\$\$;/.exec(
      CODE,
    );
    expect(fn).not.toBeNull();
    expect(fn![0]).toMatch(/No field contract is published/);
    // And it DERIVES the unit and precision rather than inserting the
    // caller's. The old shape read them straight off the payload.
    expect(fn![0]).not.toMatch(/btrim\(v_item->>'native_unit'\)/);
    expect(fn![0]).not.toMatch(/\(v_item->>'decimals'\)::smallint/);
    expect(fn![0]).toMatch(/v_unit,/);
    expect(fn![0]).toMatch(/v_decimals,/);
    // The revision is computed PER CAPTURE, not per field, and not accepted
    // from the caller. Per-field allocation is what let one block's fields sit
    // at different revisions and a per-field "latest" assemble a composite
    // that was never a real setting.
    expect(fn![0]).toMatch(/coalesce\(max\(c\.revision\), 0\) \+ 1/);
    expect(fn![0]).not.toMatch(/v_item->>'revision'/);
    // Allocated under a transaction-scoped advisory lock on (block, group), so
    // two concurrent captures cannot read the same max.
    expect(fn![0]).toMatch(/pg_advisory_xact_lock/);
    // One capture row per call, and the readings reference it.
    expect(fn![0]).toMatch(/insert into public\.treatment_setup_captures/);
    expect(fn![0]).toMatch(/capture_id/);

    // BOTH COMMANDS REACH IT. This is what makes every assertion above a
    // claim about the product rather than about an unreachable function.
    for (const caller of [
      "record_treatment_setup_group",
      "record_treatment_setup_submission",
    ]) {
      expect(
        bodyOf(caller),
        `${caller} must validate through the shared writer, not its own copy`,
      ).toMatch(/public\.record_setup_group_in_scope\(/);
    }

    // AND NEITHER KEEPS A SECOND COPY of the rules. A command that re-derived
    // a unit or re-checked a contract itself would be the drift this
    // extraction exists to prevent.
    for (const caller of [
      "record_treatment_setup_group",
      "record_treatment_setup_submission",
    ]) {
      const body = bodyOf(caller);
      expect(body, `${caller} must not re-read the field contract`).not.toMatch(
        /machine_profile_field_contract/,
      );
      expect(
        body,
        `${caller} must not allocate a capture itself`,
      ).not.toMatch(/insert into public\.treatment_setup_captures/);
    }
  });

  it("keys readings by revision, so a changed setting APPENDS", () => {
    expect(CODE).toMatch(
      /create unique index if not exists treatment_setup_readings_field_revision_uniq[\s\S]{0,200}revision\)/,
    );
    // The old write-once index must be GONE, not merely supplemented - leaving
    // it would still refuse the second observation.
    expect(CODE).not.toMatch(/treatment_setup_readings_field_uniq\b/);
    expect(CODE).toMatch(/revision smallint not null default 1/);
  });

  it("adds its practitioner columns as nullable, with no default and no backfill", () => {
    // A legacy practitioner row must stay exactly as it was: NULL means "has
    // not chosen", which is different from any machine.
    expect(CODE).toMatch(
      /add column if not exists default_machine_id uuid\s*\n?\s*references/,
    );
    expect(CODE).not.toMatch(/default_machine_id[^;]*not null/);
    expect(CODE).not.toMatch(/default_machine_id[^;]*default /);
  });

  it("performs ZERO migration-level DML", () => {
    // A write inside a function body is that command's logic. A top-level
    // write would be a data change, and this migration makes none.
    const body = CODE.replace(/\$\$[\s\S]*?\$\$/g, " ");
    expect(body).not.toMatch(/^\s*(insert|update|delete)\s+/im);
  });

  it("reads and rewrites no existing clinical column", () => {
    // Named explicitly because these are the ones it would be tempting to
    // reinterpret: the retired percentage and the legacy frequency.
    //
    // SCOPED PAST THE DELEGATING WRAPPER, whose parameter names are the legacy
    // schema's own vocabulary - see `codeWithoutWrapper`. The claim this test
    // makes about that function is stronger and lives in its own suite: it
    // performs no DML against any existing clinical table at all.
    const code = codeWithoutWrapper();
    for (const column of [
      "galvanic_intensity_percent",
      "apilus_modality",
      "energy_level",
      "machine_frequency",
    ]) {
      expect(code, `0223 must not touch ${column}`).not.toContain(column);
    }
  });

  it("NEGATIVE CONTROL: the exemption is a window, not a hole", () => {
    // `codeWithoutWrapper` removes exactly one function. If it ever removed
    // more - a bad anchor, a changed delimiter - these bans would silently
    // stop applying to most of the migration, and this file would keep
    // passing. So: the window is small, and the rest is still there.
    const full = CODE.length;
    const scoped = codeWithoutWrapper().length;
    expect(scoped, "the exemption removed nothing").toBeLessThan(full);
    expect(
      scoped / full,
      "the exemption must remove ONE function, not most of the migration",
    ).toBeGreaterThan(0.85);
    // And the migration's own substance is unquestionably still in scope.
    expect(codeWithoutWrapper()).toContain(
      "create table if not exists public.studio_machines",
    );
    expect(codeWithoutWrapper()).toContain(
      "create or replace function public.record_treatment_setup_submission(",
    );
  });

  it("drops nothing", () => {
    // `drop policy if exists` / `drop trigger if exists` on its OWN new
    // objects is the idempotent create idiom; nothing else may be dropped.
    const drops = CODE.match(/^drop \w+/gm) ?? [];
    // `drop index` joined the allowlist when append-only revisions landed: the
    // old write-once unique index had to be REMOVED, not merely supplemented,
    // because leaving it would still refuse the second observation. Its
    // absence is as load-bearing as the new index's presence.
    for (const d of drops)
      expect(["drop policy", "drop trigger", "drop index"]).toContain(d);
    // And specifically: the write-once index is gone.
    expect(CODE).toMatch(
      /drop index if exists public\.treatment_setup_readings_field_revision_uniq/,
    );
  });
});

describe("0223 makes the commands the only write path", () => {
  it("revokes all table DML from every role and grants only reads", () => {
    for (const table of ["studio_machines", "treatment_setup_readings"]) {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(CODE).toContain(`revoke all on public.${table} from ${role};`);
      }
      expect(CODE).toContain(`grant select on public.${table} to authenticated;`);
    }
    // NO WRITE PRIVILEGE ON THESE TABLES, TO ANY ROLE.
    //
    // This assertion used to name `authenticated` only - and so it missed the
    // one role for which a table grant actually matters. service_role BYPASSES
    // RLS, so `grant insert, update on studio_machines to service_role` (which
    // this file happily allowed, and 0223 carried until Codex found it at
    // 9c6fbbe5) handed a backend path a write door that never executes
    // is_studio_owner. The guard checked the role RLS protects and skipped the
    // role RLS does not.
    //
    // So the invariant is now stated positively, by parsing the privilege set
    // each role actually receives, rather than by banning the spellings I
    // happened to think of.
    for (const table of ["studio_machines", "treatment_setup_readings"]) {
      const grants = [
        ...CODE.matchAll(
          new RegExp(`grant\\s+([^;]*?)\\s+on\\s+public\\.${table}\\s+to\\s+(\\w+);`, "g"),
        ),
      ];
      expect(grants.length, `${table} must have explicit grants`).toBeGreaterThan(0);
      for (const [, privileges, role] of grants) {
        const set = privileges!
          .split(",")
          .map((p) => p.trim().toLowerCase())
          .sort();
        expect(
          set,
          `${table} grants ${privileges} to ${role}; only SELECT is permitted ` +
            `because the SECURITY DEFINER commands are the sole write path`,
        ).toEqual(["select"]);
      }
    }
  });

  it("gives each new table a member-scoped SELECT policy and no write policy", () => {
    for (const table of ["studio_machines", "treatment_setup_readings"]) {
      expect(CODE).toContain(
        `alter table public.${table} enable row level security;`,
      );
      expect(CODE).toMatch(
        new RegExp(`create policy "${table}_member_select"[\\s\\S]{0,160}for select`),
      );
    }
    // Writes go through SECURITY DEFINER commands that check ownership
    // themselves, so an insert/update policy would be a second, weaker door.
    expect(CODE).not.toMatch(/for (insert|update|delete) to authenticated/);
  });

  it("revokes EXECUTE from all four roles by name on every command", () => {
    // Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon,
    // authenticated AND service_role at create time. Missing one was the 0129
    // (anon) and 0164 (service_role) defect.
    for (const sig of COMMANDS) {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(CODE).toContain(`revoke execute on function ${sig} from ${role};`);
      }
      expect(CODE).toContain(`grant execute on function ${sig} to authenticated;`);
      // AND TO NOTHING ELSE, which this loop did not say until a negative
      // control showed it: adding a stray `to service_role;` beside the
      // intended grant left the whole file green. The revokes above are only
      // half the posture - what is granted BACK is the other half, and a
      // command the service role can call is a command that runs with no
      // tenant boundary at all.
      // MATCHED AGAINST WHITESPACE-NORMALISED SOURCE, because the raw form is
      // not the only legal spelling and I measured three variants rather than
      // reasoning about them (DB/WAIT's cases at 595b803d, extended):
      //
      //   * a grant on the SAME LINE after another statement - already
      //     caught, because this matcher is an unanchored substring search
      //     rather than line-anchored;
      //   * `grant  execute   on  function ...` with extra whitespace
      //     between keywords - WAS MISSED;
      //   * the signature REFORMATTED across lines - WAS MISSED.
      //
      // Both misses were silent: a grant to `public` in either spelling left
      // the whole file green while handing the command to every role. Squash
      // whitespace and collapse it around punctuation on BOTH the source and
      // the needle, so every spelling of one statement is one string.
      const grants = [
        ...squash(CODE).matchAll(
          new RegExp(
            `${escapeRe(squash(`grant execute on function ${sig} to `))}(\\w+);`,
            "g",
          ),
        ),
      ].map((m) => m[1]!);
      expect(grants, `${sig} must be granted to authenticated ONLY`).toEqual([
        "authenticated",
      ]);
    }

    // A BLANKET GRANT NAMES NO FUNCTION, so no per-signature check above can
    // see it. `grant execute on all functions in schema public to anon;`
    // hands every command in the schema to that role while every exact-set
    // assertion stays green - measured, not reasoned, by the DB/WAIT lane at
    // 595b803d.
    //
    // Pinned here for 0223 only. A SHARED helper for this
    // (tests/migrations/helpers/grant-posture.ts) exists on that lane's
    // branch and is not on this one, so adopting it is the right follow-up
    // rather than something I can do now - and writing a second
    // general-purpose grant parser instead would be exactly the duplication
    // this repository keeps paying for.
    expect(CODE, "0223 must grant no blanket function privilege").not.toMatch(
      /grant\s+execute\s+on\s+all\s+functions/i,
    );
    expect(CODE).not.toMatch(/grant\s+all\s+on\s+all\s+functions/i);
    // The table-level equivalent, for the same reason.
    expect(CODE).not.toMatch(/grant\s+\w+\s+on\s+all\s+tables/i);
  });

  it("leaves the immutability trigger function callable by nobody", () => {
    const sig = "public.refuse_treatment_setup_reading_update()";
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(CODE).toContain(`revoke execute on function ${sig} from ${role};`);
    }
    expect(CODE).not.toContain(`grant execute on function ${sig}`);
  });

  it("every command is SECURITY DEFINER with a pinned search_path", () => {
    const defs = CODE.match(/create or replace function[\s\S]*?\$\$;/g) ?? [];
    // Fifteen routines now:
    //   6 inventory/recording write commands (the INITIAL SAVE joined)
    //   1 contract publication command (deployment authority)
    //   1 shared scope assertion      - internal, definer, takes the locks
    //   1 shared per-group writer     - internal, INVOKER on purpose
    //   1 group-key mint              - internal, INVOKER on purpose
    //   2 immutability trigger functions (readings, captures)
    //   3 read queries (the latest setup's groups, block history, and a
    //                   block's readings in ONE statement)
    //
    // BOTH NEW ONES ARE INVOKER, so the definer count below is unchanged: the
    // mint must not carry the definer's privileges, and a READ made definer is
    // how a read becomes a leak (Codex, #860 4305780322 and 4305555264).
    expect(defs.length).toBe(15);
    // Every routine pins its search_path, definer or not.
    for (const d of defs) {
      expect(d).toMatch(/set search_path = pg_catalog, pg_temp/);
    }
    // EXACTLY the four write commands are SECURITY DEFINER. The other two are
    // invoker by deliberate choice, for different reasons:
    //   * the trigger function runs as whoever attempts the update and only
    //     ever raises;
    //   * latest_setup_for_client only READS what the caller may already read,
    //     so RLS must stay in force rather than be bypassed and
    //     re-implemented. Making a read definer is how a read becomes a leak.
    const definer = defs.filter((d) => /security definer/.test(d));
    expect(definer).toHaveLength(8); // six writes, publication, scope
    for (const name of [
      "register_studio_machine",
      "retire_studio_machine",
      "set_own_default_machine",
      "record_treatment_setup_group",
      // ONE SAVE, atomically. A write, and an entry point, so the same rule.
      "record_treatment_setup_submission",
      // THE INITIAL SAVE - the area and its settings in one transaction. A
      // write, and the entry point the create form calls.
      "create_block_with_initial_setup",
      // The shared scope assertion READS session_blocks, sessions and
      // studio_machines and takes row locks on them, none of which a tenant
      // role may do directly. It is definer for the same reason the commands
      // calling it are, and is granted to nobody.
      "assert_setup_scope",
      // Publishing a contract is an administrative write. It is SECURITY
      // DEFINER so it can write the contract tables (no role holds direct
      // DML on them), while its AUTHORITY comes from the EXECUTE grant being
      // service_role only - deployment, not any tenant.
      "sync_machine_profile_contract",
    ]) {
      expect(
        definer.some((d) => d.includes(name)),
        `${name} writes, so it must be SECURITY DEFINER and check ownership`,
      ).toBe(true);
    }
    const invoker = defs.filter((d) => !/security definer/.test(d));
    // SEVEN, with the mint and the block reader (Codex, #860 4305780322 and
    // 4305555264). Both are invoker on purpose and for different reasons:
    //   * `mint_setup_group_keys` issues an identity INSIDE a scope its caller
    //     has already proved. Carrying the definer's privileges would make it
    //     usable on its own, and a caller able to issue its own keys could
    //     issue one that collides - the whole defect restated. Invoker means
    //     it also fails at the table privilege layer, independently of its
    //     EXECUTE revoke;
    //   * `setup_readings_for_block` is a READ, and a read made definer is how
    //     a read becomes a leak - see the note below, which now covers three.
    expect(invoker).toHaveLength(7);
    for (const d of invoker) {
      expect(d).toMatch(
        /refuse_treatment_setup_reading_update|refuse_treatment_setup_capture_update|latest_setup_for_client|setup_capture_history_for_block|setup_readings_for_block|record_setup_group_in_scope|mint_setup_group_keys/,
      );
    }
    // ALL THREE READS are invoker by deliberate choice: they return only what
    // the caller may already read, so RLS must stay in force rather than be
    // bypassed and re-implemented. Making a read definer is how a read becomes
    // a leak - and `setup_readings_for_block` carries a second, independent
    // limb besides RLS, the block-in-session JOIN predicate.
    for (const name of [
      "latest_setup_for_client",
      "setup_capture_history_for_block",
      "setup_readings_for_block",
    ]) {
      const read = defs.find((d) => d.includes(name))!;
      expect(read, `${name} must be explicit about being invoker`).toMatch(
        /security invoker/,
      );
    }
    // And the read is explicit about it rather than defaulting.
    const read = defs.find((d) => d.includes("latest_setup_for_client"))!;
    expect(read).toMatch(/security invoker/);
  });
});

// ---------------------------------------------------------------------------
// A GROUP IDENTITY IS ISSUED, AND A BLOCK'S READINGS ARE ONE STATEMENT
// (Codex, #860 4305780322 and 4305555264)
// ---------------------------------------------------------------------------
//
// THESE ARE SOURCE CONTRACTS AND THEY PROVE NO BEHAVIOUR. 0204 shipped a
// command writing to a column that did not exist: it applied clean, passed its
// source test, and had never once succeeded. The behaviour lives in
// tests/db/machine-group-identity.db.test.ts, which needs a database.
//
// WHAT THEY DO EARN is the claim made in tests/security/entry-direct-dml-guard
// case 10, where `setup_readings_for_block` is excluded by exact name as
// "reviewed here". An exclusion that cites a review which does not exist is
// worse than no exclusion at all.
describe("0223 issues group identities rather than accepting them", () => {
  const fn = (name: string) => {
    const at = CODE.indexOf(`create or replace function public.${name}(`);
    expect(at, `${name} is not in the migration`).toBeGreaterThan(-1);
    return CODE.slice(at, CODE.indexOf("$$;", at));
  };

  it("the mint allocates above the highest NUMERIC key on the block", () => {
    const body = fn("mint_setup_group_keys");
    // BLOCK-WIDE, not per setup identity: the key's uniqueness widens even
    // though the revision sequence stays scoped to the unit, profile, version
    // and mode.
    expect(body).toContain("where c.session_block_id = p_block_id");
    expect(body).toMatch(/regexp_match\(btrim\(c\.group_key\), '\^g\(\[0-9\]\+\)\$'\)/);
    // NON-CONFORMING KEYS CANNOT RAISE THE CEILING but must not break the
    // allocation either - `group_key` is free text and nothing guarantees the
    // shape.
    expect(body).toContain("coalesce(");
  });

  it("and it does so under a BLOCK-WIDE lock, or the arithmetic is a race", () => {
    const body = fn("mint_setup_group_keys");
    expect(
      body,
      "without a lock, two transactions read the same max and issue the same key",
    ).toMatch(/pg_advisory_xact_lock\(/);
    // KEYED ON A COMPOSITE, not a ':'-joined string. The string form is
    // ambiguous when its parts are free text, which 0223 already learned once
    // for the identity lock (Codex, #860 4302093849).
    expect(body).toMatch(/row\('setup_group_keys', p_block_id\)::text/);
  });

  it("COARSE BEFORE FINE: the mint lock is taken before the other two", () => {
    // THE ACQUISITION ORDER MUST BE TOTAL or the three locks can cycle. The
    // mint lock is block-wide, the identity lock scopes by unit/profile/
    // version/mode, and the group lock is per (block, group) - so the mint
    // must come first. In the save command that means before the write loop;
    // in the per-group door it means after the scope is PROVEN and before the
    // writer is called.
    const save = fn("record_treatment_setup_submission");
    const mintAt = save.indexOf("public.mint_setup_group_keys(p_block_id, v_new_count)");
    const loopAt = save.indexOf("for v_group_item in");
    expect(mintAt, "the save command never mints").toBeGreaterThan(-1);
    expect(
      mintAt,
      "the mint happens inside or after the write loop, so its lock is taken after the finer ones",
    ).toBeLessThan(loopAt);

    const door = fn("record_treatment_setup_group");
    const scopeAt = door.indexOf("from public.assert_setup_scope(");
    const doorMintAt = door.indexOf("public.mint_setup_group_keys(p_block_id, 1)");
    expect(scopeAt).toBeGreaterThan(-1);
    expect(
      scopeAt,
      "the door mints BEFORE proving the scope, so it locks a block the caller may not own",
    ).toBeLessThan(doorMintAt);
  });

  it("the mint is reachable by NO role, revoked from all four by name", () => {
    const sig = "public.mint_setup_group_keys(uuid, integer)";
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      // ALL FOUR BY NAME, because Supabase's ALTER DEFAULT PRIVILEGES grants
      // EXECUTE to anon, authenticated AND service_role at create time. 0129
      // missed `anon`; 0164 missed `service_role`.
      expect(
        CODE,
        `the mint is still reachable by ${role}`,
      ).toContain(`revoke execute on function ${sig} from ${role};`);
    }
    expect(CODE).not.toContain(`grant execute on function ${sig}`);
  });

  it("the shared writer REQUIRES the new-or-existing answer, with no default", () => {
    const body = fn("record_setup_group_in_scope");
    // NO DEFAULT. A defaulted flag is a flag callers forget, and "whichever
    // meaning was convenient" is exactly the ambiguity the defect lived in.
    expect(body).toMatch(/p_group_is_new boolean\n\)/);
    expect(body).not.toMatch(/p_group_is_new boolean default/);
  });

  it("and checks it BOTH WAYS, under the per-group lock", () => {
    const body = fn("record_setup_group_in_scope");
    const lockAt = body.indexOf("hashtextextended(p_block_id::text || ':' || v_group, 0)");
    const checkAt = body.indexOf("if p_group_is_new and v_group_exists then");
    const reviseAt = body.indexOf("if not p_group_is_new and not v_group_exists then");
    expect(lockAt).toBeGreaterThan(-1);
    // UNDER THE LOCK, because an existence test taken outside it is a
    // check-then-write race - the shape that let two saves claim one channel.
    expect(
      lockAt,
      "the existence test runs before the per-group lock, so it is a race",
    ).toBeLessThan(checkAt);
    expect(checkAt).toBeGreaterThan(-1);
    expect(reviseAt).toBeGreaterThan(-1);
    // An issued key that already exists is an INTERNAL error: it means the
    // mint's lock or arithmetic is wrong, not that the user did anything.
    expect(body).toContain("errcode = 'internal_error'");
    expect(body).toContain("so it cannot be revised");
  });

  it("both granted doors take EITHER a key OR a placeholder, never both", () => {
    const save = fn("record_treatment_setup_submission");
    // `(a) = (b)` is true when NEITHER is present, so one test covers
    // both-present and both-absent.
    expect(save).toContain(
      "where (g.value ? 'group_key') = (g.value ? 'new_group_ref')",
    );
    const door = fn("record_treatment_setup_group");
    expect(door).toMatch(/\(btrim\(coalesce\(p_group_key, ''\)\) <> ''\)\s*=\s*\(btrim\(coalesce\(p_new_group_ref, ''\)\) <> ''\)/);
  });

  it("the placeholder is never stored - only the issued key is", () => {
    const save = fn("record_treatment_setup_submission");
    // The resolved payload drops the placeholder and carries the issued key,
    // so nothing downstream can mistake one for the other.
    expect(save).toContain("(g.value - 'new_group_ref')");
    expect(save).toContain("'group_key', v_new_keys[n.rk]");
  });
});

describe("0223 reads a block's settings in ONE statement", () => {
  const reader = () => {
    const at = CODE.indexOf(
      "create or replace function public.setup_readings_for_block(",
    );
    expect(at, "the reader function is not in the migration").toBeGreaterThan(-1);
    return CODE.slice(at, CODE.indexOf("$$;", at));
  };

  it("binds the block to the session as a JOIN PREDICATE, not a precheck", () => {
    const body = reader();
    // The read returns NOTHING unless the block belongs to the session given.
    // As a precheck it was sound only because `session_blocks.session_id` is
    // immutable - a property of a trigger in another file (Codex, #860
    // 4298457378).
    expect(body).toMatch(/join public\.session_blocks b\s*\n\s*on b\.id = r\.session_block_id\s*\n\s*and b\.session_id = p_session_id/);
    expect(body).toContain("where r.session_block_id = p_block_id");
  });

  it("reads in ONE statement, with no cursor, window or page ceiling", () => {
    const body = reader();
    // ONE STATEMENT IS ONE SNAPSHOT, which is the entire reason this exists:
    // a keyset loop over random UUIDs across separate requests could let a
    // concurrent capture sort either side of the cursor, so part of a new
    // capture came back as a complete setup. A page loop can only detect that.
    expect(body).not.toMatch(/\blimit\b/i);
    expect(body).not.toMatch(/\boffset\b/i);
    expect(body).toMatch(/^\s*select coalesce\(/m);
    // EXACTLY ONE `select` over the readings. The visibility check above it is
    // an `exists`, which is a different claim from assembling the data.
    expect(
      (body.match(/from public\.treatment_setup_readings/g) ?? []).length,
      "the readings are read more than once, so they are not one snapshot",
    ).toBe(1);
  });

  it("is STABLE, so the visibility check and the read share ONE snapshot", () => {
    // NOT DECORATION. Under READ COMMITTED a VOLATILE plpgsql function takes a
    // FRESH snapshot for every statement it runs, so the `exists` check and
    // the read would see two different moments - reopening exactly the
    // check-then-read window this function closed. STABLE pins one snapshot
    // for the whole call, so the block proven visible is the block whose
    // readings come back.
    const body = reader();
    expect(body).toMatch(/\nstable\n/);
    expect(body).not.toMatch(/\nvolatile\n/);
  });

  it("REFUSES a block it cannot see, identically to one that does not exist", () => {
    const body = reader();
    // A foreign studio is refused rather than answered with an empty list -
    // the decision the TypeScript read already encoded, which returning [] for
    // everything would have quietly reversed. Non-disclosure survives because
    // both cases raise the SAME sentence; what stays distinguishable is a
    // block the caller legitimately holds with no readings yet, which is the
    // ordinary state of every new treatment area.
    expect(body).toContain("Unknown treatment block for this session.");
    expect(body).toMatch(/if not exists \(/);
    // AND THE JOIN STAYS as a second, independent limb: it BINDS the rows to
    // the session rather than merely having asked about it.
    expect(body).toMatch(/and b\.session_id = p_session_id/);
  });

  it("emits value_numeric AS TEXT, so a clinical value cannot lose precision", () => {
    // numeric serialises to a JSON STRING precisely so a value survives the
    // trip; a JSON number makes doubles the ceiling. `toReading`'s Number()
    // absorbs either, so nothing would have looked broken. Caught by the first
    // DB run of this work, not by review.
    expect(reader()).toContain("'value_numeric',           r.value_numeric::text");
  });

  it("is granted to authenticated ONLY, after being revoked from all four", () => {
    const sig = "public.setup_readings_for_block(uuid, uuid)";
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(CODE).toContain(`revoke execute on function ${sig} from ${role};`);
    }
    expect(CODE).toContain(`grant execute on function ${sig} to authenticated;`);
    expect(CODE).not.toContain(`grant execute on function ${sig} to anon`);
    expect(CODE).not.toContain(`grant execute on function ${sig} to service_role`);
  });
});

describe("0223 enforces ownership in the database, not only in the server", () => {
  it("resolves the caller rather than trusting a submitted identity", () => {
    // No command takes a practitioner id, so none can write another
    // practitioner's row.
    for (const sig of COMMANDS) {
      expect(sig).not.toContain("p_practitioner_id");
    }
    expect(CODE).toContain("public.own_practitioner_in_studio(");
    expect(CODE).toContain("public.is_studio_owner(");
  });

  it("the owner commands check is_studio_owner before writing", () => {
    for (const fn of ["register_studio_machine", "retire_studio_machine"]) {
      const body = CODE.slice(
        CODE.indexOf(`create or replace function public.${fn}`),
      ).split("$$;")[0]!;
      expect(body).toMatch(/if not public\.is_studio_owner\(/);
      expect(body).toMatch(/insufficient_privilege/);
    }
  });

  it("the recording commands derive the studio FROM THE BLOCK, not from a parameter", () => {
    // NEITHER ENTRY POINT TAKES A STUDIO, so neither has one to forge. This is
    // the claim that matters, and it is now asserted for both commands rather
    // than only the one that existed first.
    for (const caller of [
      "record_treatment_setup_group",
      "record_treatment_setup_submission",
    ]) {
      const body = bodyOf(caller);
      expect(body, `${caller} must not accept a studio`).not.toMatch(/p_studio_id/);
      // It reaches the derivation rather than reimplementing it, and hands
      // it the ROUTE: the studio is still derived from the block, but the
      // block must now be the route's own (Codex, #860 4297032712). The
      // studio is derived; the route is supplied and checked.
      expect(body, `${caller} must derive its scope`).toMatch(
        /public\.assert_setup_scope\(\s*\n?\s*p_block_id, p_studio_machine_id, p_session_id, p_client_id\)/,
      );
    }

    // AND THE DERIVATION ITSELF still derives: the block names the session,
    // the session and block must both be live, and the practitioner is
    // resolved from the studio the BLOCK belongs to - never from an argument.
    const scope = bodyOf("assert_setup_scope");
    expect(scope).not.toMatch(/p_studio_id/);
    expect(scope).toMatch(/from public\.session_blocks/);
    expect(scope).toMatch(/own_practitioner_in_studio\(o_studio\)/);
    // The locks stay in the migration's fixed order - sessions, then blocks,
    // then machines. Moving them here is what makes a NEW command unable to
    // take them in a different sequence, so the order is worth pinning.
    const lockOrder = [
      /public\.sessions s where s\.id = v_session_id for share/,
      /public\.session_blocks b where b\.id = p_block_id for share/,
      /public\.studio_machines m\s*\n?\s*where m\.id = p_studio_machine_id for share/,
    ];
    let at = -1;
    for (const re of lockOrder) {
      const m = re.exec(scope);
      expect(m, `a lock is missing: ${String(re)}`).not.toBeNull();
      expect(
        m!.index,
        `locks are out of order at ${String(re)}`,
      ).toBeGreaterThan(at);
      at = m!.index;
    }
    // FOR SHARE, never FOR KEY SHARE: retirement stamps `deleted_at`, a
    // non-key UPDATE taking FOR NO KEY UPDATE, which FOR KEY SHARE does NOT
    // conflict with - a lock that reads as protection without being one.
    expect(scope).not.toMatch(/for key share/);
  });

  it("keeps the shared building blocks out of every role's reach", () => {
    // THE WRITER TRUSTS ITS SCOPE. It is handed a studio and a practitioner
    // because its callers have just proved them, so a role that could call it
    // directly would write a capture into any studio it named. Two independent
    // things stop that, and both are asserted:
    //
    //   1. EXECUTE is revoked from all four role names and granted back to
    //      nothing. Supabase's ALTER DEFAULT PRIVILEGES hands EXECUTE to anon,
    //      authenticated AND service_role at create time, which is how 0129
    //      missed `anon` and 0164 missed `service_role`.
    //   2. It is SECURITY INVOKER, so even with EXECUTE a tenant role has no
    //      insert privilege on the capture or reading tables. The revoke is
    //      not the only thing in the way.
    for (const sig of INTERNALS) {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(CODE).toContain(`revoke execute on function ${sig} from ${role};`);
      }
      expect(
        CODE,
        `${sig} is a building block, not an entry point`,
      ).not.toContain(`grant execute on function ${sig} to`);
    }
    expect(bodyOf("record_setup_group_in_scope")).toMatch(/security invoker/);

    // THE ONE DELIBERATE EXCEPTION to "no routine accepts an identity",
    // recorded here rather than smuggled past the rule above. The writer DOES
    // take a practitioner id - that is what being an internal building block
    // buys - and the two assertions above are precisely why it is allowed to.
    expect(bodyOf("record_setup_group_in_scope")).toMatch(/p_practitioner uuid/);
    for (const sig of COMMANDS) {
      expect(sig, "an ENTRY POINT may never accept an identity").not.toContain(
        "p_practitioner",
      );
    }
  });

  it("makes one SAVE atomic, exclusive across groups, and safely retryable", () => {
    const save = bodyOf("record_treatment_setup_submission");

    // ATOMICITY IS ACHIEVED BY NOT CATCHING ANYTHING. One call is one
    // statement, so an exception on the third group aborts the whole call and
    // the submission row inserted above it rolls back with the groups already
    // written. An `exception when others` block here would silently convert
    // that into a half-recorded setup nobody chose.
    expect(save, "a caught exception would break atomicity").not.toMatch(
      /exception\s+when/,
    );

    // CROSS-GROUP EXCLUSIVITY, in the database rather than only in the UI. Two
    // separate calls each carried their own duplicate-free channel array, so
    // two calls both claiming probe 2 were two individually VALID calls and
    // the conflict was invisible. A UI-only check is bypassed by anything
    // calling the RPC directly.
    expect(save).toMatch(/claimed by more than one settings group/);
    expect(save).toMatch(/group by t\.ch/);
    // A duplicate group KEY is refused too: two groups under one key are not
    // two groups, and each would silently become a revision of the other.
    expect(save).toMatch(/is given more than once in this save/);

    // IDEMPOTENCY, and the two halves that make it safe rather than a blind
    // replay: a retry of the SAME save returns the original, and a key reused
    // for a DIFFERENT save is refused loudly instead of reporting success for
    // groups that were never written.
    expect(save).toMatch(/'reused', true/);
    expect(save).toMatch(/already belongs to a different save/);
    // AND THE KEY IS BOUND TO ITS PAYLOAD. Identity alone was not enough:
    // the same key with the same machine, version and mode but DIFFERENT
    // groups was absorbed, and the values just entered were discarded with no
    // error (Codex, db3373bc P2).
    expect(save).toMatch(/payload_digest <> v_digest/);
    expect(save).toMatch(/used for a save with different settings/);
    // COMPUTED OVER A CANONICAL FORM, ordered so the same save listed in a
    // different order is not mistaken for a different one.
    //
    // AND THE ORDER IS TOTAL ACROSS BOTH GROUP FORMS (Codex, #860
    // 4305780322). A new group carries the caller's placeholder and has no
    // `group_key` yet, so sorting on `group_key` alone collapsed every new
    // group to '' and left their relative order to the aggregate - the same
    // save could then digest two ways and a legitimate retry be refused. The
    // '0'/'1' tag also keeps the two namespaces from interleaving, so a
    // placeholder that happens to equal an existing key cannot reorder the
    // payload.
    expect(save).toContain(
      "jsonb_agg(g.value order by (case when g.value ? 'group_key' then '0' else '1' end) || btrim(coalesce(g.value->>'group_key', g.value->>'new_group_ref', '')))",
    );
    // AND THE DIGEST BINDS THE IDENTITY TOO, not only the groups. The first
    // version hashed the payload alone and left the setup identity to four
    // column comparisons; both still run, and they do different jobs - the
    // columns give the DISTINGUISHABLE sentence, the digest is the backstop
    // that a column added to the row later cannot slip past (Codex, #860).
    for (const part of [
      /'machine', p_studio_machine_id::text/,
      /'profile', v_scope\.o_profile_id/,
      /'version', v_scope\.o_profile_version/,
      /'mode', +v_mode/,
    ]) {
      expect(save, `the digest must bind ${String(part)}`).toMatch(part);
    }
    // FROM THE SCOPE, WHICH MEANS AFTER IT. The profile and version in the
    // digest are the UNIT'S REGISTERED ones that assert_setup_scope resolved,
    // never the caller's claim - so the digest can only be computed once that
    // has run, and a digest built before it would be hashing an assertion
    // nobody had checked.
    expect(
      save.indexOf("assert_setup_scope"),
      "the scope must be asserted before the digest is built from it",
    ).toBeLessThan(save.indexOf("into v_digest"));
    // THE RECORDER IS DELIBERATELY ABSENT. Binding it would turn a colleague's
    // retry of a lost save into a refusal, when it is the same save and the
    // honest answer is the original submission with its original author.
    const digestExpr = save.slice(
      save.indexOf("select md5("),
      save.indexOf("into v_digest"),
    );
    expect(digestExpr, "the digest must not bind the recorder").not.toMatch(
      /practitioner/,
    );

    // STORED, or there would be nothing to compare on the retry.
    expect(save).toMatch(/idempotency_key, payload_digest,/);
    expect(CODE).toMatch(/payload_digest text not null/);
    // Check-then-insert is serialised against its own retries, or two
    // concurrent retries both insert and the second dies on the unique
    // constraint with a 23505 the caller cannot interpret.
    expect(save).toMatch(/pg_advisory_xact_lock/);
    expect(CODE).toMatch(
      /constraint treatment_setup_submissions_idempotency_uniq\s*\n?\s*unique \(session_block_id, idempotency_key\)/,
    );

    // AUTHORIZATION BEFORE DISCLOSURE. The scope assertion is also the
    // membership check, so answering "does this retry key exist" first would
    // tell a non-member something about this studio's records.
    const scopeAt = save.indexOf("public.assert_setup_scope");
    const keyAt = save.indexOf("sub.idempotency_key = v_key");
    expect(scopeAt).toBeGreaterThan(-1);
    expect(keyAt).toBeGreaterThan(-1);
    expect(keyAt, "the key lookup must come after the scope check").toBeGreaterThan(
      scopeAt,
    );

    // GROUPS ARE WRITTEN IN SORTED KEY ORDER, which is a deadlock fix and not
    // tidiness: the shared writer takes an advisory lock per (block, group),
    // so two concurrent saves naming the same groups in opposite input order
    // would each hold the lock the other wants.
    expect(save).toMatch(/order by btrim\(coalesce\(g\.value->>'group_key', ''\)\)/);

    // AND IT INTERPRETS NOTHING. No clinical inference, no copying one group's
    // values into another, no assertion that an unassigned group applies to
    // every probe.
    expect(save).not.toMatch(/insert into public\.treatment_setup_readings/);
  });

  it("refuses a cross-studio machine in both commands that accept one", () => {
    const hits = CODE.match(/belongs to another studio/g) ?? [];
    expect(hits.length).toBe(2);
  });
});

describe("0223 keeps model activation out of applied SQL", () => {
  it("does NOT constrain machine_profile_id to a known set", () => {
    // The catalogue is application-side, curated and versioned. A CHECK listing
    // today's profile ids would freeze an evidence review into applied SQL, and
    // every later activation would need a migration.
    // Line-scoped on purpose: a `[^;]*` window spans the whole CREATE TABLE
    // body, where `observation_source ... in (...)` legitimately appears.
    const profileLines = CODE.split("\n").filter((l) =>
      l.includes("machine_profile_id"),
    );
    expect(profileLines.length).toBeGreaterThan(0);
    for (const line of profileLines) {
      expect(line, "machine_profile_id must not be enumerated").not.toMatch(
        /\bin\s*\(/,
      );
    }
    // SCOPED PAST THE DELEGATING WRAPPER for `apilus` only in the sense that
    // the whole function is skipped: `p_apilus_modality` is a legacy CLINICAL
    // COLUMN's name, not a manufacturer's model id, and this ban exists to
    // stop an evidence review being frozen into applied SQL. See
    // `codeWithoutWrapper`.
    for (const id of ["dectro", "silhouettone", "permanence", "gemm", "apilus"]) {
      expect(
        codeWithoutWrapper().toLowerCase(),
        `no model id belongs in applied SQL`,
      ).not.toContain(id);
    }
    // AND THE WRAPPER ITSELF carries no model id either - only the one legacy
    // column name it is obliged to forward. Asserted rather than assumed,
    // because the exemption above would otherwise be unbounded.
    const wrapper = CODE.slice(
      CODE.indexOf(
        "create or replace function public.create_block_with_initial_setup(",
      ),
    ).split("$$;")[0]!;
    for (const id of ["dectro", "silhouettone", "permanence", "gemm"]) {
      expect(wrapper.toLowerCase(), `${id} must not reach the wrapper`).not.toContain(
        id,
      );
    }
    // `apilus` appears ONLY as part of the legacy column's parameter name.
    //
    // ASSERTED AS A SHAPE, NOT A COUNT. My first spelling pinned the number of
    // occurrences at two and the real number is three - the declaration once,
    // the named forwarding twice on one line - so the count was both wrong and
    // brittle: it would break again the moment the forwarding was reformatted.
    // What matters is that every occurrence is that one parameter.
    const apilusHits = wrapper.toLowerCase().match(/\w*apilus\w*/g) ?? [];
    expect(apilusHits.length).toBeGreaterThan(0);
    for (const hit of apilusHits) {
      expect(hit, "apilus may appear only as p_apilus_modality").toBe(
        "p_apilus_modality",
      );
    }
  });

  it("stores the profile VERSION on every reading, so history renders correctly", () => {
    expect(CODE).toMatch(/machine_profile_version integer not null/);
    // READ FROM THE UNIT, in the shared scope assertion...
    expect(bodyOf("assert_setup_scope")).toMatch(
      /m\.machine_profile_id, m\.machine_profile_version/,
    );
    // ...and WRITTEN by the shared writer from what it was handed, never from
    // the payload. Copied at record time, so a later re-registration cannot
    // retroactively change what a reading was captured under.
    const writer = bodyOf("record_setup_group_in_scope");
    expect(writer).toMatch(/p_profile_version/);
    expect(writer, "the version must not come from the caller's payload").not.toMatch(
      /v_item->>'machine_profile_version'/,
    );
  });

  it("keeps a value and a reasoned absence mutually exclusive", () => {
    expect(CODE).toMatch(/constraint treatment_setup_readings_value_xor check/);
    expect(CODE).toMatch(/'not-recorded', 'not-applicable', 'not-legible'/);
  });

  it("makes readings append-only with a trigger, not a convention", () => {
    expect(CODE).toMatch(/before update on public\.treatment_setup_readings/);
    expect(CODE).toMatch(/immutable/i);
    // DELETE is left to the block's cascade; nothing else may remove a reading.
    expect(CODE).not.toMatch(/before delete on public\.treatment_setup_readings/);
  });

  it("requires a native unit and a precision on every reading", () => {
    expect(CODE).toMatch(/native_unit text not null/);
    expect(CODE).toMatch(/decimals smallint not null check \(decimals between 0 and 6\)/);
  });
});

// ---------------------------------------------------------------------------
// THE INITIAL SAVE DELEGATES THE AREA, AND THE FORWARDING IS PINNED.
//
// `create_block_with_initial_setup` creates the treatment area and records the
// machine settings in ONE transaction, which closes the only window the two
// separate commands leave: an area that silently has no machine settings while
// the practitioner believes she entered them.
//
// IT IS NOT ABOUT A PHANTOM OR PARTIAL SUBMISSION. Since the submissions table
// landed, `record_treatment_setup_submission` writes the submission row and
// every group's captures in one transaction with no exception handler, so
// neither is reachable. The residual was block-versus-submission.
//
// It closes that by CALLING `create_block_with_entry` (0166) rather than
// inserting a block itself, so `session_blocks` keeps a SINGLE write path -
// and the price is forwarding twenty-six parameters. A wrapper that size is
// exactly the class of SQL that cannot be trusted unexecuted: one wrong
// parameter name fails only at runtime, which is the 0204 shape.
//
// So this suite RE-DERIVES the list from 0166's own declaration and compares.
// A later redefinition of that command fails here instead of silently
// diverging from the wrapper. IT REDUCES THE RISK AND DOES NOT REPLACE A
// DATABASE RUN: a name that matches can still be wired to the wrong value, and
// only an execution shows that.
// ---------------------------------------------------------------------------
describe("0223's INITIAL SAVE forwards 0166's command faithfully", () => {
  /** `create_block_with_entry`'s own parameter list, from 0166. */
  function sourceParams(): Array<{ name: string; type: string }> {
    const src = readFileSync(
      path.join(
        process.cwd(),
        "supabase/migrations/0166_session_block_electrolysis_commands.sql",
      ),
      "utf8",
    );
    const m =
      /create or replace function public\.create_block_with_entry\(\n([\s\S]*?)\n\)\nreturns/.exec(
        src,
      );
    expect(m, "0166's create_block_with_entry declaration must be findable").not.toBeNull();
    return m![1]!
      .split("\n")
      .map((l) => l.trim().replace(/,$/, ""))
      .filter(Boolean)
      .map((l) => {
        const [name, ...rest] = l.split(/\s+/);
        return { name: name!, type: rest.join(" ") };
      });
  }

  /** This command's own declaration, from 0223. */
  function wrapperBlock(): string {
    const at = CODE.indexOf(
      "create or replace function public.create_block_with_initial_setup(",
    );
    expect(at, "the initial-save command must exist").toBeGreaterThan(-1);
    return CODE.slice(at).split("$$;")[0]!;
  }

  it("finds 0166's parameters, so nothing below is vacuous", () => {
    const p = sourceParams();
    expect(p.length).toBe(26);
    expect(p[0]!.name).toBe("p_session_id");
    expect(p[0]!.type).toBe("uuid");
    expect(p[p.length - 1]!.name).toBe("p_units_of_lye");
  });

  it("DECLARES every one of them, in order, with the same type", () => {
    const decl = wrapperBlock().split(")")[0]!;
    const lines = decl
      .split("\n")
      .map((l) => l.trim().replace(/,$/, ""))
      .filter((l) => /^p_\w+\s/.test(l))
      .map((l) => {
        const [name, ...rest] = l.split(/\s+/);
        return { name: name!, type: rest.join(" ") };
      });
    const source = sourceParams();
    // The source list first, in order, then this command's own four.
    expect(lines.slice(0, source.length)).toEqual(source);
    expect(lines.slice(source.length).map((p) => p.name)).toEqual([
      "p_studio_machine_id",
      "p_setup_mode_key",
      "p_setup_idempotency_key",
      "p_setup_groups",
    ]);
  });

  it("FORWARDS every one BY NAME, never positionally", () => {
    // Positional forwarding of twenty-six arguments makes a transposition
    // silent and permanent. Named forwarding makes an order mistake
    // impossible and leaves only a name mistake, which this catches.
    const body = wrapperBlock();
    const call = body.slice(body.indexOf("public.create_block_with_entry("));
    const forwarded = [...call.matchAll(/(p_\w+)\s*=>\s*(p_\w+)/g)].map((m) => [
      m[1]!,
      m[2]!,
    ]);
    const names = sourceParams().map((p) => p.name);
    expect(forwarded.map(([to]) => to)).toEqual(names);
    // Each one is passed the parameter OF THE SAME NAME. A cross-wire - say
    // p_energy_level => p_minutes_performed - is the defect this catches, and
    // it is the one a reader of thirty lines of `=>` will not see.
    for (const [to, from] of forwarded) {
      expect(from, `${to} must be forwarded its own argument`).toBe(to);
    }
  });

  it("does NOT write session_blocks itself — one write path", () => {
    const body = wrapperBlock();
    expect(body).toMatch(/public\.create_block_with_entry\(/);
    expect(body, "a second write path to session_blocks").not.toMatch(
      /insert into public\.session_blocks/,
    );
    expect(body).not.toMatch(/public\.create_session_block_with_areas\(/);
  });

  it("CATCHES NOTHING, which is what makes it atomic", () => {
    // An exception handler here would reintroduce exactly the half-saved state
    // the command exists to remove: the block committed, the settings not.
    expect(wrapperBlock()).not.toMatch(/exception\s+when/);
  });

  it("records the settings through the SHARED save command", () => {
    // Not a third copy of the per-group rules. One definition, reached from
    // here too.
    expect(wrapperBlock()).toMatch(/public\.record_treatment_setup_submission\(/);
    expect(wrapperBlock()).not.toMatch(/machine_profile_field_contract/);
    expect(wrapperBlock()).not.toMatch(/insert into public\.treatment_setup_captures/);
  });

  it("treats NO settings as a valid save, not a refusal", () => {
    // An area saved with no machine settings is an ordinary state. The
    // submission command is reached only when there is something to record.
    const body = wrapperBlock();
    expect(body).toMatch(/jsonb_array_length\(p_setup_groups\) > 0/);
    expect(body).toMatch(/'setup', v_setup/);
  });

  it("refuses to proceed if the area somehow came back empty", () => {
    expect(wrapperBlock()).toMatch(/The treatment area could not be created/);
  });
});

describe("0223's guidance read excludes the session being charted", () => {
  // Proved behaviourally against a real database in
  // tests/db/machine-workflow-end-to-end. What a source contract adds is that
  // the parameter cannot quietly become optional again: a `default null`
  // would let any caller fall back to the defective behaviour, and the
  // wrapper's own docblock says this scoping lives in SQL precisely "so a
  // future caller cannot omit it".
  function guidance(): string {
    const at = CODE.indexOf(
      "create or replace function public.latest_setup_for_client(",
    );
    expect(at, "the guidance read must exist").toBeGreaterThan(-1);
    return CODE.slice(at).split("$$;")[0]!;
  }

  it("takes the session to exclude, and takes it REQUIRED", () => {
    const fn = guidance();
    expect(fn).toContain("p_exclude_session_id uuid");
    expect(
      fn,
      "a default would let a caller silently restore the defect",
    ).not.toMatch(/p_exclude_session_id uuid\s+default/i);
  });

  it("applies it to the anchor, which is what picks the setup", () => {
    expect(guidance()).toContain("sn.id is distinct from p_exclude_session_id");
  });

  it("keeps the client and studio scoping it already had", () => {
    // The earlier repair of this same function was for showing ANOTHER
    // CLIENT's newer reading as guidance. A fix that swapped one scope for
    // another would trade one defect for its predecessor.
    const fn = guidance();
    expect(fn).toContain("sn.client_id = p_client_id");
    expect(fn).toContain("c.studio_id = p_studio_id");
    expect(fn).toContain("public.is_studio_member(p_studio_id)");
  });

  it("carries the new signature through the grants", () => {
    // A stale two-argument revoke would leave the OLD signature granted if it
    // ever existed on a stack, and the new one ungranted.
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(
        CODE.includes(
          `revoke execute on function public.latest_setup_for_client(uuid, uuid, uuid) from ${role}`,
        ),
        `the three-argument form is not revoked from ${role}`,
      ).toBe(true);
    }
    expect(CODE).toContain(
      "grant execute on function public.latest_setup_for_client(uuid, uuid, uuid) to authenticated",
    );
    expect(
      CODE.includes("latest_setup_for_client(uuid, uuid)"),
      "a two-argument signature reference survived the change",
    ).toBe(false);
  });
});

describe("0223's INITIAL SAVE is idempotent through a session-scoped claim", () => {
  // WHAT A SOURCE CONTRACT CAN AND CANNOT SAY HERE. It can hold the ORDER of
  // the steps and the presence of each one; it cannot prove the command
  // actually absorbs a retry. tests/db/machine-initial-save.db.test.ts does
  // that against a real database, and the division is deliberate: 0204 shipped
  // a command writing to a column that did not exist, applied clean, and
  // passed its own source test.
  //
  // ITS OWN HELPERS. The forwarding describe above keeps `wrapperBlock` to
  // itself, and reaching across would couple two sets of claims that fail for
  // different reasons.
  function command(): string {
    const at = CODE.indexOf(
      "create or replace function public.create_block_with_initial_setup(",
    );
    expect(at, "the initial-save command must exist").toBeGreaterThan(-1);
    return CODE.slice(at).split("$$;")[0]!;
  }

  /** Everything between the digest and the lock - the digest expression. */
  function digestExpr(): string {
    const b = command();
    const from = b.indexOf("v_digest := md5(");
    const to = b.indexOf("pg_advisory_xact_lock");
    expect(from, "the digest must exist").toBeGreaterThan(-1);
    expect(to, "the advisory lock must exist").toBeGreaterThan(from);
    return b.slice(from, to);
  }

  /** This command's OWN declared parameters, parsed rather than listed here. */
  function declaredParams(): string[] {
    const decl = command().split(")")[0]!;
    return [...decl.matchAll(/^\s*(p_\w+)\s+\S/gm)].map((m) => m[1]!);
  }

  it("claims the key on the SESSION, because the block does not exist yet", () => {
    // THE WHOLE MECHANISM IN ONE LINE. A retry key needs an anchor that
    // PRE-EXISTS the thing it protects. The submission command's key is unique
    // per BLOCK and this command CREATES the block, so a repeat had nothing to
    // collide with - which is why a lost answer produced a second treatment
    // area carrying a second copy of the settings.
    const b = command();
    expect(b).toContain("from public.treatment_area_create_claims");
    expect(b).toContain("c.session_id = p_session_id");
    expect(b).toContain("c.idempotency_key = v_key");
  });

  it("does the four steps IN ORDER: shape, authorization, digest, lock", () => {
    // EACH ORDERING IS A SEPARATE CLAIM, and three are security or
    // correctness properties rather than style:
    //
    //   shape before I/O       - a malformed call should not take locks on its
    //                            way to being refused;
    //   AUTHORIZATION BEFORE   - answering "does this key exist on this
    //   THE CLAIM LOOKUP         session" first would tell a caller with no
    //                            membership something about its records;
    //   digest before the lock - it reads no tables, so holding the lock while
    //                            computing it buys nothing;
    //   LOCK BEFORE THE LOOKUP - the check, the create and the claim have to
    //                            be ONE indivisible step, or two concurrent
    //                            retries both create an area.
    const b = command();
    const steps = {
      shape: b.indexOf("length(v_key) < 8"),
      auth: b.indexOf("assert_session_writable(p_session_id, p_client_id)"),
      digest: b.indexOf("v_digest := md5("),
      lock: b.indexOf("pg_advisory_xact_lock"),
      lookup: b.indexOf("from public.treatment_area_create_claims"),
    };
    for (const [name, i] of Object.entries(steps)) {
      expect(i, `${name} is missing from the command`).toBeGreaterThan(-1);
    }
    expect(steps.shape, "the key's shape must be checked before any I/O").toBeLessThan(
      steps.auth,
    );
    expect(steps.auth, "authorization must precede the claim lookup").toBeLessThan(
      steps.lookup,
    );
    expect(
      steps.digest,
      "the digest must be built before the lock is taken",
    ).toBeLessThan(steps.lock);
    expect(steps.lock, "the lock must be taken before the lookup").toBeLessThan(
      steps.lookup,
    );
  });

  it("locks on (SESSION, key), so unrelated saves never wait on each other", () => {
    expect(command()).toContain("p_session_id::text || ':area-create:' || v_key");
  });

  it("hashes the WHOLE payload - every parameter it would record", () => {
    // A retry carrying the same key but a different AREA, probe lot or set of
    // readings is a different save wearing a used key, and answering it with
    // the first save's ids would report a creation that never happened.
    //
    // DERIVED FROM THE DECLARATION rather than listed by hand, so a parameter
    // added to this command later and left out of the digest fails HERE
    // instead of silently escaping the binding. That is the whole value of
    // this test: a hand-written list would have to be remembered twice.
    const skip = new Set([
      // The key is what the digest is stored UNDER, not part of what it binds.
      "p_setup_idempotency_key",
      // Both are the claim's own scope: the session is the unique constraint's
      // first column, and the client is re-asserted against it by
      // assert_session_writable, which refuses rather than redirects.
      "p_session_id",
      "p_client_id",
    ]);
    const bound = declaredParams().filter((p) => !skip.has(p));
    expect(
      bound.length,
      "the declaration should have parsed to the full parameter list",
    ).toBe(27);
    const expr = digestExpr();
    for (const p of bound) {
      expect(expr.includes(`'${p}',`), `${p} is recorded but not bound by the digest`)
        .toBe(true);
    }
  });

  it("trims numeric scale, so 120 and 120.0 are the same save", () => {
    // They are the same number. Refusing a retry over a scale difference would
    // be a DEFINITE refusal of a legitimate repeat, which is worse than the
    // laxity it avoids.
    const expr = digestExpr();
    for (const p of [
      "p_pulse_delay_seconds",
      "p_galvanic_ma",
      "p_thermolysis_duration_seconds",
      "p_units_of_lye",
    ]) {
      expect(expr.includes(`trim_scale(${p})`), `${p} must be scale-normalised`).toBe(
        true,
      );
    }
  });

  it("canonicalises the setup groups the same way the save command does", () => {
    // Otherwise the same save listed in a different order would be refused by
    // one command and absorbed by the other.
    // THE SAME TOTAL ORDER, including the new-group form: an initial save is
    // the case where EVERY group is new, so any difference here would refuse
    // the retry of a first save rather than absorb it.
    expect(digestExpr()).toContain(
      "jsonb_agg(g.value order by (case when g.value ? 'group_key' then '0' else '1' end) || btrim(coalesce(g.value->>'group_key', g.value->>'new_group_ref', '')))",
    );
  });

  it("refuses a used key with a different payload, in its OWN words", () => {
    // Distinguishable from the submission command's refusal, because the
    // remedy differs: this one means a second treatment AREA was about to be
    // created under a used key.
    const b = command();
    expect(b).toContain("already used to create a different treatment area");
    expect(b).toContain("v_claim.payload_digest <> v_digest");
  });

  it("answers an absorbed retry with the ORIGINAL ids and says it is a reuse", () => {
    const b = command();
    expect(b).toContain("'block_id', v_claim.block_id");
    expect(b).toContain("'entry_id', v_claim.entry_id");
    expect(b).toContain("'reused', true");
    // AND `reused` IS ALWAYS PRESENT, false on a fresh save: a caller reading
    // this field must not have to treat "missing" as "fresh".
    expect(b).toContain("'reused', false");
    // The settings half is rebuilt in the SAME SHAPE a fresh save returns,
    // counted from what is stored, so an absorbed retry is indistinguishable
    // from the original except by the flag.
    expect(b).toContain("'submission_id', v_claim.submission_id");
    expect(b).toContain("from public.treatment_setup_captures c");
  });

  it("writes the claim LAST, and only when a key was given", () => {
    const b = command();
    const insertAt = b.indexOf("insert into public.treatment_area_create_claims");
    const createAt = b.indexOf("from public.create_block_with_entry(");
    expect(insertAt, "the claim is never written").toBeGreaterThan(-1);
    // AFTER THE CREATE, because `block_id` is NOT NULL and a claim that cannot
    // name its block answers nothing on a retry. Safe because the advisory
    // lock - not the unique constraint - is what serialises the retries.
    expect(createAt, "the area must be created before the claim").toBeLessThan(
      insertAt,
    );
    // GUARDED BY THE KEY, so a caller that supplies none keeps the plain
    // forwarding behaviour and writes no receipt.
    const guardAt = b.lastIndexOf("if v_key <> ''", insertAt);
    expect(guardAt, "the claim insert must sit inside a key guard").toBeGreaterThan(
      createAt,
    );
  });

  it("keeps the claim table out of every role's write reach", () => {
    // Same posture as every other table here: the command is the only writer,
    // and a member may read its own studio's rows.
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(
        CODE.includes(`revoke all on public.treatment_area_create_claims from ${role}`),
        `direct DML is not revoked from ${role}`,
      ).toBe(true);
    }
    expect(CODE).toContain(
      "grant select on public.treatment_area_create_claims to authenticated",
    );
    expect(CODE).toContain(
      "alter table public.treatment_area_create_claims enable row level security",
    );
    const policyAt = CODE.indexOf(
      "create policy treatment_area_create_claims_member_select",
    );
    expect(policyAt, "the read policy must exist").toBeGreaterThan(-1);
    expect(
      CODE.slice(policyAt, policyAt + 400),
      "the read policy must be scoped to studio membership",
    ).toContain("is_studio_member(studio_id)");
  });
});

// ---------------------------------------------------------------------------
// 0223 · THE SETUP WRITE IS BOUND TO THE AUTHORIZED ROUTE
//
// `assert_setup_scope` derived the block's studio and checked studio
// membership, and stopped. A practitioner is a member of the WHOLE studio, so
// another client's block id in the same studio passed every check and
// appended IMMUTABLE readings to the wrong client's treatment
// (Codex, #860 4297032712).
//
// Pinned on the SOURCE as well as proved against Postgres, because this is
// the layer that stops a FUTURE caller from omitting the check. An
// authorization that depends on every caller remembering to ask is not an
// authorization.
// ---------------------------------------------------------------------------
describe("0223 binds every setup write to its route", () => {
  it("assert_setup_scope REQUIRES the session and the client", () => {
    expect(SQL).toMatch(
      /create or replace function public\.assert_setup_scope\([\s\S]{0,2600}?p_session_id uuid,\s*\n\s*p_client_id uuid,/,
    );
  });

  it("and verifies BOTH halves of the lineage", () => {
    // Either half alone is insufficient: the session proves the visit, the
    // client proves whose chart it is.
    //
    // SCOPED TO THIS FUNCTION'S BODY, because the file-wide version of this
    // assertion did not fail when the client half was deleted - the same
    // predicate appears in another routine, so the whole-file search found
    // it there and reported a guard that was no longer guarding anything.
    const scope = bodyOf("assert_setup_scope");
    expect(scope).toMatch(/and b\.session_id = p_session_id/);
    expect(scope).toMatch(/and sn\.client_id = p_client_id/);
  });

  it("refuses a null route rather than treating it as unscoped", () => {
    expect(SQL).toMatch(
      /if p_session_id is null or p_client_id is null then\s*\n\s*raise exception 'Setup writes must name their session and client\.'/,
    );
  });

  it("both write commands take the route and pass it down", () => {
    for (const fn of [
      "record_treatment_setup_group",
      "record_treatment_setup_submission",
    ]) {
      expect(SQL, `${fn} must take the route`).toMatch(
        new RegExp(
          `create or replace function public\\.${fn}\\([\\s\\S]{0,1400}?p_session_id uuid,\\s*\\n\\s*p_client_id uuid`,
        ),
      );
    }
    expect(
      (
        SQL.match(
          /assert_setup_scope\(\s*\n?\s*p_block_id, p_studio_machine_id, p_session_id, p_client_id\)/g,
        ) ?? []
      ).length,
      "every scope assertion must carry the route",
    ).toBe(2);
  });

  it("the grant posture names the NEW signatures, not the old ones", () => {
    // A signature change leaves the old function's revokes naming something
    // that no longer exists, which silently stops revoking anything.
    expect(SQL).not.toMatch(/public\.assert_setup_scope\(uuid, uuid\)/);
    expect(SQL).not.toMatch(
      /public\.record_treatment_setup_group\(uuid, uuid, text, text, smallint\[\], jsonb\)/,
    );
    expect(SQL).not.toMatch(
      /public\.record_treatment_setup_submission\(uuid, uuid, text, text, jsonb\)/,
    );
  });

  it("the initial-save command passes the route it already authorized", () => {
    // It calls `assert_session_writable(p_session_id, p_client_id)` first, so
    // these are the authorized ids rather than a re-derivation that could
    // disagree with the authorization just performed.
    expect(SQL).toMatch(
      /v_setup := public\.record_treatment_setup_submission\([\s\S]{0,1200}?p_session_id,\s*\n\s*p_client_id\s*\n\s*\);/,
    );
  });
});
