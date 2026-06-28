import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  closePool,
  seedSession,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";

// PR #279 (migration 0095): session_blocks gains numbing_status + probe_lot_confirmed.
// Proven on the REAL migrated local database. Additive + safely defaulted so every
// legacy row reads correctly (numbing NULL = Not recorded; not confirmed).

let s: SeededStudio;
let sess: { sessionId: string; blockId: string };

beforeAll(async () => {
  s = await seedStudio("charting0095");
  sess = await seedSession(s);
});

afterAll(async () => {
  await closePool();
});

describe("numbing_status (NULL = Not recorded)", () => {
  it("a new block defaults to NULL numbing + not-confirmed lot (legacy-safe)", async () => {
    const id = randomUUID();
    await adminQuery(
      "insert into public.session_blocks (id, studio_id, session_id) values ($1,$2,$3)",
      [id, s.studioId, sess.sessionId],
    );
    const r = await adminQuery(
      "select numbing_status, probe_lot_confirmed from public.session_blocks where id=$1",
      [id],
    );
    expect(r.rows[0].numbing_status).toBeNull();
    expect(r.rows[0].probe_lot_confirmed).toBe(false);
  });

  it("accepts 'none' and 'used'", async () => {
    for (const v of ["none", "used"]) {
      const id = randomUUID();
      const r = await adminQuery(
        "insert into public.session_blocks (id, studio_id, session_id, numbing_status) values ($1,$2,$3,$4)",
        [id, s.studioId, sess.sessionId, v],
      );
      expect(r.rowCount).toBe(1);
    }
  });

  it("rejects an unknown numbing_status (CHECK backstop)", async () => {
    await expect(
      adminQuery(
        "insert into public.session_blocks (id, studio_id, session_id, numbing_status) values ($1,$2,$3,'topical')",
        [randomUUID(), s.studioId, sess.sessionId],
      ),
    ).rejects.toThrow();
  });
});

describe("probe_lot_confirmed", () => {
  it("can be set true and round-trips alongside the lot number", async () => {
    const id = randomUUID();
    await adminQuery(
      "insert into public.session_blocks (id, studio_id, session_id, probe_lot_number, probe_lot_confirmed) values ($1,$2,$3,'460941',true)",
      [id, s.studioId, sess.sessionId],
    );
    const r = await adminQuery(
      "select probe_lot_number, probe_lot_confirmed from public.session_blocks where id=$1",
      [id],
    );
    expect(r.rows[0].probe_lot_number).toBe("460941");
    expect(r.rows[0].probe_lot_confirmed).toBe(true);
  });
});
