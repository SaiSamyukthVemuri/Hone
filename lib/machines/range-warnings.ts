import { nativeFieldGroups } from "@/lib/machines/charting";
import type { MachineMode, MachineProfile } from "@/lib/machines/profile-contract";
import { assembleReadings } from "@/lib/machines/setting-groups";
import type { SettingGroupDraft } from "@/lib/machines/setting-groups";
import { validateReading } from "@/lib/machines/validate-reading";
import type { NoteCode } from "@/lib/machines/validate-reading";

// HON-8 - a value outside a documented range WARNS, and the practitioner
// confirms it explicitly before the save. It is never clamped and never
// refused: the value is recorded exactly as typed (Sam's range decision, via
// OPS).
//
// WHAT THIS IS NOT. It is the client-side gate only. The confirmation is not
// recorded anywhere: the durable record needs migration 0267 applied and a
// wired call to record_setup_range_confirmations, and neither exists yet.
//
// The ranges come from `validateReading`, not from a second reading of the
// profile, so the warning and the server's note can never disagree about what
// counts as out of range. A reading that validateReading REFUSES (a negative
// current, a field the model lacks) produces no warning here: refusals belong
// to the existing path and are not something a tick can override.

export const RANGE_NOTE_CODES = [
  "outside_published_specification",
  "recommended_protocol_only",
  "documentation_discrepancy",
] as const satisfies readonly NoteCode[];
export type RangeNoteCode = (typeof RANGE_NOTE_CODES)[number];

export type RangeWarning = {
  groupId: string;
  stageKey: string | null;
  fieldKey: string;
  /** The number as typed. Never a bound. */
  value: number;
  code: RangeNoteCode;
  message: string;
};

/**
 * Binds the confirmation to the VALUE, so confirming 250 does not cover a later
 * edit to 300.
 */
export function warningKey(w: RangeWarning): string {
  return [w.groupId, w.stageKey ?? "", w.fieldKey, String(w.value), w.code].join("::");
}

const isRangeCode = (c: NoteCode): c is RangeNoteCode =>
  (RANGE_NOTE_CODES as readonly NoteCode[]).includes(c);

export function rangeWarningsForDraft(
  profile: MachineProfile,
  mode: MachineMode,
  groups: readonly SettingGroupDraft[],
  installedOptions?: readonly string[],
): RangeWarning[] {
  const fieldGroups = nativeFieldGroups(profile, mode);
  const out: RangeWarning[] = [];
  for (const g of groups) {
    for (const r of assembleReadings(fieldGroups, g.values)) {
      if (r.value.kind !== "value") continue;
      const checked = validateReading(
        {
          profileId: profile.profileId,
          version: profile.version,
          modeKey: mode.key,
          stageKey: r.stageKey,
          fieldKey: r.fieldKey,
          value: r.value,
          source: r.observationSource,
          ...(g.channels.length > 0 ? { channel: g.channels[0] } : {}),
        },
        { catalogue: [profile], ...(installedOptions ? { installedOptions } : {}) },
      );
      if (!checked.ok) continue;
      for (const n of checked.notes) {
        if (!isRangeCode(n.code)) continue;
        out.push({
          groupId: g.id,
          stageKey: r.stageKey,
          fieldKey: r.fieldKey,
          value: r.value.value,
          code: n.code,
          message: n.message,
        });
      }
    }
  }
  return out;
}

export function unconfirmedWarnings(
  warnings: readonly RangeWarning[],
  confirmed: ReadonlySet<string>,
): RangeWarning[] {
  return warnings.filter((w) => !confirmed.has(warningKey(w)));
}
