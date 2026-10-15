"use client";

import { useEffect, useState } from "react";

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

/**
 * Clears the host's collected draft, and renders nothing.
 *
 * WHY A COMPONENT AND NOT A CALL. The panel decides whether a collector
 * renders at all - no machine chosen, or no mode resolved, and there is
 * none. The host form would then keep the last draft it was told about and
 * save it, which is the stale-draft defect in a second shape: not "she
 * switched machines" but "she cleared the machine". A component can own that
 * as an effect; the panel's render body cannot call setState on its parent.
 */
export function MachineSettingDraftReset({
  onSettingDraft,
}: {
  onSettingDraft: (draft: null) => void;
}) {
  useEffect(() => {
    // NULL, NOT AN EMPTY DRAFT. With no machine chosen there is no setup
    // identity to report, and inventing one would be worse than saying
    // nothing: an empty draft carrying a plausible identity is exactly the
    // shape the host is meant to be able to trust.
    onSettingDraft(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

export function MachineSettingDraft({
  profile,
  mode,
  onDraftChange,
}: MachineSettingDraftProps) {
  const fieldGroups = nativeFieldGroups(profile, mode);
  const [groups, setGroups] = useState<SettingGroupDraft[]>(firstGroup);

  // REPORT THE EMPTY DRAFT ON MOUNT, which is what makes a machine or mode
  // SWITCH safe.
  //
  // THE DEFECT THIS CLOSES (Codex, db3373bc P1). The panel remounts this
  // component when the setup identity changes, so ITS state resets - but the
  // host form holds the previous draft, and this component said nothing until
  // her first keystroke. Switch machine, press Save, and the form sends the
  // PREVIOUS machine's values: numbers she never read off the unit now
  // chosen, recorded permanently.
  //
  // A remount therefore announces itself. The parent's draft is replaced with
  // an empty one carrying the NEW identity before anything can be saved, so
  // the window in which a stale draft is live does not exist.
  //
  // RUNS ON MOUNT ONLY, which is the whole point: the key gives each identity
  // its own mount, so one report per mount is one report per identity. An
  // effect keyed on the identity instead would fire on a re-render and clear
  // a draft she was still typing into.
  useEffect(() => {
    onDraftChange({ groups: [], blocking: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
