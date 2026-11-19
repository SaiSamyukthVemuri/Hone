import { pickerUnits } from "./picker-entries";
import type { MachineProfile } from "./profile-contract";
import type { StudioDevice } from "./selection";

/**
 * THE ONE-CHOICE PRESELECT (New view only). When the machine picker would offer exactly ONE entry, that entry is already the answer, so the
 * form opens on it instead of asking the practitioner to pick the only thing they can pick.
 *
 * It counts the entries the picker ACTUALLY lists, by the same rules the picker applies:
 *   - a unit is listed only if it is live (not retired) and on an active profile at its published contract version (`selectable`, from
 *     `selectableDevices`), so a retired unit or an unpublished model is never counted;
 *   - the existing xCell is one more entry when the studio is offered it (`legacyOffered`);
 *   - when that existing xCell entry is offered, a registered xCell Pur unit is NOT listed as a second xCell (one xCell choice), so it
 *     counts once, as the existing entry.
 * Zero entries, or two or more, preselect nothing. This is a pure DISPLAY default: it selects, it saves nothing; the choice is recorded
 * only when the practitioner saves the block, exactly like a remembered machine.
 */
export type Preselect = { kind: "native"; deviceId: string } | { kind: "legacy" } | null;

export function preselectOnlyChoice(
  selectable: ReadonlyArray<{ device: Pick<StudioDevice, "deviceId" | "profileId">; profile: Pick<MachineProfile, "profileId"> }>,
  legacyOffered: boolean,
  xcellRouted = false,
): Preselect {
  // Nothing is chosen yet, so no unit is "already this area's identity": exactly the units the picker lists for an empty selection.
  const natives = pickerUnits(selectable, { legacyOffered, xcellRouted, currentDeviceId: null });
  const total = natives.length + (legacyOffered ? 1 : 0);
  if (total !== 1) return null;
  if (legacyOffered) return { kind: "legacy" };
  return { kind: "native", deviceId: natives[0].device.deviceId };
}
