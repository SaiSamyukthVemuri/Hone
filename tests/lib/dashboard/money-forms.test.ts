import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { MONEY_FORMS } = await import("@/lib/dashboard/other-money-forms");

// Privacy AO2 / Insurance U2 on #1356: the inventory of money forms must stay complete. A migration that adds a table with a money-like
// column fails here until the table is classified in lib/dashboard/other-money-forms.ts (counted, unavailable, quote, not_money or
// not_checked), so a new way to record money can never silently sit outside "the amount Hone can see".

// Whole underscore-separated words only: `fee` must not match `calendar_feed_token_hash`.
const MONEY_COLUMN = /^\s*"?((?:[a-z]+_)*(?:cents|amount|fee|refund|price|deposit|tip|credit|paid|currency)(?:_[a-z]+)*)"?\s+(?:integer|int|bigint|numeric|text|smallint)\b/im;

function tablesWithMoneyColumns(): Set<string> {
  const found = new Set<string>();
  for (const file of readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql"))) {
    const sql = readFileSync(`supabase/migrations/${file}`, "utf8").replace(/--.*$/gm, "");
    for (const m of sql.matchAll(/create table(?: if not exists)? public\.([a-z_]+)\s*\(([\s\S]*?)\n\)\s*;/gi)) {
      if (MONEY_COLUMN.test(m[2].split("\n").filter((l) => !/^\s*(constraint|primary|foreign|unique|check)\b/i.test(l)).join("\n"))) found.add(m[1]);
    }
    for (const m of sql.matchAll(/alter table(?: only)?(?: if exists)? public\.([a-z_]+)\s+add column(?: if not exists)?\s+"?((?:[a-z]+_)*(?:cents|amount|fee|refund|price|deposit|tip|credit|paid)(?:_[a-z]+)*)"?\b/gi)) found.add(m[1]);
  }
  return found;
}

describe("the money-form inventory", () => {
  const inventoried = new Set(MONEY_FORMS.map((f) => f.table));
  it("classifies every table whose migrations declare a money-like column", () => {
    const missing = [...tablesWithMoneyColumns()].filter((t) => !inventoried.has(t)).sort();
    expect(missing, `classify these in lib/dashboard/other-money-forms.ts: ${missing.join(", ")}`).toEqual([]);
  });
  it("uses only the five handlings, each with a note", () => {
    for (const f of MONEY_FORMS) {
      expect(["counted", "unavailable", "quote", "not_money", "not_checked"], f.form).toContain(f.handling);
      expect(f.note.length, f.form).toBeGreaterThan(5);
    }
  });
  it("names every form this change decided on (AO1 refund, pending refund, deleted session, fees, price on the session, currency)", () => {
    const forms = MONEY_FORMS.map((f) => f.form).join(" | ");
    for (const needle of ["refund succeeded, amount unreadable", "refund pending", "soft-deleted session", "late-cancellation or no-show fee", "manual late-cancel", "price_paid_cents", "two currencies"]) {
      expect(forms, needle).toContain(needle);
    }
  });
  it("is honest about what it cannot read: the legacy Stripe tables are not_checked, not counted", () => {
    for (const t of ["stripe_charge_attempts", "stripe_refunds", "stripe_refund_attempts", "stripe_disputes", "appointment_payments"]) {
      expect(MONEY_FORMS.filter((f) => f.table === t).every((f) => f.handling === "not_checked"), t).toBe(true);
    }
  });
});
