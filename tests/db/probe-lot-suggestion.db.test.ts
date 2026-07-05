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
  select probe_key, probe_label, probe_lot_number, probe_lot_confirmed, created_at
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
};
type Sugg = { lot: string; confirmed: boolean };

function normalizeLabel(label: string | null): string {
  return (label ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function reduceSuggestions(rows: SuggRow[]): {
  byKey: Record<string, Sugg>;
  byLabel: Record<string, Sugg>;
} {
  const byKey: Record<string, Sugg> = {};
  const byLabel: Record<string, Sugg> = {};
  for (const row of rows) {
    const lot = row.probe_lot_number?.trim();
    if (!lot) continue;
    const confirmed = row.probe_lot_confirmed === true;
    const key = row.probe_key?.trim();
    if (key && !(key in byKey)) byKey[key] = { lot, confirmed };
    const label = normalizeLabel(row.probe_label);
    if (label && !(label in byLabel)) byLabel[label] = { lot, confirmed };
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
  },
): Promise<void> {
  await adminQuery(
    `insert into public.session_blocks
       (id, studio_id, session_id, probe_key, probe_label, probe_lot_number, probe_lot_confirmed, created_at, deleted_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      randomUUID(), studio.studioId, sessionId,
      opts.probeKey, opts.label ?? null, opts.lot, opts.confirmed,
      opts.createdAt, opts.deleted ? opts.createdAt : null,
    ],
  );
}

describe("getProbeLotSuggestions semantics (byKey + byLabel, confirmed-aware)", () => {
  let c: SeededStudio;
  let cSession: string;
  beforeAll(async () => {
    c = await seedStudio("probe-sugg-c");
    cSession = (await seedSession(c)).sessionId;
    // Keyed probe K: older CONFIRMED KC beats newer unconfirmed KU.
    await insertLabeledBlock(c, cSession, { probeKey: "K", label: "L Brand · Gold · F2", lot: "KC", confirmed: true, createdAt: "2026-01-01T00:00:00Z" });
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
    expect(byKey["K"]).toEqual({ lot: "KC", confirmed: true }); // confirmed beats newer unconfirmed
    expect(byKey["U"]).toEqual({ lot: "UU", confirmed: false }); // unconfirmed fallback kept
  });

  it("byLabel provides a normalized free-text fallback (probe_key null)", async () => {
    const { rows } = await adminQuery(SUGG_QUERY, [c.studioId]);
    const { byLabel } = reduceSuggestions(rows as SuggRow[]);
    expect(byLabel["sterex · gold · two-piece · f2 short"]).toEqual({ lot: "FREETEXTLOT", confirmed: false });
  });

  it("never leaks another studio's lot into byKey/byLabel", async () => {
    const { rows } = await adminQuery(SUGG_QUERY, [c.studioId]);
    const { byKey, byLabel } = reduceSuggestions(rows as SuggRow[]);
    const all = [...Object.values(byKey), ...Object.values(byLabel)].map((v) => v.lot);
    expect(all).not.toContain("D_LOT");
  });
});
