import {
  settingGroupIssues,
  type FieldDescriptor,
  type FieldGroup,
  type GroupIssue,
} from "./charting";
import type { MachineProfile, ReadingValue } from "./profile-contract";
import type { ReadingSubmission } from "./machine-queries";

// MPX-03 — SETTING GROUPS: probes that share one set of settings.
//
// TWO THINGS ARE CALLED A "GROUP" IN THIS FEATURE and they are not the same.
// `nativeFieldGroups` returns the contract's FIELD groups - how one mode's
// fields are laid out, which is a display fact. `group_key` in the database is
// a SETTING group: a set of probes that were run at the same values. This
// module is about the second, and nothing here changes the first.
//
// WHY IT EXISTS. The entry surface hard-coded `group_key: "g1"` with no
// channels, while the schema, the command and both read paths have always
// supported several groups with channel associations. A practitioner running
// probes at different settings could therefore store only one apparently
// global setup and lost which probes used which values (Codex, 15cc6c99).
//
// WHAT THE CONTRACT DECIDES, AND THIS DOES NOT:
//
//   * WHICH CHANNEL IDENTITIES EXIST. Only `1..channels.count`. There is no
//     mapping from a channel number to a manufacturer's own probe labelling
//     here, because no source establishes one - inventing it would put a
//     fiction in a clinical record.
//   * WHETHER DISTINCT GROUPS ARE OFFERED AT ALL. `supportsDistinctSettingGroups`
//     is the model's own answer, and the contract's note is explicit about why
//     it matters: "a simple form must never label a per-probe setting as a
//     global control".
//   * WHETHER A GROUP MUST NAME ITS CHANNELS. `associationRequired` is false by
//     a recorded practitioner ruling - "a setup saves without sixteen
//     mandatory rows, and channel identity is recorded only when the workflow
//     actually confirms which probe is which". So an unnamed group is legal.
//
// AND THE ONE THING AN UNNAMED GROUP MUST NEVER BE TAKEN TO MEAN: that it
// applies to every probe. It records no association, which is a different and
// weaker claim. The UI says so in those words; this module simply never
// invents channels for it.

/** A blank, non-numeric or non-finite entry is not a reading. */
export function parse(raw: string): ReadingValue | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return { kind: "value", value: n };
}

/** The stable identity of one field within one group. */
export function draftKey(groupKey: string, f: FieldDescriptor): string {
  return `${groupKey}::${f.stageKey ?? ""}::${f.key}`;
}

/**
 * Turn the practitioner's typed draft into the readings to submit.
 *
 * EXTRACTED SO IT CAN BE TESTED. This logic lived inside `submit`, an event
 * handler, and this repository has no jsdom or testing-library in the unit
 * stack - so nothing could reach it. That is how a hard-coded
 * "practitioner-entered" survived on every field, including ones the contract
 * marks machine-displayed or device-computed, with the rows immutable
 * (Codex, 15cc6c99). It is the third defect in this lane to ship inside an
 * untestable handler, so the rule now is: if it decides what gets stored, it
 * does not live in a closure.
 *
 * Two behaviours worth stating, because both are deliberate:
 *
 *  - A BLANK FIELD IS NOT RECORDED. Not a zero, and not "not-applicable" -
 *    neither is what she told us. Absence with a reason is a different act,
 *    and the command has its own vocabulary for it.
 *  - THE SOURCE COMES FROM THE CONTRACT, per field. Transcribing a value the
 *    machine computed is not the same act as entering one, and the record must
 *    not claim it is.
 */
export function assembleReadings(
  groups: readonly FieldGroup[],
  draft: Readonly<Record<string, string>>,
): ReadingSubmission[] {
  const readings: ReadingSubmission[] = [];
  for (const g of groups) {
    for (const f of g.fields) {
      const value = parse(draft[draftKey(g.key, f)] ?? "");
      if (value === null) continue;
      readings.push({
        stageKey: f.stageKey,
        fieldKey: f.key,
        value,
        observationSource: f.expectedSource,
      });
    }
  }
  return readings;
}

/** One setting group as the practitioner is building it. */
export type SettingGroupDraft = {
  /**
   * The group's identity, which becomes `group_key`. STABLE for the life of
   * the draft and never renumbered: the database allocates revisions per
   * (block, group), so a key that shifted would append to the wrong group's
   * history.
   */
  id: string;
  /** Channel identities this group's settings applied to. Empty is legal. */
  channels: number[];
  /** Typed values, keyed exactly as the entry form keys its inputs. */
  values: Record<string, string>;
};

/** The channel identities the contract declares, or none. */
export function channelChoices(profile: MachineProfile): number[] {
  const count = profile.channels?.count ?? 0;
  if (count <= 0) return [];
  return Array.from({ length: count }, (_, i) => i + 1);
}

/**
 * May this model have MORE THAN ONE setting group?
 *
 * Both conditions are the contract's: it must have channels to distinguish,
 * and it must declare that its probes can genuinely be run differently.
 */
export function supportsDistinctGroups(profile: MachineProfile): boolean {
  return (
    channelChoices(profile).length > 0 &&
    profile.channels?.supportsDistinctSettingGroups === true
  );
}

/**
 * A fresh group, empty: settings are never copied from a sibling.
 *
 * THE ORDINAL IS PASSED IN, NOT DERIVED FROM THE LIST, and the difference is
 * load-bearing. My first version took the highest id present, which means
 * removing `g2` lets the next group BE `g2` - and the database allocates
 * revisions per (block, group), so that second group's capture would append
 * revision 2 to the first one's history and merge two different probe sets
 * into one timeline.
 *
 * It happens to be unreachable today, because removal is only offered for a
 * group with nothing entered and such a group was never saved. That is one
 * guard away from a corrupt clinical record, which is not where this
 * invariant should live. The caller keeps a monotonic counter instead; a
 * retired identity is never reissued.
 */
export function addGroup(
  existing: readonly SettingGroupDraft[],
  ordinal: number,
): SettingGroupDraft[] {
  return [...existing, { id: `g${ordinal}`, channels: [], values: {} }];
}

export function firstGroup(): SettingGroupDraft[] {
  return [{ id: "g1", channels: [], values: {} }];
}

/** Add or remove one channel from one group. Contract-declared ids only. */
export function toggleChannel(
  group: SettingGroupDraft,
  channel: number,
  profile: MachineProfile,
): SettingGroupDraft {
  if (!channelChoices(profile).includes(channel)) return group;
  const has = group.channels.includes(channel);
  return {
    ...group,
    channels: has
      ? group.channels.filter((c) => c !== channel)
      : [...group.channels, channel].sort((a, b) => a - b),
  };
}

/**
 * Cross-group problems, from the rule that already existed.
 *
 * `settingGroupIssues` in charting.ts has treated "channel already recorded in
 * another group" as invalid since long before this entry surface could create
 * two groups - and this path did not call it, so the practitioner could toggle
 * channel 2 on in both groups and each RPC call would accept its own
 * internally-duplicate-free array. The database CANNOT catch this: it sees two
 * separate, individually valid calls. The UI is the only place it can be
 * caught (Codex, f175e732).
 *
 * This adapts the draft shape to the one that rule takes rather than
 * reimplementing the check, so there is one definition of a channel conflict.
 */
export function groupIssues(
  profile: MachineProfile,
  groups: readonly SettingGroupDraft[],
): GroupIssue[] {
  return settingGroupIssues(
    profile,
    groups.map((g) => ({ groupId: g.id, channels: g.channels, readings: {} })),
  );
}

export type GroupReadiness = "empty" | "partial" | "complete";

/**
 * Is this group ready to record?
 *
 * THE MIDDLE STATE IS THE POINT. An empty group is simply not recorded, which
 * is how a practitioner adds a group and changes her mind. A group with some
 * values but a missing REQUIRED field is neither: skipping it would silently
 * discard numbers she typed, and submitting it would be refused by the
 * command. It blocks the save and is named.
 */
export function groupReadiness(
  fieldGroups: readonly FieldGroup[],
  group: SettingGroupDraft,
): GroupReadiness {
  const entered = fieldGroups.some((fg) =>
    fg.fields.some((f) => parse(group.values[draftKey(fg.key, f)] ?? "") !== null),
  );
  if (!entered) return "empty";
  const requiredComplete = fieldGroups.every((fg) =>
    fg.fields.every(
      (f) => f.optional || parse(group.values[draftKey(fg.key, f)] ?? "") !== null,
    ),
  );
  return requiredComplete ? "complete" : "partial";
}

export type GroupSubmission = {
  groupKey: string;
  channels: number[];
  readings: ReadingSubmission[];
};

/**
 * The submissions to send, one per group that has something to record.
 *
 * ONE CALL PER GROUP, deliberately. `record_treatment_setup_group` is one
 * atomic capture of one group, and that boundary is the design: two groups are
 * two facts, each with its own revision sequence within the block. They are
 * NOT batched into one call, because that would require the command to mean
 * something it does not.
 *
 * The consequence the caller must handle: with two groups, the first can
 * succeed and the second fail. That is a representable state, not an incoherent
 * one - but it must be REPORTED, not rounded to "saved" or "failed".
 */
export function assembleGroupSubmissions(
  fieldGroups: readonly FieldGroup[],
  groups: readonly SettingGroupDraft[],
  /**
   * Groups already recorded, which must NOT be sent again.
   *
   * With several groups the first can succeed and a later one fail. Retrying
   * after fixing the failure used to resubmit the successful group too, and
   * because captures are append-only that created an extra immutable revision
   * - a second capture of settings she entered once, indistinguishable in the
   * record from a genuine mid-treatment change (Codex, f175e732).
   */
  alreadySaved: ReadonlySet<string> = new Set(),
): GroupSubmission[] {
  const out: GroupSubmission[] = [];
  for (const g of groups) {
    if (alreadySaved.has(g.id)) continue;
    const readings = assembleReadings(fieldGroups, g.values);
    if (readings.length === 0) continue;
    out.push({ groupKey: g.id, channels: g.channels, readings });
  }
  return out;
}
