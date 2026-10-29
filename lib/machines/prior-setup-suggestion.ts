/**
 * NEXT-VISIT CONTINUITY, MACHINE-FIRST. With no machine remembered for this
 * practitioner, the client's last recorded setup may OFFER the unit it was
 * recorded on.
 *
 * AN OFFER, NEVER A SELECTION. The recorded unit is history; today's unit is
 * the practitioner's choice, and a selection also writes the sticky default.
 * The panel shows this beside the picker and she accepts it explicitly.
 *
 * NO GUESSING: a prior capture spanning more than one unit, an unknown unit, a
 * retired one or one from another studio offers nothing. The usability rule is
 * `selectableDevices`' own, so an offer can never name a unit the picker would
 * refuse.
 *
 * NO MIGRATION: the input is the `deviceId` every recorded reading carries.
 */

import { MACHINE_CATALOGUE } from "./catalogue";
import {
  selectableDevices,
  type SelectionScope,
  type StudioDevice,
} from "./selection";
import type { MachineProfile } from "./profile-contract";

export type SuggestedMachine = { deviceId: string; displayName: string };

export function suggestMachineFromPriorSetup(input: {
  scope: SelectionScope;
  /** "none" is the only state that may be offered anything. */
  remembered: "none" | "selected" | "unavailable" | "not-verified";
  /** The device id of every reading in the client's last recorded setup. */
  priorDeviceIds: readonly string[];
  devices: readonly StudioDevice[];
  catalogue?: readonly MachineProfile[];
}): SuggestedMachine | null {
  if (input.remembered !== "none") return null;
  const distinct = [...new Set(input.priorDeviceIds)];
  if (distinct.length !== 1) return null;
  const hit = selectableDevices(
    input.scope,
    input.devices,
    input.catalogue ?? MACHINE_CATALOGUE,
  ).find((s) => s.device.deviceId === distinct[0]);
  return hit
    ? { deviceId: hit.device.deviceId, displayName: hit.device.displayName }
    : null;
}
