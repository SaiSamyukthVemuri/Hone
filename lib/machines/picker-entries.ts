import { XCELL_PUR_PROFILE_ID } from "./xcell-pur";

/**
 * THE UNITS THE MACHINE PICKER LISTS, one rule for the picker and for the one-choice preselect, so the preselect counts exactly what the
 * picker renders.
 *
 * ONE xCell CHOICE: when the existing xCell is offered, a registered xCell Pur unit is never listed as a second xCell, even before a route
 * exists. The one exception keeps a unit that is already this area's chosen identity visible when no route is active.
 */
export function pickerUnits<T extends { device: { deviceId: string; profileId: string } }>(
  selectable: readonly T[],
  o: { legacyOffered: boolean; xcellRouted: boolean; currentDeviceId: string | null },
): T[] {
  return selectable.filter(
    ({ device }) => !(o.legacyOffered && device.profileId === XCELL_PUR_PROFILE_ID && (o.xcellRouted || device.deviceId !== o.currentDeviceId)),
  );
}
