import type { StudioDevice } from "@/lib/machines/selection";
import { XCELL_PUR_PROFILE_ID } from "@/lib/machines/xcell-pur";

type Pointer = { deviceId: string | null } | null;

/**
 * What the xCell unit may do automatically, by the state of the platform rollout for a NEW setup (an existing xCell block never reaches here):
 *  - "available": the rollout is on, or was not needed. Nothing is changed.
 *  - "off": the unit may still be listed, but nothing may PRESELECT it: a remembered, suggested or last-used selection that points at it is cleared,
 *    so a new area cannot start on the unit just because an earlier area did. (A restored selection belongs to an existing block and is kept.)
 *  - "unavailable": the read failed, so nothing is known: the unit leaves the list and every selection pointing at it is cleared.
 * A stale selection would preselect the unit, and the save path does not re-check the rollout. Pure, so each selection is pinned on its own.
 */
export type RolloutState = "available" | "off" | "unavailable";

export function withholdXcellUnits<R extends Pointer, S extends Pointer, T extends Pointer, C extends Pointer>(input: {
  rollout: RolloutState;
  devices: StudioDevice[];
  remembered: R;
  suggestedMachine: S;
  restoredSelection: T;
  clientLastMachine: C;
}): { devices: StudioDevice[]; remembered: R | null; suggestedMachine: S | null; restoredSelection: T | null; clientLastMachine: C | null } {
  if (input.rollout === "available") return input;
  const units = new Set(input.devices.filter((d) => d.profileId === XCELL_PUR_PROFILE_ID).map((d) => d.deviceId));
  const keep = <V extends Pointer>(v: V): V | null => (v !== null && v.deviceId !== null && units.has(v.deviceId) ? null : v);
  const unavailable = input.rollout === "unavailable";
  return {
    devices: unavailable ? input.devices.filter((d) => !units.has(d.deviceId)) : input.devices,
    remembered: keep(input.remembered),
    suggestedMachine: keep(input.suggestedMachine),
    restoredSelection: unavailable ? keep(input.restoredSelection) : input.restoredSelection,
    clientLastMachine: keep(input.clientLastMachine),
  };
}
