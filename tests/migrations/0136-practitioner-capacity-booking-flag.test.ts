import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Source/structural contract for migration 0136 (two-flag capacity state model).

const DIR = join(process.cwd(), "supabase/migrations");
const FILE = readdirSync(DIR).find((f) => f.startsWith("0136_"));
const SQL = FILE ? readFileSync(join(DIR, FILE), "utf8") : "";
const CODE = SQL.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");

describe("0136 — file", () => {
  it("exists with a purpose-encoding name", () => {
    expect(FILE).toBe("0136_practitioner_capacity_booking_flag.sql");
  });
});

describe("0136 — booking flag + state validity", () => {
  it("adds the operator-controlled booking flag, default false", () => {
    expect(CODE).toMatch(
      /add column if not exists practitioner_capacity_booking_enabled boolean not null default false/i,
    );
  });
  it("rejects the invalid state (booking on without capacity) via a CHECK", () => {
    expect(CODE).toMatch(
      /check \(practitioner_capacity_enabled or not practitioner_capacity_booking_enabled\)/i,
    );
  });
  it("the operator guard covers BOTH flags", () => {
    expect(CODE).toMatch(
      /before update of practitioner_capacity_enabled, practitioner_capacity_booking_enabled/i,
    );
    expect(CODE).toMatch(/practitioner_capacity_booking_enabled is distinct from old/i);
    expect(CODE).toMatch(/current_user in \('anon', 'authenticated'\)/i);
  });
});

describe("0136 — structural retirement RPC", () => {
  it("is SECURITY DEFINER with a hardened search_path, preflights, and fails closed", () => {
    const fn = CODE.match(
      /create or replace function public\.retire_practitioner_capacity[\s\S]*?\$\$;/i,
    )?.[0];
    expect(fn).toBeTruthy();
    expect(fn).toMatch(/security definer/i);
    expect(fn).toMatch(/set search_path = pg_catalog, pg_temp/i);
    expect(fn).toMatch(/for update/i); // locks the studio row
    expect(fn).toMatch(/booking_still_enabled/);
    expect(fn).toMatch(/overlapping_appointments/);
    // Only flips capacity OFF after the preflight passes.
    expect(fn).toMatch(/update public\.studios set practitioner_capacity_enabled = false/i);
  });

  it("both retirement functions are service-role only (revoked from browser roles)", () => {
    for (const sig of [
      "public.retire_practitioner_capacity(uuid)",
      "public.practitioner_capacity_retirement_blockers(uuid)",
    ]) {
      expect(CODE).toContain(sig);
    }
    expect(CODE).toMatch(/revoke execute on function %s from public/i);
    expect(CODE).toMatch(/revoke execute on function %s from anon/i);
    expect(CODE).toMatch(/revoke execute on function %s from authenticated/i);
    expect(CODE).toMatch(/grant execute on function %s to service_role/i);
  });

  it("exposes no client/clinical data — reason codes are counts only", () => {
    // The RPC bodies never select name/email/notes.
    expect(CODE).not.toMatch(/\b(email|phone|display_name|notes|client_id)\b/i);
  });
});
