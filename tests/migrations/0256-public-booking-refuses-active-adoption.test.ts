import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// 0256 (SEC-004): an ordinary public new-client booking refuses, inside its own
// transaction, to adopt an existing ACTIVE client by email. Source contract; the
// behaviour is proved on a real database in
// tests/db/public-booking-refuses-active-adoption.db.test.ts.

const VERSION = "0256";
const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/0256_public_booking_refuses_active_client_adoption.sql"),
  "utf8",
);

// Strip comments and string literals so a prose mention cannot satisfy a rule.
const CODE = SQL.replace(/--[^\n]*/g, "").replace(/'(?:[^']|'')*'/g, "''");
const fnBody = (name: string): string => {
  const a = SQL.indexOf(`create or replace function public.${name}(`);
  expect(a, `${name} is not redefined`).toBeGreaterThan(-1);
  return SQL.slice(a, SQL.indexOf("\n$$;", a));
};

describe("0256 file shape", () => {
  it("is sha-pinned", () => {
    expect(createHash("sha256").update(SQL, "utf8").digest("hex")).toBe("47a37b19c2381985e33d2213c04b977315df44a7d919c0c8c600af0663b1af0c");
  });

  it("is allocated exactly once and is the repository maximum", () => {
    expect(countVersion(VERSION)).toBe(1);
    expect(isRepoMax(VERSION)).toBe(true);
    expect(versionsAbove(VERSION)).toEqual([]);
  });

  it("is one transaction with its own lock timeout inside it", () => {
    const begin = CODE.indexOf("begin;");
    const lock = CODE.indexOf("set local lock_timeout");
    const commit = CODE.lastIndexOf("commit;");
    expect(begin).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(begin);
    expect(commit).toBeGreaterThan(lock);
  });

  it("changes functions only: no table, column, index, trigger, policy or data", () => {
    expect(CODE).not.toMatch(/\b(create|alter|drop)\s+(table|index|trigger|policy|type)\b/i);
    expect(CODE).not.toMatch(/\balter\s+table\b/i);
  });
});

describe.each([
  ["create_public_appointment_for_new_client", 13],
  ["create_public_appointment_for_new_client_v2", 14],
])("%s", (name, argc) => {
  const body = fnBody(name);

  it("refuses, with the closed result, in BOTH places an existing row can be found", () => {
    const refusals = body.match(/select 'existing_client_requires_confirmation'::text/g) ?? [];
    expect(refusals).toHaveLength(2);
  });

  it("refuses only for the ordinary path (no invitation entry) and only for a found row", () => {
    const guards = body.match(/if v_client_id is not null and p_entry_id is null then/g) ?? [];
    expect(guards).toHaveLength(2);
  });

  it("still refuses an ARCHIVED row exactly as before", () => {
    expect((body.match(/select 'archived_client_collision'::text/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // the archived check runs before the active one, so an archived row keeps its own code
    expect(body.indexOf("archived_client_collision")).toBeLessThan(body.indexOf("existing_client_requires_confirmation"));
  });

  it("is not weakened for invitations: no refusal is keyed on anything but p_entry_id being null", () => {
    expect(body).not.toMatch(/existing_client_requires_confirmation[\s\S]{0,200}p_entry_id is not null/);
  });

  it("restates its grants by NAME: revoked from public, anon, authenticated and service_role, then granted to service_role only", () => {
    const sig = new RegExp(`public\\.${name}\\(`);
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(SQL, `${role} not revoked`).toMatch(new RegExp(`revoke execute on function public\\.${name}\\([^)]*\\) from ${role};`));
    }
    const grants = SQL.match(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to ([a-z_]+);`, "g")) ?? [];
    expect(grants).toHaveLength(1);
    expect(grants[0]).toContain("service_role");
    expect(SQL).toMatch(sig);
    const m = SQL.match(new RegExp(`grant execute on function public\\.${name}\\(([^)]*)\\)`));
    expect((m?.[1] ?? "").split(",").length).toBe(argc);
  });
});
