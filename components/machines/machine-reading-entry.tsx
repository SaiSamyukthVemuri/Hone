"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { nativeFieldGroups } from "@/lib/machines/charting";
import { SettingDraftFields } from "./setting-draft-fields";
import {
  assembleGroupSubmissions,
  firstGroup,
  groupIssues,
  groupReadiness,
  toggleChannel,
  type SettingGroupDraft,
} from "@/lib/machines/setting-groups";
import {
  afterDraftChanged,
  afterOutcome,
  afterRecordAnother,
  canSubmit,
  initialSaveState,
  keyForSave,
  type SaveOutcome,
  type SaveState,
} from "@/lib/machines/save-attempt";
import type { MachineMode, MachineProfile } from "@/lib/machines/profile-contract";
import type { ReadingSubmission } from "@/lib/machines/machine-queries";

// MPX-03 — recording what the machine showed.
//
// WHAT CHANGED, AND WHY THE OLD RULE IS GONE. Until the storage migration
// landed this panel deliberately rendered no inputs: there were no reading
// columns, and a clinical form that accepted numbers and then dropped them
// would be worse than one that did not ask. The columns exist now, so the
// inputs appear - and the tests that asserted "no input anywhere" were
// REPLACED rather than deleted, with assertions that inputs exist only once a
// machine is chosen and that saving goes through the owner-gated command.
//
// FIELDS COME FROM THE MODEL, NOT FROM THIS FILE. The inputs are generated from
// `nativeFieldGroups`, so the labels, the native units and the decimal
// precision are the machine's own and this component knows nothing about any
// particular machine.
//
// WHAT IT REFUSES TO DO. It does not clamp, round, or reject a value for being
// outside a documented range: a reading is what the practitioner saw. Advisory
// text is shown beside the field, and the only input it will not submit is one
// that is not a finite number - which is malformed rather than surprising.
// Server-side, `recordReadingsAction` validates the field against the model and
// the database refuses a block or machine in another studio.

export type MachineReadingEntryProps = {
  profile: MachineProfile;
  mode: MachineMode;
  /** The treatment block being charted. */
  blockId: string;
  deviceId: string;
  /**
   * Submits ONE SAVE - every settings group at once. Injected so the panel
   * owns the transport.
   *
   * IT USED TO SUBMIT ONE GROUP, and this form looped over it. That made a
   * partial save representable: the first group committed and the second did
   * not, with nothing in the database tying them together. The command behind
   * this is atomic now, so the loop and all its bookkeeping are gone.
   *
   * `idempotencyKey` identifies the SAVE and is reused on every retry of it,
   * which is what makes retrying safe after a lost response. Its lifetime is
   * `lib/machines/save-attempt.ts`, not this component.
   */
  onRecord: (input: {
    blockId: string;
    machineId: string;
    modeKey: string;
    idempotencyKey: string;
    groups: Array<{
      groupKey: string;
      channels: number[];
      readings: ReadingSubmission[];
    }>;
  }) => Promise<{
    ok: boolean;
    error?: string;
    /** Captures the submission holds, as the database counted them. */
    captures?: number;
    written?: number;
    /** The retry key matched an existing submission; nothing was duplicated. */
    reused?: boolean;
  }>;
  /** Injected by tests so the retry key is deterministic. */
  mintKey?: () => string;
};

export function MachineReadingEntry({
  profile,
  mode,
  blockId,
  deviceId,
  onRecord,
  mintKey,
}: MachineReadingEntryProps) {
  const fieldGroups = nativeFieldGroups(profile, mode);
  // SETTING GROUPS - probes sharing one set of values. One to begin with, which
  // is the entire surface for a model without channels.
  const [groups, setGroups] = useState<SettingGroupDraft[]>(firstGroup);
  // MONOTONIC, never derived from the list: a removed group's identity is
  // retired for the life of the mount. See addGroup for why reuse would
  // corrupt a group's revision history.
  const [groupOrdinal, setGroupOrdinal] = useState(1);
  // THE WHOLE SAVE, as one state machine.
  //
  // THIS REPLACED FIVE PIECES OF PER-GROUP BOOKKEEPING - a saved-group set, an
  // unknown-group set, a boolean, a message and a capture count - and the
  // reduction is a consequence of the command, not a tidy-up. A Save was
  // several independent calls, so the form had to remember which groups had
  // committed, which had been refused and which had an unknown outcome, and
  // send only the untold remainder on a retry. One atomic call makes every one
  // of those states unreachable: either the save committed or it did not.
  //
  // The rules live in lib/machines/save-attempt.ts because this repository has
  // no jsdom, so logic inside a component is provable only by mounting a
  // browser - and what this decides is whether a clinical capture is written,
  // written twice, or reported as written when nobody knows.
  const [save, setSave] = useState<SaveState>(initialSaveState);
  const [pending, setPending] = useState(false);

  // `channelChoices` and `supportsDistinctGroups` moved with the fields they
  // drive; what stays here is what the SAVE needs to decide.
  const readiness = groups.map((g) => groupReadiness(fieldGroups, g));
  // SAVEABLE when something is complete and nothing is half-finished. A
  // partially filled group blocks rather than being skipped: skipping would
  // silently discard numbers she typed, and submitting it would be refused by
  // the command.
  const partial = groups.filter((_, i) => readiness[i] === "partial");
  // CROSS-GROUP CONFLICTS, from the rule that already existed - and now
  // ENFORCED IN THE DATABASE TOO, by record_treatment_setup_submission. This
  // is no longer the only guard, and the comment used to say it was; it is
  // kept because warning her before a round trip is better than refusing her
  // after one, not because the database would otherwise miss it.
  const issues = groupIssues(profile, groups);
  const ready =
    readiness.some((r) => r === "complete") &&
    partial.length === 0 &&
    issues.length === 0 &&
    canSubmit(save);

  // EVERY DRAFT CHANGE CLOSES THE OPEN SAVE, which is how the retry key keeps
  // meaning what it says: a changed draft is a DIFFERENT save and must mint a
  // new key. Without this, she could fix a refused value and have the database
  // absorb the corrected save as a retry of the one it refused.
  const editDraft = (f: (prev: SettingGroupDraft[]) => SettingGroupDraft[]) => {
    setGroups(f);
    setSave(afterDraftChanged);
  };

  const setValue = (groupId: string, k: string, v: string) =>
    editDraft((prev) =>
      prev.map((g) => (g.id === groupId ? { ...g, values: { ...g.values, [k]: v } } : g)),
    );

  const flipChannel = (groupId: string, channel: number) =>
    editDraft((prev) =>
      prev.map((g) => (g.id === groupId ? toggleChannel(g, channel, profile) : g)),
    );

  async function submit() {
    setPending(true);
    // ONE CALL, EVERY GROUP. The loop this replaced had to carry the
    // consequence of several calls: with two groups the first could succeed
    // and the second fail, and "saved" and "could not save" were both false.
    // That state is unreachable now - record_treatment_setup_submission is one
    // transaction, so either every group committed or none did.
    const submissions = assembleGroupSubmissions(fieldGroups, groups);

    // THE KEY IS TAKEN BEFORE THE CALL AND HELD ACROSS RETRIES, which is the
    // entire mechanism. Minting one per attempt would make every retry look
    // like a new save; never minting a new one would make a deliberate second
    // capture impossible.
    const key = keyForSave(save, mintKey ?? (() => crypto.randomUUID()));
    setSave((prev) => ({ ...prev, key }));

    let outcome: SaveOutcome;
    try {
      const out = await onRecord({
        blockId,
        machineId: deviceId,
        modeKey: mode.key,
        idempotencyKey: key,
        groups: submissions,
      });
      outcome = out.ok
        ? {
            kind: "saved",
            // THE DATABASE'S OWN TALLY where it gave one. Counting the groups
            // sent would be wrong on a reused submission - it reports what the
            // ORIGINAL save recorded, which is the only true answer.
            groups: out.captures ?? submissions.length,
            readings: out.written ?? 0,
            reused: out.reused === true,
          }
        : { kind: "refused", error: out.error };
    } catch {
      // THE TRANSPORT FAILED, SO THE ANSWER IS UNKNOWN - not failed. The write
      // may well have committed. This used to end in "reload the chart to see
      // what committed", because a blind retry would have appended a second
      // immutable capture. With the key above, the retry is safe and is
      // offered instead (Codex, ef45a4b0 and #860 6157725545).
      outcome = { kind: "unknown" };
    } finally {
      // ALWAYS, so a throw cannot leave the form pending for ever.
      setPending(false);
    }

    setSave((prev) => afterOutcome(prev, key, outcome));
  }

  if (save.recorded) {
    return (
      <div
        className="flex flex-col gap-2"
        data-testid="machine-reading-saved"
        role="status"
      >
        {/*
          THE SCHEMA CHANGED UNDER THIS COPY, TWICE, AND IT HAS TRACKED BOTH.

          Originally it claimed "a change of setting is recorded as a new
          reading", which the write-once schema refused. That was corrected to
          say settings could not be overwritten and to send the practitioner to
          free-text notes. Append-only revision CAPTURES then shipped, which
          makes that second version wrong in the opposite direction: the
          structured path now exists, and sending her to prose throws it away
          (Codex, 752a7ef6).

          So: say what is true - the capture is permanent and a change is a NEW
          capture - and give her the control to make one, rather than requiring
          a page reload to reach a path the database supports.
        */}
        <p className="text-sm text-neutral-700 dark:text-neutral-300">
          {save.captures === 1
            ? "Settings saved to this treatment. This capture is permanent and cannot be edited."
            : `${save.captures} captures saved to this treatment. Each one is permanent and cannot be edited.`}{" "}
          If a setting changes during the treatment, record it as a new capture
          - the earlier one stays in the record.
        </p>
        <div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              // A NEW capture, not an edit of the last one. Everything is
              // cleared deliberately - values AND channel associations.
              // Pre-filling either from the previous capture would invite a
              // practitioner to submit settings she has not re-read off the
              // machine, or to assert she ran the same probes, which is the
              // opposite of what a reading is.
              setGroups(firstGroup());
              setGroupOrdinal(1);
              // A NEW SAVE, WITH A NEW KEY. Inheriting the previous one would
              // make the database absorb this as a retry of the capture just
              // recorded - settings she has deliberately re-read off the
              // machine, silently discarded. The capture COUNT survives: it is
              // what this mount has recorded against the treatment.
              setSave(afterRecordAnother);
            }}
            data-testid="machine-reading-record-change"
          >
            Record a setting change
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="machine-reading-entry">
      {/*
        THE FIELDS, SHARED WITH THE CREATE-MODE SURFACE. Moved out verbatim so
        one set of inputs serves both save paths; the render lock in
        tests/components/machine-reading-entry-render.test.ts pins that the
        move changed nothing.
      */}
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

      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="primary"
          size="md"
          onClick={submit}
          disabled={pending || !ready}
          pending={pending}
          busyLabel="Saving…"
          data-testid="machine-reading-save"
        >
          {/*
            THE LABEL SAYS WHICH ACTION THIS IS. After an unresolved attempt
            the only safe thing to do is retry THE SAME SAVE, and calling that
            "Save these settings" would read as starting a new one - the exact
            thing that would record the treatment twice if the first attempt
            did commit.
          */}
          {save.unresolved ? "Try saving again" : "Save these settings"}
        </Button>
        {!ready && partial.length === 0 && (
          <span className="text-xs text-neutral-500">
            Enter every required field before saving.
          </span>
        )}
        {issues.length > 0 && (
          <span className="text-xs text-amber-700 dark:text-amber-500" role="status">
            {/*
              NAMED HERE SO SHE SEES IT BEFORE A ROUND TRIP, not because this
              is the only guard. It used to be: each call carried its own
              duplicate-free channel array, so two groups claiming the same
              probe were two individually VALID calls that the database could
              not see as related, and a UI check was bypassed by anything
              calling the RPC directly. record_treatment_setup_submission
              refuses it now (#860 6157725545). Both are kept deliberately -
              one for the practitioner, one for the record.
            */}
            {issues[0]!.problem}
          </span>
        )}
        {partial.length > 0 && (
          <span className="text-xs text-amber-700 dark:text-amber-500" role="status">
            {/*
              NAMED, not skipped. A group with some values and a missing
              required field is neither ready nor empty, and silently leaving it
              out would discard numbers she had typed.
            */}
            Setting group
            {partial.length > 1 ? "s " : " "}
            {partial
              .map((g) => groups.findIndex((x) => x.id === g.id) + 1)
              .join(", ")}{" "}
            {partial.length > 1 ? "are" : "is"} missing a required field.
          </span>
        )}
      </div>

      {save.message && (
        <p
          className={
            save.unresolved
              ? "text-xs text-amber-700 dark:text-amber-500"
              : "text-xs text-neutral-600 dark:text-neutral-400"
          }
          role="status"
          data-testid="machine-reading-message"
        >
          {save.message}
        </p>
      )}
    </div>
  );
}
