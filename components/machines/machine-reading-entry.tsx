"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/ui/section-label";
import { nativeFieldGroups } from "@/lib/machines/charting";
import {
  addGroup,
  assembleGroupSubmissions,
  channelChoices,
  draftKey,
  firstGroup,
  groupIssues,
  groupReadiness,
  supportsDistinctGroups,
  toggleChannel,
  type SettingGroupDraft,
} from "@/lib/machines/setting-groups";
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
  /** Submits one settings group. Injected so the panel owns the transport. */
  onRecord: (input: {
    blockId: string;
    machineId: string;
    modeKey: string;
    groupKey: string;
    channels: number[];
    readings: ReadingSubmission[];
  }) => Promise<{ ok: boolean; error?: string }>;
};

export function MachineReadingEntry({
  profile,
  mode,
  blockId,
  deviceId,
  onRecord,
}: MachineReadingEntryProps) {
  const fieldGroups = nativeFieldGroups(profile, mode);
  // SETTING GROUPS - probes sharing one set of values. One to begin with, which
  // is the entire surface for a model without channels.
  const [groups, setGroups] = useState<SettingGroupDraft[]>(firstGroup);
  // MONOTONIC, never derived from the list: a removed group's identity is
  // retired for the life of the mount. See addGroup for why reuse would
  // corrupt a group's revision history.
  const [groupOrdinal, setGroupOrdinal] = useState(1);
  // GROUPS ALREADY RECORDED IN THIS MOUNT. A capture is append-only, so
  // resubmitting one on a retry would create a second immutable revision of
  // settings entered once - indistinguishable in the record from a genuine
  // mid-treatment change (Codex, f175e732).
  const [savedGroups, setSavedGroups] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  // GROUPS WHOSE OUTCOME IS UNKNOWN, kept apart from the saved ones on
  // purpose. They are excluded from resubmission for the same reason, but they
  // must never be REPORTED as recorded: nobody knows whether they were.
  const [unknownGroups, setUnknownGroups] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // How many captures this mount has recorded. Drives the confirmation copy
  // and distinguishes the first capture from a later revision.
  const [captures, setCaptures] = useState(0);

  const channels = channelChoices(profile);
  const canAdd = supportsDistinctGroups(profile);
  const readiness = groups.map((g) => groupReadiness(fieldGroups, g));
  // SAVEABLE when something is complete and nothing is half-finished. A
  // partially filled group blocks rather than being skipped: skipping would
  // silently discard numbers she typed, and submitting it would be refused by
  // the command.
  const partial = groups.filter((_, i) => readiness[i] === "partial");
  // CROSS-GROUP CONFLICTS, from the rule that already existed. The database
  // cannot catch these: it sees two separate, individually valid calls.
  const issues = groupIssues(profile, groups);
  const ready =
    readiness.some(
      (r, i) =>
        r === "complete" &&
        !savedGroups.has(groups[i]!.id) &&
        !unknownGroups.has(groups[i]!.id),
    ) &&
    partial.length === 0 &&
    issues.length === 0;

  const setValue = (groupId: string, k: string, v: string) =>
    setGroups((prev) =>
      prev.map((g) => (g.id === groupId ? { ...g, values: { ...g.values, [k]: v } } : g)),
    );

  const flipChannel = (groupId: string, channel: number) =>
    setGroups((prev) =>
      prev.map((g) => (g.id === groupId ? toggleChannel(g, channel, profile) : g)),
    );

  async function submit() {
    setPending(true);
    setMessage(null);
    // Groups already recorded are excluded, so a retry after a partial save
    // sends only what has not been stored.
    const submissions = assembleGroupSubmissions(
      fieldGroups,
      groups,
      new Set([...savedGroups, ...unknownGroups]),
    );

    // ONE CALL PER GROUP, because one capture is one group's atomic fact. The
    // consequence is reported rather than rounded: with two groups the first
    // can succeed and the second fail, and saying "saved" or "could not save"
    // would both be false. See assembleGroupSubmissions.
    // THREE OUTCOMES, NOT TWO, and the third is the one that was missing.
    //
    // `onRecord` can REJECT - a dropped connection, a server-action exception,
    // a timeout - and this loop had no try/catch at all. The consequences were
    // all silent:
    //
    //   * the throw escaped `submit`, so `setPending(false)` never ran and the
    //     form sat on "Saving…" for ever with no message;
    //   * groups that had ALREADY succeeded earlier in the loop were never
    //     added to `savedGroups`, so a later retry could record them a second
    //     time - the very duplication the saved-set exists to prevent;
    //   * and the outcome of the group that threw is genuinely UNKNOWN. The
    //     write may well have committed; the answer was simply lost on the way
    //     back.
    //
    // AN UNKNOWN OUTCOME IS NOT A FAILURE, and must not be treated as one.
    // Retrying it is the blind replay that would duplicate an immutable
    // capture; calling it saved is fake success. So it is reported as unknown,
    // excluded from resubmission, and the practitioner is told that a reload
    // shows what actually committed - which is the only thing that can settle
    // it (Codex, ef45a4b0).
    const succeeded: string[] = [];
    const refused: Array<{ groupKey: string; error?: string }> = [];
    const unknown: string[] = [];
    try {
      for (const sub of submissions) {
        try {
          const out = await onRecord({
            blockId,
            machineId: deviceId,
            modeKey: mode.key,
            groupKey: sub.groupKey,
            channels: sub.channels,
            readings: sub.readings,
          });
          if (out.ok) succeeded.push(sub.groupKey);
          else refused.push({ groupKey: sub.groupKey, error: out.error });
        } catch {
          // The transport failed, so the server's answer is unknown. Stop:
          // sending the NEXT group over a connection that just failed would
          // compound an unresolved state.
          unknown.push(sub.groupKey);
          break;
        }
      }
    } finally {
      // ALWAYS, so a throw anywhere above cannot leave the form pending.
      setPending(false);
    }

    setCaptures((n) => n + succeeded.length);
    // Acknowledged writes only. An unknown group is NOT added here, because
    // `savedGroups` is also what the status line reports as recorded.
    if (succeeded.length > 0) {
      setSavedGroups((prev) => new Set([...prev, ...succeeded]));
    }
    // Excluded from resubmission all the same: a click must not blindly replay
    // a write that may already have committed.
    if (unknown.length > 0) {
      setUnknownGroups((prev) => new Set([...prev, ...unknown]));
    }

    if (unknown.length > 0) {
      setMessage(
        `The connection failed while saving ${unknown.join(", ")}, so whether ` +
          "it was recorded is NOT known - it may have been. " +
          (succeeded.length > 0
            ? `${succeeded.join(", ")} did save. `
            : "") +
          "Reload this chart to see what actually committed before entering it " +
          "again; saving it a second time would record it twice.",
      );
      return;
    }
    if (refused.length === 0) {
      setSaved(true);
      setMessage("Saved to this treatment.");
      return;
    }
    if (succeeded.length === 0) {
      setMessage(refused[0]!.error ?? "Could not save those settings.");
      return;
    }
    setMessage(
      `Saved ${succeeded.length} of ${submissions.length} setting groups. ` +
        `${refused.map((f) => f.groupKey).join(", ")} could not be saved: ` +
        `${refused[0]!.error ?? "the command refused it"}. ` +
        "The saved groups are already recorded and are not affected.",
    );
  }

  if (saved) {
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
          {captures === 1
            ? "Settings saved to this treatment. This capture is permanent and cannot be edited."
            : `${captures} captures saved to this treatment. Each one is permanent and cannot be edited.`}{" "}
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
              setSavedGroups(new Set());
              setUnknownGroups(new Set());
              setMessage(null);
              setSaved(false);
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
      {groups.map((setting, settingIndex) => (
        <div
          key={setting.id}
          className={
            groups.length > 1
              ? "flex flex-col gap-2 rounded-md border border-neutral-200 p-3 dark:border-neutral-800"
              : "flex flex-col gap-2"
          }
          data-testid={`setting-group-${setting.id}`}
        >
          {/*
            THE GROUP HEADER ONLY EXISTS WHEN THERE IS MORE THAN ONE.
            A single group is the whole setup, and labelling it "Group 1" would
            invent a distinction the practitioner has not made.
          */}
          {groups.length > 1 && (
            <div className="flex items-baseline justify-between gap-2">
              <SectionLabel size="caption">
                Setting group {settingIndex + 1}
              </SectionLabel>
              {savedGroups.has(setting.id) && (
                <span
                  className="text-xs text-neutral-500"
                  data-testid={`setting-group-recorded-${setting.id}`}
                >
                  recorded
                </span>
              )}
              {unknownGroups.has(setting.id) && (
                <span
                  className="text-xs text-amber-700 dark:text-amber-500"
                  data-testid={`setting-group-unknown-${setting.id}`}
                >
                  outcome unknown — reload to confirm
                </span>
              )}
              {readiness[settingIndex] === "empty" && (
                <Button
                  type="button"
                  variant="quiet"
                  size="sm"
                  onClick={() =>
                    setGroups((prev) => prev.filter((g) => g.id !== setting.id))
                  }
                  data-testid={`setting-group-remove-${setting.id}`}
                >
                  Remove
                </Button>
              )}
            </div>
          )}

          {/*
            CHANNEL ASSOCIATION, offered only where the contract declares
            channels, and never required: `associationRequired` is false by a
            recorded practitioner ruling, so a setup saves without naming
            probes.

            THE EMPTY STATE IS NAMED HONESTLY. An unassociated group records NO
            association - it does NOT mean "every probe". Saying "all channels"
            here would assert a clinical fact nobody entered, which is the one
            thing this surface must not do.
          */}
          {channels.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-neutral-600 dark:text-neutral-400">
                {profile.channels!.nativeLabel}s these settings applied to
              </span>
              <div className="flex flex-wrap gap-2">
                {channels.map((c) => {
                  const on = setting.channels.includes(c);
                  return (
                    <Button
                      key={c}
                      type="button"
                      variant={on ? "primary" : "secondary"}
                      size="sm"
                      aria-pressed={on}
                      onClick={() => flipChannel(setting.id, c)}
                      data-testid={`setting-group-${setting.id}-channel-${c}`}
                    >
                      {c}
                    </Button>
                  );
                })}
              </div>
              {setting.channels.length === 0 && (
                <span
                  className="text-xs text-neutral-500"
                  data-testid={`setting-group-${setting.id}-no-channels`}
                >
                  No {profile.channels!.nativeLabel.toLowerCase()} recorded for this
                  group. This is saved as no association — not as every{" "}
                  {profile.channels!.nativeLabel.toLowerCase()}.
                </span>
              )}
            </div>
          )}

          {fieldGroups.map((fieldGroup) => (
            <div key={fieldGroup.key} className="flex flex-col gap-2">
              <SectionLabel size="caption">{fieldGroup.label}</SectionLabel>
              <div className="grid gap-3 md:grid-cols-2">
                {fieldGroup.fields.map((f) => {
                  const k = draftKey(fieldGroup.key, f);
                  return (
                    <label key={k} className="flex flex-col gap-1">
                      <span className="text-sm font-medium">
                        {/* Same ids as the panel's read-only list; only one of
                            the two renders at a time. See the note there. */}
                        <span data-testid={`field-label-${f.key}`}>{f.label}</span>
                        {f.unit && (
                          <span
                            className="ml-1 font-normal text-neutral-500"
                            data-testid={`field-unit-${f.key}`}
                          >
                            ({f.unit})
                          </span>
                        )}
                        {f.optional && (
                          <span className="ml-1 font-normal text-neutral-500">
                            optional
                          </span>
                        )}
                        {/*
                          MACHINE-DERIVED FIELDS ARE STILL MARKED. Removing the
                          `disabled` attribute took away the only signal this
                          surface had, and the distinction matters even though
                          the value is transcribed by hand: the practitioner is
                          reading it off the device rather than deciding it.
                        */}
                        {!f.editable && (
                          <span
                            className="ml-1 font-normal text-neutral-500"
                            data-testid={`field-machine-shown-${f.key}`}
                          >
                            shown by the machine
                          </span>
                        )}
                      </span>
                      <input
                        type="number"
                        inputMode="decimal"
                        step={f.decimals === 0 ? 1 : 1 / 10 ** f.decimals}
                        // NOT DISABLED by `editable: false`: that flag means
                        // she cannot change the value ON THE MACHINE, not that
                        // it cannot be charted, and nothing else populates it
                        // (Codex, 15cc6c99).
                        value={setting.values[k] ?? ""}
                        onChange={(e) => setValue(setting.id, k, e.target.value)}
                        data-testid={
                          groups.length > 1
                            ? `reading-${setting.id}-${f.key}`
                            : `reading-${f.key}`
                        }
                        className="min-h-[44px] rounded-md border border-neutral-300 px-3 py-2 text-base pointer-fine:text-sm dark:border-neutral-700 dark:bg-neutral-950"
                      />
                      {f.advisory.map((note, i) => (
                        <span key={i} className="text-xs text-neutral-500">
                          {note}
                        </span>
                      ))}
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ))}

      {/*
        ADD A GROUP, only where the model says its probes can differ.
        `supportsDistinctSettingGroups` is the contract's own answer and the
        reason it exists is in its docblock: a simple form must never label a
        per-probe setting as a global control. Nothing is copied into the new
        group - carrying values over would assert that she ran the second set of
        probes at the first set's settings.
      */}
      {canAdd && (
        <div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              setGroups((prev) => addGroup(prev, groupOrdinal + 1));
              setGroupOrdinal((n) => n + 1);
            }}
            data-testid="setting-group-add"
          >
            Add setting group
          </Button>
        </div>
      )}

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
          Save these settings
        </Button>
        {!ready && partial.length === 0 && (
          <span className="text-xs text-neutral-500">
            Enter every required field before saving.
          </span>
        )}
        {issues.length > 0 && (
          <span className="text-xs text-amber-700 dark:text-amber-500" role="status">
            {/*
              NAMED, because the database cannot refuse it. Each call carries
              its own duplicate-free channel array, so two groups claiming the
              same probe are two individually valid calls - and the result
              would permanently record one channel under two different
              settings.
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

      {message && (
        <p className="text-xs text-neutral-600 dark:text-neutral-400" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
