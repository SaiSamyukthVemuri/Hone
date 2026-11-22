import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Rollback contract for 0350 (an option-gated mode is recorded only when its option is fitted).
// The behavioural proof, with a negative control, is tests/db/machine-setup-option-null-element.db.test.ts.
const ROOT = join(__dirname, "..", "..");
const DOWN_FILE = readFileSync(join(ROOT, "supabase/rollbacks/0350_setup_option_check_null_element.down.sql"), "utf8");
const OLD_FILE = readFileSync(join(ROOT, "supabase/migrations/0237_machine_native_text_readings.sql"), "utf8");
const BUGGY = "and not (v_requires_option = any (coalesce(p_installed_options, '{}'::text[]))) then";

const functionBlock = (sql: string): string => {
  const start = sql.indexOf("create or replace function public.record_setup_group_in_scope(");
  const end = sql.indexOf("\n$$;", start);
  if (start < 0 || end < 0) throw new Error("record_setup_group_in_scope block not found");
  return sql.slice(start, end + "\n$$;".length);
};

describe("0350 rollback", () => {
  it("the down file restores the 0237 body exactly", () => {
    expect(functionBlock(DOWN_FILE)).toBe(functionBlock(OLD_FILE));
    expect(DOWN_FILE).toContain(BUGGY);
  });
});
