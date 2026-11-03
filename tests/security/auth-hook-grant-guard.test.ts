import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Insurance H-2: pin the Custom Access Token hook's existence, signature and grants so a later migration cannot drop it, change
// its signature (GoTrue calls it with one jsonb argument) or widen who may execute it. Supabase requires the function to be
// executable by supabase_auth_admin; it must NOT be executable by PUBLIC, anon, authenticated or service_role (the default
// privileges grant to anon, authenticated and service_role at create time, so each is revoked BY NAME: CLAUDE.md section 5).
// A hook whose grant is missing makes GoTrue fail every token request (a lockout, once the hook is enabled in the auth config).
const DIR = join(process.cwd(), "supabase/migrations");
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const withHook = files.filter((f) => /custom_access_token_hook/i.test(readFileSync(join(DIR, f), "utf8")));
const text = (f: string) => readFileSync(join(DIR, f), "utf8");
const strip = (s: string) => s.replace(/--[^\n]*/g, "");

describe("custom_access_token_hook is pinned", () => {
  it("is defined in exactly one migration, and no migration drops or renames it", () => {
    const defs = files.filter((f) => /create\s+(or\s+replace\s+)?function\s+public\.custom_access_token_hook\s*\(/i.test(strip(text(f))));
    expect(defs).toEqual(["0292_auth_block_password_tokens_hook.sql"]);
    for (const f of withHook) {
      expect(strip(text(f)), f).not.toMatch(/drop\s+function[^;]*custom_access_token_hook/i);
      expect(strip(text(f)), f).not.toMatch(/alter\s+function[^;]*custom_access_token_hook[^;]*(rename|owner|set\s+schema)/i);
    }
  });

  const sql = strip(text("0292_auth_block_password_tokens_hook.sql"));

  it("has the signature GoTrue calls: (event jsonb) returns jsonb, plpgsql, stable, empty search_path, NOT security definer", () => {
    expect(sql).toMatch(/function\s+public\.custom_access_token_hook\s*\(\s*event\s+jsonb\s*\)\s*returns\s+jsonb/i);
    expect(sql).toMatch(/language\s+plpgsql/i);
    expect(sql).toMatch(/\bstable\b/i);
    expect(sql).toMatch(/set\s+search_path\s*=\s*''/i);
    expect(sql).not.toMatch(/security\s+definer/i);
  });

  it("grants EXECUTE (and schema usage) to supabase_auth_admin and to nobody else", () => {
    expect(sql).toMatch(/grant\s+usage\s+on\s+schema\s+public\s+to\s+supabase_auth_admin/i);
    expect(sql).toMatch(/grant\s+execute\s+on\s+function\s+public\.custom_access_token_hook\(jsonb\)\s+to\s+supabase_auth_admin/i);
    const grants = [...sql.matchAll(/grant\s+execute\s+on\s+function\s+public\.custom_access_token_hook\(jsonb\)\s+to\s+([a-z_]+)/gi)].map((m) => m[1].toLowerCase());
    expect(grants).toEqual(["supabase_auth_admin"]);
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(sql, `revoke from ${role}`).toMatch(new RegExp(`revoke\\s+execute\\s+on\\s+function\\s+public\\.custom_access_token_hook\\(jsonb\\)\\s+from\\s+${role}\\b`, "i"));
    }
  });

  it("no later migration grants it to any other role", () => {
    for (const f of withHook) {
      const s = strip(text(f));
      for (const m of s.matchAll(/grant\s+execute\s+on\s+function\s+public\.custom_access_token_hook\([^)]*\)\s+to\s+([a-z_]+)/gi)) {
        expect(m[1].toLowerCase(), f).toBe("supabase_auth_admin");
      }
    }
  });
});
