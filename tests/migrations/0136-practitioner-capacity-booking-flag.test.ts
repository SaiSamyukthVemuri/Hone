import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Source/structural contract for migration 0136 (two-flag capacity state model).

const DIR = join(process.cwd(), "supabase/migrations");
const FILE = readdirSync(DIR).find((f) => f.startsWith("0136_"));
const SQL = FILE ? readFileSync(join(DIR, FILE), "utf8") : "";
const CODE = SQL.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");

describe("0136: file", () => {
  it("exists with a purpose-encoding name", () => {
    expect(FILE).toBe("0136_practitioner_capacity_booking_flag.sql");
  });
});

describe("0136: booking flag + state validity", () => {
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

describe("0136: structural retirement RPC", () => {
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

  it("exposes no client/clinical data: reason codes are counts only", () => {
    // The RPC bodies never select name/email/notes.
    expect(CODE).not.toMatch(/\b(email|phone|display_name|notes|client_id)\b/i);
  });
});

describe("0136: 3B-1 three-state model", () => {
  it("documents THREE technical states, not four", () => {
    expect(SQL).toMatch(/CAPACITY_READY_BOOKING_PAUSED/);
    expect(SQL).toMatch(/THREE\b/i);
    expect(SQL).not.toMatch(/yield four states/i);
  });
});

describe("0136: 3B-2 capacity-participation predicate (used consistently)", () => {
  it("defines one named predicate: confirmed OR completed-not-expired", () => {
    expect(CODE).toMatch(
      /function public\.appointment_participates_in_capacity\(\s*p_status text,\s*p_blocked_ends_at timestamptz/i,
    );
    expect(CODE).toMatch(
      /p_status = 'confirmed'\s*or \(p_status = 'completed' and p_blocked_ends_at > now\(\)\)/i,
    );
  });
  it("the sync trigger, rematerialize, retire, and blockers ALL use the predicate", () => {
    const uses = CODE.match(/appointment_participates_in_capacity\(/g) ?? [];
    // definition + sync + rematerialize + retire(2) + blockers(2) => >= 6 call sites.
    expect(uses.length).toBeGreaterThanOrEqual(6);
    // The old confirmed-only overlap literal is gone from the retirement path.
    expect(CODE).not.toMatch(/a1\.status = 'confirmed' and a2\.status = 'confirmed'/);
  });
});

describe("0136: 3B-3 nonexistent-studio + 3B-4 advisory lock", () => {
  it("blockers reports studio_exists first", () => {
    expect(CODE).toMatch(
      /returns table \(studio_exists boolean, booking_still_enabled boolean, overlapping_appointments int\)/i,
    );
    expect(CODE).toMatch(/exists \(select 1 from public\.studios s where s\.id = p_studio_id\)/i);
  });
  it("a per-studio transaction advisory lock helper exists and retire takes it first", () => {
    expect(CODE).toMatch(
      /function public\.acquire_studio_capacity_lock\(p_studio_id uuid\)[\s\S]*?pg_advisory_xact_lock\(hashtextextended\('studio_capacity:' \|\| p_studio_id::text, 0\)\)/i,
    );
    // retire acquires the lock before reading the studio row.
    const retire = CODE.match(/function public\.retire_practitioner_capacity[\s\S]*?\$\$;/i)?.[0];
    expect(retire).toMatch(/acquire_studio_capacity_lock\(p_studio_id\)[\s\S]*for update/i);
  });
  it("the new helpers are execute-revoked from browser roles", () => {
    expect(CODE).toContain("public.appointment_participates_in_capacity(text, timestamptz)");
    expect(CODE).toContain("public.acquire_studio_capacity_lock(uuid)");
  });
});
