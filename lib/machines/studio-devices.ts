/**
 * MPX-03 — the studio's physical machine inventory.
 *
 * WHAT IS ACTUALLY HERE TODAY. Nothing to read. A census of the schema at
 * production `6c5eac80` finds NO device, machine or equipment table: the only
 * machine-shaped columns in the whole database are
 * `practitioners.default_machine_frequency` (0084, a sticky UI default),
 * `session_blocks.machine_frequency` / the entry mirror, and
 * `laser_entries.method_or_machine` (free text). None of them identifies a
 * model, so none can seed a verified inventory.
 *
 * So this module does not query anything and does not pretend to. It returns an
 * empty inventory with a reason, and `INVENTORY_SOURCE` names what has to exist
 * before that changes. The alternative - querying a table that is not there -
 * would turn a known gap into a runtime error on a charting page.
 *
 * WHY IT IS STILL WORTH WRITING NOW. The panel, the selection resolver and the
 * server action all consume this shape, so having it settled means the drop-in
 * when the table lands is mechanical: implement `listStudioDevices` against the
 * real rows and delete the explanation. Nothing above it changes.
 *
 * CATALOGUE IDENTITY AND DEVICE IDENTITY STAY SEPARATE. A studio names its own
 * units ("Room 2 xCell"), two rooms can hold the same model, and installed
 * options belong to the unit rather than to the model. That is why a device
 * carries `profileId` plus `profileVersion` rather than being a profile.
 */

import type { StudioDevice } from "./selection";

/** Why an inventory read returned nothing. */
export type InventorySource =
  /** The table exists and this studio has registered no machine. */
  | "empty-for-studio"
  /** There is no inventory table yet. The current state. */
  | "no-inventory-table";

export type StudioInventory = {
  devices: StudioDevice[];
  source: InventorySource;
  /** Practitioner-facing sentence. Shown rather than swallowed. */
  reason: string;
};

/**
 * What has to exist before an inventory can be read. Written down so the next
 * slice does not have to re-derive it, and so nothing here silently assumes a
 * number: a fresh census on 2026-10-12 found 0211-0222 all claimed across open
 * PRs and worktrees (0219 went to G1 for public practitioner selection), so the
 * first free number was 0223 AT THAT MOMENT and must be re-censused before
 * anyone authors against it.
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
    "One row per physical unit, studio-scoped, with owner-only write and " +
    "member read. Needs its own migration; the number must come from a fresh " +
    "census, never from this constant.",
} as const;

const NO_TABLE_REASON =
  "No machine inventory exists in the database yet, so no studio has a " +
  "registered machine to choose.";

/**
 * The studio's registered machines.
 *
 * Takes the studio id rather than deriving it, because the only caller that
 * may decide which studio this is is the server action that authenticated the
 * request. Nothing here trusts the value for authorization - it is a filter,
 * and the authorization happened before the call.
 */
export async function listStudioDevices(
  studioId: string,
): Promise<StudioInventory> {
  // The parameter is kept because it is the filter the real query needs, and
  // changing the signature later would churn every caller. Referenced here so
  // the shape is honest rather than decorative.
  void studioId;
  return { devices: [], source: "no-inventory-table", reason: NO_TABLE_REASON };
}

/** True when the emptiness is a missing capability rather than a bare studio. */
export function inventoryUnavailable(inv: StudioInventory): boolean {
  return inv.source === "no-inventory-table";
}
