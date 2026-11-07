import { LEGACY_MACHINE_PROFILE_ID } from "@/lib/machines/legacy-machine";
import type { MachineDb } from "@/lib/machines/machine-queries";
import { catalogueForRuntime } from "@/lib/machines/synthetic-profile";
import { checkDeviceChoice, type SelectionScope } from "@/lib/machines/selection";
import { listStudioDevices } from "@/lib/machines/studio-devices";

export const MACHINE_MODE_NOT_OFFERED =
  "That machine does not offer that mode. Choose the machine and mode again. Nothing was saved.";

/** Clear copy for a refused unit/mode pair. Only refusals that name nothing but the unit's own name pass their message through. */
export function machineChoiceRefusal(code: string, message: string): string {
  if (code === "mode_requires_installed_option" || code === "device_retired" || code === "profile_not_offered") {
    return `${message} Nothing was saved.`;
  }
  if (code === "unknown_mode") return MACHINE_MODE_NOT_OFFERED;
  return "That machine could not be used for this area. Choose it again. Nothing was saved.";
}

export type IdentityChoice = { deviceId: string | null; modeKey: string | null; profileId: string | null };
export type IdentityCheck = { ok: true } | { ok: false; error: string };

/**
 * A MACHINE IDENTITY BEING SAVED ON A TREATMENT AREA MUST PASS THE CONTRACT A REMEMBERED CHOICE PASSES (Codex, #1369 4498767101).
 *
 * The database commands only check that the unit is the studio's and not retired (and that a given model matches the unit's), so
 * a stale panel or a crafted request could store a mode the model does not offer, or one that needs an option the unit lacks, and
 * the panel would then show a different mode than the record holds. Run this BEFORE any write: when it refuses, nothing has been
 * sent, so the refusal is definitive. Reads the studio's own inventory and the catalogue; writes nothing.
 */
export async function checkIdentityChoice(
  db: MachineDb,
  scope: SelectionScope,
  choice: IdentityChoice,
): Promise<IdentityCheck> {
  if (choice.deviceId === null) {
    // The existing xCell workflow: a model with no unit and no mode.
    if (choice.profileId !== LEGACY_MACHINE_PROFILE_ID) {
      return { ok: false, error: "That machine could not be checked." };
    }
    if (choice.modeKey !== null) return { ok: false, error: MACHINE_MODE_NOT_OFFERED };
    return { ok: true };
  }
  let devices: Awaited<ReturnType<typeof listStudioDevices>>["devices"];
  try {
    devices = (await listStudioDevices(db, scope.studioId)).devices;
  } catch {
    return { ok: false, error: "That machine choice could not be checked just now. Nothing was saved." };
  }
  const checked = checkDeviceChoice(scope, choice.deviceId, choice.modeKey, devices, catalogueForRuntime());
  if (!checked.ok) return { ok: false, error: machineChoiceRefusal(checked.code, checked.message) };
  const unit = devices.find((d) => d.deviceId === choice.deviceId);
  if (choice.profileId !== null && unit && choice.profileId !== unit.profileId) {
    return { ok: false, error: MACHINE_MODE_NOT_OFFERED };
  }
  return { ok: true };
}
