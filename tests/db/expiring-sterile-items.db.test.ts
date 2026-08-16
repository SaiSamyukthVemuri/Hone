import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  asUser,
  closePool,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";

// PR #317. getExpiringSterileItems (lib/record-keeping/queries.ts) selects
// sterile items that are expired OR expiring within a horizon, studio-scoped.
// The TS function runs through the RLS `createClient()` (a request-context
// client we can't build here), so this exercises the EXACT filter it issues
// against the REAL migrated DB, as the studio's authenticated member — proving
// the RLS + `expiry_date is not null` + `<= horizon` + studio-scope semantics
// the function depends on. Deterministic: `today`/`horizon` are fixed here.

// Migration 0182 adds `.is("date_discarded", null)` to that filter: stock the
// practitioner has recorded as physically thrown away is no longer CURRENT
// inventory, so it must raise no expiry warning. This is Chloe's actual
// complaint — Hone kept telling her to replace probes she had already binned.
//
// The function's filter, verbatim in SQL (mirrors:
//   .eq(studio_id).is(date_discarded, null).not(expiry_date is null)
//   .lte(expiry_date, horizon).order(expiry_date asc)):
const FILTER_SQL = `
  select id, expiry_date
  from public.record_keeping_sterile_items
  where studio_id = $1
    and date_discarded is null
    and expiry_date is not null
    and expiry_date <= $2
  order by expiry_date asc
`;

const TODAY = "2026-07-02";
// Mirror supplyExpiryHorizon(TODAY, 30) = today + 30 days = 2026-08-01.
const HORIZON = "2026-08-01";

let a: SeededStudio;
let b: SeededStudio;

// Studio A rows (ids captured so assertions scope to this run, never counts).
const ids = {
  expired: randomUUID(), // before today → in horizon
  today: randomUUID(), // == today → in horizon
  soon: randomUUID(), // within 30d → in horizon
  boundary: randomUUID(), // == horizon (today+30) → in horizon (<=)
  future: randomUUID(), // beyond horizon → EXCLUDED
  noExpiry: randomUUID(), // null expiry → EXCLUDED
  // 0182. Both are EXPIRED and inside the horizon, so before the discard gate
  // both warned. They differ ONLY by date_discarded, which makes them a matched
  // positive/negative control pair: `discardedExpired` proves the gate fires,
  // `expired` (above, identical expiry) proves it did not over-fire and silence
  // genuine warnings.
  discardedExpired: randomUUID(), // expired BUT discarded → EXCLUDED
};
const bId = randomUUID(); // Studio B, expired → EXCLUDED for A (cross-studio)

async function insertSterile(
  studio: SeededStudio,
  id: string,
  expiry: string | null,
  discarded: string | null = null,
) {
  await adminQuery(
    `insert into public.record_keeping_sterile_items
       (id, studio_id, date_purchased, item_description, expiry_date, date_discarded)
     values ($1,$2,'2026-01-01','probe box',$3,$4)`,
    [id, studio.studioId, expiry, discarded],
  );
}

beforeAll(async () => {
  a = await seedStudio("rk-expiring-a");
  b = await seedStudio("rk-expiring-b");
  await insertSterile(a, ids.expired, "2026-06-01");
  await insertSterile(a, ids.today, TODAY);
  await insertSterile(a, ids.soon, "2026-07-20");
  await insertSterile(a, ids.boundary, HORIZON);
  await insertSterile(a, ids.future, "2026-09-15");
  await insertSterile(a, ids.noExpiry, null);
  // 0182: same expiry as ids.expired, but recorded as thrown away.
  await insertSterile(a, ids.discardedExpired, "2026-06-01", "2026-06-20");
  await insertSterile(b, bId, "2026-06-01"); // B expired, must not leak to A
});

afterAll(async () => {
  await closePool();
});

describe("getExpiringSterileItems filter on the real migrated DB (RLS-scoped)", () => {
  it("returns expired + today + within-horizon (incl. the horizon boundary), asc by expiry", async () => {
    const res = await asUser(a.userId, (q) =>
      q(FILTER_SQL, [a.studioId, HORIZON]),
    );
    const got = res.rows.map((r) => r.id);
    expect(got).toEqual([ids.expired, ids.today, ids.soon, ids.boundary]);
  });

  it("excludes rows with no expiry_date", async () => {
    const res = await asUser(a.userId, (q) =>
      q(FILTER_SQL, [a.studioId, HORIZON]),
    );
    expect(res.rows.map((r) => r.id)).not.toContain(ids.noExpiry);
  });

  // ---- Migration 0182: the discard gate --------------------------------
  it("excludes an EXPIRED item once it is recorded as discarded (0182)", async () => {
    const res = await asUser(a.userId, (q) =>
      q(FILTER_SQL, [a.studioId, HORIZON]),
    );
    expect(res.rows.map((r) => r.id)).not.toContain(ids.discardedExpired);
  });

  it("POSITIVE CONTROL: the identically-expired UNdiscarded item still warns", async () => {
    // Without this the test above would pass just as well if the gate were
    // over-broad and silenced every expiry warning. ids.expired and
    // ids.discardedExpired share the expiry date 2026-06-01 and differ ONLY by
    // date_discarded, so the pair isolates the new predicate exactly.
    const res = await asUser(a.userId, (q) =>
      q(FILTER_SQL, [a.studioId, HORIZON]),
    );
    expect(res.rows.map((r) => r.id)).toContain(ids.expired);
  });

  it("NEGATIVE CONTROL: the row still EXISTS and is readable — discard is not deletion", async () => {
    // The whole architecture rests on this: the warning stops, the record does
    // not. Historical record keeping, traceability, export and search all read
    // the row through exactly this path.
    const res = await asUser(a.userId, (q) =>
      q(
        `select id, expiry_date, date_discarded
           from public.record_keeping_sterile_items
          where id = $1`,
        [ids.discardedExpired],
      ),
    );
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].date_discarded).not.toBeNull();
  });

  it("a CLEARED discard restores the warning (undiscard is reversible, 0182)", async () => {
    // Correction path: an accidental discard is undone by clearing the field,
    // and the item returns to current inventory. Restored afterwards so the
    // other cases in this file keep their fixture.
    await adminQuery(
      "update public.record_keeping_sterile_items set date_discarded = null where id = $1",
      [ids.discardedExpired],
    );
    const back = await asUser(a.userId, (q) =>
      q(FILTER_SQL, [a.studioId, HORIZON]),
    );
    expect(back.rows.map((r) => r.id)).toContain(ids.discardedExpired);

    await adminQuery(
      "update public.record_keeping_sterile_items set date_discarded = '2026-06-20' where id = $1",
      [ids.discardedExpired],
    );
    const gone = await asUser(a.userId, (q) =>
      q(FILTER_SQL, [a.studioId, HORIZON]),
    );
    expect(gone.rows.map((r) => r.id)).not.toContain(ids.discardedExpired);
  });

  it("excludes a future expiry beyond the horizon", async () => {
    const res = await asUser(a.userId, (q) =>
      q(FILTER_SQL, [a.studioId, HORIZON]),
    );
    expect(res.rows.map((r) => r.id)).not.toContain(ids.future);
  });

  it("is studio-scoped: never returns another studio's expired item (RLS + filter)", async () => {
    const res = await asUser(a.userId, (q) =>
      q(FILTER_SQL, [a.studioId, HORIZON]),
    );
    expect(res.rows.map((r) => r.id)).not.toContain(bId);

    // And RLS itself denies A's member any visibility of B's row, even without
    // the studio_id filter — a member cannot read across studios.
    const rls = await asUser(a.userId, (q) =>
      q(
        "select id from public.record_keeping_sterile_items where id = $1",
        [bId],
      ),
    );
    expect(rls.rowCount).toBe(0);
  });

  it("studio B sees its own expired row but none of A's", async () => {
    const res = await asUser(b.userId, (q) =>
      q(FILTER_SQL, [b.studioId, HORIZON]),
    );
    const got = res.rows.map((r) => r.id);
    expect(got).toEqual([bId]);
    for (const id of Object.values(ids)) expect(got).not.toContain(id);
  });
});
