import { afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { adminQuery, closePool } from "./helpers/harness";
import {
  dropSynthStudio,
  seedSynthStudioA,
  seedSynthStudioB,
  type SynthStudio,
} from "./helpers/synth-fleet";

// PR B — migration 0135 per-practitioner availability model, against the real
// migrated schema (db-integration lane) on synthetic Studio B (owner + 2
// practitioners). Proves: a studio-wide fallback row and a per-practitioner row
// coexist for the same day; the partial uniques forbid duplicates within each
// scope; and the composite FK enforces same-studio (nullable => studio-wide
// rows skip it).

let B: SynthStudio;

beforeEach(async () => {
  B = await seedSynthStudioB();
});
afterEach(async () => {
  if (B) await dropSynthStudio(B);
});
afterAll(async () => {
  await closePool();
});

const insDefault = (
  studioId: string,
  dow: number,
  practitionerId: string | null,
) =>
  adminQuery(
    `insert into public.studio_availability_default
       (studio_id, day_of_week, is_open, open_time, close_time, practitioner_id)
     values ($1, $2, true, '09:00', '17:00', $3)`,
    [studioId, dow, practitionerId],
  );

describe("0135: studio-wide + per-practitioner availability coexist", () => {
  it("a studio-wide row and a per-practitioner row can both exist for the same weekday", async () => {
    const p = B.practitioners[1].practitionerId;
    await insDefault(B.studioId, 1, null); // studio-wide fallback
    await insDefault(B.studioId, 1, p); // practitioner override
    const rows = await adminQuery(
      `select count(*)::int as c from public.studio_availability_default
         where studio_id = $1 and day_of_week = 1`,
      [B.studioId],
    );
    expect(rows.rows[0].c).toBe(2);
  });

  it("two studio-wide rows for the same weekday are rejected (partial unique)", async () => {
    await insDefault(B.studioId, 2, null);
    await expect(insDefault(B.studioId, 2, null)).rejects.toMatchObject({
      code: "23505",
    });
  });

  it("two rows for the same (practitioner, weekday) are rejected (partial unique)", async () => {
    const p = B.practitioners[1].practitionerId;
    await insDefault(B.studioId, 3, p);
    await expect(insDefault(B.studioId, 3, p)).rejects.toMatchObject({
      code: "23505",
    });
  });

  it("two DIFFERENT practitioners may each have their own row for the same weekday", async () => {
    await insDefault(B.studioId, 4, B.practitioners[1].practitionerId);
    await insDefault(B.studioId, 4, B.practitioners[2].practitionerId);
    const rows = await adminQuery(
      `select count(*)::int as c from public.studio_availability_default
         where studio_id = $1 and day_of_week = 4 and practitioner_id is not null`,
      [B.studioId],
    );
    expect(rows.rows[0].c).toBe(2);
  });
});

describe("0135: same-studio composite FK", () => {
  it("a per-practitioner row referencing a practitioner from ANOTHER studio is rejected", async () => {
    const A = await seedSynthStudioA();
    try {
      await expect(
        insDefault(B.studioId, 5, A.practitioners[0].practitionerId),
      ).rejects.toMatchObject({ code: "23503" }); // FK violation
    } finally {
      await dropSynthStudio(A);
    }
  });

  it("a studio-wide (null practitioner) row skips the FK entirely", async () => {
    const r = await insDefault(B.studioId, 6, null);
    expect(r.rowCount).toBe(1);
  });

  it("overrides enforce the same composite FK", async () => {
    const A = await seedSynthStudioA();
    try {
      await expect(
        adminQuery(
          `insert into public.studio_availability_overrides
             (studio_id, effective_date, is_open, open_time, close_time, practitioner_id)
           values ($1, '2031-05-01', true, '09:00', '17:00', $2)`,
          [B.studioId, A.practitioners[0].practitionerId],
        ),
      ).rejects.toMatchObject({ code: "23503" });
    } finally {
      await dropSynthStudio(A);
    }
  });
});
