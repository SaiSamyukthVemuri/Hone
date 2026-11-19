import type { StudioDevice } from "@/lib/machines/selection";
import { XCELL_PUR_PROFILE_ID } from "@/lib/machines/xcell-pur";

type Pointer = { deviceId: string | null } | null;

/**
 * When the platform rollout could not be read, a registered xCell Pur unit must not be offered at all, and neither may any selection that points
 * at one: a stale remembered, suggested, restored or last-used selection would preselect the unit, and the save path does not re-check the rollout.
 * A pure function of its inputs so each selection is pinned on its own. With `withhold` false everything passes through untouched.
 */
export function withholdXcellUnits<R extends Pointer, S extends Pointer, T extends Pointer, C extends Pointer>(input: {
  withhold: boolean;
  devices: StudioDevice[];
  remembered: R;
  suggestedMachine: S;
  restoredSelection: T;
  clientLastMachine: C;
}): { devices: StudioDevice[]; remembered: R | null; suggestedMachine: S | null; restoredSelection: T | null; clientLastMachine: C | null } {
  if (!input.withhold) return input;
  const withheld = new Set(input.devices.filter((d) => d.profileId === XCELL_PUR_PROFILE_ID).map((d) => d.deviceId));
  const keep = <V extends Pointer>(v: V): V | null => (v !== null && v.deviceId !== null && withheld.has(v.deviceId) ? null : v);
  return {
    devices: input.devices.filter((d) => !withheld.has(d.deviceId)),
    remembered: keep(input.remembered),
    suggestedMachine: keep(input.suggestedMachine),
    restoredSelection: keep(input.restoredSelection),
    clientLastMachine: keep(input.clientLastMachine),
  };
}
