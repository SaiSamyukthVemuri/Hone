import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// 0367: one owner-only, read-only command that returns COUNTS of waitlist invitations in a period and how many became a booking. Behaviour is proved
// against a real database in tests/db/waitlist-invitation-booking-counts.db.test.ts. This file pins the SHAPE of the files, so a later edit cannot
// widen the grant, add a write or drop the owner check without a test going red.

const root = join(__dirname, "..", "..");
const UP_PATH = join(root, "supabase/migrations/0367_waitlist_invitation_booking_counts.sql");
const DOWN_PATH = join(root, "supabase/rollbacks/0367_waitlist_invitation_booking_counts.down.sql");
const exec = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const FN = "public.waitlist_invitation_booking_counts(uuid, timestamptz, timestamptz)";

const up = () => exec(readFileSync(UP_PATH, "utf8"));
const down = () => exec(readFileSync(DOWN_PATH, "utf8"));

describe("0367 migration: the files exist and open their own transaction", () => {
  it("has an up file and a down file", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
  it("opens its own transaction with the lock timeout INSIDE it, and commits", () => {
    const u = up().trim();
    expect(u).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(u.endsWith("commit;")).toBe(true);
    const d = down().trim();
    expect(d).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(d.endsWith("commit;")).toBe(true);
  });
});

describe("0367 migration: one function, read-only, owner-checked, pinned", () => {
  it("creates exactly one function with the agreed signature", () => {
    const u = up();
    expect([...u.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([\w.]+)\s*\(/gi)].map((m) => m[1])).toEqual(["public.waitlist_invitation_booking_counts"]);
    expect(u).toMatch(/p_studio_id\s+uuid\s*,\s*p_from\s+timestamptz\s+default\s+null\s*,\s*p_to\s+timestamptz\s+default\s+null/);
  });
  it("is security definer, stable, with a pinned search_path", () => {
    const u = up();
    expect(u).toMatch(/\bsecurity definer\b/);
    expect(u).toMatch(/\bstable\b/);
    expect(u).toMatch(/set search_path = pg_catalog, pg_temp/);
    expect(u).not.toMatch(/\bvolatile\b/);
  });
  it("re-derives the owner from auth.uid() for the studio asked about, and refuses with ONE generic error", () => {
    const u = up();
    expect(u).toMatch(/auth\.uid\(\)\s+is\s+null/);
    expect(u).toMatch(/public\.is_studio_owner\(p_studio_id\)/);
    expect(u).toMatch(/raise exception 'not allowed' using errcode = '42501'/);
    // Nothing names the studio, the caller or a role in a message.
    const body = u.match(/create function[\s\S]*?\n\$\$;/)![0];
    expect([...body.matchAll(/raise exception '([^']*)'/g)].map((m) => m[1])).toEqual(["not allowed", "invalid window"]);
  });
  it("writes nothing and creates nothing: no insert, update, delete, merge, truncate, create table or alter table", () => {
    const u = up();
    expect(u).not.toMatch(/\b(insert\s+into|update\s+public\.|delete\s+from|merge\s+into|truncate|create\s+table|alter\s+table|drop\s+table)\b/i);
    expect(u).not.toMatch(/\bperform\b/i);
  });
  it("reads only the three tables it needs, and no contact, name or token column", () => {
    const u = up();
    const tables = new Set([...u.matchAll(/\b(?:from|join)\s+(public\.[a-z_]+)/gi)].map((m) => m[1]));
    expect([...tables].sort()).toEqual([
      "public.appointments",
      "public.new_client_waitlist_entries",
      "public.new_client_waitlist_invitations",
      "public.waitlist_invitation_bookings",
    ]);
    expect(u).not.toMatch(/\b(email|phone|name|token_hash|notes)\b/i);
    expect(u).not.toMatch(/\bselect\s+\*/i);
  });
  it("returns counts only (integers), nothing else", () => {
    const u = up();
    const returns = u.match(/returns table\s*\(([\s\S]*?)\)\s*language/i)?.[1] ?? "";
    const cols = returns.split(",").map((c) => c.trim().split(/\s+/));
    expect(cols).toEqual([
      ["invitations_total", "integer"],
      ["people_invited", "integer"],
      ["booked_linked_live", "integer"],
      ["booked_then_cancelled", "integer"],
      ["converted_unlinked", "integer"],
    ]);
  });
});

describe("0367 migration: the grant", () => {
  it("revokes EXECUTE from public, anon, authenticated AND service_role by name, then grants authenticated only", () => {
    const u = up();
    expect(u).toContain(`revoke all on function ${FN} from public, anon, authenticated, service_role;`);
    const grants = [...u.matchAll(/grant\s+execute\s+on\s+function\s+[^;]+?\s+to\s+([a-z_, ]+);/gi)].map((m) => m[1]!.trim());
    expect(grants).toEqual(["authenticated"]);
    expect(u).toContain(`grant execute on function ${FN} to authenticated;`);
  });
  it("ends with a self-check of the privileges, so an apply that finds another grantee fails", () => {
    const u = up();
    expect(u).toMatch(/has_function_privilege\('anon'/);
    expect(u).toMatch(/has_function_privilege\('service_role'/);
    expect(u).toMatch(/has_function_privilege\('authenticated'/);
    expect(u).toMatch(/aclexplode\(p\.proacl\)[\s\S]*a\.grantee = 0/);
  });
});

describe("0367 rollback", () => {
  it("only drops the function, and touches no table, row or other function", () => {
    const d = down();
    expect(d).toContain(`drop function if exists ${FN};`);
    expect(d).not.toMatch(/\b(drop\s+table|delete\s+from|update\s+public\.|insert\s+into|alter\s+table|create\s+)/i);
  });
});
