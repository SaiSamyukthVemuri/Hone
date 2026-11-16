import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Source contract for 0350 (an option-gated mode is recorded only when its option is fitted).
// The behavioural proof, with a negative control, is tests/db/machine-setup-option-null-element.db.test.ts.
const ROOT = join(__dirname, "..", "..");
const NEW_FILE = readFileSync(join(ROOT, "supabase/migrations/0350_setup_option_check_null_element.sql"), "utf8");
const DOWN_FILE = readFileSync(join(ROOT, "supabase/rollbacks/0350_setup_option_check_null_element.down.sql"), "utf8");
const OLD_FILE = readFileSync(join(ROOT, "supabase/migrations/0237_machine_native_text_readings.sql"), "utf8");

const FIXED = "and (v_requires_option = any (coalesce(p_installed_options, '{}'::text[]))) is not true then";
const BUGGY = "and not (v_requires_option = any (coalesce(p_installed_options, '{}'::text[]))) then";

const functionBlock = (sql: string): string => {
  const start = sql.indexOf("create or replace function public.record_setup_group_in_scope(");
  const end = sql.indexOf("\n$$;", start);
  if (start < 0 || end < 0) throw new Error("record_setup_group_in_scope block not found");
  return sql.slice(start, end + "\n$$;".length);
};

describe("0350 source contract", () => {
  it("is present (only the current maximum migration may assert it is the max)", () => {
    expect(NEW_FILE.length).toBeGreaterThan(0);
  });

  it("uses the fail-closed form and not the previous one", () => {
    expect(NEW_FILE).toContain(FIXED);
    expect(NEW_FILE).not.toContain(BUGGY);
  });

  it("changes only that condition from the 0237 body", () => {
    const before = functionBlock(OLD_FILE).split("\n");
    const after = functionBlock(NEW_FILE).split("\n");
    const removed = before.filter((l) => !after.includes(l));
    const added = after.filter((l) => !before.includes(l));
    expect(removed).toHaveLength(1);
    expect(removed[0]).toContain("and not (v_requires_option = any");
    expect(added).toHaveLength(2);
    expect(added.some((l) => l.includes("is not true then"))).toBe(true);
    expect(added.some((l) => l.trim().startsWith("--"))).toBe(true);
  });

  it("opens its own transaction, arms lock_timeout inside it, and revokes EXECUTE by name", () => {
    expect(NEW_FILE).toMatch(/^begin;\nset local lock_timeout = '5s';/m);
    expect(NEW_FILE.trimEnd().endsWith("commit;")).toBe(true);
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(NEW_FILE).toContain(
        `revoke execute on function public.record_setup_group_in_scope(uuid, uuid, uuid, uuid, text, integer, text[], text, text, smallint[], jsonb, uuid, text[], boolean) from ${role};`,
      );
    }
    expect(NEW_FILE).not.toMatch(/\bgrant execute\b/i);
  });

  it("the down file restores the 0237 body exactly", () => {
    expect(functionBlock(DOWN_FILE)).toBe(functionBlock(OLD_FILE));
    expect(DOWN_FILE).toContain(BUGGY);
  });
});
