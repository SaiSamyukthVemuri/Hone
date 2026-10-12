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
] as const;

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
  it("creates its two tables and alters only practitioners", () => {
    expect(CODE).toMatch(/create table if not exists public\.studio_machines/);
    expect(CODE).toMatch(
      /create table if not exists public\.treatment_setup_readings/,
    );
    const alters = CODE.match(/^alter table public\.(\w+)/gm) ?? [];
    const altered = new Set(
      alters.map((a) => a.replace(/^alter table public\./, "")),
    );
    // `alter table` also covers `enable row level security` on the new tables,
    // which is expected; what matters is that no OTHER existing table is in it.
    altered.delete("studio_machines");
    altered.delete("treatment_setup_readings");
    expect([...altered]).toEqual(["practitioners"]);
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
    for (const d of drops) expect(["drop policy", "drop trigger"]).toContain(d);
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
    // Four WRITE commands, the trigger function, and one READ query.
    expect(defs.length).toBe(6);
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
    expect(definer).toHaveLength(4);
    for (const name of [
      "register_studio_machine",
      "retire_studio_machine",
      "set_own_default_machine",
      "record_treatment_setup_group",
    ]) {
      expect(
        definer.some((d) => d.includes(name)),
        `${name} writes, so it must be SECURITY DEFINER and check ownership`,
      ).toBe(true);
    }
    const invoker = defs.filter((d) => !/security definer/.test(d));
    expect(invoker).toHaveLength(2);
    for (const d of invoker) {
      expect(d).toMatch(
        /refuse_treatment_setup_reading_update|latest_setup_for_client/,
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

  it("the reading command derives the studio FROM THE BLOCK, not from a parameter", () => {
    const body = CODE.slice(
      CODE.indexOf("create or replace function public.record_treatment_setup_group"),
    ).split("$$;")[0]!;
    // There is no studio parameter at all, so there is none to forge.
    expect(body).not.toMatch(/p_studio_id/);
    expect(body).toMatch(/from public\.session_blocks/);
    expect(body).toMatch(/own_practitioner_in_studio\(v_studio\)/);
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
    const body = CODE.slice(
      CODE.indexOf("create or replace function public.record_treatment_setup_group"),
    ).split("$$;")[0]!;
    // Copied from the unit at record time, so a later re-registration cannot
    // retroactively change what a reading was captured under.
    expect(body).toMatch(/v_profile_version/);
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
