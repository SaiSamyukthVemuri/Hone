import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  closePool,
  seedStudio,
  seedSession,
  type SeededStudio,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";

// Feature A: getLatestProbeLotByProbeKey(studioId) suggests the most recent
// lot/batch used for the SAME probe (probe_key) in the SAME studio. The TS
// helper runs through the RLS createClient() (a request-context client we can't
// build here), so this exercises the EXACT query + reduction it issues against
// the real migrated DB, proving: studio scope, same-probe keying, prefer-
// confirmed-then-newest, and exclusion of null probe_key / null-or-blank lot /
// soft-deleted rows. No cross-studio leakage.

// The helper's query, verbatim (mirrors the supabase-js chain):
const QUERY = `
  select probe_key, probe_lot_number, probe_lot_confirmed, created_at
  from public.session_blocks
  where studio_id = $1
    and probe_key is not null
    and probe_lot_number is not null
    and deleted_at is null
  order by probe_key asc, probe_lot_confirmed desc, created_at desc
`;

// The helper's JS reduction (first row per probe_key wins; blank lot skipped).
function reduce(
  rows: Array<{ probe_key: string | null; probe_lot_number: string | null }>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const row of rows) {
    const key = row.probe_key?.trim();
    const lot = row.probe_lot_number?.trim();
    if (!key || !lot) continue;
    if (!(key in map)) map[key] = lot;
  }
  return map;
}

let a: SeededStudio;
let b: SeededStudio;
let aSession: string;
let bSession: string;

async function insertBlock(
  studio: SeededStudio,
  sessionId: string,
  opts: {
    probeKey: string | null;
    lot: string | null;
    confirmed: boolean;
    createdAt: string;
    deleted?: boolean;
  },
): Promise<void> {
  await adminQuery(
    `insert into public.session_blocks
       (id, studio_id, session_id, probe_key, probe_lot_number, probe_lot_confirmed, created_at, deleted_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      randomUUID(),
      studio.studioId,
      sessionId,
      opts.probeKey,
      opts.lot,
      opts.confirmed,
      opts.createdAt,
      opts.deleted ? opts.createdAt : null,
    ],
  );
}

beforeAll(async () => {
  a = await seedStudio("probe-lot-a");
  b = await seedStudio("probe-lot-b");
  aSession = (await seedSession(a)).sessionId;
  bSession = (await seedSession(b)).sessionId;

  // Studio A, probe X: an OLDER confirmed lot L2 + a NEWER unconfirmed lot L1.
  // Prefer-confirmed must pick L2 even though L1 is newer.
  await insertBlock(a, aSession, { probeKey: "X", lot: "L2", confirmed: true, createdAt: "2026-01-01T00:00:00Z" });
  await insertBlock(a, aSession, { probeKey: "X", lot: "L1", confirmed: false, createdAt: "2026-06-01T00:00:00Z" });
  // Probe Y: single unconfirmed lot L3.
  await insertBlock(a, aSession, { probeKey: "Y", lot: "L3", confirmed: false, createdAt: "2026-03-01T00:00:00Z" });
  // Excluded rows: blank lot, null probe_key, and a soft-deleted block.
  await insertBlock(a, aSession, { probeKey: "X", lot: "   ", confirmed: false, createdAt: "2026-07-01T00:00:00Z" });
  await insertBlock(a, aSession, { probeKey: null, lot: "L9", confirmed: true, createdAt: "2026-07-01T00:00:00Z" });
  await insertBlock(a, aSession, { probeKey: "Z", lot: "L6", confirmed: true, createdAt: "2026-05-01T00:00:00Z", deleted: true });

  // Studio B, probe X: a confirmed lot that must NEVER appear for studio A.
  await insertBlock(b, bSession, { probeKey: "X", lot: "STUDIO_B_LOT", confirmed: true, createdAt: "2026-06-15T00:00:00Z" });
});

afterAll(async () => {
  await closePool();
});

describe("getLatestProbeLotByProbeKey semantics", () => {
  it("prefers a confirmed lot over a newer unconfirmed one, per probe", async () => {
    const { rows } = await adminQuery(QUERY, [a.studioId]);
    const map = reduce(rows as never[]);
    expect(map["X"]).toBe("L2"); // confirmed beats newer-unconfirmed L1
    expect(map["Y"]).toBe("L3");
  });

  it("excludes null probe_key, blank lots, and soft-deleted blocks", async () => {
    const { rows } = await adminQuery(QUERY, [a.studioId]);
    const map = reduce(rows as never[]);
    // Blank lot never becomes X's value (X stays L2).
    expect(map["X"]).not.toBe("");
    // Soft-deleted probe Z contributes nothing.
    expect(map["Z"]).toBeUndefined();
    // The null-probe_key row (lot L9) contributes nothing.
    expect(Object.values(map)).not.toContain("L9");
  });

  it("never suggests across studios", async () => {
    const { rows } = await adminQuery(QUERY, [a.studioId]);
    const map = reduce(rows as never[]);
    expect(map["X"]).not.toBe("STUDIO_B_LOT");
    expect(Object.values(map)).not.toContain("STUDIO_B_LOT");
  });

  it("a studio with no prior probe lots yields an empty map", async () => {
    const empty = await seedStudio("probe-lot-empty");
    const { rows } = await adminQuery(QUERY, [empty.studioId]);
    expect(reduce(rows as never[])).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Reliability update: getProbeLotSuggestions(studioId) returns byKey + byLabel
// (each with a confirmed flag), confirmed-preferred + newest-wins, studio-
// scoped. This exercises the EXACT query + reduction it issues.
// ---------------------------------------------------------------------------
const SUGG_QUERY = `
  select probe_key, probe_label, probe_lot_number, probe_lot_confirmed,
         probe_inventory_item_id, created_at
  from public.session_blocks
  where studio_id = $1
    and probe_lot_number is not null
    and deleted_at is null
  order by probe_lot_confirmed desc, created_at desc
`;

type SuggRow = {
  probe_key: string | null;
  probe_label: string | null;
  probe_lot_number: string | null;
  probe_lot_confirmed: boolean;
  probe_inventory_item_id: string | null;
};
// 0155: the suggestion carries the DISPLAY winner's linked id (may be null) AND,
// independently, the newest CONFIRMED-LINKED id — the only value auto-fill uses.
// This reduction mirrors lib/record-keeping/queries.ts getProbeLotSuggestions.
type Sugg = {
  lot: string;
  confirmed: boolean;
  inventoryItemId: string | null;
  lastConfirmedInventoryItemId: string | null;
};

function normalizeLabel(label: string | null): string {
  return (label ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function reduceSuggestions(rows: SuggRow[]): {
  byKey: Record<string, Sugg>;
  byLabel: Record<string, Sugg>;
} {
  const byKey: Record<string, Sugg> = {};
  const byLabel: Record<string, Sugg> = {};
  const seedFirst = (
    map: Record<string, Sugg>,
    slot: string,
    lot: string,
    confirmed: boolean,
    inventoryItemId: string | null,
  ) => {
    if (!(slot in map)) {
      map[slot] = { lot, confirmed, inventoryItemId, lastConfirmedInventoryItemId: null };
    }
    if (confirmed && inventoryItemId != null && map[slot].lastConfirmedInventoryItemId == null) {
      map[slot].lastConfirmedInventoryItemId = inventoryItemId;
    }
  };
  for (const row of rows) {
    const lot = row.probe_lot_number?.trim();
    if (!lot) continue;
    const confirmed = row.probe_lot_confirmed === true;
    const inventoryItemId = row.probe_inventory_item_id ?? null;
    const key = row.probe_key?.trim();
    if (key) seedFirst(byKey, key, lot, confirmed, inventoryItemId);
    const label = normalizeLabel(row.probe_label);
    if (label) seedFirst(byLabel, label, lot, confirmed, inventoryItemId);
  }
  return { byKey, byLabel };
}

async function insertLabeledBlock(
  studio: SeededStudio,
  sessionId: string,
  opts: {
    probeKey: string | null;
    label?: string | null;
    lot: string;
    confirmed: boolean;
    createdAt: string;
    deleted?: boolean;
    inventoryItemId?: string | null;
  },
): Promise<void> {
  await adminQuery(
    `insert into public.session_blocks
       (id, studio_id, session_id, probe_key, probe_label, probe_lot_number, probe_lot_confirmed, probe_inventory_item_id, created_at, deleted_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      randomUUID(), studio.studioId, sessionId,
      opts.probeKey, opts.label ?? null, opts.lot, opts.confirmed,
      opts.inventoryItemId ?? null,
      opts.createdAt, opts.deleted ? opts.createdAt : null,
    ],
  );
}

// Seed a probe sterile-inventory row so a block can carry a real (FK-valid)
// probe_inventory_item_id. Returns its id.
async function seedSterileItem(
  studio: SeededStudio,
  opts: { probeKey?: string; lot?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.record_keeping_sterile_items
       (id, studio_id, date_purchased, item_description, lot_number, probe_key)
     values ($1,$2,current_date,'Sterex probe',$3,$4)`,
    [id, studio.studioId, opts.lot ?? "KC", opts.probeKey ?? "K"],
  );
  return id;
}

describe("getProbeLotSuggestions semantics (byKey + byLabel, confirmed-aware)", () => {
  let c: SeededStudio;
  let cSession: string;
  let kInventoryId: string;
  beforeAll(async () => {
    c = await seedStudio("probe-sugg-c");
    cSession = (await seedSession(c)).sessionId;
    kInventoryId = await seedSterileItem(c);
    // Keyed probe K: older CONFIRMED KC (inventory-LINKED) beats newer
    // unconfirmed KU. The linked id is the auto-fill data source.
    await insertLabeledBlock(c, cSession, { probeKey: "K", label: "L Brand · Gold · F2", lot: "KC", confirmed: true, createdAt: "2026-01-01T00:00:00Z", inventoryItemId: kInventoryId });
    await insertLabeledBlock(c, cSession, { probeKey: "K", label: "L Brand · Gold · F2", lot: "KU", confirmed: false, createdAt: "2026-06-01T00:00:00Z" });
    // Keyed probe U: only UNCONFIRMED lot (the fallback that must be kept).
    await insertLabeledBlock(c, cSession, { probeKey: "U", label: "Uprobe", lot: "UU", confirmed: false, createdAt: "2026-03-01T00:00:00Z" });
    // Free-text (probe_key null) probe with a LABEL only + a lot.
    await insertLabeledBlock(c, cSession, { probeKey: null, label: "  Sterex · Gold · Two-piece · F2 Short ", lot: "FREETEXTLOT", confirmed: false, createdAt: "2026-05-01T00:00:00Z" });
    // Studio D isolation.
    const d = await seedStudio("probe-sugg-d");
    const dSession = (await seedSession(d)).sessionId;
    await insertLabeledBlock(d, dSession, { probeKey: "K", label: "L Brand · Gold · F2", lot: "D_LOT", confirmed: true, createdAt: "2026-07-01T00:00:00Z" });
  });

  it("byKey prefers confirmed over newer unconfirmed; keeps unconfirmed fallback", async () => {
    const { rows } = await adminQuery(SUGG_QUERY, [c.studioId]);
    const { byKey } = reduceSuggestions(rows as SuggRow[]);
    // confirmed beats newer unconfirmed (K linked to inventory); U fallback kept.
    expect(byKey["K"]).toEqual({ lot: "KC", confirmed: true, inventoryItemId: kInventoryId, lastConfirmedInventoryItemId: kInventoryId });
    expect(byKey["U"]).toEqual({ lot: "UU", confirmed: false, inventoryItemId: null, lastConfirmedInventoryItemId: null });
  });

  it("(#4) surfaces the CONFIRMED lot's linked inventory id (the auto-fill source); the unconfirmed fallback carries no confirmed id", async () => {
    const { rows } = await adminQuery(SUGG_QUERY, [c.studioId]);
    const { byKey } = reduceSuggestions(rows as SuggRow[]);
    // The confirmed K row is inventory-linked → its id is the last-confirmed
    // auto-fill source, and confirmed:true (the form only uses it when confirmed).
    expect(byKey["K"].inventoryItemId).toBe(kInventoryId);
    expect(byKey["K"].confirmed).toBe(true);
    // The U probe's only prior selection is UNCONFIRMED → confirmed:false, so the
    // form gates it out of the "last-confirmed" branch (contract #2).
    expect(byKey["U"].confirmed).toBe(false);
    expect(byKey["U"].inventoryItemId).toBeNull();
  });

  it("byLabel provides a normalized free-text fallback (probe_key null)", async () => {
    const { rows } = await adminQuery(SUGG_QUERY, [c.studioId]);
    const { byLabel } = reduceSuggestions(rows as SuggRow[]);
    expect(byLabel["sterex · gold · two-piece · f2 short"]).toEqual({ lot: "FREETEXTLOT", confirmed: false, inventoryItemId: null, lastConfirmedInventoryItemId: null });
  });

  it("never leaks another studio's lot into byKey/byLabel", async () => {
    const { rows } = await adminQuery(SUGG_QUERY, [c.studioId]);
    const { byKey, byLabel } = reduceSuggestions(rows as SuggRow[]);
    const all = [...Object.values(byKey), ...Object.values(byLabel)].map((v) => v.lot);
    expect(all).not.toContain("D_LOT");
  });
});

// -----------------------------------------------------------------------------
// last-confirmed LINKED selection (0155, issue #2). lastConfirmedInventoryItemId
// tracks the newest row that is BOTH confirmed AND inventory-linked, INDEPENDENT
// of the display winner — so a newer confirmed MANUAL row can't mask an older
// confirmed LINKED one, and unconfirmed / deleted / cross-studio rows never
// contribute. Proven on the real migrated DB with the production reduction.
// -----------------------------------------------------------------------------
describe("last-confirmed LINKED selection (0155 issue #2)", () => {
  let s: SeededStudio;
  let sess: string;
  let other: SeededStudio;
  let linkedOlderId: string; // confirmed + linked, OLDER
  let linkedNewerId: string; // linked but UNCONFIRMED (or newer), per scenario
  let crossStudioId: string;

  beforeAll(async () => {
    s = await seedStudio("lcl-main");
    sess = (await seedSession(s)).sessionId;
    other = await seedStudio("lcl-other");
    const otherSess = (await seedSession(other)).sessionId;

    // --- Probe P1: newer CONFIRMED MANUAL + older CONFIRMED LINKED -----------
    linkedOlderId = await seedSterileItem(s, { probeKey: "P1", lot: "P1-LINKED" });
    await insertLabeledBlock(s, sess, { probeKey: "P1", lot: "P1-LINKED", confirmed: true, createdAt: "2026-01-01T00:00:00Z", inventoryItemId: linkedOlderId });
    await insertLabeledBlock(s, sess, { probeKey: "P1", lot: "P1-MANUAL-NEWER", confirmed: true, createdAt: "2026-06-01T00:00:00Z", inventoryItemId: null });

    // --- Probe P2: newer UNCONFIRMED LINKED + older CONFIRMED LINKED ---------
    const p2Older = await seedSterileItem(s, { probeKey: "P2", lot: "P2-OLD" });
    linkedNewerId = await seedSterileItem(s, { probeKey: "P2", lot: "P2-NEW" });
    await insertLabeledBlock(s, sess, { probeKey: "P2", lot: "P2-OLD", confirmed: true, createdAt: "2026-02-01T00:00:00Z", inventoryItemId: p2Older });
    await insertLabeledBlock(s, sess, { probeKey: "P2", lot: "P2-NEW", confirmed: false, createdAt: "2026-07-01T00:00:00Z", inventoryItemId: linkedNewerId });

    // --- Probe P3: ONLY confirmed MANUAL rows -------------------------------
    await insertLabeledBlock(s, sess, { probeKey: "P3", lot: "P3-MANUAL", confirmed: true, createdAt: "2026-03-01T00:00:00Z", inventoryItemId: null });

    // --- Probe P4: a DELETED confirmed-linked + a cross-studio confirmed-linked
    const p4Deleted = await seedSterileItem(s, { probeKey: "P4", lot: "P4-DEL" });
    await insertLabeledBlock(s, sess, { probeKey: "P4", lot: "P4-DEL", confirmed: true, createdAt: "2026-04-01T00:00:00Z", inventoryItemId: p4Deleted, deleted: true });
    crossStudioId = await seedSterileItem(other, { probeKey: "P4", lot: "P4-OTHER" });
    await insertLabeledBlock(other, otherSess, { probeKey: "P4", lot: "P4-OTHER", confirmed: true, createdAt: "2026-05-01T00:00:00Z", inventoryItemId: crossStudioId });
  });

  it("newer confirmed MANUAL + older confirmed LINKED → the older linked id wins", async () => {
    const { rows } = await adminQuery(SUGG_QUERY, [s.studioId]);
    const { byKey } = reduceSuggestions(rows as SuggRow[]);
    // Display winner is the newer confirmed MANUAL row (inventoryItemId null)...
    expect(byKey["P1"].inventoryItemId).toBeNull();
    expect(byKey["P1"].confirmed).toBe(true);
    // ...but the auto-fill source is the older confirmed LINKED id.
    expect(byKey["P1"].lastConfirmedInventoryItemId).toBe(linkedOlderId);
  });

  it("newer UNCONFIRMED linked + older CONFIRMED linked → the older confirmed linked id wins", async () => {
    const { rows } = await adminQuery(SUGG_QUERY, [s.studioId]);
    const { byKey } = reduceSuggestions(rows as SuggRow[]);
    // The newer linked row is unconfirmed → never qualifies; the older confirmed
    // linked id is chosen.
    const p2Older = byKey["P2"].lastConfirmedInventoryItemId;
    expect(p2Older).not.toBeNull();
    expect(p2Older).not.toBe(linkedNewerId); // NOT the newer unconfirmed one
  });

  it("only confirmed MANUAL rows → no last-confirmed inventory id", async () => {
    const { rows } = await adminQuery(SUGG_QUERY, [s.studioId]);
    const { byKey } = reduceSuggestions(rows as SuggRow[]);
    expect(byKey["P3"].confirmed).toBe(true);
    expect(byKey["P3"].lastConfirmedInventoryItemId).toBeNull();
  });

  it("deleted rows never contribute, and cross-studio linked ids never leak", async () => {
    const { rows } = await adminQuery(SUGG_QUERY, [s.studioId]);
    const { byKey } = reduceSuggestions(rows as SuggRow[]);
    // The only P4 row for this studio is soft-deleted → filtered out entirely.
    expect(byKey["P4"]).toBeUndefined();
    // And the other studio's confirmed-linked id is never present anywhere.
    const allLast = Object.values(byKey).map((v) => v.lastConfirmedInventoryItemId);
    expect(allLast).not.toContain(crossStudioId);
  });
});
