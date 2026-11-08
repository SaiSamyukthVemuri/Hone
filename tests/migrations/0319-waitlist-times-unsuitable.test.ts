import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countVersion, isRepoMax } from "./helpers/migration-state";

// 0319 — "these times don't work". STATIC contract. Behaviour is proved against a
// real database in tests/db/waitlist-times-unsuitable.db.test.ts.

const M = readFileSync(join(__dirname, "..", "..", "supabase/migrations/0319_waitlist_times_unsuitable.sql"), "utf8");
const exec = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const E = exec(M);

describe("0319 — migration state", () => {
  it("is the current repository maximum and consumes exactly one number", () => {
    expect(isRepoMax("0319")).toBe(true);
    expect(countVersion("0319")).toBe(1);
  });
});

describe("0319 — shape", () => {
  it("opens its own transaction and arms lock_timeout inside it", () => {
    const e = E.trim();
    expect(e).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(e.endsWith("commit;")).toBe(true);
  });

  it("every definer function pins search_path to pg_catalog, pg_temp", () => {
    const defs = E.match(/create or replace function[\s\S]*?\$\$;/g) ?? [];
    expect(defs.length).toBe(4);
    for (const d of defs) expect(d).toMatch(/set search_path = pg_catalog, pg_temp/);
  });

  it("grants execute to service_role only, revoking all four default grantees by name", () => {
    for (const fn of [
      "decline_waitlist_invitation_times_unsuitable(text, text, text)",
      "count_waitlist_times_feedback(uuid, uuid)",
      "list_waitlist_times_feedback(uuid, uuid)",
      "acknowledge_waitlist_times_feedback(uuid, uuid, uuid)",
    ]) {
      expect(E).toContain(`revoke all on function public.${fn} from public, anon, authenticated, service_role;`);
      expect(E).toContain(`grant execute on function public.${fn} to service_role;`);
    }
    expect(E).not.toMatch(/grant[^;]*\bto (anon|authenticated|public)\b/);
  });

  it("the table has RLS on, no policy, and no grants", () => {
    expect(E).toMatch(/alter table public\.waitlist_times_feedback enable row level security;/);
    expect(E).not.toMatch(/create policy/);
    expect(E).toMatch(/revoke all on public\.waitlist_times_feedback from public, anon, authenticated, service_role;/);
  });

  it("returns the SAME entry to waiting and never inserts an entry", () => {
    expect(E).not.toMatch(/insert into public\.new_client_waitlist_entries/);
    expect(E).toMatch(/set status = 'released'[\s\S]*set status = 'waiting'/);
    expect(E).not.toMatch(/joined_at/);
  });

  it("locks entry before invitation (0192 decline's order)", () => {
    const i = E.indexOf("from public.new_client_waitlist_entries e");
    const j = E.indexOf("from public.new_client_waitlist_invitations i\n   where i.id = v_inv");
    expect(i).toBeGreaterThan(0);
    expect(j).toBeGreaterThan(i);
  });

  it("owner commands are gated by the owner resolver", () => {
    expect((E.match(/new_client_waitlist_resolve_owner/g) ?? []).length).toBe(3);
  });
});
