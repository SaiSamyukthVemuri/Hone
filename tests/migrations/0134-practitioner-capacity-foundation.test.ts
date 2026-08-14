import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Source/structural contract for migration 0134 (practitioner-capacity
// foundation). Complements the behavioural DB/RLS suite
// (tests/db/practitioner-capacity.db.test.ts) by pinning the access-control and
// hardening properties that must hold in the SQL itself, the final-gate
// review contract before merge.

const MIGRATIONS_DIR = join(process.cwd(), "supabase/migrations");
const FILES = readdirSync(MIGRATIONS_DIR);
const FILE = FILES.find((f) => f.startsWith("0134_"));
const SQL = FILE ? readFileSync(join(MIGRATIONS_DIR, FILE), "utf8") : "";
// Comment-stripped copy so doc-comments can't satisfy or trip a grep.
const CODE = SQL.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");

// Every SECURITY DEFINER / mutation-capable helper 0134 creates. Each must be
// execute-revoked from public + anon + authenticated (Gate 2).
const REVOKED_FUNCTIONS = [
  "set_appointment_capacity_enabled",
  "studio_capacity_enabled",
  "fanout_studio_wide_reservation",
  "sync_appointment_to_calendar_reservation",
  "sync_timed_block_to_calendar_reservation",
  "sync_blockout_to_calendar_reservation",
  "sync_recurring_break_occurrence_to_calendar_reservation",
  "rematerialize_studio_reservations",
  "on_studio_capacity_flag_change",
  "on_practitioner_change_refan",
  "default_eligibility_for_service",
  "default_eligibility_for_practitioner",
  "set_reservation_resource_key_default",
  "guard_capacity_flag_activation",
  "guard_service_practitioner_active",
];

describe("0134: file present", () => {
  it("exists with a purpose-encoding filename", () => {
    expect(FILE).toBe("0134_practitioner_capacity_foundation.sql");
    expect(SQL.length).toBeGreaterThan(1000);
  });
});

describe("0134, Gate 1: capacity flag is operator-controlled", () => {
  it("adds the flag as additive, default false", () => {
    expect(CODE).toMatch(
      /add column if not exists practitioner_capacity_enabled boolean not null default false/i,
    );
  });

  it("installs a BEFORE UPDATE guard that rejects flag changes by browser roles", () => {
    expect(CODE).toMatch(/create or replace function public\.guard_capacity_flag_activation/i);
    expect(CODE).toMatch(
      /before update of practitioner_capacity_enabled\s+on public\.studios/i,
    );
    // Rejects only when the value actually changes AND the caller is a browser role.
    expect(CODE).toMatch(/current_user in \('anon', 'authenticated'\)/i);
    expect(CODE).toMatch(/is distinct from old\.practitioner_capacity_enabled/i);
    expect(CODE).toMatch(/42501/); // insufficient_privilege
  });

  it("the guard is SECURITY INVOKER (must see the real caller, not the owner)", () => {
    const fn = CODE.match(
      /create or replace function public\.guard_capacity_flag_activation[\s\S]*?\$\$;/i,
    )?.[0];
    expect(fn).toBeTruthy();
    expect(fn).not.toMatch(/security definer/i);
    expect(fn).toMatch(/set search_path = pg_catalog, pg_temp/i);
  });
});

describe("0134, Gate 2: SECURITY DEFINER helpers are locked down", () => {
  it("revokes execute from public + anon + authenticated in a single loop", () => {
    // The loop body must issue all three revokes.
    expect(CODE).toMatch(/revoke execute on function %s from public/i);
    expect(CODE).toMatch(/revoke execute on function %s from anon/i);
    expect(CODE).toMatch(/revoke execute on function %s from authenticated/i);
  });

  it("names every mutation-capable / trigger function in the revoke set", () => {
    for (const fn of REVOKED_FUNCTIONS) {
      expect(CODE).toContain(`public.${fn}(`);
    }
  });

  it("the shadow/rematerialize/fanout helpers are SECURITY DEFINER + hardened path", () => {
    for (const fn of [
      "fanout_studio_wide_reservation",
      "rematerialize_studio_reservations",
      "sync_appointment_to_calendar_reservation",
    ]) {
      const block = CODE.match(
        new RegExp(`create or replace function public\\.${fn}[\\s\\S]*?\\$\\$;`, "i"),
      )?.[0];
      expect(block, `${fn} block`).toBeTruthy();
      expect(block).toMatch(/security definer/i);
      expect(block).toMatch(/set search_path = pg_catalog, pg_temp/i);
    }
  });
});

describe("0134, Gate 3: service_practitioners authorization", () => {
  it("enables RLS and grants NO browser write policy (service-role-only writes)", () => {
    expect(CODE).toMatch(/alter table public\.service_practitioners enable row level security/i);
    // Read-only for members; the old owner-write ("for all") policy is dropped.
    expect(CODE).toMatch(/create policy "service_practitioners_member_select"[\s\S]*?for select/i);
    expect(CODE).not.toMatch(/create policy "service_practitioners_owner_all"/i);
    // No INSERT/UPDATE/DELETE/ALL policy for any browser role.
    expect(CODE).not.toMatch(/create policy "service_practitioners[^"]*"[\s\S]*?for (all|insert|update|delete)/i);
  });

  it("enforces same-studio via composite FKs to the 0032 companion uniques", () => {
    expect(CODE).toMatch(/foreign key \(service_id, studio_id\)\s*references public\.services \(id, studio_id\)/i);
    expect(CODE).toMatch(
      /foreign key \(practitioner_id, studio_id\)\s*references public\.practitioners \(id, studio_id\)/i,
    );
  });

  it("rejects marking an inactive practitioner eligible (BEFORE INSERT guard)", () => {
    expect(CODE).toMatch(/create or replace function public\.guard_service_practitioner_active/i);
    expect(CODE).toMatch(/before insert on public\.service_practitioners/i);
    expect(CODE).toMatch(/p\.active = true/i);
  });

  it("backfill + default triggers only ever add ACTIVE practitioners", () => {
    // Backfill join filters active; both default-eligibility fns filter active.
    expect(CODE).toMatch(/join\s+public\.practitioners p\s+on p\.studio_id = s\.studio_id and p\.active = true/i);
    expect(CODE).toMatch(/where p\.studio_id = new\.studio_id and p\.active = true/i);
    expect(CODE).toMatch(/if new\.active = true then/i);
  });
});

describe("0134: collision-model invariants", () => {
  it("resource_key is NOT NULL and the shadow exclusion keys on it", () => {
    expect(CODE).toMatch(/alter column resource_key set not null/i);
    expect(CODE).toMatch(
      /no_overlapping_calendar_reservations_per_resource[\s\S]*?exclude using gist\s*\(\s*resource_key with =/i,
    );
  });

  it("appointment partials: studio-wide when OFF, per-practitioner when ON", () => {
    expect(CODE).toMatch(/no_overlapping_appointments_studio_wide[\s\S]*?where \(status = 'confirmed' and capacity_enabled = false\)/i);
    expect(CODE).toMatch(/no_overlapping_appointments_per_practitioner[\s\S]*?where \(status = 'confirmed' and capacity_enabled = true\)/i);
  });

  it("CHECK requires a practitioner only for confirmed/completed ON appointments", () => {
    expect(CODE).toMatch(
      /check\s*\(\s*capacity_enabled = false\s*or practitioner_id is not null\s*or status not in \('confirmed', 'completed'\)/i,
    );
  });

  it("appointment shadow sync UPSERTs (stable reservation-row identity)", () => {
    expect(CODE).toMatch(/on conflict on constraint studio_calendar_reservations_source_unique\s*do update set/i);
  });
});
