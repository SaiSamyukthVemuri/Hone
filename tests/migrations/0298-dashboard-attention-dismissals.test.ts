import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Migration 0298 (HELD): the owner's per-user dismissals of Dashboard reminders. Source contract; behaviour is proved by
// tests/db/dashboard-attention-dismissals.db.test.ts on an owned stack.

const raw = readFileSync("supabase/migrations/0298_dashboard_attention_dismissals.sql", "utf8");
const code = raw.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const FNS = [
  "dismiss_attention_item(uuid, text, text)",
  "restore_attention_item(uuid, text)",
  "list_dismissed_attention(uuid)",
];

describe("0298 source contract", () => {
  it("opens its own transaction and arms lock_timeout inside it", () => {
    expect(code).toMatch(/^\s*begin;\s*\n\s*set local lock_timeout/m);
    expect(code.trim().endsWith("commit;")).toBe(true);
  });
  it("revokes every default-granted role BY NAME from each command, then grants authenticated only", () => {
    for (const fn of FNS) {
      const esc = fn.replace(/[()]/g, "\\$&");
      expect(code, fn).toMatch(new RegExp(`revoke execute on function public\\.${esc} from public, anon, service_role, authenticated;`));
      expect(code, fn).toMatch(new RegExp(`grant execute on function public\\.${esc} to authenticated;`));
      expect(code, fn).not.toMatch(new RegExp(`grant execute on function public\\.${esc} to (anon|public|service_role)`));
    }
  });
  it("every command is SECURITY DEFINER with an empty search_path and checks the owner and auth.uid()", () => {
    for (const name of ["dismiss_attention_item", "restore_attention_item", "list_dismissed_attention"]) {
      const start = code.indexOf(`function public.${name}`);
      const asAt = code.indexOf("as $$", start);
      const fn = code.slice(start, code.indexOf("$$;", asAt));
      expect(fn, name).toMatch(/security definer/);
      expect(fn, name).toMatch(/set search_path = ''/);
      expect(fn, name).toMatch(/v_user uuid := auth\.uid\(\)/);
      expect(fn, name).toMatch(/v_user is null or p_studio is null or not public\.is_studio_owner\(p_studio\)/);
    }
  });
  it("the table has RLS on, no policy, and no privilege for any API role", () => {
    expect(code).toMatch(/alter table public\.dashboard_attention_events enable row level security;/);
    expect(code).not.toMatch(/create policy/i);
    expect(code).toMatch(/revoke all on table public\.dashboard_attention_events from public, anon, authenticated, service_role;/);
    expect(code).not.toMatch(/grant (select|insert|update|delete|all)[^;]*on (table )?public\.dashboard_attention_events/i);
  });
  it("is append-only: update and delete are refused by a trigger", () => {
    expect(code).toMatch(/before update or delete on public\.dashboard_attention_events/);
  });
  it("touches no money, setup or access table: no foreign key, no read, no write", () => {
    const refs = [...code.matchAll(/public\.(\w+)/g)].map((m) => m[1]);
    const tables = new Set(refs.filter((r) => !FNS.some((f) => f.startsWith(r)) && r !== "dashboard_attention_events_immutable"));
    expect([...tables].sort()).toEqual(["dashboard_attention_events", "is_studio_owner", "studios"]);
    expect(code).not.toMatch(/payment|settlement|jurisdiction|stripe|permission_|practitioners/i);
  });
  it("stores ids and opaque tokens only: no name, amount or message column", () => {
    const table = code.slice(code.indexOf("create table"), code.indexOf(");", code.indexOf("create table")));
    expect(table).not.toMatch(/\b(name|email|amount|cents|message|body|note)\b/i);
  });
});
