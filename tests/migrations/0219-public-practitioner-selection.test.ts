import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

const VERSION = "0219";
const FILE = "supabase/migrations/0219_public_practitioner_selection.sql";
const sql = readFileSync(FILE, "utf8");

/** The file with COMMENTS REMOVED.
 *
 *  A DDL/DML scan must read executable SQL, not prose. Scanning the raw text
 *  made the "writes nothing" assertion fail on the word "Truncate" inside a
 *  comment explaining `date_trunc` — a guard reporting a TRUNCATE in a
 *  migration that contains none. Line comments are stripped before block
 *  comments, or a `--` inside a block would be mis-paired. */
const EXECUTABLE = sql
  .replace(/--[^\n]*/g, " ")
  .replace(/\/\*[\s\S]*?\*\//g, " ");

describe("0219 sits correctly in the migration sequence", () => {
  it("is the repository maximum, and nothing sits above it", () => {
    // Only the CURRENT maximum migration's own test may assert this
    // (CLAUDE.md §2). 0218's test hands off to this one on this branch.
    expect(isRepoMax(VERSION), "0219 is no longer the repo max").toBe(true);
    expect(versionsAbove(VERSION)).toEqual([]);
  });

  it("is allocated exactly once", () => {
    expect(countVersion(VERSION)).toBe(1);
  });

  it("opens its own transaction and arms lock_timeout inside it", () => {
    // supabase db push does not wrap a file in a transaction, and a bare
    // SET LOCAL outside one emits 25P01 and never arms (CLAUDE.md §5).
    expect(sql).toMatch(/^begin;/m);
    expect(sql).toMatch(/set local lock_timeout = '5s';/);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    const begin = sql.indexOf("begin;");
    expect(sql.indexOf("set local lock_timeout")).toBeGreaterThan(begin);
  });
});

describe("0219 is additive — it changes no existing behaviour", () => {
  it("creates only the two new read functions", () => {
    const created = [...EXECUTABLE.matchAll(/create or replace function public\.([a-z_]+)/g)].map(
      (m) => m[1],
    );
    expect(created.sort()).toEqual([
      "public_booking_practitioner_options",
      "public_booking_slot_candidates_for_practitioner",
    ]);
  });

  it("does NOT redefine the existing public booking surfaces", () => {
    // The whole safety claim of this slice. Redefining either would make it a
    // behaviour change to every existing caller.
    expect(EXECUTABLE).not.toMatch(
      /create or replace function public\.create_public_appointment\b/,
    );
    expect(EXECUTABLE).not.toMatch(
      /create or replace function public\.public_booking_slot_candidates\s*\(/,
    );
  });

  it("writes nothing and alters no schema object", () => {
    for (const banned of [
      /\bcreate table\b/i,
      /\balter table\b/i,
      /\bdrop table\b/i,
      /\bcreate index\b/i,
      /\bcreate trigger\b/i,
      /\bcreate policy\b/i,
      /\binsert into\b/i,
      /\bupdate \w/i,
      /\bdelete from\b/i,
      /\btruncate\b/i,
    ]) {
      expect(EXECUTABLE, `0219 must not contain ${banned}`).not.toMatch(banned);
    }
  });
});

describe("0219 grant posture — authenticated-only means revoke all three by name", () => {
  // Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon, authenticated
  // AND service_role at create time, so each must be revoked explicitly by
  // name. Missed once in 0129 (anon) and again in 0164 (service_role).
  const fns: [string, string][] = [
    ["public_booking_practitioner_options", "uuid"],
    ["public_booking_slot_candidates_for_practitioner", "uuid, date, integer, uuid"],
  ];

  for (const [fn, args] of fns) {
    it(`${fn} revokes from public, anon, authenticated and service_role`, () => {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(
          sql,
          `${fn} does not revoke from ${role}`,
        ).toContain(`revoke execute on function public.${fn}(${args}) from ${role};`);
      }
    });

    it(`${fn} grants EXECUTE to service_role only`, () => {
      expect(sql).toContain(
        `grant execute on function public.${fn}(${args}) to service_role;`,
      );
      for (const role of ["anon", "authenticated"]) {
        expect(
          sql,
          `${fn} must not grant to ${role} — the public route uses the service-role client`,
        ).not.toContain(
          `grant execute on function public.${fn}(${args}) to ${role};`,
        );
      }
    });
  }
});

describe("0219 reuses existing authority rather than inventing policy", () => {
  it("uses 0139's capacity-aware resource scope, not a hand-rolled one", () => {
    expect(sql).toContain("public.studio_capacity_enabled(p_studio_id)");
    // studio-wide when capacity is off; the named practitioner's key when on.
    expect(sql).toMatch(/when not v_cap_on then cr\.resource_key = p_studio_id/);
    expect(sql).toMatch(/else cr\.resource_key = p_practitioner_id/);
  });

  it("uses 0152's window precedence — a practitioner row beats the studio row", () => {
    expect(sql).toMatch(
      /o\.practitioner_id = p_practitioner_id or o\.practitioner_id is null/,
    );
    expect(sql).toMatch(/order by \(o\.practitioner_id is not null\) desc/);
    expect(sql).toMatch(
      /d\.practitioner_id = p_practitioner_id or d\.practitioner_id is null/,
    );
    expect(sql).toMatch(/order by \(d\.practitioner_id is not null\) desc/);
  });

  it("refuses a practitioner who is not this studio's, active and treating", () => {
    expect(sql).toMatch(/p\.studio_id = p_studio_id/);
    expect(sql).toMatch(/p\.active/);
    expect(sql).toMatch(/p\.role in \('owner', 'practitioner'\)/);
  });
});
