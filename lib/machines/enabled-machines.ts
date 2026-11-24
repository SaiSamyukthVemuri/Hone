import type { StudioDevice } from "@/lib/machines/selection";
import { STUDIO_MACHINE_MODELS, type StudioMachineChoices } from "@/lib/machines/studio-machine-settings";
import { XCELL_PUR_PROFILE_ID } from "@/lib/machines/xcell-pur";

const SWITCHABLE: ReadonlySet<string> = new Set(STUDIO_MACHINE_MODELS.map((m) => m.profileId));
type Pointer = { deviceId: string | null } | null;

/** The default machine a NEW area opens on: a unit, or the studio's existing xCell choice (the legacy entry, which MultiPlex rides on). */
export type DefaultMachine = { kind: "native"; deviceId: string } | { kind: "legacy" } | null;

/**
 * THE OWNER'S SWITCHES APPLIED TO A NEW AREA'S PICKER.
 *
 * Only a NEW area (no block yet) is affected: an existing block keeps every machine it was charted with, so it reopens exactly as it was.
 * With the switches in force (`choices` not null):
 *   - a model that is OFF leaves the list: its units are not offered, and the existing xCell entry is not offered when xCell is off;
 *   - a remembered, suggested or client-last pointer at such a unit is cleared, so a new area cannot start on a machine the owner switched off;
 *   - the studio's default, when it is ON, is returned as the lowest-priority preselect (client-last and remembered still win).
 * Without them (`choices` null, or an existing block) nothing changes. Pure, so each rule is pinned on its own.
 */
export function applyEnabledMachines<R extends Pointer, S extends Pointer, C extends Pointer>(input: {
  choices: StudioMachineChoices | null;
  creating: boolean;
  devices: StudioDevice[];
  legacyOffered: boolean;
  remembered: R;
  suggestedMachine: S;
  clientLastMachine: C;
}): { devices: StudioDevice[]; legacyOffered: boolean; remembered: R | null; suggestedMachine: S | null; clientLastMachine: C | null; defaultMachine: DefaultMachine } {
  const { choices } = input;
  if (!choices || !input.creating) {
    return { devices: input.devices, legacyOffered: input.legacyOffered, remembered: input.remembered, suggestedMachine: input.suggestedMachine, clientLastMachine: input.clientLastMachine, defaultMachine: null };
  }
  // Only the three switchable models are filtered; a unit of any other profile is never touched. The xCell model covers the studio's existing
  // xCell choice AND its xCell Pur units: one model, one switch.
  const off = new Set(input.devices.filter((d) => SWITCHABLE.has(d.profileId) && !choices.enabled.has(d.profileId)).map((d) => d.deviceId));
  const devices = input.devices.filter((d) => !off.has(d.deviceId));
  const xcellOn = choices.enabled.has(XCELL_PUR_PROFILE_ID);
  const legacyOffered = input.legacyOffered && xcellOn;
  const clear = <V extends Pointer>(v: V): V | null => (v !== null && v.deviceId !== null && off.has(v.deviceId) ? null : v);
  let defaultMachine: DefaultMachine = null;
  const def = choices.defaultProfileId;
  if (def && choices.enabled.has(def)) {
    if (def === XCELL_PUR_PROFILE_ID) {
      if (legacyOffered) defaultMachine = { kind: "legacy" };
    } else {
      const unit = devices.filter((d) => d.profileId === def && d.retiredAt === null).sort((a, b) => a.deviceId.localeCompare(b.deviceId))[0];
      if (unit) defaultMachine = { kind: "native", deviceId: unit.deviceId };
    }
  }
  return { devices, legacyOffered, remembered: clear(input.remembered), suggestedMachine: clear(input.suggestedMachine), clientLastMachine: clear(input.clientLastMachine), defaultMachine };
}
