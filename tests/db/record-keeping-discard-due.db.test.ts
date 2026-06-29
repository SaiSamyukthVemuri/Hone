import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  closePool,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";

// PR #280 (migration 0096): record_keeping_disinfectants gains discard_due_date.
// Proven on the REAL migrated local database. Additive + nullable so legacy rows
// (no due date) read safely.

// Normalize a Postgres `date` column to YYYY-MM-DD. The pg driver returns a
// `date` as a JS Date (at local midnight for that calendar day); a `::text`
// cast or a different driver returns a string. Support both.
function ymd(v: unknown): string {
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

let s: SeededStudio;

beforeAll(async () => {
  s = await seedStudio("rk-discard-due");
});

afterAll(async () => {
  await closePool();
});

describe("discard_due_date column", () => {
  it("stores and round-trips a discard/replace-by date", async () => {
    const id = randomUUID();
    await adminQuery(
      `insert into public.record_keeping_disinfectants
         (id, studio_id, date_prepared, disinfectant_name, discard_due_date)
       values ($1,$2,'2026-06-01','CaviCide','2026-06-15')`,
      [id, s.studioId],
    );
    const r = await adminQuery(
      "select date_prepared, discard_due_date, date_discarded from public.record_keeping_disinfectants where id=$1",
      [id],
    );
    expect(ymd(r.rows[0].discard_due_date)).toBe("2026-06-15");
    expect(ymd(r.rows[0].date_prepared)).toBe("2026-06-01");
    expect(r.rows[0].date_discarded).toBeNull();
  });

  it("is nullable — a legacy-style row without a due date is valid", async () => {
    const id = randomUUID();
    const ins = await adminQuery(
      `insert into public.record_keeping_disinfectants
         (id, studio_id, date_prepared, disinfectant_name)
       values ($1,$2,'2026-06-01','Barbicide')`,
      [id, s.studioId],
    );
    expect(ins.rowCount).toBe(1);
    const r = await adminQuery(
      "select discard_due_date from public.record_keeping_disinfectants where id=$1",
      [id],
    );
    expect(r.rows[0].discard_due_date).toBeNull();
  });
});
