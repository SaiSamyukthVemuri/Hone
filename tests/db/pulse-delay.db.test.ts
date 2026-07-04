import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  closePool,
  seedStudio,
  seedSession,
  type SeededStudio,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";

// Migration 0102: electrolysis_entries.pulse_delay_seconds carries the delay
// between high-frequency pulses, and a CHECK bounds a non-null value to
// [0.03, 1.90] while always allowing NULL. This exercises the REAL migrated DB:
// valid values (incl. both boundaries) insert; out-of-range values are rejected
// by the constraint; NULL inserts fine (so single-pulse + pre-0102 rows stay
// valid).

let studio: SeededStudio;
let sessionId: string;
let blockId: string;

beforeAll(async () => {
  studio = await seedStudio("pulse-delay");
  const s = await seedSession(studio);
  sessionId = s.sessionId;
  blockId = s.blockId;
});

afterAll(async () => {
  await closePool();
});

async function insertEntry(pulseDelay: number | null): Promise<void> {
  await adminQuery(
    `insert into public.electrolysis_entries
       (id, session_id, block_id, area, pulse_count, pulse_delay_seconds)
     values ($1, $2, $3, 'Chin', 2, $4)`,
    [randomUUID(), sessionId, blockId, pulseDelay],
  );
}

describe("electrolysis_entries.pulse_delay_seconds range CHECK", () => {
  it("accepts valid values including both boundaries and NULL", async () => {
    for (const v of [0.5, 0.03, 1.9, 1.25]) {
      await expect(insertEntry(v)).resolves.not.toThrow();
    }
    // NULL is always allowed → single-pulse + pre-0102 rows stay valid.
    await expect(insertEntry(null)).resolves.not.toThrow();
  });

  it("rejects values below 0.03", async () => {
    await expect(insertEntry(0.02)).rejects.toThrow(
      /pulse_delay_seconds_range_check/,
    );
    await expect(insertEntry(0)).rejects.toThrow(
      /pulse_delay_seconds_range_check/,
    );
  });

  it("rejects values above 1.90", async () => {
    await expect(insertEntry(1.91)).rejects.toThrow(
      /pulse_delay_seconds_range_check/,
    );
    await expect(insertEntry(2.5)).rejects.toThrow(
      /pulse_delay_seconds_range_check/,
    );
  });

  it("stores the value at two-decimal resolution", async () => {
    const id = randomUUID();
    await adminQuery(
      `insert into public.electrolysis_entries
         (id, session_id, block_id, area, pulse_count, pulse_delay_seconds)
       values ($1, $2, $3, 'Lip', 3, 0.5)`,
      [id, sessionId, blockId],
    );
    const { rows } = await adminQuery(
      `select pulse_delay_seconds from public.electrolysis_entries where id = $1`,
      [id],
    );
    expect(Number(rows[0].pulse_delay_seconds)).toBeCloseTo(0.5, 2);
  });
});
