/**
 * HON-46: machine-native settings for the day packet (Codex P1 #4500315781).
 *
 * A block charted through the machine-first flow stores its settings in
 * `treatment_setup_readings`, not in the legacy `session_blocks` /
 * `electrolysis_entries` columns. This renders those readings READ-ONLY with
 * Machines' own catalogue and label helpers (lib/machines/**, not edited).
 *
 * FAIL CLOSED. A block whose recorded shape cannot be shown faithfully
 * (profile/version/mode/field no longer resolvable, a value of an unknown shape)
 * prints NATIVE_SETTINGS_UNREADABLE and NO settings. It never falls back to the
 * legacy columns, which would be stale or empty and read as complete.
 */

import { observationSourceLabel, recordedUnitLabel } from "@/lib/machines/charting";
import { profileAtVersion } from "@/lib/machines/catalogue";
import { findMode, modeFields } from "@/lib/machines/profile-contract";

export const NATIVE_SETTINGS_UNREADABLE = "Settings recorded in a format this packet can't show yet";

export const SETUP_READING_COLUMNS =
  "id, session_block_id, capture_id, machine_profile_id, machine_profile_version, mode_key, group_key, channels, stage_key, field_key, value_numeric, value_text, absence_reason, native_unit, decimals, observation_source, revision, recorded_at";

export type PacketSetupReadingSource = {
  id: string;
  session_block_id: string;
  capture_id: string | null;
  machine_profile_id: string;
  machine_profile_version: number;
  mode_key: string;
  group_key: string;
  channels: number[] | null;
  stage_key: string | null;
  field_key: string;
  value_numeric: string | number | null;
  value_text: string | null;
  absence_reason: string | null;
  native_unit: string;
  decimals: number;
  observation_source: string | null;
  revision: number;
  recorded_at: string;
};

type Line = { label: string; value: string };
/** `null` = this block has no machine-native readings (legacy columns apply). */
export type NativeSettings = { kind: "settings"; lines: Line[] } | { kind: "unreadable" };

const ABSENCE: Record<string, string> = { "not-recorded": "Not recorded", "not-applicable": "Not applicable", "not-legible": "Not legible" };

function display(r: PacketSetupReadingSource): string | null {
  if (r.value_text !== null && r.value_text !== undefined) {
    return r.value_text.trim().length > 0 ? r.value_text : null;
  }
  if (r.value_numeric !== null && r.value_numeric !== undefined) {
    const n = Number(r.value_numeric);
    if (!Number.isFinite(n)) return null;
    if (!Number.isInteger(r.decimals) || r.decimals < 0 || r.decimals > 6) return null;
    const own = String(n).split(".")[1]?.length ?? 0;
    return n.toFixed(Math.max(r.decimals, own));
  }
  return r.absence_reason !== null && r.absence_reason in ABSENCE ? ABSENCE[r.absence_reason] : null;
}

/** Every recorded revision is shown, oldest first: a mid-treatment change is a second observation, not an edit. */
export function nativeSettingsForBlock(rows: ReadonlyArray<PacketSetupReadingSource>): NativeSettings | null {
  if (rows.length === 0) return null;
  const groups = new Map<string, PacketSetupReadingSource[]>();
  for (const r of rows) {
    const k = [r.machine_profile_id, r.machine_profile_version, r.mode_key, r.group_key, r.revision, r.capture_id ?? ""].join("|");
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const ordered = [...groups.values()].sort(
    (a, b) => a[0].recorded_at.localeCompare(b[0].recorded_at) || a[0].group_key.localeCompare(b[0].group_key) || a[0].revision - b[0].revision,
  );
  const revisionsOf = new Map<string, number>();
  for (const g of ordered) {
    const k = `${g[0].machine_profile_id}|${g[0].machine_profile_version}|${g[0].mode_key}|${g[0].group_key}`;
    revisionsOf.set(k, (revisionsOf.get(k) ?? 0) + 1);
  }

  const lines: Line[] = [];
  for (const g of ordered) {
    const head = g[0];
    const profile = profileAtVersion(head.machine_profile_id, head.machine_profile_version);
    const mode = profile ? findMode(profile, head.mode_key) : undefined;
    if (!profile || !mode) return { kind: "unreadable" };
    const fields = modeFields(mode);
    const stageLabel = (key: string | null) => (key === null ? null : (mode.stages.find((s) => s.key === key)?.nativeLabel ?? null));

    const body: Line[] = [];
    for (const r of [...g].sort((a, b) => (a.stage_key ?? "").localeCompare(b.stage_key ?? "") || a.field_key.localeCompare(b.field_key))) {
      const match = fields.find((f) => f.field.key === r.field_key && (f.stageKey ?? null) === (r.stage_key ?? null));
      const shown = display(r);
      if (!match || shown === null) return { kind: "unreadable" };
      const unit = recordedUnitLabel(r.native_unit);
      const source = observationSourceLabel(r.observation_source);
      const stage = stageLabel(r.stage_key);
      body.push({
        label: stage ? `${stage}: ${match.field.nativeLabel}` : match.field.nativeLabel,
        value: `${shown}${unit ? ` ${unit}` : ""}${source ? ` (${source})` : ""}`,
      });
    }
    const channels = (head.channels ?? []).length > 0 ? ` · channels ${(head.channels ?? []).join(", ")}` : "";
    const total = revisionsOf.get(`${head.machine_profile_id}|${head.machine_profile_version}|${head.mode_key}|${head.group_key}`) ?? 1;
    const rev = total > 1 ? ` · entry ${head.revision} of ${total}` : "";
    lines.push({
      label: "Machine settings",
      value: `${profile.manufacturer} ${profile.model}${profile.variant ? ` (${profile.variant})` : ""} · ${mode.nativeLabel} · group ${head.group_key}${channels}${rev}`,
    });
    lines.push(...body);
  }
  return { kind: "settings", lines };
}
