import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveProbeInventorySelection } from "@/lib/record-keeping/probe-inventory-validation";

// Server-side resolution of a probe-lot selection (migration 0155). Covers test
// points #8 (cross-studio/forged reject), #9 (wrong probe), #10 (linked derives
// snapshot), #11 (manual), #15 (expired policy). A fake Supabase returns a
// single configured row for the eq(id)/eq(studio_id)/maybeSingle chain.

const STUDIO = "11111111-1111-1111-1111-111111111111";
const ITEM = "22222222-2222-2222-2222-222222222222";
const F3 = "sterex-gold-two-piece-f3-short";
const TOMORROW = new Date(Date.now() + 3 * 24 * 3600 * 1000)
  .toISOString()
  .slice(0, 10);
const YESTERDAY = "2000-01-01";

// A fake that MODELS PostgREST eq() filtering: the stored row is returned only
// when EVERY applied .eq(col, val) matches it. This makes the studio-scoping
// test non-tautological, dropping `.eq("studio_id", studioId)` from the
// resolver would make the cross-studio row visible and fail the reject test.
function fakeSupabase(row: Record<string, unknown> | null, error = false) {
  return {
    from: () => {
      const filters: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return builder;
        },
        maybeSingle: async () => {
          if (error) return { data: null, error: { message: "boom" } };
          const match =
            row != null &&
            Object.entries(filters).every(([k, v]) => row[k] === v);
          return { data: match ? row : null, error: null };
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const base = {
  probeInventoryItemId: ITEM,
  probeKey: F3,
  manualLotNumber: null,
  probeLotConfirmed: true,
};

describe("manual path (#11)", () => {
  it("no inventory id → manual: id null, trimmed text snapshot, not linked", async () => {
    const r = await resolveProbeInventorySelection(fakeSupabase(null), STUDIO, {
      probeInventoryItemId: null,
      probeKey: F3,
      manualLotNumber: "  ABC-123  ",
      probeLotConfirmed: true,
    });
    expect(r).toEqual({
      ok: true,
      probeInventoryItemId: null,
      probeLotNumber: "ABC-123",
      linked: false,
    });
  });
  it("blank manual → null snapshot", async () => {
    const r = await resolveProbeInventorySelection(fakeSupabase(null), STUDIO, {
      probeInventoryItemId: "   ",
      probeKey: F3,
      manualLotNumber: "   ",
      probeLotConfirmed: false,
    });
    expect(r.ok && r.probeLotNumber).toBeNull();
    expect(r.ok && r.probeInventoryItemId).toBeNull();
  });
});

describe("linked path: validation", () => {
  it("(#10) valid same-studio matching-probe active item → derives snapshot from the DB row", async () => {
    const r = await resolveProbeInventorySelection(
      fakeSupabase({
        id: ITEM,
        studio_id: STUDIO,
        lot_number: "DB-LOT-9",
        probe_key: F3,
        expiry_date: TOMORROW,
      }),
      STUDIO,
      { ...base, manualLotNumber: "CLIENT-LIED" },
    );
    // Snapshot is DB-derived, NOT the client's text.
    expect(r).toEqual({
      ok: true,
      probeInventoryItemId: ITEM,
      probeLotNumber: "DB-LOT-9",
      linked: true,
    });
  });

  it("(#8) a malformed (non-UUID) id is rejected", async () => {
    const r = await resolveProbeInventorySelection(fakeSupabase(null), STUDIO, {
      ...base,
      probeInventoryItemId: "not-a-uuid",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid/i);
  });

  it("(#8) a cross-studio id is rejected by studio scoping, never falls back to client text", async () => {
    // The row EXISTS, but in ANOTHER studio. The resolver's .eq("studio_id")
    // must hide it (RLS + explicit scope) → no row → reject. The modelled fake
    // only returns the row when studio_id also matches, so this genuinely
    // exercises the scope filter.
    const r = await resolveProbeInventorySelection(
      fakeSupabase({
        id: ITEM,
        studio_id: "99999999-9999-9999-9999-999999999999",
        lot_number: "FOREIGN-LOT",
        probe_key: F3,
        expiry_date: TOMORROW,
      }),
      STUDIO,
      { ...base, manualLotNumber: "SHOULD-NOT-BE-USED" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/isn't in your studio/i);
  });

  it("(#8) a nonexistent id (no row at all) is rejected", async () => {
    const r = await resolveProbeInventorySelection(fakeSupabase(null), STUDIO, base);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/isn't in your studio/i);
  });

  it("(#9) an inventory item classified for a DIFFERENT probe is rejected", async () => {
    const r = await resolveProbeInventorySelection(
      fakeSupabase({
        id: ITEM,
        studio_id: STUDIO,
        lot_number: "L",
        probe_key: "sterex-stainless-steel-two-piece-f2-short",
        expiry_date: TOMORROW,
      }),
      STUDIO,
      base,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/different probe/i);
  });

  it("an item with a blank lot number is rejected", async () => {
    const r = await resolveProbeInventorySelection(
      fakeSupabase({ id: ITEM, studio_id: STUDIO, lot_number: "  ", probe_key: F3, expiry_date: TOMORROW }),
      STUDIO,
      base,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no lot number/i);
  });

  it("a DB error is a safe failure (not a silent fallback)", async () => {
    const r = await resolveProbeInventorySelection(fakeSupabase(null, true), STUDIO, base);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/could not verify/i);
  });
});

// A Supabase whose .from() THROWS, proves the preserve path never queries
// inventory (so a later lot edit / expiry / reclassification cannot affect it).
function throwingSupabase() {
  return {
    from() {
      throw new Error("resolver must NOT query inventory on the unchanged path");
    },
  } as unknown as SupabaseClient;
}

describe("unchanged link preserves the FROZEN snapshot (#4/#7 historical immutability)", () => {
  const F2 = "sterex-stainless-steel-two-piece-f2-short";

  it("unchanged id + unchanged stored probe → preserve the frozen snapshot with NO live query at all", async () => {
    const r = await resolveProbeInventorySelection(throwingSupabase(), STUDIO, {
      ...base,
      probeKey: F3,
      probeLotConfirmed: false,
      existingProbeKey: F3, // stored block probe == incoming probe
      existingInventoryItemId: ITEM, // stored link == incoming link
      existingSnapshot: "ORIGINAL-LOT",
    });
    expect(r).toEqual({
      ok: true,
      probeInventoryItemId: ITEM,
      probeLotNumber: "ORIGINAL-LOT",
      linked: true,
    });
  });

  it("inventory RECLASSIFICATION (probe_key changed to another probe) does NOT block an unrelated edit when block probe + link are unchanged", async () => {
    // The live inventory row is now classified F2 AND its lot/expiry changed;
    // the resolver must not even look, the stored F3 link is preserved as-is.
    const r = await resolveProbeInventorySelection(throwingSupabase(), STUDIO, {
      ...base,
      probeKey: F3,
      existingProbeKey: F3,
      existingInventoryItemId: ITEM,
      existingSnapshot: "ORIGINAL-LOT",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.probeInventoryItemId).toBe(ITEM);
      expect(r.probeLotNumber).toBe("ORIGINAL-LOT");
    }
  });

  it("CHANGING the block's probe while retaining the OLD link is rejected (full validation runs against the current inventory probe)", async () => {
    // Inventory item ITEM is still classified F3; the user changes the block's
    // probe to F2 but keeps the F3 link → probe changed → full validation →
    // current inventory probe (F3) != new selected probe (F2) → rejected.
    const r = await resolveProbeInventorySelection(
      fakeSupabase({
        id: ITEM,
        studio_id: STUDIO,
        lot_number: "L",
        probe_key: F3,
        expiry_date: TOMORROW,
      }),
      STUDIO,
      {
        ...base,
        probeKey: F2, // NEW selected probe
        existingProbeKey: F3, // but the block was stored as F3
        existingInventoryItemId: ITEM,
        existingSnapshot: "OLD-SNAP",
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/different probe/i);
  });

  it("a CHANGED link (different id) invokes full CURRENT validation + derives a fresh snapshot", async () => {
    const NEW = "33333333-3333-3333-3333-333333333333";
    const r = await resolveProbeInventorySelection(
      fakeSupabase({
        id: NEW,
        studio_id: STUDIO,
        lot_number: "NEW-LOT",
        probe_key: F3,
        expiry_date: TOMORROW,
      }),
      STUDIO,
      {
        ...base,
        probeInventoryItemId: NEW,
        probeKey: F3,
        existingProbeKey: F3,
        existingInventoryItemId: ITEM, // was linked to a different item
        existingSnapshot: "ORIGINAL-LOT",
      },
    );
    expect(r).toEqual({
      ok: true,
      probeInventoryItemId: NEW,
      probeLotNumber: "NEW-LOT",
      linked: true,
    });
  });

  it("a CHANGED link to a CROSS-STUDIO / vanished item is rejected (no row), never blindly preserved", async () => {
    const NEW = "33333333-3333-3333-3333-333333333333";
    const r = await resolveProbeInventorySelection(fakeSupabase(null), STUDIO, {
      ...base,
      probeInventoryItemId: NEW,
      existingProbeKey: F3,
      existingInventoryItemId: ITEM,
      existingSnapshot: "OLD-SNAP",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/isn't in your studio/i);
  });

  it("a forged id that does NOT match the stored link is rejected (unchanged cannot be forged from the client)", async () => {
    const FORGED = "44444444-4444-4444-4444-444444444444";
    const r = await resolveProbeInventorySelection(fakeSupabase(null), STUDIO, {
      ...base,
      probeInventoryItemId: FORGED,
      existingProbeKey: F3,
      existingInventoryItemId: ITEM, // server-loaded; forged != stored → validated
      existingSnapshot: "OLD-SNAP",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/isn't in your studio/i);
  });
});

describe("expired-lot policy (#15)", () => {
  const expiredRow = {
    id: ITEM,
    studio_id: STUDIO,
    lot_number: "OLD-LOT",
    probe_key: F3,
    expiry_date: YESTERDAY,
  };
  it("an EXPIRED lot is REJECTED when not explicitly confirmed", async () => {
    const r = await resolveProbeInventorySelection(fakeSupabase(expiredRow), STUDIO, {
      ...base,
      probeLotConfirmed: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/expired/i);
  });
  it("an EXPIRED lot is ALLOWED (retrospective) only with explicit confirmation", async () => {
    const r = await resolveProbeInventorySelection(fakeSupabase(expiredRow), STUDIO, {
      ...base,
      probeLotConfirmed: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.probeLotNumber).toBe("OLD-LOT");
  });
});
