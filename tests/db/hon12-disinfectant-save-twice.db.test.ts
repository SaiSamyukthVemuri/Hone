import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, asUser, closePool, seedStudio, type SeededStudio } from "./helpers/harness";

// HON-12: recording the replacement date through the authenticated path (RLS, as the Records edit does) twice leaves ONE logbook row with the same date;
// the overdue selection the Notification Centre uses (not discarded, has a due date) no longer includes it; a second studio is untouched. Synthetic data.
afterAll(async () => {
  await closePool();
});

let A: SeededStudio;
let B: SeededStudio;
const overdueIds = async (studioId: string) =>
  (await adminQuery(`select id from public.record_keeping_disinfectants where studio_id = $1 and date_discarded is null and discard_due_date is not null order by discard_due_date`, [studioId])).rows.map((r) => String(r.id));

describe("HON-12: saving the replacement twice", () => {
  it("one row, one date, selection empties, other studio unchanged", async () => {
    A = await seedStudio("hon12-a");
    B = await seedStudio("hon12-b");
    const id = randomUUID();
    const idB = randomUUID();
    await adminQuery(`insert into public.record_keeping_disinfectants (id, studio_id, date_prepared, disinfectant_name, discard_due_date) values ($1, $2, '2019-12-01', 'Synthetic A', '2020-01-01')`, [id, A.studioId]);
    await adminQuery(`insert into public.record_keeping_disinfectants (id, studio_id, date_prepared, disinfectant_name, discard_due_date) values ($1, $2, '2019-12-01', 'Synthetic B', '2020-01-01')`, [idB, B.studioId]);
    expect(await overdueIds(A.studioId)).toEqual([id]);
    const bBefore = (await adminQuery(`select to_jsonb(d) r from public.record_keeping_disinfectants d where id = $1`, [idB])).rows[0].r;
    for (let i = 0; i < 2; i++) {
      const upd = await asUser(A.userId, (q) => q(`update public.record_keeping_disinfectants set date_discarded = '2026-03-10' where id = $1 and studio_id = $2 returning id`, [id, A.studioId]));
      expect(upd.rows.length).toBe(1);
    }
    expect(Number((await adminQuery(`select count(*) n from public.record_keeping_disinfectants where studio_id = $1`, [A.studioId])).rows[0].n)).toBe(1);
    expect(String((await adminQuery(`select date_discarded::text d from public.record_keeping_disinfectants where id = $1`, [id])).rows[0].d)).toBe("2026-03-10");
    expect(await overdueIds(A.studioId), "reload: nothing overdue").toEqual([]);
    expect((await adminQuery(`select to_jsonb(d) r from public.record_keeping_disinfectants d where id = $1`, [idB])).rows[0].r).toEqual(bBefore);
    expect(await overdueIds(B.studioId)).toEqual([idB]);
  });
});
