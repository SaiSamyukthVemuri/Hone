"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { nativeFieldGroups } from "@/lib/machines/charting";
import { SettingDraftFields } from "./setting-draft-fields";
import {
  assembleGroupSubmissions,
  clearedForNextCapture,
  groupIssues,
  groupReadiness,
  groupsFromRecorded,
  highestOrdinal,
  toggleChannel,
  type RecordedGroupIdentity,
  type SettingGroupDraft,
} from "@/lib/machines/setting-groups";
import {
  afterDraftChanged,
  outcomeFromRecordResult,
  afterOutcome,
  afterRecordAnother,
  canEditDraft,
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
   * WHAT IS ALREADY RECORDED against this block, used for one thing only:
   * recovering which setting groups exist so a change is attributed to the
   * probe it was made on.
   *
   * Identities, never values. The form restores no number and no channel from
   * this - see `groupsFromRecorded`. It is a required prop rather than an
   * optional one because a caller that forgets it does not get a degraded
   * form, it gets the misattribution defect back, silently; an empty array is
   * the honest way to say "nothing recorded".
   */
  recordedGroups: readonly RecordedGroupIdentity[];
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
    /**
     * WHY it failed, where the distinction changes what happens next.
     *
     * `"unknown"` means the write MAY have committed - a transport failure
     * that arrived in PostgREST's `error` rather than as a throw. It must
     * reach the same outcome a throw does, or the draft unfreezes, the
     * retry key is released, and the next save appends a duplicate
     * immutable capture (Codex, #860 4301722737).
     */
    code?: string;
    /** Captures the submission holds, as the database counted them. */
    captures?: number;
    written?: number;
    /** The retry key matched an existing submission; nothing was duplicated. */
    reused?: boolean;
  }>;
  /** Injected by tests so the retry key is deterministic. */
  mintKey?: () => string;
  /**
   * REPORT WHEN THIS SAVE'S OUTCOME IS UNKNOWN, so the panel can freeze the
   * machine and mode with it.
   *
   * Round 10 froze the identity controls against the CREATE form's
   * unresolved save. A REVISION save is the other path, and its unresolved
   * state lived entirely in this child: the dropdown stayed live, and
   * switching after a lost response UNMOUNTED this component and discarded
   * the retry key it was holding. Switching back and saving then minted a
   * new key and appended a duplicate immutable capture if the first request
   * had committed (Codex, #860 4300759930).
   *
   * The key's whole purpose is to survive the gap between a lost answer and
   * the retry; a control that can unmount the thing holding it is part of
   * that gap.
   */
  onUnresolvedChange?: (unresolved: boolean) => void;
};

export function MachineReadingEntry({
  profile,
  mode,
  blockId,
  deviceId,
  recordedGroups,
  onRecord,
  mintKey,
  onUnresolvedChange,
}: MachineReadingEntryProps) {
  const fieldGroups = nativeFieldGroups(profile, mode);
  // SETTING GROUPS - probes sharing one set of values. One to begin with, which
  // is the entire surface for a model without channels.
  // SEEDED FROM WHAT IS ALREADY RECORDED, in this mount's scope.
  //
  // The initializer used to be a bare `firstGroup`, and that was the last way
  // into the identity defect: a reload of a block holding g1 and g2 offered
  // one fresh g1, so a change to the former g2 appended as a revision of g1
  // (Codex, #860 4294673722). `clearedForNextCapture` had already closed the
  // within-mount path; a reload has no mount-local state to preserve, so it
  // needs the identities to come from the RECORD.
  //
  // Lazy, so the scan runs once per mount rather than on every render - and
  // the mount is keyed by exactly this scope, so a device or mode change
  // remounts and re-seeds rather than carrying a stale layout across.
  const [groups, setGroups] = useState<SettingGroupDraft[]>(() =>
    groupsFromRecorded(recordedGroups, {
      deviceId,
      profileId: profile.profileId,
      profileVersion: profile.version,
      modeKey: mode.key,
    }),
  );
  // MONOTONIC, never derived from the list AFTERWARDS: a removed group's
  // identity is retired for the life of the mount. See addGroup for why reuse
  // would corrupt a group's revision history.
  //
  // IT STARTS FROM THE SEED, THOUGH, and must. The counter's job is to never
  // reissue an identity, and a restored draft begins with identities this
  // mount did not issue - so starting at a flat 1 beside a seeded g1 and g2
  // would mint a SECOND g2 on the next add, collapsing two probes into one
  // revision history. That is the defect this whole path exists to prevent,
  // arriving through its repair, which is why it is read from the seed once
  // rather than tracked separately.
  const [groupOrdinal, setGroupOrdinal] = useState(() => highestOrdinal(groups));
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

  // WHILE AN OUTCOME IS UNKNOWN, THE PAYLOAD IS FROZEN.
  //
  // `canEditDraft` has encoded this rule since the state machine was written
  // and was wired to NOTHING, so the controls stayed live through an
  // unresolved save (Codex, #860 4296029605). What that cost: the retry key
  // is preserved precisely so pressing Save again is safe, but the command
  // binds that key to a digest of the payload. Editing first makes the retry
  // a DIFFERENT payload under the same key, so a first attempt that did
  // commit refuses it as a mismatch - and a further edit then mints a new
  // key, which appends a second capture of settings entered once. The
  // promise "press Save again" is only honest while the thing being saved
  // cannot change underneath it.
  // THE FREEZE STARTS AT SUBMIT, not when the answer comes back (Codex,
  // #860 4305022472). `pending` is the request's own duration, and the
  // payload was already snapshotted when it began.
  const frozen = !canEditDraft(save, pending);

  // TOLD TO THE PANEL, because the controls that can destroy this save's
  // retry key are not in this component. Reported on every change of the
  // flag, including back to false when the retry settles, so the freeze
  // lifts rather than sticking.
  //
  /**
   * WHAT THE HOST HAS TO FREEZE, which is NOT the same as what this form has
   * to freeze (Codex, #860 4305364945).
   *
   * The last round reported `frozen` upward, and `frozen` is
   * `!canEditDraft(save, pending)` — which is also false once a save is
   * ACKNOWLEDGED. So after an ordinary successful capture the host's machine
   * picker, mode picker and Cancel stayed disabled until she pressed "record
   * a setting change". A confirmed save should release the form, not hold it.
   *
   * The host's controls are frozen for exactly one reason: each of them can
   * DISCARD THIS SAVE'S RETRY KEY, and that only matters while a key is at
   * risk — the request is in flight, or its outcome is unknown. An
   * acknowledged save has no key left to protect.
   *
   * `frozen` keeps `recorded` for the entry's OWN fields, which is right:
   * after a recorded save she starts a new capture rather than editing the
   * one in the record.
   */
  const transportHold = pending || save.unresolved;

  const reportedUnresolved = useRef<boolean | null>(null);
  useEffect(() => {
    if (reportedUnresolved.current === transportHold) return;
    reportedUnresolved.current = transportHold;
    onUnresolvedChange?.(transportHold);
  }, [transportHold, onUnresolvedChange]);

  // EVERY DRAFT CHANGE CLOSES THE OPEN SAVE, which is how the retry key keeps
  // meaning what it says: a changed draft is a DIFFERENT save and must mint a
  // new key. Without this, she could fix a refused value and have the database
  // absorb the corrected save as a retry of the one it refused.
  const editDraft = (f: (prev: SettingGroupDraft[]) => SettingGroupDraft[]) => {
    // REFUSED AT THE HANDLER TOO, not only at the controls. Disabling the
    // controls is what the practitioner sees; this is what makes the payload
    // actually immutable, so a control that is ever added without the
    // `frozen` wiring cannot corrupt a retry. Belt and braces is the right
    // shape here because the failure is a duplicate clinical capture.
    if (frozen) return;
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
      // THE MAPPING LIVES IN `save-attempt`, not here, so a test can drive
      // it: this component cannot be mounted in this repository.
      outcome = outcomeFromRecordResult(out, submissions.length);
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
              // A NEW capture, not an edit of the last one. Values AND channel
              // associations are cleared deliberately: pre-filling either from
              // the previous capture would invite a practitioner to submit
              // settings she has not re-read off the machine, or to assert she
              // ran the same probes, which is the opposite of what a reading
              // is.
              //
              // THE GROUP IDENTITIES SURVIVE, and that is the repair. This
              // reset to `firstGroup()`, so after a save of g1 and g2 the form
              // offered one fresh g1 - and a change to what had been g2 was
              // submitted as a revision of g1, which guidance then combined
              // with the stale g2 (Codex, #860 4290452715). See
              // `clearedForNextCapture`.
              setGroups(clearedForNextCapture);
              // THE ORDINAL IS NOT RESET, and must not be: it is monotonic so
              // a removed group's id is never reused. Resetting it to 1 while
              // g1 and g2 are still on screen would mint a SECOND g2 on the
              // next "add group".
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
        // THE REVISION PATH'S HALF OF THE FREEZE. `canEditDraft` is also
        // false once a save is ACKNOWLEDGED, which is already correct here:
        // after a recorded save she presses "record a setting change" to
        // start a new capture rather than editing the one in the record.
        frozen={frozen}
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
