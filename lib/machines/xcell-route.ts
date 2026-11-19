import { currentProfile, type MachineProfile } from "./profile-contract";
import { XCELL_PUR_PROFILE_ID } from "./xcell-pur";
import type { StudioDevice } from "./selection";

/**
 * ONE xCell CHOICE, TWO WAYS TO STORE IT (HON-71).
 *
 * The studio keeps its existing xCell charting exactly as it is (the legacy choice, no unit, no mode). MultiPlex is added ALONGSIDE it
 * as a mode of that same xCell choice: picking it routes the NEW area through the existing native path (a registered unit of the xCell
 * Pur contract, mode `multiplex`), because the old columns cannot hold it (integer seconds, one thermolysis pair).
 *
 * The route exists only when ALL of these hold, so nothing changes for the studio until MultiPlex can really be saved:
 *   * the existing xCell choice is offered (the studio has that workflow's history);
 *   * the xCell Pur profile is active in the catalogue and offers `multiplex`;
 *   * its contract row is PUBLISHED for that exact version and mode (the database validates against it);
 *   * the studio has a usable (not retired) unit of that profile.
 * The unit is created by the owner's reviewed publication step, never by the practitioner.
 */
export type XcellMultiplexRoute = { deviceId: string; modeKey: "multiplex" };

export const XCELL_MULTIPLEX_MODE_KEY = "multiplex" as const;

export function xcellMultiplexRoute(input: {
  legacyOffered: boolean;
  catalogue: readonly MachineProfile[];
  devices: readonly StudioDevice[];
  /** Mode keys published for the profile's CURRENT version, or null when the read failed (then no route). */
  publishedModes: readonly string[] | null;
}): XcellMultiplexRoute | null {
  if (!input.legacyOffered || input.publishedModes === null) return null;
  const profile = currentProfile(input.catalogue, XCELL_PUR_PROFILE_ID);
  if (!profile || profile.availability !== "active") return null;
  // Each check stands on its own (a profile that is not active offers nothing, whatever its modes say): the mode is read directly.
  if (!profile.modes.some((m) => m.key === XCELL_MULTIPLEX_MODE_KEY && m.availability === "active")) return null;
  if (!input.publishedModes.includes(XCELL_MULTIPLEX_MODE_KEY)) return null;
  const unit = input.devices
    .filter((d) => d.profileId === profile.profileId && d.profileVersion === profile.version && d.retiredAt === null)
    .sort((a, b) => a.deviceId.localeCompare(b.deviceId))[0];
  return unit ? { deviceId: unit.deviceId, modeKey: XCELL_MULTIPLEX_MODE_KEY } : null;
}
