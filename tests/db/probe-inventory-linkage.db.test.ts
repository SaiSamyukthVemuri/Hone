import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  purgeAppointmentAudit,
  asUser,
  closePool,
  seedSession,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// Migration 0155 — inventory-backed probe-lot linkage, proven on the REAL
// migrated local database. Covers test points #3, #8, #16, #17, #18, #22:
//   #22 same-studio inventory link accepted (composite FK)
//   #8  cross-studio / forged link rejected at the DB (backstop below the app)
//   #16/#18 historical snapshot never changes when inventory is edited/deleted
//   #17 legacy text-only (manual, no link) still valid
//   #3  a non-probe sterile item (probe_key NULL) is legal
// The link column ON DELETE SET NULL only nulls the pointer; the immutable
// lot-number snapshot and the block itself survive. Studio deletion still
// cascades both the block and the inventory row (studio-scoped isolation).

let a: SeededStudio;
let b: SeededStudio;

const F3 = "sterex-gold-two-piece-f3-short";
const F2 = "sterex-stainless-steel-two-piece-f2-short";

async function seedProbeItem(
  studio: SeededStudio,
  opts: { probeKey: string | null; lot: string | null; expiry?: string | null },
): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.record_keeping_sterile_items
       (id, studio_id, date_purchased, item_description, lot_number, probe_key, expiry_date)
     values ($1, $2, current_date, 'Sterex probe', $3, $4, $5)`,
    [id, studio.studioId, opts.lot, opts.probeKey, opts.expiry ?? null],
  );
  return id;
}

// Create a session_block through the REAL atomic RPC (the production write path)
// as an authenticated member, carrying the inventory link + snapshot in p_block.
async function rpcCreateLinkedBlock(
  studio: SeededStudio,
  sessionId: string,
  block: Record<string, unknown>,
): Promise<string> {
  return asUser(studio.userId, async (q) => {
    const r = await q(
      `select public.create_session_block_with_areas($1,$2,$3::jsonb,$4::jsonb) as id`,
      [studio.studioId, sessionId, JSON.stringify(block), "[]"],
    );
    return r.rows[0].id as string;
  });
}

beforeAll(async () => {
  a = await seedStudio("probeinv-a");
  b = await seedStudio("probeinv-b");
});

afterAll(async () => {
  await closePool();
});

describe("probe_key on sterile items (#3 optional, catalog-length backstop)", () => {
  it("accepts NULL probe_key (a non-probe sterile item)", async () => {
    const id = await seedProbeItem(a, { probeKey: null, lot: "GENERIC-1" });
    const r = await adminQuery(
      "select probe_key from public.record_keeping_sterile_items where id=$1",
      [id],
    );
    expect(r.rows[0].probe_key).toBeNull();
  });

  it("(#1) persists a real catalog probe_key classification and reads it back verbatim", async () => {
    const id = await seedProbeItem(a, { probeKey: F3, lot: "CLASSIFIED-1" });
    const r = await adminQuery(
      "select probe_key from public.record_keeping_sterile_items where id=$1",
      [id],
    );
    expect(r.rows[0].probe_key).toBe(F3);
  });

  it("rejects an over-length probe_key (CHECK char_length <= 120)", async () => {
    await expect(
      adminQuery(
        `insert into public.record_keeping_sterile_items
           (id, studio_id, date_purchased, item_description, probe_key)
         values ($1,$2,current_date,'x',$3)`,
        [randomUUID(), a.studioId, "z".repeat(121)],
      ),
    ).rejects.toThrow();
  });
});

describe("#22 same-studio inventory link is accepted via the atomic RPC", () => {
  it("stores the durable link id AND the lot-number snapshot together", async () => {
    const item = await seedProbeItem(a, { probeKey: F3, lot: "LOT-A-100" });
    const { sessionId } = await seedSession(a);
    const blockId = await rpcCreateLinkedBlock(a, sessionId, {
      probe_key: F3,
      probe_inventory_item_id: item,
      probe_lot_number: "LOT-A-100",
      probe_lot_confirmed: true,
    });
    const r = await adminQuery(
      "select probe_inventory_item_id, probe_lot_number, probe_lot_confirmed, studio_id from public.session_blocks where id=$1",
      [blockId],
    );
    expect(r.rows[0].probe_inventory_item_id).toBe(item);
    expect(r.rows[0].probe_lot_number).toBe("LOT-A-100");
    expect(r.rows[0].probe_lot_confirmed).toBe(true);
    expect(r.rows[0].studio_id).toBe(a.studioId);
  });
});

describe("#8 a cross-studio / forged inventory link is rejected at the DB", () => {
  it("the atomic RPC aborts when the link points at ANOTHER studio's inventory row", async () => {
    const foreignItem = await seedProbeItem(b, { probeKey: F3, lot: "LOT-B-1" });
    const { sessionId } = await seedSession(a);
    await expect(
      rpcCreateLinkedBlock(a, sessionId, {
        probe_key: F3,
        probe_inventory_item_id: foreignItem,
        probe_lot_number: "LOT-B-1",
      }),
    ).rejects.toThrow();
  });

  it("a direct cross-studio insert also violates the composite FK", async () => {
    const foreignItem = await seedProbeItem(b, { probeKey: F3, lot: "LOT-B-2" });
    const { sessionId } = await seedSession(a);
    await expect(
      adminQuery(
        `insert into public.session_blocks (id, studio_id, session_id, probe_inventory_item_id)
         values ($1,$2,$3,$4)`,
        [randomUUID(), a.studioId, sessionId, foreignItem],
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it("a nonexistent (forged) inventory id also fails the FK", async () => {
    const { sessionId } = await seedSession(a);
    await expect(
      adminQuery(
        `insert into public.session_blocks (id, studio_id, session_id, probe_inventory_item_id)
         values ($1,$2,$3,$4)`,
        [randomUUID(), a.studioId, sessionId, randomUUID()],
      ),
    ).rejects.toThrow();
  });
});

describe("#16/#18 historical charting is immutable when inventory later changes", () => {
  it("editing the inventory lot number does NOT rewrite the block's snapshot (no live join)", async () => {
    const item = await seedProbeItem(a, { probeKey: F3, lot: "ORIG-LOT" });
    const { sessionId } = await seedSession(a);
    const blockId = await rpcCreateLinkedBlock(a, sessionId, {
      probe_key: F3,
      probe_inventory_item_id: item,
      probe_lot_number: "ORIG-LOT",
    });
    // Someone later corrects the inventory record.
    await adminQuery(
      "update public.record_keeping_sterile_items set lot_number='CORRECTED' where id=$1",
      [item],
    );
    const r = await adminQuery(
      "select probe_inventory_item_id, probe_lot_number from public.session_blocks where id=$1",
      [blockId],
    );
    // Link still points at the row, but the SNAPSHOT is frozen.
    expect(r.rows[0].probe_inventory_item_id).toBe(item);
    expect(r.rows[0].probe_lot_number).toBe("ORIG-LOT");
  });

  it("deleting the inventory row nulls ONLY the link and preserves the snapshot + block + studio", async () => {
    const item = await seedProbeItem(a, { probeKey: F3, lot: "DEL-LOT" });
    const { sessionId } = await seedSession(a);
    const blockId = await rpcCreateLinkedBlock(a, sessionId, {
      probe_key: F3,
      probe_inventory_item_id: item,
      probe_lot_number: "DEL-LOT",
    });
    await adminQuery(
      "delete from public.record_keeping_sterile_items where id=$1",
      [item],
    );
    const r = await adminQuery(
      "select probe_inventory_item_id, probe_lot_number, studio_id from public.session_blocks where id=$1",
      [blockId],
    );
    expect(r.rowCount).toBe(1); // the charting record is NOT deleted
    expect(r.rows[0].probe_inventory_item_id).toBeNull(); // link cleared (SET NULL)
    expect(r.rows[0].probe_lot_number).toBe("DEL-LOT"); // snapshot preserved
    expect(r.rows[0].studio_id).toBe(a.studioId); // studio_id NOT nulled
  });
});

describe("#17 legacy / manual text-only lot (no inventory link) stays valid", () => {
  it("a block with a manual snapshot and NULL link round-trips", async () => {
    const { sessionId } = await seedSession(a);
    const blockId = await rpcCreateLinkedBlock(a, sessionId, {
      probe_key: F2,
      probe_inventory_item_id: null,
      probe_lot_number: "MANUAL-77",
    });
    const r = await adminQuery(
      "select probe_inventory_item_id, probe_lot_number from public.session_blocks where id=$1",
      [blockId],
    );
    expect(r.rows[0].probe_inventory_item_id).toBeNull();
    expect(r.rows[0].probe_lot_number).toBe("MANUAL-77");
  });
});

describe("RLS: a linked inventory row is invisible across studios (#8)", () => {
  it("studio B cannot read studio A's sterile inventory row", async () => {
    const item = await seedProbeItem(a, { probeKey: F3, lot: "A-PRIVATE" });
    const seen = await asUser(b.userId, async (q) => {
      const r = await q(
        "select id from public.record_keeping_sterile_items where id=$1",
        [item],
      );
      return r.rowCount;
    });
    expect(seen).toBe(0);
  });
});

describe("studio-scoped cascade still removes both the block and its inventory", () => {
  it("deleting the studio cascades away the linked block and the sterile item", async () => {
    const c = await seedStudio("probeinv-c");
    const item = await seedProbeItem(c, { probeKey: F3, lot: "C-LOT" });
    const { sessionId } = await seedSession(c);
    const blockId = await rpcCreateLinkedBlock(c, sessionId, {
      probe_key: F3,
      probe_inventory_item_id: item,
      probe_lot_number: "C-LOT",
    });
    await purgeAppointmentAudit(c.studioId);
    await adminQuery("delete from public.studios where id=$1", [c.studioId]);
    const blk = await adminQuery(
      "select id from public.session_blocks where id=$1",
      [blockId],
    );
    const inv = await adminQuery(
      "select id from public.record_keeping_sterile_items where id=$1",
      [item],
    );
    expect(blk.rowCount).toBe(0);
    expect(inv.rowCount).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// MIXED-VERSION COMPATIBILITY (proves DB-FIRST rollout is safe): the NEW 0155
// RPCs must accept OLD application payloads whose p_block OMITS the new
// probe_inventory_item_id key. jsonb_populate_record leaves an absent key NULL,
// so the write succeeds, no inventory link is fabricated, and the existing
// manual probe_lot_number + confirmation semantics are unchanged. This is the
// window between applying 0155 and deploying the new app code.
// -----------------------------------------------------------------------------
describe("mixed-version: new 0155 RPCs accept OLD app payloads (no probe_inventory_item_id key)", () => {
  it("create_session_block_with_areas succeeds when p_block lacks the new key — link NULL, manual lot preserved", async () => {
    const { sessionId } = await seedSession(a);
    // OLD app payload: NO probe_inventory_item_id key at all.
    const oldPayload = {
      primary_area: "Chin",
      probe_lot_number: "MANUAL-OLD",
      probe_lot_confirmed: true,
    };
    expect("probe_inventory_item_id" in oldPayload).toBe(false);
    const blockId = await asUser(a.userId, async (q) => {
      const r = await q(
        `select public.create_session_block_with_areas($1,$2,$3::jsonb,$4::jsonb) as id`,
        [a.studioId, sessionId, JSON.stringify(oldPayload), "[]"],
      );
      return r.rows[0].id as string;
    });
    const row = await adminQuery(
      "select probe_inventory_item_id, probe_lot_number, probe_lot_confirmed from public.session_blocks where id=$1",
      [blockId],
    );
    expect(row.rows[0].probe_inventory_item_id).toBeNull(); // no fabricated link
    expect(row.rows[0].probe_lot_number).toBe("MANUAL-OLD"); // manual snapshot kept
    expect(row.rows[0].probe_lot_confirmed).toBe(true); // confirmation unchanged
  });

  it("update_session_block_with_areas succeeds when p_block lacks the new key — no link fabricated, manual semantics intact", async () => {
    const { sessionId, blockId } = await seedSession(a);
    const oldPayload = {
      primary_area: "Lip",
      probe_lot_number: "MANUAL-UPD",
      probe_lot_confirmed: true,
    };
    expect("probe_inventory_item_id" in oldPayload).toBe(false);
    await asUser(a.userId, (q) =>
      q(
        `select public.update_session_block_with_areas($1,$2,$3,$4::jsonb,$5::jsonb,null)`,
        [a.studioId, sessionId, blockId, JSON.stringify(oldPayload), "[]"],
      ),
    );
    const row = await adminQuery(
      "select probe_inventory_item_id, probe_lot_number, probe_lot_confirmed from public.session_blocks where id=$1",
      [blockId],
    );
    expect(row.rows[0].probe_inventory_item_id).toBeNull(); // never fabricated
    expect(row.rows[0].probe_lot_number).toBe("MANUAL-UPD");
    expect(row.rows[0].probe_lot_confirmed).toBe(true);
  });
});
