import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, closePool, seedStudio, type SeededStudio } from "./helpers/harness";

// Migration 0110: studios.postcare_delivery_mode text not null default 'manual',
// CHECK in ('manual','auto_on_complete'). Exercises the REAL migrated DB: new
// studios default to manual (safe by default); auto_on_complete is accepted; an
// invalid value is rejected.

let studio: SeededStudio;

beforeAll(async () => {
  studio = await seedStudio("postcare-mode");
});

afterAll(async () => {
  await closePool();
});

describe("studios.postcare_delivery_mode (migration 0110)", () => {
  it("a freshly seeded studio defaults to manual (safe by default)", async () => {
    const { rows } = await adminQuery(
      `select postcare_delivery_mode from public.studios where id = $1`,
      [studio.studioId],
    );
    expect(rows[0].postcare_delivery_mode).toBe("manual");
  });

  it("accepts auto_on_complete", async () => {
    await adminQuery(
      `update public.studios set postcare_delivery_mode = 'auto_on_complete' where id = $1`,
      [studio.studioId],
    );
    const { rows } = await adminQuery(
      `select postcare_delivery_mode from public.studios where id = $1`,
      [studio.studioId],
    );
    expect(rows[0].postcare_delivery_mode).toBe("auto_on_complete");
  });

  it("rejects an invalid value via the CHECK constraint", async () => {
    await expect(
      adminQuery(
        `update public.studios set postcare_delivery_mode = 'always' where id = $1`,
        [studio.studioId],
      ),
    ).rejects.toThrow(/postcare_delivery_mode_check/);
  });
});
