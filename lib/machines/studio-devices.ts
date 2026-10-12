import { listStudioMachines, type MachineDb } from "./machine-queries";
import type { StudioDevice } from "./selection";

/**
 * MPX-03 — the studio's physical machine inventory.
 *
 * NOW A REAL READ. Migration 0223 created `public.studio_machines`, so this
 * queries it. Before 0223 this module returned an empty list and said the table
 * did not exist; that branch is gone, and `InventorySource` keeps the
 * distinction that still matters.
 *
 * WHY THE SOURCE STILL MATTERS. "No machines" has two very different causes and
 * a picker must not present them identically:
 *
 *   `empty-for-studio` — the read succeeded and this studio has registered
 *                        nothing. The answer is "add your first machine".
 *   `unreadable`       — the read itself failed. The answer is NOT "add a
 *                        machine", because one may well already exist; showing
 *                        an empty picker here would invite a duplicate.
 *
 * CATALOGUE IDENTITY AND DEVICE IDENTITY STAY SEPARATE. A row carries the
 * profile it IS (`machine_profile_id` + version) apart from what the studio
 * calls it and what is physically fitted, because two rooms can hold the same
 * model and options belong to the unit.
 *
 * NO AUTHORIZATION HAPPENS HERE. The studio id is a filter; RLS scopes the read
 * to studios the caller is a member of, and every WRITE goes through an
 * owner-gated command. Passing a studio id is not a claim about the caller.
 */

export type InventorySource =
  /** Read succeeded; this studio has registered no machine. */
  | "empty-for-studio"
  /** The read failed. Emptiness here means nothing about the studio. */
  | "unreadable";

export type StudioInventory = {
  devices: StudioDevice[];
  source: InventorySource | "ok";
  /** Practitioner-facing sentence when there is nothing to show. */
  reason: string | null;
};

/**
 * What the storage slice needed before it existed. Kept because the column
 * list is still the contract a reviewer checks the table against, and because
 * it deliberately encodes NO migration number - 0223 is recorded in the
 * migration itself and in the reservation file, not here.
 */
export const INVENTORY_SOURCE = {
  table: "public.studio_machines",
  columns: [
    "id",
    "studio_id",
    "machine_profile_id",
    "machine_profile_version",
    "display_name",
    "installed_options",
    "retired_at",
  ],
  note:
    "One row per physical unit, studio-scoped, owner-only write and member " +
    "read. Created by the machine-inventory migration; the number lives in " +
    "that file and in its reservation, never here.",
} as const;

/** The studio's live machines. Retired units are excluded by the query. */
export async function listStudioDevices(
  db: MachineDb,
  studioId: string,
): Promise<StudioInventory> {
  const result = await listStudioMachines(db, studioId);

  if (!result.ok) {
    return {
      devices: [],
      source: "unreadable",
      reason:
        "Your machines could not be read just now, so none can be offered. " +
        "This is not the same as having none registered - do not add a " +
        "duplicate until the list loads.",
    };
  }

  if (result.value.length === 0) {
    return {
      devices: [],
      source: "empty-for-studio",
      reason: "This studio has no machine registered yet.",
    };
  }

  return { devices: result.value, source: "ok", reason: null };
}

/** True when emptiness says nothing about the studio, because the read failed. */
export function inventoryUnavailable(inv: StudioInventory): boolean {
  return inv.source === "unreadable";
}
