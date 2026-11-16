import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ROLES-PAGE-ONLY-01. This branch ships the Roles page and nothing that ENFORCES a permission. These tests prove the boundary from source so a
// later change that sneaks enforcement in (an import of the enforcement helper, a call to the engine's check function, a new command from the
// page) fails here and has to be a decision, not a side effect. They run no database.
//
// What "enforcement" means here: the application asking the engine whether a person may do something (lib/permissions/require-permission.ts and
// its callers), and anything that makes a saved choice take effect. The page's own commands only STORE choices and preview them; the one command
// that can put a stored choice into force is activate_released_permissions, and the database refuses it for a key that has not been released.

const ROOTS = ["app", "lib", "components"];
const PAGE_DIR = "app/(app)/settings/roles";
const LIB_DIR = "lib/settings/roles";

// The page's commands: each is a 0287 function the page's own core wrapper calls. A name outside this list is a new capability.
const ALLOWED_RPCS = [
  "activate_released_permissions",
  "adopt_new_defaults",
  "change_staff_role",
  "effective_access",
  "get_role_permissions",
  "list_permission_audit",
  "preview_activation",
  "preview_adopt_new_defaults",
  "preview_reset",
  "preview_role_changes_at", // 0356: the reviewed pair replaces preview_role_changes and save_role_permissions
  "reset_role_to_defaults",
  "save_role_permissions_reviewed",
] as const;

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
};
const sources = ROOTS.flatMap((r) => walk(r)).map((path) => ({ path, text: readFileSync(path, "utf8") }));

// --- the scanners, kept as functions so the negative controls can run them on text that breaks the rule ---
const importsEnforcementHelper = (text: string) => /from\s+["'][^"']*require-permission["']|import\(\s*["'][^"']*require-permission["']\s*\)/.test(text);
const asksTheEngine = (text: string) => /has_studio_permission/.test(text);
const rpcNames = (text: string) => [...text.matchAll(/\bcall\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
const rpcOutsideAllowlist = (text: string) => rpcNames(text).filter((n) => !(ALLOWED_RPCS as readonly string[]).includes(n));

describe("the page-only branch contains no enforcement", () => {
  it("no file under app, lib or components imports require-permission, and the helper itself is not in the tree", () => {
    const offenders = sources.filter((s) => importsEnforcementHelper(s.text)).map((s) => s.path);
    expect(offenders).toEqual([]);
    expect(sources.some((s) => s.path.endsWith("lib/permissions/require-permission.ts"))).toBe(false);
  });

  it("no application code asks the engine's check function (has_studio_permission) at all", () => {
    expect(sources.filter((s) => asksTheEngine(s.text)).map((s) => s.path)).toEqual([]);
  });

  it("only the Roles page and its library import the permission catalog or the roles library", () => {
    const inPage = (p: string) => p.startsWith(PAGE_DIR) || p.startsWith(LIB_DIR) || p.startsWith("lib/permissions/");
    const importers = sources
      .filter((s) => /lib\/permissions\/|lib\/settings\/roles\//.test(s.text) && !inPage(s.path))
      .map((s) => s.path);
    expect(importers).toEqual([]);
  });

  it("the page's one server-action file is the only 'use server' file that touches the roles library", () => {
    const actionFiles = sources.filter((s) => /^\s*["']use server["']/m.test(s.text) && /settings\/roles/.test(s.text)).map((s) => s.path);
    expect(actionFiles).toEqual([`${PAGE_DIR}/actions.ts`]);
  });

  it("the server actions reach the database only through the roles core wrappers, never a client or the engine directly", () => {
    const actions = readFileSync(`${PAGE_DIR}/actions.ts`, "utf8");
    expect(actions).not.toMatch(/\.rpc\(|\.from\(/);
    expect(actions).not.toMatch(/service-role|createAdminClient|supabase\/admin/i);
    expect(importsEnforcementHelper(actions)).toBe(false);
  });

  it("every command the roles core sends is one of the twelve 0287 page commands", () => {
    const core = readFileSync(`${LIB_DIR}/core.ts`, "utf8");
    const names = rpcNames(core);
    expect(names.length).toBeGreaterThanOrEqual(ALLOWED_RPCS.length - 1);
    expect(rpcOutsideAllowlist(core)).toEqual([]);
    // and nothing else in the app or lib calls these commands behind the core's back
    const direct = sources
      .filter((s) => s.path !== `${LIB_DIR}/core.ts`)
      .filter((s) => ALLOWED_RPCS.some((n) => new RegExp(`\\.rpc\\(\\s*["']${n}["']`).test(s.text)))
      .map((s) => s.path);
    expect(direct).toEqual([]);
  });

  it("the only command that can put a saved choice into force refuses a key that has not been released (database source)", () => {
    const sql = readFileSync("supabase/migrations/0287_roles_permission_engine.sql", "utf8");
    const bodyOf = (fn: string) => {
      const start = sql.indexOf(`function public.${fn}(`);
      expect(start, fn).toBeGreaterThan(-1);
      const next = sql.indexOf("create or replace function", start + 10);
      return sql.slice(start, next === -1 ? undefined : next);
    };
    // the two commands the page can send are thin wrappers over ONE runner
    expect(bodyOf("activate_released_permissions")).toMatch(/perm_run_activation\(/);
    expect(bodyOf("preview_activation")).toMatch(/perm_run_activation\(/);
    // and that runner refuses any key with no release row
    const runner = bodyOf("perm_run_activation");
    expect(runner).toMatch(/not exists \(select 1 from public\.permission_key_release where key = v_key and released_at is not null\)/);
    expect(runner).toMatch(/perm_fail\('not_released'/);
    // marking a key released is an operator-only command: no API role holds EXECUTE
    expect(sql).toMatch(/revoke all on function public\.mark_permissions_released\([^)]*\)\s+from public, anon, authenticated, service_role/);
  });
});

describe("NEGATIVE CONTROLS: the scanners catch what they are meant to catch", () => {
  it("an import of the enforcement helper is detected, in static and dynamic form", () => {
    expect(importsEnforcementHelper(`import { requirePermission } from "@/lib/permissions/require-permission";`)).toBe(true);
    expect(importsEnforcementHelper(`const m = await import("../permissions/require-permission");`)).toBe(true);
    expect(importsEnforcementHelper(`import { catalogByKey } from "@/lib/permissions/catalog";`)).toBe(false);
  });
  it("a call to the engine's check function is detected", () => {
    expect(asksTheEngine(`await db.rpc("has_studio_permission", { p_studio })`)).toBe(true);
    expect(asksTheEngine(`await call("get_role_permissions", {})`)).toBe(false);
  });
  it("a new command outside the allowlist is detected, and an allowed one is not", () => {
    expect(rpcOutsideAllowlist(`await call("mark_permissions_released", {})`)).toEqual(["mark_permissions_released"]);
    expect(rpcOutsideAllowlist(`await call("save_role_permissions_reviewed", {})`)).toEqual([]);
    // the old non-versioned pair is no longer sent by the page (0356)
    expect(rpcOutsideAllowlist(`await call("save_role_permissions", {})`)).toEqual(["save_role_permissions"]);
  });
});
