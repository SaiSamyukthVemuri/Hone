import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const fn = (s: string) => {
  const a = s.indexOf("create or replace function public.appointment_has_blocking_dependents(");
  return s.slice(a, s.indexOf("$$;", a) + 3);
};

describe("0344 revert guard", () => {
  const up = read("supabase/migrations/0344_revert_guard_fee_settlement.sql");
  const down = read("supabase/rollbacks/0344_revert_guard_fee_settlement.down.sql");
  const old = read("supabase/migrations/0177_postcare_write_boundary.sql");

  it("down restores the 0177 function body byte for byte", () => {
    expect(fn(down)).toBe(fn(old));
  });

  it("up keeps the whole 0177 body up to its final return and only appends", () => {
    const tail = "\n  return null;\nend;\n$$;";
    const prefix = fn(old).slice(0, -tail.length);
    expect(fn(up).startsWith(prefix)).toBe(true);
  });

  it("up adds exactly the two reasons, fee_charge before settlement, after postcare_in_flight", () => {
    const u = fn(up);
    const order = ["postcare_in_flight", "fee_charge", "settlement"].map((r) => u.indexOf(`return '${r}'`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("both files open their own transaction with lock_timeout and restate the ACL by name", () => {
    for (const f of [up, down]) {
      expect(f).toMatch(/begin;\s+set local lock_timeout = '5s';/);
      expect(f).toMatch(/revoke execute on function public\.appointment_has_blocking_dependents\(uuid, uuid\)\s+from public, anon, authenticated;/);
      expect(f).toMatch(/to service_role;/);
      expect(f.trimEnd().endsWith("commit;")).toBe(true);
    }
  });
});
