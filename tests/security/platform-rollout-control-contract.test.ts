import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Platform rollout control: the SOURCE CONTRACT of docs/proposals/platform-rollout-control.sql (it moves to supabase/migrations/<number>_... unchanged
// at seal and this path is then updated). Unit lane, no database. Behaviour is proved by tests/db/platform-rollout-control.db.test.ts.
const SQL = readFileSync("docs/proposals/platform-rollout-control.sql", "utf8");
const CODE = SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const ROLLBACK = readFileSync("docs/proposals/platform-rollout-control-rollback.sql", "utf8");

const fns: { name: string; args: string; body: string }[] = [];
for (const m of CODE.matchAll(/create function public\.(\w+)\(([\s\S]*?)\)\s*returns/g)) {
  const end = CODE.indexOf("\n$$;", m.index!);
  fns.push({ name: m[1], args: m[2].replace(/\s+/g, " ").trim(), body: CODE.slice(m.index!, end) });
}
const find = (n: string) => fns.find((f) => f.name === n)!;
const CALLABLE = ["platform_rollout_enabled_for", "set_platform_rollout_mode", "add_platform_rollout_studio", "remove_platform_rollout_studio", "list_platform_rollout", "log_blocked_platform_rollout_attempt"];

describe("grants: every function revoked from ALL FOUR roles by name; the callable ones to service_role ONLY", () => {
  it("each function has the by-name revoke", () => {
    expect(fns.length).toBe(7);
    for (const f of fns) expect(CODE, f.name).toMatch(new RegExp(`revoke all on function public\\.${f.name}\\([^)]*\\) from public, anon, authenticated, service_role;`));
  });
  it("only service_role is ever granted; the internal actor check is granted to nobody", () => {
    for (const n of CALLABLE) expect(CODE, n).toMatch(new RegExp(`grant execute on function public\\.${n}\\([^)]*\\) to service_role;`));
    expect(CODE).not.toMatch(/grant execute on function public\.platform_rollout_check_actor/);
    expect(CODE).not.toMatch(/grant[^;]* to [^;]*\b(anon|authenticated|public)\b/i);
  });
  it("both tables: RLS on, every privilege revoked, no policy and no grant for any role", () => {
    for (const t of ["platform_rollouts", "platform_rollout_studios"]) {
      expect(CODE).toContain(`alter table public.${t} enable row level security;`);
      expect(CODE).toContain(`revoke all on public.${t} from public, anon, authenticated, service_role;`);
    }
    expect(CODE).not.toMatch(/create policy/i);
    expect(CODE).not.toMatch(/grant (select|insert|update|delete|all)[^;]* on (table )?public\.platform_rollout/i);
  });
});

describe("the migration touches only the control and its audit", () => {
  it("never names a studio machine, reading, capture, block or chart table (invariant: All never creates or edits them)", () => {
    expect(CODE).not.toMatch(/studio_machines|treatment_setup|session_blocks|block_write_receipts|machine_profile|appointments|clients/);
    const writes = [...CODE.matchAll(/\b(?<!before )(?<!do )(insert into|update|delete from)\s+(?:public\.)?(\w+)/g)].map((m) => m[2]);
    const allowed = new Set(["platform_rollouts", "platform_rollout_studios", "admin_action_events"]);
    expect(writes.filter((w) => !allowed.has(w))).toEqual([]);
    expect(CODE).not.toMatch(/alter table public\.(studios|practitioners|clients)/);
  });
  it("opens its own begin/commit with lock_timeout inside; the single seeded row is the control itself, mode off", () => {
    expect(CODE).toMatch(/^\s*begin;\s*\nset local lock_timeout/m);
    expect(CODE.trim().endsWith("commit;")).toBe(true);
    expect(CODE).toMatch(/insert into public\.platform_rollouts \(key\) values \('charting_new_view_xcell'\);/);
    expect(CODE).toMatch(/mode\s+text not null default 'off'/);
  });
});

describe("the audit rules inside the commands (Privacy 1 to 3, Insurance S2)", () => {
  const writers = ["set_platform_rollout_mode", "add_platform_rollout_studio", "remove_platform_rollout_studio"];
  it("each writer validates the actor, writes its audit row in the same function, with CONSTANT action and target_type", () => {
    const expected: Record<string, string> = { set_platform_rollout_mode: "platform_rollout_mode_set", add_platform_rollout_studio: "platform_rollout_studio_added", remove_platform_rollout_studio: "platform_rollout_studio_removed" };
    for (const n of writers) {
      const b = find(n).body;
      expect(b, n).toContain("platform_rollout_check_actor(p_actor_user_id, p_actor_email)");
      expect(b, n).toContain("insert into public.admin_action_events");
      expect(b, n).toContain(`'platform_rollout', p_key, '${expected[n]}'`);
      expect(b, n).toMatch(/actor_user_id/);
    }
  });
  it("metadata is built here from constants and ids only: exactly mode_before/mode_after or studio_id, never a parameter passed through", () => {
    expect(find("set_platform_rollout_mode").body).toContain("jsonb_build_object('mode_before', v_before, 'mode_after', p_mode)");
    for (const n of ["add_platform_rollout_studio", "remove_platform_rollout_studio"]) expect(find(n).body, n).toContain("jsonb_build_object('studio_id', p_studio::text)");
    for (const f of fns) expect(f.args, f.name).not.toMatch(/metadata|jsonb|body|note|reason|message|text_/i);
    expect(CODE.match(/jsonb_build_object\(/g)?.length).toBe(3);
  });
  it("the actor email is shape- and length-checked, and the tables store only user ids (no email column)", () => {
    expect(find("platform_rollout_check_actor").body).toMatch(/length\(p_actor_email\) > 254/);
    expect(find("platform_rollout_check_actor").body).toMatch(/!~ '\^\[\^@\[:space:\]\[:cntrl:\]\]\+@\[\^@\[:space:\]\[:cntrl:\]\]\+\$'/);
    const tables = CODE.slice(CODE.indexOf("create table public.platform_rollouts"), CODE.indexOf("alter table public.platform_rollouts enable"));
    expect(tables).not.toMatch(/email/i);
    expect(tables).toMatch(/updated_by uuid/);
    expect(tables).toMatch(/added_by\s+uuid/);
  });
  it("a blocked attempt: user id only (NO email column written), constant actions, de-duplicated to one per user per action per 10 minutes", () => {
    const b = find("log_blocked_platform_rollout_attempt").body;
    expect(b).toMatch(/insert into public\.admin_action_events \(actor_user_id, target_type, action, outcome, source\)/);
    expect(b).not.toMatch(/actor_email|metadata/);
    expect(b).toContain("interval '10 minutes'");
    expect(b).toContain("pg_advisory_xact_lock");
    expect(b).toMatch(/p_action not in \('platform_rollout_mode_set', 'platform_rollout_studio_added', 'platform_rollout_studio_removed'\)/);
  });
});

describe("the read fails closed", () => {
  it("an unknown key, a missing studio id and every unexpected mode are false; 'all' never reads membership; only 'pilot' does", () => {
    const b = find("platform_rollout_enabled_for").body;
    expect(b).toContain("if p_key is null or p_studio is null then return false; end if;");
    expect(b.indexOf("if v_mode = 'all' then return true; end if;")).toBeLessThan(b.indexOf("platform_rollout_studios"));
    expect(b).toMatch(/if v_mode = 'pilot' then\s+return exists/);
    expect(b.trim().endsWith("return false;\nend;") || /return false;\s*end;?$/.test(b.trim())).toBe(true);
  });
});

describe("rollback", () => {
  it("refuses unless the mode is off and no pilot row exists, and never touches the audit table", () => {
    expect(ROLLBACK).toMatch(/if v_mode is not null or n > 0 then\s+raise exception 'REFUSED/);
    expect(ROLLBACK.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")).not.toMatch(/admin_action_events/);
    expect(ROLLBACK).toMatch(/Set Off and remove the pilots first/);
  });
});
