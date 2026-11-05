import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Privacy R1b on #1356. Five legacy Stripe tables are listed `not_checked` in the dashboard's money-form inventory
// (lib/dashboard/other-money-forms.ts) because an owner session cannot read them (RLS on, no policy) and no app code touches them.
// That is only honest while it stays true. This guard fails if any app code starts reading or writing them, or calls one of the
// database functions that write them, or if one of those functions becomes callable by a browser role. At that point the inventory
// (and the label "Hone can see") must be revisited deliberately, not by accident.

const TABLES = ["appointment_payments", "stripe_charge_attempts", "stripe_refund_attempts", "stripe_refunds", "stripe_disputes"];
const WRITER_FUNCTIONS = [
  "_recompute_payment_status",
  "_retire_superseded_charge_attempts",
  "create_or_claim_refund_attempt",
  "reconcile_dispute_closed",
  "reconcile_dispute_created",
  "reconcile_dispute_updated",
  "reconcile_payment_intent_by_charge_attempt",
  "reconcile_refund_event",
  "resolve_double_charge_incident",
];
// The ONLY files allowed to NAME these: the inventory itself, and the export registry that classifies tables.
const ALLOWED_NAMING = ["lib/dashboard/other-money-forms.ts", "lib/export/resource-registry.ts"];

function filesNaming(names: string[]): string[] {
  const pattern = names.map((n) => `\\b${n}\\b`).join("|");
  try {
    return execFileSync("grep", ["-rlE", pattern, "app", "lib", "components", "middleware.ts", "--include=*.ts", "--include=*.tsx"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .sort();
  } catch {
    return []; // grep exits 1 on no match
  }
}

describe("the five legacy Stripe tables stay untouched by app code", () => {
  it("no app or lib file reads or writes them, other than the inventory and the export registry", () => {
    const offenders = filesNaming(TABLES).filter((f) => !ALLOWED_NAMING.includes(f));
    expect(offenders, `app code now touches a legacy Stripe table: ${offenders.join(", ")}. Revisit lib/dashboard/other-money-forms.ts and the 'Hone can see' label.`).toEqual([]);
  });
  it("no app or lib file calls a database function that writes them", () => {
    const offenders = filesNaming(WRITER_FUNCTIONS).filter((f) => !ALLOWED_NAMING.includes(f));
    expect(offenders, `app code now calls a legacy Stripe writer function: ${offenders.join(", ")}`).toEqual([]);
  });
  it("the inventory still lists all five as not_checked", () => {
    const src = readFileSync("lib/dashboard/other-money-forms.ts", "utf8");
    for (const t of TABLES) expect(src, t).toMatch(new RegExp(`table: "${t}"[^}]*handling: "not_checked"`));
  });
  it("every migration that grants execute on a writer function grants it to service_role only", () => {
    const bad: string[] = [];
    let seen = 0;
    for (const file of readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql"))) {
      const sql = readFileSync(`supabase/migrations/${file}`, "utf8").replace(/--.*$/gm, "");
      for (const fn of WRITER_FUNCTIONS) {
        const re = new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${fn}\\s*\\([^;]*?\\)\\s+to\\s+([^;]+);`, "gi");
        for (const m of sql.matchAll(re)) {
          seen += 1;
          const roles = m[1].split(",").map((r) => r.trim().toLowerCase());
          if (roles.some((r) => r !== "service_role")) bad.push(`${file}: ${fn} -> ${m[1].trim()}`);
        }
      }
    }
    expect(seen, "the grant scan must actually find the service_role grants").toBeGreaterThanOrEqual(5);
    expect(bad, `a legacy writer function became callable by a browser role: ${bad.join("; ")}`).toEqual([]);
  });
});
