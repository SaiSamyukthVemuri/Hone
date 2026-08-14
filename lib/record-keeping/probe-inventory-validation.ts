import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isUuid } from "@/lib/sessions/probe-lot-validation";

// Server-side resolution of a charted probe-lot selection into the two durable
// values written to session_blocks: the inventory link (probe_inventory_item_id)
// and the lot-number SNAPSHOT (probe_lot_number). Migration 0155.
//
// SECURITY: a client-supplied probe_inventory_item_id is NEVER trusted. When a
// link is being ESTABLISHED or CHANGED, it must be a well-formed UUID that
// (a) exists, (b) belongs to the caller's OWN studio (RLS-scoped query: a
// cross-studio id returns no row), (c) has a nonblank lot number, (d) is
// classified for the NEWLY-selected probe, and (e) satisfies the expired-lot
// policy. The lot-number snapshot is DERIVED FROM THE DATABASE ROW: client
// text is never trusted for the linked path. On any failure we return an error
// and write nothing (never fall back to client text).
//
// HISTORICAL IMMUTABILITY: when the link is UNCHANGED: the incoming inventory
// id AND the incoming selected probe both equal what the block ALREADY stored
// (values loaded server-side from the block row, never claimed by the client),
// the frozen snapshot is preserved with NO live re-validation. The link was
// validated when first written and is still protected by the same-studio FK, so
// a later inventory lot-number edit, expiry change, or probe RECLASSIFICATION
// must never block an unrelated edit to a historical record (contract #4/#7).
//
// The dormant probe_lots table and electrolysis_entries.probe_lot_id are not
// touched. Manual path: probe_inventory_item_id is NULL; the trimmed free-text
// lot number is the snapshot; it is clearly manual/unlinked.

export type ProbeInventoryResolution =
  | {
      ok: true;
      // The durable inventory link (null = manual/unlinked).
      probeInventoryItemId: string | null;
      // The lot-number snapshot to store (DB-derived for linked, trimmed text
      // for manual, or null).
      probeLotNumber: string | null;
      // Whether this resolution is inventory-linked (for callers that branch UI).
      linked: boolean;
    }
  | { ok: false; error: string };

export type ProbeInventoryInput = {
  probeInventoryItemId: string | null;
  // The resolved structured probe_key for this block (from resolveStructuredProbe).
  probeKey: string | null;
  // The client's free-text lot number (used ONLY on the manual path).
  manualLotNumber: string | null;
  // The practitioner's explicit "package is correct" confirmation. An EXPIRED
  // inventory lot may only be linked when explicitly confirmed (truthful
  // retrospective charting), never auto-filled.
  probeLotConfirmed: boolean;
  // EDIT ONLY: the block's currently-STORED probe classification + inventory
  // link + snapshot, read server-side (never from the client). "Unchanged" is
  // derived ONLY from these values: when the incoming inventory id AND the
  // incoming selected probe_key both equal what the block already stored, the
  // frozen snapshot is PRESERVED and NO live re-validation runs (lot / expiry /
  // CURRENT inventory probe classification are not re-checked), so a later
  // inventory edit or reclassification cannot block an unrelated historical
  // edit (contract #4/#7). If EITHER the probe or the id changed, full current
  // validation runs. Omit all three on create.
  existingProbeKey?: string | null;
  existingInventoryItemId?: string | null;
  existingSnapshot?: string | null;
};

const LOT_MAX = 120;

export async function resolveProbeInventorySelection(
  supabase: SupabaseClient,
  studioId: string,
  input: ProbeInventoryInput,
): Promise<ProbeInventoryResolution> {
  const rawId = (input.probeInventoryItemId ?? "").trim();

  // ---- Manual path (no inventory link) -----------------------------------
  if (!rawId) {
    const manual = (input.manualLotNumber ?? "").trim().slice(0, LOT_MAX) || null;
    return {
      ok: true,
      probeInventoryItemId: null,
      probeLotNumber: manual,
      linked: false,
    };
  }

  // ---- Inventory-linked path ---------------------------------------------
  if (!isUuid(rawId)) {
    return { ok: false, error: "That inventory lot reference is invalid." };
  }

  const chosenProbe = (input.probeKey ?? "").trim();
  if (!chosenProbe) {
    return {
      ok: false,
      error: "Choose a probe before linking an inventory lot.",
    };
  }

  // ---- UNCHANGED historical link -----------------------------------------
  // Derived ONLY from the server-loaded block: the incoming inventory id AND the
  // incoming selected probe both equal what the block already stored. Preserve
  // the frozen snapshot with NO live re-validation, the link was validated when
  // first written and is still protected by the same-studio FK, so a later
  // inventory lot-number edit, expiry change, or probe RECLASSIFICATION must not
  // block an unrelated edit to this historical record. A client can never forge
  // "unchanged": existing* come from the server-loaded block row. Contract #4/#7.
  const existingId = (input.existingInventoryItemId ?? "").trim();
  const existingProbe = (input.existingProbeKey ?? "").trim();
  if (
    existingId &&
    rawId === existingId &&
    existingProbe &&
    chosenProbe === existingProbe
  ) {
    return {
      ok: true,
      probeInventoryItemId: rawId,
      probeLotNumber: (input.existingSnapshot ?? "").trim() || null,
      linked: true,
    };
  }

  // ---- Establishing OR changing a link: full CURRENT validation ----------
  // Reached when the inventory id changed OR the block's probe changed (or on
  // create). Verify the item exists, is in THIS studio, is classified for the
  // NEWLY-selected probe, has a nonblank lot, and satisfies the expired policy;
  // then derive a FRESH snapshot from the DB row (client text is never trusted).
  const { data, error } = await supabase
    .from("record_keeping_sterile_items")
    .select("id, studio_id, lot_number, probe_key, expiry_date")
    .eq("id", rawId)
    .eq("studio_id", studioId)
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      error: "Could not verify that inventory lot. Please try again.",
    };
  }
  // No row => nonexistent OR a cross-studio id hidden by RLS. Either way reject;
  // never fall back to the client's text.
  if (!data) {
    return {
      ok: false,
      error: "That inventory lot isn't in your studio's inventory.",
    };
  }
  const itemProbe = ((data.probe_key as string | null) ?? "").trim();
  if (itemProbe !== chosenProbe) {
    return {
      ok: false,
      error: "That inventory lot is recorded for a different probe.",
    };
  }

  const lot = ((data.lot_number as string | null) ?? "").trim();
  if (!lot) {
    return { ok: false, error: "That inventory item has no lot number." };
  }

  const expiry = (data.expiry_date as string | null) ?? null;
  const todayIso = new Date().toISOString().slice(0, 10);
  const isExpired = expiry != null && expiry < todayIso;
  // Expired inventory is never auto-filled; it may only be LINKED when the
  // practitioner explicitly confirms the package (retrospective charting).
  if (isExpired && !input.probeLotConfirmed) {
    return {
      ok: false,
      error:
        "That inventory lot is expired. Confirm the package to record it for a past treatment, or choose an active lot.",
    };
  }

  // Snapshot is DERIVED from the DB row: client text is never trusted here.
  return {
    ok: true,
    probeInventoryItemId: rawId,
    probeLotNumber: lot,
    linked: true,
  };
}
