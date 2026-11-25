import { currentProfile, type MachineProfile } from "./profile-contract";

/**
 * The existing charting workflow (the studio's xCell) as a CHOICE in the one
 * machine selector.
 *
 * It is not a registered unit and not a native profile: its catalogue entry is
 * blocked and stays unchanged (tests/lib/machines/xcell-unchanged-guard.test.ts).
 * Choosing it only SAVES THE MODEL on the treatment area (migration 0301) so a
 * reopened area comes back as the legacy form; every field it shows is the
 * existing one. The label is the catalogue's own, never typed here, and the
 * option is offered only where the studio has this workflow's history.
 */
export const LEGACY_MACHINE_PROFILE_ID = "dectro-apilus:xcell";

/** The option value used inside the selector. Never a unit id. */
export const LEGACY_MACHINE_OPTION_VALUE = "legacy:xcell";

export type LegacyMachineOffer = { profileId: string; label: string };

export function legacyMachineOffer(
  catalogue: readonly MachineProfile[],
): LegacyMachineOffer | null {
  const entry = currentProfile(catalogue, LEGACY_MACHINE_PROFILE_ID);
  if (!entry) return null;
  return {
    profileId: entry.profileId,
    label: [entry.manufacturer, entry.model, entry.variant]
      .filter((part): part is string => Boolean(part))
      .join(" "),
  };
}

/**
 * ONE RULE for "this treatment area was charted with a machine's OWN readings" (a native profile such as xCell Pur MultiPlex), as opposed to the
 * existing xCell workflow. The existing workflow saves its model on the block (machine_profile_id = LEGACY_MACHINE_PROFILE_ID) but keeps every
 * reading in the legacy columns, so a machine_profile_id on its own does NOT mean native. A native block is saved by the identity command with a
 * mode and a registered unit.
 *
 * Used wherever the legacy entry's columns must not be read as what was done: the area card, the entry row, the copy preview and the data export.
 */
export function isNativeMachineBlock(
  block:
    | {
        machine_profile_id?: string | null;
        machine_mode_key?: string | null;
        studio_machine_id?: string | null;
      }
    | null
    | undefined,
): boolean {
  const id = block?.machine_profile_id;
  if (typeof id !== "string" || id.length === 0) return false;
  if (id === LEGACY_MACHINE_PROFILE_ID) return false;
  return block?.machine_mode_key != null || block?.studio_machine_id != null;
}
