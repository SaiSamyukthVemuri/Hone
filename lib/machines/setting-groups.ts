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

/**
 * The draft for the NEXT capture on a treatment that already has one.
 *
 * KEEPS EVERY GROUP'S IDENTITY and clears everything else. The entry surface
 * used to reset to `firstGroup()` here, which renumbered her groups: after a
 * save of g1 and g2 the form offered a single fresh g1, so a change to what
 * had been g2 was submitted as a revision of g1 (Codex, #860 4290452715).
 *
 * WHAT THAT DID TO THE RECORD, which is worse than the form being wrong.
 * `latest_setup_for_client` returns the newest capture PER GROUP KEY, so it
 * then combined the repurposed g1 with the stale g2 and offered them as one
 * setup: two settings for one probe, and the channel g1 originally described
 * dropped out of the guidance entirely. The field that carries this is
 * documented as "STABLE for the life of the draft and never renumbered:
 * the database allocates revisions per (block, group), so a key that shifted
 * would append to the wrong group's history" - the rule was written down and
 * the reset broke it.
 *
 * VALUES AND CHANNELS ARE STILL CLEARED, which is the part the old reset had
 * right and this keeps: pre-filling either would invite her to submit settings
 * she has not re-read off the machine, or to assert she ran the same probes.
 * The identity is not an observation; the values and the channels are.
 *
 * AN EMPTY GROUP COSTS NOTHING AT SAVE. `assembleGroupSubmissions` drops any
 * group with no readings, and `draftBlocking` only refuses a PARTIAL one, so
 * a practitioner changing g2 alone leaves g1 untouched and saves exactly one
 * group - which is what makes offering both safe rather than noisy.
 */
export function clearedForNextCapture(
  groups: readonly SettingGroupDraft[],
): SettingGroupDraft[] {
  // A draft with no groups cannot happen through the UI, but a surface that
  // returned an empty list here would have no box to type in at all.
  if (groups.length === 0) return firstGroup();
  return groups.map((g) => ({ id: g.id, channels: [], values: {} }));
}

/**
 * The scope a group identity is meaningful in. A `group_key` says WHICH probe
 * within one of these; across two of them the same `g1` is two different
 * things, which is why every one of these fields is part of the mount key.
 */
export type SettingGroupScope = {
  deviceId: string;
  profileId: string;
  profileVersion: number;
  modeKey: string;
};

/** The minimum of a recorded reading needed to recover a group's identity. */
export type RecordedGroupIdentity = SettingGroupScope & { groupKey: string };

/**
 * THE GROUPS A BLOCK ALREADY HAS, recovered from what was RECORDED.
 *
 * THE INVARIANT THIS SERVES, which five review rounds have now approached
 * from four directions: a group identity must survive every way the entry
 * form can be mounted. `clearedForNextCapture` preserves it across a save
 * within one mount. This preserves it across a mount that has no prior
 * state at all - a RELOAD, which is the path Codex found still broken
 * (#860 4294673722). Together they are the only two ways the draft is ever
 * seeded, so the identity now has one source in both.
 *
 * WHY A RELOAD WAS THE DANGEROUS ONE. After a reload of a block holding g1
 * and g2 the form offered a single fresh g1 while the recorded setup rendered
 * below it, so the screen showed two probes and accepted a change for one.
 * A change to the former g2 appended as a revision of g1, and
 * `latest_setup_for_client` then combined that revision with the stale g2 -
 * the same corruption as the within-mount case, reached by closing the tab.
 *
 * SCOPED, AND THAT IS NOT A DETAIL. Identities are only comparable within one
 * (device, profile, version, mode); the entry form is already keyed by exactly
 * that tuple. Seeding from readings outside the scope would import another
 * unit's probe layout - which is the same defect pointed the other way, and is
 * why a machine switch must still start clean rather than inherit.
 *
 * CHANNELS AND VALUES ARE NOT RESTORED, matching `clearedForNextCapture`
 * exactly: the identity is not an observation. Restoring a channel set would
 * assert she ran the same probes before she has said so.
 */
export function groupsFromRecorded(
  recorded: readonly RecordedGroupIdentity[],
  scope: SettingGroupScope,
): SettingGroupDraft[] {
  const keys: string[] = [];
  for (const r of recorded) {
    if (
      r.deviceId !== scope.deviceId ||
      r.profileId !== scope.profileId ||
      r.profileVersion !== scope.profileVersion ||
      r.modeKey !== scope.modeKey
    ) {
      continue;
    }
    if (!keys.includes(r.groupKey)) keys.push(r.groupKey);
  }
  // NOTHING RECORDED IN THIS SCOPE is the ordinary create case, and a new
  // machine's first capture reaches it too.
  if (keys.length === 0) return firstGroup();
  // ORDERED BY THE ORDINAL THE KEY CARRIES, not by the order rows arrived.
  // A reader comparing the form to the history below it is comparing probe
  // labels, so g1 above g2 is a correctness property of the screen, and row
  // order is whatever the query's sort happened to be.
  return [...keys]
    .sort((a, b) => (ordinalOf(a) ?? 0) - (ordinalOf(b) ?? 0) || a.localeCompare(b))
    .map((id) => ({ id, channels: [], values: {} }));
}

/** The number in a `g<n>` key, or null for a key not of that shape. */
function ordinalOf(groupKey: string): number | null {
  const m = /^g(\d+)$/.exec(groupKey);
  return m ? Number(m[1]) : null;
}

/**
 * The highest ordinal already ISSUED in this draft, so the next group added
 * cannot reuse one.
 *
 * Needed because the counter is monotonic per mount and a restored draft
 * starts with identities the mount did not issue: seeding g1 and g2 while the
 * counter sat at its initial 1 would mint a SECOND g2 on the next add, and the
 * two would collapse into one revision history - the same corruption this
 * whole path exists to prevent, arriving through the repair.
 *
 * A key that is not `g<n>` contributes nothing; it cannot collide with one.
 */
export function highestOrdinal(groups: readonly SettingGroupDraft[]): number {
  let n = 1;
  for (const g of groups) {
    const o = ordinalOf(g.id);
    if (o !== null && o > n) n = o;
  }
  return n;
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

/**
 * Why this draft must not be saved yet, or null.
 *
 * EXTRACTED FROM THE CREATE-MODE COLLECTOR because a negative control caught
 * it: the collector computed this inline, so "a half-finished draft is
 * reported as ready" could be mutated in and every test stayed green. What
 * decides whether a clinical save proceeds does not belong where only a
 * mounted browser can reach it.
 *
 * TWO REASONS, in priority order:
 *   1. A CROSS-GROUP CONFLICT - two groups claiming the same probe. The
 *      command refuses it too; naming it here means she sees it before a
 *      round trip rather than after one.
 *   2. A PARTIALLY FILLED GROUP - some values and a missing required field.
 *      Neither ready nor empty: skipping it would silently discard numbers
 *      she typed, and submitting it would be refused.
 *
 * The conflict wins because it is the one she cannot fix by typing more.
 */
export function draftBlocking(
  profile: MachineProfile,
  fieldGroups: readonly FieldGroup[],
  groups: readonly SettingGroupDraft[],
): string | null {
  const issues = settingGroupIssues(
    profile,
    groups.map((g) => ({ groupId: g.id, channels: g.channels, readings: {} })),
  );
  if (issues.length > 0) return issues[0]!.problem;

  const partial = groups.filter(
    (g) => groupReadiness(fieldGroups, g) === "partial",
  );
  if (partial.length === 0) return null;
  const numbers = partial.map(
    (g) => groups.findIndex((x) => x.id === g.id) + 1,
  );
  return `Setting group${partial.length > 1 ? "s" : ""} ${numbers.join(", ")} ${
    partial.length > 1 ? "are" : "is"
  } missing a required field.`;
}

export type GroupSubmission = {
  groupKey: string;
  channels: number[];
  readings: ReadingSubmission[];
};

/**
 * Every group that has something to record, as one SAVE.
 *
 * IT USED TO MEAN ONE CALL PER GROUP, and said so: `record_treatment_setup_group`
 * was one atomic capture of one group, two groups were two facts, and batching
 * would have required the command to mean something it did not. That is no
 * longer true. `record_treatment_setup_submission` means exactly that - one
 * Save, every group, one transaction - so this returns the groups OF one save
 * rather than a list of calls to make.
 *
 * THE `alreadySaved` PARAMETER IS GONE, and the state it guarded is now
 * unreachable rather than merely unhandled. It existed because the first group
 * could commit and the second fail, so a retry had to send only the untold
 * remainder - resubmitting a committed group would have appended a second
 * immutable revision of settings entered once, indistinguishable in the record
 * from a genuine mid-treatment change (Codex, f175e732).
 *
 * Two things replaced it, and both are stronger than a set in component
 * memory, which died on reload:
 *
 *   * a save either commits entirely or not at all, so "already recorded" is
 *     never true of SOME groups;
 *   * a retry of an unresolved save carries the same idempotency key, so the
 *     DATABASE recognises it and returns the original submission. Deduplication
 *     moved from the client's memory to the record itself.
 */
export function assembleGroupSubmissions(
  fieldGroups: readonly FieldGroup[],
  groups: readonly SettingGroupDraft[],
): GroupSubmission[] {
  const out: GroupSubmission[] = [];
  for (const g of groups) {
    const readings = assembleReadings(fieldGroups, g.values);
    if (readings.length === 0) continue;
    out.push({ groupKey: g.id, channels: g.channels, readings });
  }
  return out;
}
