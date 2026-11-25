import { currentProfile, type MachineProfile } from "./profile-contract";
import { XCELL_PUR_PROFILE_ID } from "./xcell-pur";
import type { StudioDevice } from "./selection";
import { unspecifiedDeviceFor } from "./unspecified-machine";

/**
 * MULTIPLEX ON THE EXISTING CHART FOR EVERY STUDIO (HON-71, widened by HON-119).
 *
 * MultiPlex sits beside Thermolysis, Blend and Galvanic from the first visit. It routes the NEW area through the native path (the xCell
 * Pur contract, mode `multiplex`), because the legacy columns cannot hold it (integer seconds, one thermolysis pair).
 *
 * The route exists when ALL of these hold:
 *   * the xCell Pur profile is active in the catalogue and offers `multiplex`;
 *   * its contract row is PUBLISHED for that exact version and mode (the database validates against it).
 * That is the whole offer: no registered machine, no legacy xCell history and no platform rollout is required, and `charting_new_view_xcell`
 * is NOT consulted (that rollout stays the Twin's, for the registered-xCell picker offer and the New View toggle). Flipping the mode's
 * availability off in the catalogue is the stop: the pill disappears and nothing new saves, while every saved reading still renders.
 *
 * THE UNIT. The machine stays UNSPECIFIED unless the person selected one:
 *   * a studio that is offered the existing xCell choice AND has a usable registered unit (and whose rollout allows it) keeps today's route:
 *     MultiPlex under that choice binds the registered unit (#1790);
 *   * every other case routes to the inert placeholder, `unspecified: true`. Its id is the real row when it exists, otherwise the sentinel
 *     that the save turns into the real row.
 */
export type XcellMultiplexRoute = { deviceId: string; modeKey: "multiplex"; unspecified: boolean };

export const XCELL_MULTIPLEX_MODE_KEY = "multiplex" as const;

export function xcellMultiplexRoute(input: {
  /** The studio is offered the existing xCell choice (its own history). Only then may MultiPlex bind its registered unit. */
  legacyOffered: boolean;
  /** The platform rollout lets a registered xCell unit be used. When false, a registered unit is never the route (the placeholder is). */
  registeredUnitAllowed: boolean;
  catalogue: readonly MachineProfile[];
  devices: readonly StudioDevice[];
  /** The studio's placeholder rows (any version), or [] when none exists yet. */
  unspecifiedUnits: readonly StudioDevice[];
  studioId: string;
  /** The unit an EXISTING area already stores, so a saved MultiPlex area keeps recognising its own placeholder whatever else the studio has. */
  savedUnitId?: string | null;
  /** Mode keys published for the profile's CURRENT version, or null when the read failed (then no route). */
  publishedModes: readonly string[] | null;
}): XcellMultiplexRoute | null {
  if (input.publishedModes === null) return null;
  const profile = currentProfile(input.catalogue, XCELL_PUR_PROFILE_ID);
  if (!profile || profile.availability !== "active") return null;
  // Each check stands on its own (a profile that is not active offers nothing, whatever its modes say): the mode is read directly.
  if (!profile.modes.some((m) => m.key === XCELL_MULTIPLEX_MODE_KEY && m.availability === "active")) return null;
  if (!input.publishedModes.includes(XCELL_MULTIPLEX_MODE_KEY)) return null;
  const saved = input.savedUnitId ? input.unspecifiedUnits.find((u) => u.deviceId === input.savedUnitId && u.profileVersion === profile.version) : undefined;
  if (saved) return { deviceId: saved.deviceId, modeKey: XCELL_MULTIPLEX_MODE_KEY, unspecified: true };
  if (input.legacyOffered && input.registeredUnitAllowed) {
    const unit = input.devices
      .filter((d) => d.isUnspecified !== true && d.profileId === profile.profileId && d.profileVersion === profile.version && d.retiredAt === null)
      .sort((a, b) => a.deviceId.localeCompare(b.deviceId))[0];
    if (unit) return { deviceId: unit.deviceId, modeKey: XCELL_MULTIPLEX_MODE_KEY, unspecified: false };
  }
  const placeholder = unspecifiedDeviceFor(input.studioId, profile.version, input.unspecifiedUnits);
  return { deviceId: placeholder.deviceId, modeKey: XCELL_MULTIPLEX_MODE_KEY, unspecified: true };
}
