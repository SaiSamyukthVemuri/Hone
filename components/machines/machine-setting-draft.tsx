"use client";

import { useState } from "react";

import { SettingDraftFields } from "./setting-draft-fields";
import {
  assembleGroupSubmissions,
  draftBlocking,
  firstGroup,
  toggleChannel,
  type SettingGroupDraft,
} from "@/lib/machines/setting-groups";
import { nativeFieldGroups } from "@/lib/machines/charting";
import type { MachineMode, MachineProfile } from "@/lib/machines/profile-contract";
import type { GroupSubmission } from "@/lib/machines/setting-groups";

// MPX-03 — COLLECTING MACHINE SETTINGS WHEN THERE IS NO BLOCK YET.
//
// WHAT THIS CHANGES. Until now the create form refused to collect a reading it
// had nowhere to put: a new settings block has no row, so the panel showed the
// model's field contract read-only and the practitioner saved the area,
// re-opened it, and recorded. Two steps for one act.
//
// `create_block_with_initial_setup` (0223) writes the area and the settings in
// ONE transaction, so there is now somewhere to put them - the save that
// creates the block carries them. This collects them for that save.
//
// IT DOES NOT SAVE, AND THAT IS THE DIVISION. `MachineReadingEntry` owns a
// save and a retry key because it records against a block that exists. This
// owns neither: it reports its draft upward and the host form's save decides
// what happens. The FIELDS are the same component in both, so there is one
// definition of what the machine's contract says a reading is.
//
// NOTHING IS PRE-FILLED. The draft starts empty here exactly as it does in the
// entry form - a value she has not read off the machine is not a reading, and
// the record must not be able to acquire one by her failing to notice a filled
// box.

export type MachineSettingDraftProps = {
  profile: MachineProfile;
  mode: MachineMode;
  /**
   * Reports the draft after every change.
   *
   * `groups` is already assembled into the submission shape, so the host does
   * not reimplement that; `blocking` is non-null when the draft must not be
   * saved yet and says why, in words meant for the practitioner.
   */
  onDraftChange: (draft: {
    groups: GroupSubmission[];
    blocking: string | null;
  }) => void;
};

export function MachineSettingDraft({
  profile,
  mode,
  onDraftChange,
}: MachineSettingDraftProps) {
  const fieldGroups = nativeFieldGroups(profile, mode);
  const [groups, setGroups] = useState<SettingGroupDraft[]>(firstGroup);
  // MONOTONIC, never derived from the list: a removed group's identity is
  // retired for the life of the mount, because reuse would corrupt a group's
  // revision history. Same rule as the entry form, same reason.
  const [groupOrdinal, setGroupOrdinal] = useState(1);

  /**
   * What the host must know, recomputed from a candidate draft.
   *
   * COMPUTED FROM THE NEXT DRAFT, not from state, because `setGroups` has not
   * applied yet when this runs - reporting from state would always be one
   * keystroke behind, and the host would save the previous values.
   */
  const report = (next: SettingGroupDraft[]) => {
    // THE RULE LIVES IN lib/, not here. A negative control caught it inline:
    // "a half-finished draft is reported as ready" could be mutated in and
    // every test stayed green, because a static render cannot type into a
    // field. What decides whether a clinical save proceeds does not belong
    // where only a mounted browser can reach it.
    onDraftChange({
      groups: assembleGroupSubmissions(fieldGroups, next),
      blocking: draftBlocking(profile, fieldGroups, next),
    });
  };

  const editDraft = (f: (prev: SettingGroupDraft[]) => SettingGroupDraft[]) =>
    setGroups((prev) => {
      const next = f(prev);
      report(next);
      return next;
    });

  const setValue = (groupId: string, k: string, v: string) =>
    editDraft((prev) =>
      prev.map((g) => (g.id === groupId ? { ...g, values: { ...g.values, [k]: v } } : g)),
    );

  const flipChannel = (groupId: string, channel: number) =>
    editDraft((prev) =>
      prev.map((g) => (g.id === groupId ? toggleChannel(g, channel, profile) : g)),
    );

  return (
    <div className="flex flex-col gap-3" data-testid="machine-setting-draft">
      {/*
        SAID OUT LOUD, because the difference from the entry form is not
        visible in the fields themselves: these values are saved WITH the
        treatment area, by the same press of Save, rather than by a separate
        action. Without the line she has no way to know whether the area's
        Save will carry them.
      */}
      <p className="text-xs text-neutral-500" data-testid="setting-draft-note">
        These settings are saved together with the treatment area — one save,
        both recorded.
      </p>

      <SettingDraftFields
        profile={profile}
        mode={mode}
        groups={groups}
        groupOrdinal={groupOrdinal}
        editDraft={editDraft}
        onAdvanceOrdinal={() => setGroupOrdinal((n) => n + 1)}
        setValue={setValue}
        flipChannel={flipChannel}
      />
    </div>
  );
}
