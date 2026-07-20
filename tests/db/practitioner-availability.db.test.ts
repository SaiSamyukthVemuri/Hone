import { afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { adminQuery, asRole, asUser, closePool } from "./helpers/harness";
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
  // Enable capacity so the 0135 practitioner-scope guard permits
  // practitioner_id rows. Studio-wide (NULL) rows are unaffected by the guard,
  // so the flag-OFF upsert-compat cases below still exercise the same paths.
  await adminQuery(
    `update public.studios set practitioner_capacity_enabled = true where id = $1`,
    [B.studioId],
  );
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

describe("0135: availability upsert compatibility (the ON CONFLICT regression)", () => {
  // The exact SQL a supabase-js `.upsert(row, { onConflict })` emits, run against
  // the real migrated schema, so we reproduce the regression and prove the fix
  // at the persistence layer PostgREST actually uses.

  it("REPRODUCTION: the OLD column-only ON CONFLICT (studio_id, day_of_week) fails 42P10", async () => {
    // 0135 replaced the plain unique(studio_id, day_of_week) with a
    // NULLS-NOT-DISTINCT constraint over three columns, so a 2-column arbiter no
    // longer matches any constraint — the exact break the old action would hit.
    await expect(
      adminQuery(
        `insert into public.studio_availability_default
           (studio_id, day_of_week, practitioner_id, is_open, open_time, close_time)
         values ($1, 1, null, true, '09:00', '17:00')
         on conflict (studio_id, day_of_week)
         do update set is_open = excluded.is_open`,
        [B.studioId],
      ),
    ).rejects.toMatchObject({ code: "42P10" }); // no matching ON CONFLICT constraint
  });

  it("FIX: the 3-column ON CONFLICT (…, practitioner_id) INSERTS then UPDATES the studio-wide row (no duplicate)", async () => {
    const upsert = (open: string, close: string) =>
      adminQuery(
        `insert into public.studio_availability_default
           (studio_id, day_of_week, practitioner_id, is_open, open_time, close_time)
         values ($1, 2, null, true, $2, $3)
         on conflict (studio_id, day_of_week, practitioner_id)
         do update set is_open = excluded.is_open,
                       open_time = excluded.open_time,
                       close_time = excluded.close_time`,
        [B.studioId, open, close],
      );
    // First save creates the studio-wide row; second UPDATES it in place.
    await expect(upsert("09:00", "17:00")).resolves.toBeTruthy();
    await expect(upsert("10:00", "18:00")).resolves.toBeTruthy();
    const rows = await adminQuery(
      `select open_time, close_time from public.studio_availability_default
         where studio_id = $1 and day_of_week = 2 and practitioner_id is null`,
      [B.studioId],
    );
    expect(rows.rows).toHaveLength(1); // upsert UPDATED — did NOT duplicate
    expect(String(rows.rows[0].open_time)).toMatch(/^10:00/);
    expect(String(rows.rows[0].close_time)).toMatch(/^18:00/);
  });

  it("FIX: overrides upsert the same way (insert then update, no duplicate)", async () => {
    const upsert = (open: string) =>
      adminQuery(
        `insert into public.studio_availability_overrides
           (studio_id, effective_date, practitioner_id, is_open, open_time, close_time)
         values ($1, '2031-06-01', null, true, $2, '20:00')
         on conflict (studio_id, effective_date, practitioner_id)
         do update set open_time = excluded.open_time`,
        [B.studioId, open],
      );
    await expect(upsert("09:00")).resolves.toBeTruthy();
    await expect(upsert("11:00")).resolves.toBeTruthy();
    const rows = await adminQuery(
      `select open_time from public.studio_availability_overrides
         where studio_id = $1 and effective_date = '2031-06-01' and practitioner_id is null`,
      [B.studioId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(String(rows.rows[0].open_time)).toMatch(/^11:00/);
  });

  it("NULLS NOT DISTINCT: a studio-wide and a per-practitioner row for the same day still upsert independently", async () => {
    const p = B.practitioners[1].practitionerId;
    await adminQuery(
      `insert into public.studio_availability_default
         (studio_id, day_of_week, practitioner_id, is_open, open_time, close_time)
       values ($1, 3, null, true, '09:00', '17:00')
       on conflict (studio_id, day_of_week, practitioner_id) do update set is_open = excluded.is_open`,
      [B.studioId],
    );
    await adminQuery(
      `insert into public.studio_availability_default
         (studio_id, day_of_week, practitioner_id, is_open, open_time, close_time)
       values ($1, 3, $2, true, '11:00', '15:00')
       on conflict (studio_id, day_of_week, practitioner_id) do update set is_open = excluded.is_open`,
      [B.studioId, p],
    );
    const rows = await adminQuery(
      `select count(*)::int as c from public.studio_availability_default
         where studio_id = $1 and day_of_week = 3`,
      [B.studioId],
    );
    expect(rows.rows[0].c).toBe(2); // one studio-wide + one per-practitioner
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

describe("Part 2: availability authorization (owner-only RLS + scope guard)", () => {
  const ownerUser = () => B.practitioners.find((p) => p.role === "owner")!.userId;
  const memberUser = () =>
    B.practitioners.find((p) => p.role === "practitioner")!.userId;

  const studioWideInsert = (
    q: (t: string, p?: unknown[]) => Promise<{ rowCount: number | null }>,
  ) =>
    q(
      `insert into public.studio_availability_default
         (studio_id, day_of_week, practitioner_id, is_open, open_time, close_time)
       values ($1, 0, null, true, '09:00', '17:00')
       on conflict (studio_id, day_of_week, practitioner_id) do update set is_open = excluded.is_open`,
      [B.studioId],
    );

  it("owner may write studio-wide availability (RLS owner-write)", async () => {
    const r = await asUser(ownerUser(), (q) => studioWideInsert(q));
    expect(r.rowCount).toBe(1);
  });

  it("a non-owner practitioner cannot write availability (42501)", async () => {
    await expect(
      asUser(memberUser(), (q) => studioWideInsert(q)),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("anon cannot write availability", async () => {
    const outcome = await asRole("anon", (q) => studioWideInsert(q))
      .then((r) => ({ rows: r.rowCount, err: null as string | null }))
      .catch((e) => ({ rows: null, err: e.code as string }));
    expect(outcome.rows === 0 || outcome.err != null).toBe(true);
  });

  it("a practitioner-scoped row on a flag-OFF studio is rejected by the guard (42501)", async () => {
    await adminQuery(
      `update public.studios set practitioner_capacity_enabled = false where id = $1`,
      [B.studioId],
    );
    await expect(
      insDefault(B.studioId, 1, B.practitioners[1].practitionerId),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("an inactive practitioner cannot get an availability row (guard 23514)", async () => {
    const p = B.practitioners[2].practitionerId;
    await adminQuery(`update public.practitioners set active = false where id = $1`, [p]);
    await expect(insDefault(B.studioId, 1, p)).rejects.toMatchObject({ code: "23514" });
  });

  it("reset deletes ONLY the practitioner's row — studio-wide + other practitioners intact", async () => {
    const p1 = B.practitioners[1].practitionerId;
    const p2 = B.practitioners[2].practitionerId;
    await insDefault(B.studioId, 4, null); // studio-wide
    await insDefault(B.studioId, 4, p1);
    await insDefault(B.studioId, 4, p2);
    // Reset p1's Thursday only.
    await adminQuery(
      `delete from public.studio_availability_default
         where studio_id = $1 and practitioner_id = $2 and day_of_week = 4`,
      [B.studioId, p1],
    );
    const rows = await adminQuery(
      `select practitioner_id from public.studio_availability_default
         where studio_id = $1 and day_of_week = 4`,
      [B.studioId],
    );
    const ids = rows.rows.map((r) => r.practitioner_id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(null); // studio-wide intact
    expect(ids).toContain(p2); // other practitioner intact
    expect(ids).not.toContain(p1); // only p1's row removed
  });
});
