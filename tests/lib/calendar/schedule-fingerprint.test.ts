import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FIELDS, scheduleFingerprint } from "@/lib/calendar/schedule-fingerprint";

// HON-48 Q7: a label-only edit whose live signal was missed must change the fingerprint,
// or the fallback refresh cannot report the degraded signal.

const migration = readFileSync("supabase/migrations/0271_schedule_change_signal.sql", "utf8").replace(/^\s*--.*$/gm, "");
function triggerColumns(table: string): string[] {
  const m = migration.match(new RegExp(`create trigger ${table}_schedule_signal_upd_trg[\\s\\S]*?emit_schedule_signal\\(([^)]*)\\)`));
  expect(m, `${table} update trigger`).toBeTruthy();
  return [...m![1].matchAll(/'([a-z_0-9]+)'/g)].map((x) => x[1]);
}

const TABLES = {
  appointments: "appointments",
  timedBlocks: "studio_timed_blocks",
  blockouts: "studio_blockouts",
  recurringOccurrences: "studio_recurring_break_occurrences",
} as const;

const BASE = {
  appointments: { id: "a", practitioner_id: "p", client_id: "c", service_id: "s", starts_at: "t1", ends_at: "t2", duration_minutes: 30, status: "booked", notes: "n", blocked_ends_at: "t3", buffer_minutes_snapshot: 5 },
  timedBlocks: { id: "b", practitioner_id: "p", starts_at: "t1", ends_at: "t2", category: "lunch", private_note: "note" },
  blockouts: { id: "o", starts_on: "d1", ends_on: "d2", reason: "holiday" },
  recurringOccurrences: { id: "r", starts_at: "t1", ends_at: "t2" },
} as const;

const fp = (over: Partial<Record<keyof typeof BASE, Record<string, unknown>>> = {}) =>
  scheduleFingerprint({
    appointments: [{ ...BASE.appointments, ...over.appointments }],
    timedBlocks: [{ ...BASE.timedBlocks, ...over.timedBlocks }],
    blockouts: [{ ...BASE.blockouts, ...over.blockouts }],
    recurringOccurrences: [{ ...BASE.recurringOccurrences, ...over.recurringOccurrences }],
  });

describe("every schedule-visible field changes the fingerprint", () => {
  for (const key of Object.keys(FIELDS) as Array<keyof typeof FIELDS>) {
    for (const field of FIELDS[key]) {
      it(`${key}.${field}`, () => {
        expect(fp({ [key]: { [field]: "changed-value" } })).not.toBe(fp());
      });
    }
  }

  it("covers the label fields explicitly: timed-block private_note, blockout reason, appointment notes", () => {
    expect(fp({ timedBlocks: { private_note: "other" } })).not.toBe(fp());
    expect(fp({ timedBlocks: { private_note: null } })).not.toBe(fp());
    expect(fp({ blockouts: { reason: "other" } })).not.toBe(fp());
    expect(fp({ blockouts: { reason: null } })).not.toBe(fp());
    expect(fp({ appointments: { notes: "other" } })).not.toBe(fp());
  });

  it("an unchanged schedule keeps the same fingerprint", () => {
    expect(fp()).toBe(fp());
  });
});

describe("the fingerprint covers every column 0271 signals on", () => {
  for (const [key, table] of Object.entries(TABLES) as Array<[keyof typeof FIELDS, string]>) {
    it(table, () => {
      const missing = triggerColumns(table).filter((c) => !(FIELDS[key] as readonly string[]).includes(c));
      // recurring-break occurrences: practitioner_id is a scope change that rematerialises rows
      // (delete and insert), so their ids change; it is not an in-place column.
      expect(missing).toEqual([]);
    });
  }
});
