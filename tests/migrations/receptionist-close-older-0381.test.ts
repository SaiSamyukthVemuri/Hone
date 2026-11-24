import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isRepoMax } from "./helpers/migration-state";

// 0381 closes receptionist_client_directory and receptionist_client_contacts_v2 by privilege only. SOURCE contract; the behaviour is proved by
// tests/db/receptionist-older-commands-closed.db.test.ts on a real database.

const UP = readFileSync("supabase/migrations/0381_receptionist_close_older_contact_commands.sql", "utf8");
const DOWN = readFileSync("supabase/rollbacks/0381_receptionist_close_older_contact_commands.down.sql", "utf8");
const S0380 = readFileSync("supabase/migrations/0380_receptionist_name_rule.sql", "utf8");
const FNS = [
  "public.receptionist_client_directory(uuid, text, text[], text, integer, integer)",
  "public.receptionist_client_contacts_v2(uuid, text, integer)",
];
const MD5 = ["9356d1ca1f30005b09b5f6ba1765d59f", "2c398e896eede58c9a09a11213b122a0"];
const code = (s: string) => s.replace(/--[^\n]*/g, "");

describe("0381 is shaped like a sealed migration", () => {
  it("is the current maximum migration", () => {
    expect(isRepoMax("0381")).toBe(true);
  });
  it("opens its own transaction, arms lock_timeout inside it, and changes no function body", () => {
    expect(UP).toMatch(/^begin;$/m);
    expect(UP).toMatch(/^commit;$/m);
    expect(UP.indexOf("begin;")).toBeLessThan(UP.indexOf("set local lock_timeout"));
    expect(UP.indexOf("set local lock_timeout")).toBeLessThan(UP.indexOf("revoke all on function"));
    expect(code(UP)).not.toMatch(/create\s+(or\s+replace\s+)?function/i);
    expect(DOWN).toMatch(/^begin;$/m);
    expect(DOWN).toMatch(/^commit;$/m);
    expect(code(DOWN)).not.toMatch(/create\s+(or\s+replace\s+)?function/i);
  });
  it("fails closed: refuses unless both bodies are exactly 0380's (so it cannot apply before 0380)", () => {
    const pre = UP.slice(UP.indexOf("$pre$"), UP.indexOf("$pre$;"));
    for (const m of MD5) expect(pre).toContain(`'${m}'`);
    for (const f of FNS) expect(pre).toContain(`'${f}'`);
    expect(pre).toMatch(/refuses to run/);
    expect(pre).toMatch(/apply 0380 first/);
    // the md5s are the ones 0380's own after-check records
    for (const m of MD5) expect(S0380).toContain(`'${m}'`);
  });
});

describe("the privilege change", () => {
  it("revokes EXECUTE by name from public, anon, authenticated and service_role on both, and grants nothing", () => {
    for (const f of FNS) {
      expect(UP).toContain(`revoke all on function ${f} from public, anon, authenticated, service_role;`);
      for (const role of ["public", "anon", "authenticated", "service_role"]) expect(UP, `${f} ${role}`).toContain(`revoke execute on function ${f} from ${role};`);
    }
    expect(code(UP)).not.toMatch(/\bgrant\b/i);
  });
  it("names no other function and leaves receptionist_calendar_v2 open", () => {
    const names = new Set([...code(UP).matchAll(/public\.([a-z0-9_]+)\(/g)].map((m) => m[1]));
    expect([...names].sort()).toEqual(["receptionist_client_contacts_v2", "receptionist_client_directory"]);
  });
  it("the comments say CLOSED", () => {
    expect(UP.match(/'0381 CLOSED\./g)?.length).toBe(2);
  });
});

describe("the after-check refuses to commit if any role can still execute either function", () => {
  it("checks PUBLIC, anon, authenticated and service_role, every grantee besides the owner, and the body md5", () => {
    const chk = UP.slice(UP.indexOf("$check$"));
    for (const must of ["has_function_privilege('public'", "has_function_privilege('anon'", "has_function_privilege('authenticated'", "has_function_privilege('service_role'", "a.grantee <> p.proowner", "aclexplode", "can still execute", "body changed"]) expect(chk, must).toContain(must);
    for (const m of MD5) expect(chk).toContain(`'${m}'`);
  });
});

describe("the down file restores exactly the 0380 ACL and comments", () => {
  it("is labelled an emergency measure, regrants authenticated only, revokes the rest by name, and restores the 0380 comments", () => {
    expect(DOWN).toMatch(/EMERGENCY ONLY/);
    for (const f of FNS) {
      expect(DOWN).toContain(`grant execute on function ${f} to authenticated;`);
      for (const role of ["public", "anon", "service_role"]) expect(DOWN, `${f} ${role}`).toContain(`revoke execute on function ${f} from ${role};`);
      expect(DOWN).not.toMatch(new RegExp(`grant[^;]*${f.replace(/[()]/g, "\\$&")}[^;]*(anon|service_role|public|grant option)`, "i"));
    }
    for (const key of ["receptionist_client_directory", "receptionist_client_contacts_v2"]) {
      const m = S0380.match(new RegExp(`comment on function public\\.${key}\\([^)]*\\) is\\n  '((?:[^']|'')*)';`));
      expect(m, key).not.toBeNull();
      expect(DOWN, key).toContain(`'${m![1]}'`);
    }
    for (const m of MD5) expect(DOWN).toContain(`'${m}'`);
  });
});
