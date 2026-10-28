"use client";

import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/ui/section-label";
import { nativeFieldGroups } from "@/lib/machines/charting";
import {
  addGroup,
  channelChoices,
  draftKey,
  groupReadiness,
  supportsDistinctGroups,
  type SettingGroupDraft,
} from "@/lib/machines/setting-groups";
import type { MachineMode, MachineProfile } from "@/lib/machines/profile-contract";

// MPX-03 — THE SETTING DRAFT'S FIELDS, shared by the two surfaces that collect
// them.
//
// WHY THIS IS ITS OWN COMPONENT. The treatment form records settings against a
// settings block that exists; the CREATE form has no block yet, so it can only
// collect them and hand them to the save that creates the block. Those are two
// different save paths and ONE set of fields, and a second copy of the fields
// would be a second copy of what the machine's contract says a reading is -
// the duplication this feature has already paid for three times.
//
// IT OWNS NO STATE AND NO SAVE. Every value and every handler is passed in, so
// the component that holds the draft decides what happens to it. That is also
// what makes this renderable in a test: the repository has no jsdom, so a
// component that owned its own state could only be proved by mounting a
// browser.
//
// THE JSX HERE WAS MOVED, NOT REWRITTEN. A render lock captured from the
// pre-extraction component (tests/components/machine-reading-entry-render.test.ts)
// pins the testids and the visible words in order, so a transcription slip
// fails rather than shipping as a layout change nobody chose.

export type SettingDraftFieldsProps = {
  profile: MachineProfile;
  mode: MachineMode;
  groups: SettingGroupDraft[];
  /** Monotonic, so a removed group's id is never reused. See `addGroup`. */
  groupOrdinal: number;
  /** Applies a change to the draft AND closes any open save. */
  editDraft: (f: (prev: SettingGroupDraft[]) => SettingGroupDraft[]) => void;
  /** Advances the monotonic ordinal, so a removed group's id is retired. */
  onAdvanceOrdinal: () => void;
  setValue: (groupId: string, key: string, value: string) => void;
  flipChannel: (groupId: string, channel: number) => void;
  /**
   * THE PAYLOAD IS FROZEN because a save's outcome is unknown.
   *
   * Every control here feeds a digest the database binds to a retry key, so
   * while an attempt is unresolved the thing being retried must not change.
   * Editing under the preserved key makes a committed first attempt refuse
   * the retry as a payload mismatch, and editing again mints a new key that
   * appends a duplicate capture (Codex, #860 4296029605 and 4296029608).
   *
   * ONE FLAG FOR BOTH SAVE PATHS. This component is the shared surface for
   * the initial save and for a revision, and both bind a digest, so the rule
   * is enforced here once rather than twice at the hosts.
   *
   * Defaults to false: a host that does not bind a retry key has nothing to
   * freeze.
   */
  frozen?: boolean;
};

export function SettingDraftFields({
  profile,
  mode,
  groups,
  groupOrdinal,
  editDraft,
  onAdvanceOrdinal,
  setValue,
  flipChannel,
  frozen = false,
}: SettingDraftFieldsProps) {
  const fieldGroups = nativeFieldGroups(profile, mode);
  const channels = channelChoices(profile);
  const canAdd = supportsDistinctGroups(profile);
  const readiness = groups.map((g) => groupReadiness(fieldGroups, g));

  return (
    <>
      {mode.captureHold && (
        <p role="status" className="text-sm text-neutral-600" data-testid="native-control-pending">
          {mode.captureHold}
        </p>
      )}
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
              {/*
                NO PER-GROUP OUTCOME BADGE ANY MORE. "recorded" and "outcome
                unknown" described a state that one atomic save cannot reach:
                a group cannot be recorded while its neighbour is not. Leaving
                them would be a UI that can report a mixed outcome the
                database can no longer produce.
              */}
              {readiness[settingIndex] === "empty" && (
                <Button
                  type="button"
                  variant="quiet"
                  size="sm"
                  onClick={() =>
                    editDraft((prev) => prev.filter((g) => g.id !== setting.id))
                  }
                  disabled={frozen}
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
                      disabled={frozen}
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
                      {f.valueKind === "choice" ? (
                        <select
                          value={setting.values[k] ?? ""}
                          onChange={(e) => setValue(setting.id, k, e.target.value)}
                          disabled={frozen}
                          data-testid={groups.length > 1 ? `reading-${setting.id}-${f.key}` : `reading-${f.key}`}
                          className="min-h-[44px] rounded-md border border-neutral-300 px-3 py-2 text-base pointer-fine:text-sm"
                        >
                          <option value="">Choose…</option>
                          {f.choices?.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
                        </select>
                      ) : <input
                        type={f.valueKind === "text" ? "text" : "number"}
                        inputMode={f.valueKind === "text" ? "text" : "decimal"}
                        step={f.valueKind === "text" ? undefined : f.decimals === 0 ? 1 : 1 / 10 ** f.decimals}
                        // NOT DISABLED by `editable: false`: that flag means
                        // she cannot change the value ON THE MACHINE, not that
                        // it cannot be charted, and nothing else populates it
                        // (Codex, 15cc6c99).
                        value={setting.values[k] ?? ""}
                        onChange={(e) => setValue(setting.id, k, e.target.value)}
                        // FROZEN is a different reason from `editable: false`
                        // above, and the comment there is why both exist:
                        // that flag is about the MACHINE, this is about an
                        // in-flight save whose payload must not move.
                        disabled={frozen}
                        data-testid={
                          groups.length > 1
                            ? `reading-${setting.id}-${f.key}`
                            : `reading-${f.key}`
                        }
                        className="min-h-[44px] rounded-md border border-neutral-300 px-3 py-2 text-base pointer-fine:text-sm dark:border-neutral-700 dark:bg-neutral-950"
                      />}
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
      {/*
        WHY EVERYTHING IS DEAD. A disabled form with no reason given reads as
        a broken page, and the recovery she needs is one specific action -
        press Save again, unchanged. The host's own alert says that; this
        says why she cannot type meanwhile, next to the controls that stopped
        responding.
      */}
      {frozen && (
        <p
          className="text-xs text-amber-700 dark:text-amber-500"
          role="status"
          data-testid="setting-draft-frozen"
        >
          These settings are held while the last save is confirmed. The values
          cannot change until then, because the retry has to be the same save —
          editing would make it a new one.
        </p>
      )}

      {canAdd && (
        <div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              editDraft((prev) => addGroup(prev, groupOrdinal + 1));
              onAdvanceOrdinal();
            }}
            disabled={frozen}
            data-testid="setting-group-add"
          >
            Add setting group
          </Button>
        </div>
      )}
    </>
  );
}
