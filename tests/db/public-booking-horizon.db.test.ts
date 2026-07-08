import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  closePool,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// Migration 0112 widens studios.public_booking_horizon_months from CHECK (3,4,6)
// to (1..12). Proves the constraint accepts every whole month 1..12, keeps the
// legacy 3/4/6 valid, and rejects below-floor (0) and above-ceiling (13).

let s: SeededStudio;

beforeAll(async () => {
  s = await seedStudio("horizon");
});
afterAll(async () => {
  await closePool();
});

function setHorizon(months: number) {
  return adminQuery(
    `update public.studios set public_booking_horizon_months = $1 where id = $2`,
    [months, s.studioId],
  );
}

describe("public_booking_horizon_months CHECK — 1..12", () => {
  it("accepts every whole month 1..12", async () => {
    for (let m = 1; m <= 12; m++) {
      await expect(setHorizon(m)).resolves.toBeDefined();
    }
    const { rows } = await adminQuery(
      `select public_booking_horizon_months from public.studios where id = $1`,
      [s.studioId],
    );
    expect(rows[0].public_booking_horizon_months).toBe(12);
  });

  it("keeps the legacy 3 / 4 / 6 values valid", async () => {
    for (const m of [3, 4, 6]) {
      await expect(setHorizon(m)).resolves.toBeDefined();
    }
  });

  it("rejects 0 (below the 1-month floor)", async () => {
    await expect(setHorizon(0)).rejects.toThrow();
  });

  it("rejects 13 (above the 12-month ceiling)", async () => {
    await expect(setHorizon(13)).rejects.toThrow();
  });
});
