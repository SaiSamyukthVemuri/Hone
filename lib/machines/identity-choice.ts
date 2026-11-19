import { XCELL_PUR_PROFILE_ID } from "@/lib/machines/xcell-pur";
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
 * Why a choice was refused, because the CALLER treats the three differently:
 *  - "contract": the pair is impossible (a mode the model does not offer, a missing option, a mismatched profile). Never stored.
 *  - "availability": the unit is retired, unknown or another studio's. The identity COMMAND refuses those for a NEW write itself,
 *    so the caller may let the receipt-aware command decide, which is what lets a lost-answer retry recover after a unit is retired.
 *  - "unreadable": the inventory could not be read. Says nothing about the choice: the outcome is unknown, the key is kept.
 */
export type IdentityRefusalReason = "contract" | "availability" | "unreadable";
export type IdentityCheck = { ok: true; unitProfileId: string | null } | { ok: false; error: string; reason: IdentityRefusalReason };

/**
 * A MACHINE IDENTITY BEING SAVED ON A TREATMENT AREA MUST PASS THE CONTRACT A REMEMBERED CHOICE PASSES.
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
    return { ok: true, unitProfileId: null };
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
  return { ok: true, unitProfileId: unit?.profileId ?? null };
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

/**
 * Whether this block ALREADY stores an xCell Pur unit: re-saving it must keep its identity whatever the platform rollout says.
 * Reads the block's unit, then the unit's model. A failed or odd read is false (the rollout then decides, and an error refuses): never a guess.
 */
export async function blockUsesXcellPur(db: MachineDb, blockId: string, sessionId: string): Promise<boolean> {
  try {
    const blk = await db.from("session_blocks").select("studio_machine_id").eq("id", blockId).eq("session_id", sessionId).limit(1);
    if (blk.error || !Array.isArray(blk.data) || blk.data.length !== 1) return false;
    const unit = (blk.data[0] as { studio_machine_id?: unknown }).studio_machine_id;
    if (typeof unit !== "string" || unit.trim() === "") return false;
    const m = await db.from("studio_machines").select("id").eq("id", unit.trim()).eq("machine_profile_id", XCELL_PUR_PROFILE_ID).limit(1);
    return !m.error && Array.isArray(m.data) && m.data.length === 1;
  } catch {
    return false;
  }
}

/**
 * W4 (redesign on): does this block already hold readings, legacy or native? A block that does keeps its machine identity. Reads the first live
 * entry's reading columns and any native setup reading. A failed read answers TRUE (hold): never a guess that would let a change through.
 */
type Rows = PromiseLike<{ data: unknown; error: unknown }>;
type LooseDb = { from: (t: string) => { select: (c: string) => { eq: (c: string, v: unknown) => { eq: (c: string, v: unknown) => { limit: (n: number) => Rows }; is: (c: string, v: null) => { limit: (n: number) => Rows }; limit: (n: number) => Rows } } } };
export async function blockHoldsReadings(machineDb: MachineDb, blockId: string, sessionId: string): Promise<boolean> {
  const db = machineDb as unknown as LooseDb;
  try {
    const blk = await db.from("session_blocks").select("id").eq("id", blockId).eq("session_id", sessionId).limit(1);
    if (blk.error || !Array.isArray(blk.data) || blk.data.length !== 1) return true;
    const native = await db.from("treatment_setup_readings").select("id").eq("session_block_id", blockId).limit(1);
    if (native.error) return true;
    if (Array.isArray(native.data) && native.data.length > 0) return true;
    const entries = await db
      .from("electrolysis_entries")
      .select("thermolysis_intensity_percent, thermolysis_duration_seconds, galvanic_ma, galvanic_duration_seconds, units_of_lye, energy_level, apilus_modality")
      .eq("block_id", blockId)
      .is("deleted_at", null)
      .limit(50);
    if (entries.error || !Array.isArray(entries.data)) return true;
    return (entries.data as unknown[]).some((e) => Object.values(e as Record<string, unknown>).some((v) => v != null));
  } catch {
    return true;
  }
}

export const IDENTITY_FROZEN_MESSAGE = "This area already has readings recorded, so its machine can't be changed. Add a new settings block for a different machine.";

/** With the redesign on, xCell Pur's Thermolysis, Blend and Galvanic cannot be recorded faithfully yet; never fall back to the old xCell identity. */
export const PUR_LEGACY_MODES_UNAVAILABLE_MESSAGE =
  "xCell Pur's Thermolysis, Blend and Galvanic can't be recorded yet. Nothing was saved. Choose MultiPlex, or another machine.";
export function purLegacyModeRefused(o: { redesignOn: boolean; mode: string | null | undefined; profileId: string | null | undefined }): boolean {
  const m = (o.mode ?? "").trim();
  return o.redesignOn && o.profileId === XCELL_PUR_PROFILE_ID && (m === "thermo" || m === "blend" || m === "galv");
}
