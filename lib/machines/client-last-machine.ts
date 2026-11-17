import { currentProfile, type MachineProfile } from "./profile-contract";
import { selectableDevices, type SelectionScope, type StudioDevice } from "./selection";

export type ClientLastMachineRow = { profileId: string | null; deviceId: string | null; modeKey: string | null };
export type ClientLastMachineChoice = { deviceId: string | null; modeKey: string | null; legacy: boolean };

/**
 * THIS CLIENT's last machine, checked like any other choice before it is offered
 * (Photos R2; Privacy EL-2b). A unit the picker would refuse is dropped; a mode
 * that is not one of that unit's ACTIVE modes becomes null, which the panel
 * resolves to the unit's first active mode, exactly as for the remembered
 * preference. The existing workflow is offered only when that is the model.
 */
export function validateClientLastMachine(input: {
  last: ClientLastMachineRow | null;
  scope: SelectionScope;
  devices: readonly StudioDevice[];
  catalogue: readonly MachineProfile[];
  legacyProfileId: string | null;
}): ClientLastMachineChoice | null {
  const { last } = input;
  if (!last) return null;
  if (last.deviceId) {
    const hit = selectableDevices(input.scope, input.devices, input.catalogue).find(
      (s) => s.device.deviceId === last.deviceId,
    );
    if (!hit) return null;
    const profile = currentProfile(input.catalogue, hit.device.profileId);
    const active = profile?.modes.some((m) => m.availability === "active" && m.key === last.modeKey) ?? false;
    return { deviceId: last.deviceId, modeKey: active ? last.modeKey : null, legacy: false };
  }
  if (input.legacyProfileId && last.profileId === input.legacyProfileId) {
    return { deviceId: null, modeKey: null, legacy: true };
  }
  return null;
}
