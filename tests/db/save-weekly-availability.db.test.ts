import { afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { adminQuery, closePool, resolveLocalDbUrl } from "./helpers/harness";
import { dropSynthStudio, seedSynthStudioB, type SynthStudio } from "./helpers/synth-fleet";

// PR B Part 4 (migration 0149, Item 2) — the full-week availability save is now
// ONE atomic transaction under the studios-row + capacity advisory lock: no
// half-applied week, and it serializes with booking / retirement. Studio B.

let B: SynthStudio;
const P = (i: number) => B.practitioners[i].practitionerId;

beforeEach(async () => {
  B = await seedSynthStudioB();
  await adminQuery(
    `update public.studios set practitioner_capacity_enabled = true,
       practitioner_capacity_booking_enabled = true, timezone = 'UTC' where id = $1`,
    [B.studioId],
  );
});
afterEach(async () => {
  if (B) await dropSynthStudio(B);
});
afterAll(async () => {
  await closePool();
});

const save = (scope: string | null, days: unknown[]) =>
  adminQuery(`select public.save_weekly_availability($1,$2,$3::jsonb) r`, [
    B.studioId,
    scope,
    JSON.stringify(days),
  ]).then((r) => r.rows[0].r as string);
const week = (open: string, close: string) =>
  Array.from({ length: 7 }, (_, dow) => ({ day_of_week: dow, is_open: true, open_time: open, close_time: close }));
const rowsFor = (scope: string | null) =>
  adminQuery(
    `select day_of_week d, open_time::text o, close_time::text c from public.studio_availability_default
      where studio_id=$1 and practitioner_id is not distinct from $2 order by day_of_week`,
    [B.studioId, scope],
  ).then((r) => r.rows as { d: number; o: string; c: string }[]);

describe("0149 — atomic full-week availability save", () => {
  it("writes all seven studio-wide days in one call", async () => {
    expect(await save(null, week("09:00", "17:00"))).toBe("ok");
    const rows = await rowsFor(null);
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.o === "09:00:00" && r.c === "17:00:00")).toBe(true);
  });

  it("is ATOMIC: a bad day rolls the WHOLE week back, leaving the prior week intact", async () => {
    expect(await save(null, week("09:00", "17:00"))).toBe("ok");
    // Second save: all days 10:00–16:00 EXCEPT day 3 is invalid (16:00 >= 10:00).
    const bad = week("10:00", "16:00").map((d) =>
      d.day_of_week === 3 ? { ...d, open_time: "16:00", close_time: "10:00" } : d,
    );
    await expect(save(null, bad)).rejects.toMatchObject({ code: "23514" }); // CHECK violation
    const rows = await rowsFor(null);
    // Untouched — still the first week, NOT a half-applied 10:00–16:00.
    expect(rows.every((r) => r.o === "09:00:00" && r.c === "17:00:00")).toBe(true);
  });

  it("practitioner scope writes that practitioner's rows; an invalid scope is rejected", async () => {
    expect(await save(P(1), week("10:00", "14:00"))).toBe("ok");
    const rows = await rowsFor(P(1));
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.o === "10:00:00")).toBe(true);
    await adminQuery(`update public.practitioners set active=false where id=$1`, [P(2)]);
    expect(await save(P(2), week("10:00", "14:00"))).toBe("invalid_practitioner");
    expect(await rowsFor(P(2))).toHaveLength(0);
  });

  it("unknown studio → studio_not_found", async () => {
    const r = await adminQuery(
      `select public.save_weekly_availability('00000000-0000-0000-0000-000000000000', null, '[]'::jsonb) r`,
    );
    expect(r.rows[0].r).toBe("studio_not_found");
  });

  it("takes the studios-row lock: a concurrent holder blocks the save until it commits (no deadlock)", async () => {
    const c1 = new Client({ connectionString: resolveLocalDbUrl() });
    await c1.connect();
    let finished = false;
    try {
      await c1.query("begin");
      await c1.query(`select 1 from public.studios where id=$1 for update`, [B.studioId]); // holds the row lock
      const savePromise = save(null, week("09:00", "17:00")).then((r) => {
        finished = true;
        return r;
      });
      await new Promise((r) => setTimeout(r, 200));
      expect(finished).toBe(false); // still blocked behind c1's studios-row lock
      await c1.query("commit"); // release
      expect(await savePromise).toBe("ok");
    } finally {
      await c1.end();
    }
  });

  it("Legacy (capacity OFF) studio-wide save still writes the rows (byte-for-byte behaviour)", async () => {
    await adminQuery(
      `update public.studios set practitioner_capacity_booking_enabled=false,
         practitioner_capacity_enabled=false where id=$1`,
      [B.studioId],
    );
    expect(await save(null, week("08:00", "12:00"))).toBe("ok");
    expect(await rowsFor(null)).toHaveLength(7);
  });
});
