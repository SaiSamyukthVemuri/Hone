/**
 * RELOAD CONTINUITY, MACHINE-FIRST. A reopened visit comes back on the unit and
 * mode its LAST SAVED capture used, rather than the practitioner's sticky
 * default, which may have moved since (another client, another room).
 *
 * The result seeds the panel's SELECTION only. It is not written to the
 * remembered default: that is a UI preference, and merely reopening a visit
 * must not change it.
 *
 * NO GUESSING. The last capture must name exactly one unit and one mode, the
 * unit must pass `selectableDevices` (the picker's own rule: active, this
 * studio, current profile version) and the mode must still be active on that
 * profile. Anything else restores nothing and the ordinary remembered machine
 * applies.
 *
 * Current schema: the unit, mode and capture ride on every recorded reading.
 */

import { MACHINE_CATALOGUE } from "./catalogue";
import type { RecordedReading } from "./machine-queries";
import { activeModes, type MachineProfile } from "./profile-contract";
import {
  selectableDevices,
  type SelectionScope,
  type StudioDevice,
} from "./selection";

export type RestoredSelection = { deviceId: string; modeKey: string };

export function restoreSelectionFromRecordedSetup(input: {
  scope: SelectionScope;
  recordedSetup: readonly RecordedReading[];
  devices: readonly StudioDevice[];
  catalogue?: readonly MachineProfile[];
}): RestoredSelection | null {
  const rows = input.recordedSetup;
  if (rows.length === 0) return null;

  // The last capture: newest recordedAt, then highest revision. Readings are
  // immutable, so this is a fact rather than a race. A row with no capture id
  // is its own capture.
  const keyOf = (r: RecordedReading) => r.captureId ?? `row:${r.revision}`;
  let latest = rows[0];
  for (const r of rows) {
    if (
      r.recordedAt > latest.recordedAt ||
      (r.recordedAt === latest.recordedAt && r.revision > latest.revision)
    ) {
      latest = r;
    }
  }
  const capture = rows.filter((r) => keyOf(r) === keyOf(latest));

  const devices = new Set(capture.map((r) => r.deviceId));
  const modes = new Set(capture.map((r) => r.modeKey));
  if (devices.size !== 1 || modes.size !== 1) return null;
  const deviceId = capture[0].deviceId;
  const modeKey = capture[0].modeKey;

  const hit = selectableDevices(
    input.scope,
    input.devices,
    input.catalogue ?? MACHINE_CATALOGUE,
  ).find((s) => s.device.deviceId === deviceId);
  if (!hit) return null;
  if (!activeModes(hit.profile).some((m) => m.key === modeKey)) return null;
  return { deviceId, modeKey };
}
