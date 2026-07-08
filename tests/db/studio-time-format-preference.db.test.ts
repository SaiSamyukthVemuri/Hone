import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, closePool, seedStudio, type SeededStudio } from "./helpers/harness";

// Migration 0109: studios.time_format_preference text not null default '12h',
// CHECK in ('12h','24h'). Exercises the REAL migrated DB: existing/new studios
// default to 12h; 24h is accepted; an invalid value is rejected.

let studio: SeededStudio;

beforeAll(async () => {
  studio = await seedStudio("time-format-pref");
});

afterAll(async () => {
  await closePool();
});

describe("studios.time_format_preference (migration 0109)", () => {
  it("a freshly seeded studio defaults to 12h", async () => {
    const { rows } = await adminQuery(
      `select time_format_preference from public.studios where id = $1`,
      [studio.studioId],
    );
    expect(rows[0].time_format_preference).toBe("12h");
  });

  it("accepts 24h", async () => {
    await adminQuery(
      `update public.studios set time_format_preference = '24h' where id = $1`,
      [studio.studioId],
    );
    const { rows } = await adminQuery(
      `select time_format_preference from public.studios where id = $1`,
      [studio.studioId],
    );
    expect(rows[0].time_format_preference).toBe("24h");
  });

  it("rejects an invalid value via the CHECK constraint", async () => {
    await expect(
      adminQuery(
        `update public.studios set time_format_preference = 'military' where id = $1`,
        [studio.studioId],
      ),
    ).rejects.toThrow(/time_format_preference_check/);
  });
});
