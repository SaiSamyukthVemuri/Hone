import { LEGACY_MACHINE_PROFILE_ID } from "@/lib/machines/legacy-machine";
import type { MachineDb } from "@/lib/machines/machine-queries";
import { catalogueForRuntime } from "@/lib/machines/synthetic-profile";
import { checkDeviceChoice, type SelectionScope } from "@/lib/machines/selection";
import { listStudioDevices } from "@/lib/machines/studio-devices";

const UNREADABLE_INVENTORY =
  "We could not check that machine choice just now. Try again in a moment; nothing has been lost.";

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
/**
 * Why a choice was refused, because the CALLER treats the three differently (Codex, #1369 4499083273):
 *  - "contract": the pair is impossible (a mode the model does not offer, a missing option, a mismatched profile). Never stored.
 *  - "availability": the unit is retired, unknown or another studio's. The identity COMMAND refuses those for a NEW write itself,
 *    so the caller may let the receipt-aware command decide, which is what lets a lost-answer retry recover after a unit is retired.
 *  - "unreadable": the inventory could not be read. Says nothing about the choice: the outcome is unknown, the key is kept.
 */
export type IdentityRefusalReason = "contract" | "availability" | "unreadable";
export type IdentityCheck = { ok: true } | { ok: false; error: string; reason: IdentityRefusalReason };

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
      return { ok: false, error: "That machine could not be checked.", reason: "contract" };
    }
    if (choice.modeKey !== null) return { ok: false, error: MACHINE_MODE_NOT_OFFERED, reason: "contract" };
    return { ok: true };
  }
  let devices: Awaited<ReturnType<typeof listStudioDevices>>["devices"];
  let inventorySource: string | undefined;
  try {
    const inventory = await listStudioDevices(db, scope.studioId);
    devices = inventory.devices;
    inventorySource = inventory.source;
  } catch {
    return { ok: false, error: UNREADABLE_INVENTORY, reason: "unreadable" };
  }
  // A read that answered with no units because it FAILED is "could not tell", not "no such unit".
  if (devices.length === 0 && inventorySource === "unreadable") {
    return { ok: false, error: UNREADABLE_INVENTORY, reason: "unreadable" };
  }
  const checked = checkDeviceChoice(scope, choice.deviceId, choice.modeKey, devices, catalogueForRuntime());
  if (!checked.ok) {
    const availability =
      checked.code === "device_retired" || checked.code === "unknown_device" || checked.code === "cross_studio_device";
    return {
      ok: false,
      error: machineChoiceRefusal(checked.code, checked.message),
      reason: availability ? "availability" : "contract",
    };
  }
  const unit = devices.find((d) => d.deviceId === choice.deviceId);
  if (choice.profileId !== null && unit && choice.profileId !== unit.profileId) {
    return { ok: false, error: MACHINE_MODE_NOT_OFFERED, reason: "contract" };
  }
  return { ok: true };
}

/**
 * IS THIS EXACT CHOICE ALREADY THE ONE STORED ON THE BLOCK? The receipt table is readable by no API role, so the block's own
 * stored identity is the readable proof that an earlier write of this choice committed (a lost-answer retry). Re-asserting what
 * is already stored creates no new impossible record, so the caller may skip the current-availability and contract checks and let
 * the receipt-aware command answer. A failed read, or a block without the columns, is "not the same": the checks then apply.
 */
export async function storedIdentityMatches(
  db: MachineDb,
  where: { blockId: string; sessionId: string },
  choice: IdentityChoice,
): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("session_blocks")
      .select("machine_profile_id, studio_machine_id, machine_mode_key")
      .eq("id", where.blockId)
      .eq("session_id", where.sessionId)
      .limit(1);
    if (error || !Array.isArray(data) || data.length !== 1) return false;
    const row = data[0] as { machine_profile_id?: unknown; studio_machine_id?: unknown; machine_mode_key?: unknown };
    const norm = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
    const unitMatches = norm(row.studio_machine_id) === choice.deviceId;
    const modeMatches = norm(row.machine_mode_key) === (choice.modeKey === null ? null : choice.modeKey.trim() || null);
    // A unit's model is derived from the unit; compare the model only when the choice carries one or has no unit (xCell).
    const profileMatches = choice.deviceId === null
      ? norm(row.machine_profile_id) === choice.profileId
      : choice.profileId === null || norm(row.machine_profile_id) === choice.profileId;
    return choice.deviceId !== null || choice.profileId !== null ? unitMatches && modeMatches && profileMatches : false;
  } catch {
    return false;
  }
}
