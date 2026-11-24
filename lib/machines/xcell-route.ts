import { currentProfile, type MachineProfile } from "./profile-contract";
import { XCELL_PUR_PROFILE_ID } from "./xcell-pur";
import type { StudioDevice } from "./selection";
import type { XcellModelSwitch } from "./xcell-switch-seam";

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
 * The unit is registered by the studio OWNER in Settings > Machines (the existing owner command, once the contract is published; the model is
 * shown there as 'Dectro xCell' and a second one is refused), never by the practitioner.
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

/** Shown when every xCell unit the studio ever had is retired. A retired unit is never recreated by a save. */
export const XCELL_MULTIPLEX_RETIRED_MESSAGE = "The studio's xCell has been retired, so MultiPlex cannot be used. Ask the studio owner to add the xCell again in Settings.";

/**
 * MULTIPLEX FOLLOWS THE OWNER'S SWITCH (a product decision). The studio's old xCell history is not an input: the owner enabling the
 * model is. This decides only what the picker and the save should do; the unit record itself is created by the database command, once, inside
 * the first successful MultiPlex save.
 *  - not enabled, or the layout is not published (or its read failed), or the profile or mode is not active: not offered (null);
 *  - a live unit of this model and version exists: use it (the client's last-used live unit, else the lowest id);
 *  - no unit was ever registered: offered, and the unit is created at the first save;
 *  - units exist but every one is retired: refused. A retired unit is never silently recreated.
 */
export type XcellMultiplexSwitchRoute =
  | { kind: "use-unit"; deviceId: string; modeKey: "multiplex" }
  | { kind: "create-at-first-save"; modeKey: "multiplex" }
  | { kind: "refused"; reason: "retired" };

export function xcellMultiplexSwitchRoute(input: {
  modelEnabled: boolean;
  catalogue: readonly MachineProfile[];
  devices: readonly StudioDevice[];
  /** Mode keys published for the profile's CURRENT version, or null when the read failed (then nothing is offered). */
  publishedModes: readonly string[] | null;
  /** The client's last-used unit id, or null. Honoured only when it is a live unit of this model. */
  clientLastUnitId: string | null;
}): XcellMultiplexSwitchRoute | null {
  if (!input.modelEnabled || input.publishedModes === null) return null;
  const profile = currentProfile(input.catalogue, XCELL_PUR_PROFILE_ID);
  if (!profile || profile.availability !== "active") return null;
  if (!profile.modes.some((m) => m.key === XCELL_MULTIPLEX_MODE_KEY && m.availability === "active")) return null;
  if (!input.publishedModes.includes(XCELL_MULTIPLEX_MODE_KEY)) return null;
  const ofModel = input.devices.filter((d) => d.profileId === profile.profileId && d.profileVersion === profile.version);
  const live = ofModel.filter((d) => d.retiredAt === null).sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  if (live.length > 0) {
    const last = input.clientLastUnitId ? live.find((d) => d.deviceId === input.clientLastUnitId) : undefined;
    return { kind: "use-unit", deviceId: (last ?? live[0]).deviceId, modeKey: XCELL_MULTIPLEX_MODE_KEY };
  }
  if (ofModel.length > 0) return { kind: "refused", reason: "retired" };
  return { kind: "create-at-first-save", modeKey: XCELL_MULTIPLEX_MODE_KEY };
}

export type XcellMultiplexOffer = {
  /** The unit to route MultiPlex through, or null. */
  route: XcellMultiplexRoute | null;
  /** The switch is on and the studio has never had a unit: the database command will create it at the first successful MultiPlex save. App code creates nothing. */
  createAtFirstSave: boolean;
  /** Set when every unit is retired: shown to the practitioner. */
  refusal: string | null;
};

/**
 * THE PICKER'S ONE DECISION. While the owner's switch is unavailable the answer is exactly the old history route (no behaviour change). Once
 * it is available the switch decides and old history is not read.
 */
export function resolveXcellMultiplexOffer(input: {
  switchState: XcellModelSwitch;
  legacyOffered: boolean;
  catalogue: readonly MachineProfile[];
  devices: readonly StudioDevice[];
  publishedModes: readonly string[] | null;
  clientLastUnitId: string | null;
}): XcellMultiplexOffer {
  if (!input.switchState.available) {
    const route = xcellMultiplexRoute({ legacyOffered: input.legacyOffered, catalogue: input.catalogue, devices: input.devices, publishedModes: input.publishedModes });
    return { route, createAtFirstSave: false, refusal: null };
  }
  if (!input.switchState.enabled) return { route: null, createAtFirstSave: false, refusal: null };
  const r = xcellMultiplexSwitchRoute({
    modelEnabled: true,
    catalogue: input.catalogue,
    devices: input.devices,
    publishedModes: input.publishedModes,
    clientLastUnitId: input.clientLastUnitId,
  });
  if (r === null) return { route: null, createAtFirstSave: false, refusal: null };
  if (r.kind === "use-unit") return { route: { deviceId: r.deviceId, modeKey: r.modeKey }, createAtFirstSave: false, refusal: null };
  if (r.kind === "refused") return { route: null, createAtFirstSave: false, refusal: XCELL_MULTIPLEX_RETIRED_MESSAGE };
  return { route: null, createAtFirstSave: true, refusal: null };
}
