import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// ===========================================================================
// HON-44 — THE RECEPTIONIST NAME / SEARCH PAYLOAD BOUNDARY (current schema).
//
// A receptionist is not a practitioner (0216). Their only client-facing reads
// are two security-definer functions. This pins, from the migration source, what
// those functions can return and search, so a later edit cannot widen a
// receptionist's view of a client by adding a column to a select list:
//
//   * the exact RETURNS TABLE columns of each function;
//   * the NAME is the stored clients.name, never a preferred or legal identity
//     (HON-58 adds those for ordinary staff surfaces; a receptionist is not one);
//   * the search predicate touches only name, email and phone, escapes LIKE
//     metacharacters, needs 2+ characters, and is capped at 50 rows;
//   * the actor check runs BEFORE any client read, archived clients are out,
//     and the studio is bound by p_studio_id;
//   * execute is granted to authenticated only.
//
// SOURCE CONTRACT: it reads SQL text. It does not prove behaviour on a live
// database (that is tests/db territory and needs a local stack), and it does not
// judge the product question of what a receptionist SHOULD see; it only holds
// the line 0216 drew. Widening it should fail here and be a decision.
// ===========================================================================

const SQL = readFileSync(
  path.resolve(__dirname, "../../supabase/migrations/0216_receptionist_membership_foundation.sql"),
  "utf8",
);

function fn(name: string): string {
  const start = SQL.indexOf(`create or replace function public.${name}(`);
  expect(start, `${name} definition`).toBeGreaterThan(-1);
  const end = SQL.indexOf("\n$$;", start);
  expect(end).toBeGreaterThan(start);
  return SQL.slice(start, end);
}

// Negative checks run on code, not on the comments that NAME what is excluded.
const code = (body: string) => body.replace(/--[^\n]*/g, "");

function returnsColumns(body: string): string[] {
  const m = body.match(/returns table \(([\s\S]*?)\)\s*language/);
  expect(m).not.toBeNull();
  return m![1]
    .split(",")
    .map((c) => c.trim().split(/\s+/)[0])
    .filter(Boolean);
}

const contacts = fn("receptionist_client_contacts");
const calendar = fn("receptionist_calendar");

describe("receptionist_client_contacts", () => {
  it("returns exactly the contact fields and completion facts", () => {
    expect(returnsColumns(contacts)).toEqual([
      "client_id", "name", "phone", "email", "intake_status", "intake_submitted_at", "consent_accepted_at",
    ]);
  });
  it("selects the stored name only: no preferred or legal identity, no other client column", () => {
    const sel = contacts.slice(contacts.indexOf("select c.id"), contacts.indexOf("from public.clients c"));
    expect(sel).toContain("c.id, c.name, c.phone, c.email");
    const clientCols = [...code(contacts).matchAll(/\bc\.([a-z_]+)/g)].map((m) => m[1]);
    expect(new Set(clientCols)).toEqual(
      new Set(["id", "name", "phone", "email", "studio_id", "archived_at"]),
    );
    expect(code(contacts)).not.toMatch(/preferred_name|legal_|date_of_birth|address|allerg|notes/);
  });
  it("searches name, email and phone only, with LIKE metacharacters escaped", () => {
    const where = contacts.slice(contacts.indexOf("v_pattern is null"));
    const searched = [...where.matchAll(/or c\.([a-z_]+) ilike v_pattern/g)].map((m) => m[1]);
    expect(searched).toEqual(["name", "email", "phone"]);
    expect(contacts).toContain("replace(replace(replace(v_query, '\\', '\\\\'), '%', '\\%'), '_', '\\_')");
  });
  it("needs 2+ characters and caps the page at 50", () => {
    expect(contacts).toContain("char_length(v_query) < 2");
    expect(contacts).toContain("least(greatest(coalesce(p_limit, 25), 1), 50)");
  });
  it("checks the actor before reading any client, binds the studio, and drops archived clients", () => {
    const actor = contacts.indexOf("receptionist_actor_id(p_studio_id) is null");
    const firstRead = contacts.indexOf("from public.clients c");
    expect(actor).toBeGreaterThan(-1);
    expect(actor).toBeLessThan(firstRead);
    expect(contacts).toContain("where c.studio_id = p_studio_id");
    expect(contacts).toContain("c.archived_at is null");
  });
});

describe("receptionist_calendar", () => {
  it("returns exactly the fixed calendar columns, with the client NAME as the only client field", () => {
    expect(returnsColumns(calendar)).toEqual([
      "appointment_id", "starts_at", "ends_at", "status",
      "practitioner_id", "practitioner_display_name", "practitioner_color",
      "service_id", "service_name", "client_id", "client_display_name",
    ]);
  });
  it("sources client_display_name from the stored name, not a preferred or legal identity", () => {
    expect(calendar).toContain("a.client_id, c.name");
    expect(code(calendar)).not.toMatch(/preferred_name|legal_|price|payment|notes/);
  });
  it("checks the actor first, bounds the window to 93 days, and binds the studio", () => {
    expect(calendar.indexOf("receptionist_actor_id(p_studio_id) is null")).toBeLessThan(calendar.indexOf("from public.appointments a"));
    expect(calendar).toContain("interval '93 days'");
    expect(calendar).toContain("where a.studio_id = p_studio_id");
  });
});

describe("grants", () => {
  it.each([
    "receptionist_client_contacts(uuid, text, integer)",
    "receptionist_calendar(uuid, timestamptz, timestamptz)",
  ])("%s: revoked from public, anon and service_role by name; granted to authenticated only", (sig) => {
    for (const role of ["public", "anon", "service_role"]) {
      expect(SQL).toContain(`revoke execute on function public.${sig} from ${role};`);
    }
    expect(SQL).toMatch(new RegExp(`grant execute on function public\\.${sig.replace(/[()]/g, "\\$&")}\\s+to authenticated;`));
    expect(SQL).not.toMatch(new RegExp(`grant execute on function public\\.${sig.replace(/[()]/g, "\\$&")}\\s+to (anon|public|service_role)`));
  });
});
