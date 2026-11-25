import type { MachineDb, MachineOutcome } from "./machine-queries";
import type { StudioDevice } from "./selection";
import { XCELL_PUR_PROFILE_ID } from "./xcell-pur";

/**
 * "MACHINE NOT SPECIFIED" (migration 0385).
 *
 * MultiPlex can be charted in a studio that has registered no machine. The readings tables need a unit, so each studio gets ONE inert
 * placeholder per xCell Pur version, created by a practitioner's first save (`ensure_unspecified_machine`). Nobody sees it as a unit:
 * it is never in a picker, a Settings list, a count, a default or a remembered choice, and every surface that names an area's machine
 * prints this one wording. The constant is the ONLY spelling the application uses; the database holds the same text in the row.
 */
export const UNSPECIFIED_MACHINE_LABEL = "Machine not specified";

/**
 * What the chart carries as the unit BEFORE the row exists (a new area in a studio that has not charted MultiPlex yet). The save actions
 * turn it into the real id through the database command; it is never sent to the database as an id and never stored.
 */
export const UNSPECIFIED_DEVICE_ID = "unspecified:xcell-pur";

export function isUnspecifiedDeviceId(id: string | null | undefined): boolean {
  return id === UNSPECIFIED_DEVICE_ID;
}

type Row = { id: string; studio_id: string; machine_profile_id: string; machine_profile_version: number; display_name: string };

/** The studio's placeholder rows (any version). Members read them under the table's own policy. A failed read is `ok: false`, never empty. */
export async function listUnspecifiedMachines(db: MachineDb, studioId: string): Promise<MachineOutcome<StudioDevice[]>> {
  let data: unknown;
  try {
    const out = await db
      .from("studio_machines")
      .select("id, studio_id, machine_profile_id, machine_profile_version, display_name")
      .eq("studio_id", studioId)
      .eq("is_unspecified", true)
      .eq("machine_profile_id", XCELL_PUR_PROFILE_ID)
      .limit(50);
    if (out.error) return { ok: false, error: "Could not read the machine record." };
    data = out.data;
  } catch {
    return { ok: false, error: "Could not read the machine record." };
  }
  return {
    ok: true,
    value: ((data ?? []) as Row[]).map((r) => ({
      deviceId: r.id,
      studioId: r.studio_id,
      profileId: r.machine_profile_id,
      profileVersion: r.machine_profile_version,
      displayName: UNSPECIFIED_MACHINE_LABEL,
      installedOptions: [],
      retiredAt: null,
      isUnspecified: true,
    })),
  };
}

/** The placeholder as the chart's device for a CURRENT version, real when the row exists, otherwise carrying the sentinel id. */
export function unspecifiedDeviceFor(studioId: string, profileVersion: number, existing: readonly StudioDevice[]): StudioDevice {
  const hit = existing.find((d) => d.profileVersion === profileVersion);
  if (hit) return hit;
  return {
    deviceId: UNSPECIFIED_DEVICE_ID,
    studioId,
    profileId: XCELL_PUR_PROFILE_ID,
    profileVersion,
    displayName: UNSPECIFIED_MACHINE_LABEL,
    installedOptions: [],
    retiredAt: null,
    isUnspecified: true,
  };
}

/** The database command. One generic refusal on any miss, so the answer says nothing about why. */
export async function ensureUnspecifiedMachine(db: MachineDb, studioId: string): Promise<MachineOutcome<string>> {
  const { data, error } = await db.rpc("ensure_unspecified_machine", { p_studio_id: studioId });
  if (error || typeof data !== "string" || data.trim() === "") return { ok: false, error: "MultiPlex could not be recorded right now. Nothing was saved." };
  return { ok: true, value: data };
}

/**
 * At a WRITE: the sentinel becomes the real id (created on first use); any other id passes through untouched. A refusal is returned
 * for the caller to say, and nothing has been written by the caller yet.
 */
export async function resolveUnspecifiedDeviceId(db: MachineDb, studioId: string, deviceId: string | null): Promise<MachineOutcome<string | null>> {
  if (!isUnspecifiedDeviceId(deviceId)) return { ok: true, value: deviceId };
  return ensureUnspecifiedMachine(db, studioId);
}
