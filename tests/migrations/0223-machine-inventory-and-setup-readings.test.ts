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
  "public.record_treatment_setup_group(uuid, uuid, text, text, smallint[], jsonb)",
  // ONE SAVE of every settings group, atomically. An ENTRY POINT - granted to
  // `authenticated` - so every posture rule below applies to it unchanged.
  "public.record_treatment_setup_submission(uuid, uuid, text, text, jsonb)",
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
  "public.assert_setup_scope(uuid, uuid)",
  "public.record_setup_group_in_scope(uuid, uuid, uuid, uuid, text, integer, text[], text, text, smallint[], jsonb, uuid)",
] as const;

/** The body of one `create or replace function` in the migration. */
function bodyOf(name: string): string {
  const at = CODE.indexOf(`create or replace function public.${name}`);
  expect(at, `${name} is not in the migration`).toBeGreaterThan(-1);
  return CODE.slice(at).split("$$;")[0]!;
}

describe("0223 sits correctly in the migration sequence", () => {
  it("is the repository maximum, and nothing sits above it", () => {
    // Only the CURRENT maximum migration's own test may assert this - see
    // CLAUDE.md §2. It reached this file from
    // tests/migrations/0210-sms-waitlist-join-acknowledgement.test.ts in the
    // same change that authored 0223.
    expect(isRepoMax(VERSION), "0223 is no longer the repo max").toBe(true);
    expect(versionsAbove(VERSION), "something was added above 0223").toEqual([]);
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
  it("creates its six tables and alters only practitioners", () => {
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
    for (const column of [
      "galvanic_intensity_percent",
      "apilus_modality",
      "energy_level",
      "machine_frequency",
    ]) {
      expect(CODE, `0223 must not touch ${column}`).not.toContain(column);
    }
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
    }
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
    // Twelve routines now:
    //   5 inventory/recording write commands (the whole-save command joined)
    //   1 contract publication command (deployment authority)
    //   1 shared scope assertion      - internal, definer, takes the locks
    //   1 shared per-group writer     - internal, INVOKER on purpose
    //   2 immutability trigger functions (readings, captures)
    //   2 read queries (the latest setup's groups, block history)
    expect(defs.length).toBe(12);
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
    expect(definer).toHaveLength(7); // five writes, publication, scope
    for (const name of [
      "register_studio_machine",
      "retire_studio_machine",
      "set_own_default_machine",
      "record_treatment_setup_group",
      // ONE SAVE, atomically. A write, and an entry point, so the same rule.
      "record_treatment_setup_submission",
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
    expect(invoker).toHaveLength(5);
    for (const d of invoker) {
      expect(d).toMatch(
        /refuse_treatment_setup_reading_update|refuse_treatment_setup_capture_update|latest_setup_for_client|setup_capture_history_for_block|record_setup_group_in_scope/,
      );
    }
    // Both READS are invoker by deliberate choice: they return only what the
    // caller may already read, so RLS must stay in force rather than be
    // bypassed and re-implemented. Making a read definer is how a read becomes
    // a leak.
    for (const name of ["latest_setup_for_client", "setup_capture_history_for_block"]) {
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
      // It reaches the derivation rather than reimplementing it.
      expect(body, `${caller} must derive its scope`).toMatch(
        /public\.assert_setup_scope\(p_block_id, p_studio_machine_id\)/,
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
    for (const id of ["dectro", "silhouettone", "permanence", "gemm", "apilus"]) {
      expect(CODE.toLowerCase(), `no model id belongs in applied SQL`).not.toContain(
        id,
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
