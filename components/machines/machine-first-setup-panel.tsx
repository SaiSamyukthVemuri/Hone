"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { FieldLabel, fieldControlClass } from "@/components/ui/field";
import { SectionLabel } from "@/components/ui/section-label";
import { MACHINE_CATALOGUE } from "@/lib/machines/catalogue";
import {
  initialSelection,
  selectionRequested,
  selectionSettled,
  unusableSelection,
  type SelectionState,
} from "@/lib/machines/selection-state";
import {
  NO_PERSISTENCE,
  type PersistenceCapability,
} from "@/lib/machines/selection-store";
import type {
  ReadingSubmission,
  RecordedReading,
} from "@/lib/machines/machine-queries";
import { MachineReadingEntry } from "./machine-reading-entry";
import { MachinePriorSetup } from "./machine-prior-setup";
import { MachineRecordedSetups } from "./machine-recorded-setups";
import {
  MachineSettingDraft,
  MachineSettingDraftReset,
} from "./machine-setting-draft";
import type { GroupSubmission } from "@/lib/machines/setting-groups";
import type { PendingSetupIdentity } from "@/lib/machines/pending-setup";
import type { MachineProfile } from "@/lib/machines/profile-contract";
import { nativeFieldGroups } from "@/lib/machines/charting";
import {
  selectableDevices,
  supportedModes,
  type SelectionScope,
  type StudioDevice,
} from "@/lib/machines/selection";

// MPX-03 mount. The machine-first panel that heads treatment setup.
//
// WHAT IT DOES TODAY, AND WHY IT CLAIMS NO MORE. The practitioner picks the
// physical studio machine before entering settings, and the panel then shows
// that exact model's own fields, under the machine's labels and units, in the
// machine's grouping. Models whose evidence is incomplete are listed with the
// reason they are withheld, because a picker that silently omits a studio's
// actual machine looks broken, while one that offers it would be claiming
// verification nobody did.
//
// IT IS A DISPLAY SURFACE, NOT A SECOND RECORD. It renders the field contract;
// it does not collect readings. That is deliberate rather than unfinished: the
// readings columns are MPX-02 work, and a clinical form that accepted numbers
// and then discarded them would be worse than one that does not ask. The
// existing charting fields below this panel remain the record and are untouched.
//
// THREE STATUSES ARE STATED IN THE UI ITSELF, not just in this comment:
// whether any model is selectable, whether the choice is remembered between
// visits, and whether anything here is stored. All three are currently
// negative, and saying so is the point - see `PersistenceStatus` below.
//
// Server-safe to render: `useState` has an initial value, so
// `renderToStaticMarkup` produces the real markup the tests assert on.

export type MachineFirstSetupPanelProps = {
  /**
   * The studio's registered physical machines. There is no device registry
   * table yet, so the host surface passes none and the panel says so.
   */
  devices?: readonly StudioDevice[];
  /**
   * Which practitioner in which studio. `null` when the host surface does not
   * know - which is the case in the session charting form today, since
   * BlockSetupForm receives neither id.
   */
  scope?: SelectionScope | null;
  /** Pre-selected device, so a server render can show the chosen state. */
  initialDeviceId?: string | null;
  /**
   * The remembered MODE, which the loader resolves and nothing used.
   *
   * Without it the panel always took `activeModes(profile)[0]`, so for any
   * profile with more than one active mode it rendered and RECORDED the wrong
   * field contract - the practitioner's remembered choice was resolved on the
   * server and then discarded (Codex, 15cc6c99).
   */
  initialModeKey?: string | null;
  /**
   * A stored machine that CANNOT be used, with the reason, when the server
   * resolved one. Mutually exclusive with `initialDeviceId`: the loader sets
   * one or the other, never both, because a selection is either usable or it
   * is this. Supplying it shows nothing chosen AND says why, instead of
   * leaving the practitioner with an empty picker and a status line claiming a
   * machine is remembered (Codex, 1a39a51f).
   */
  unavailableSelection?: { deviceId: string; reason: string } | null;
  /**
   * Recorded unit id -> the studio's name for it, for next-visit guidance.
   * Resolved on the server, where retired units are visible.
   */
  unitNames?: Readonly<Record<string, string>>;
  /** Injectable for tests and for a future studio-scoped catalogue. */
  catalogue?: readonly MachineProfile[];
  /**
   * What the backing store can actually do. The default is the truth on the
   * server today: nothing persists. A test double passes its own capability so
   * a test-store render can never read as production persistence.
   */
  persistence?: PersistenceCapability;
  /**
   * Set when there is nothing to offer and the reason is worth showing - an
   * empty studio and an unreadable inventory are different situations.
   */
  inventoryReason?: string | null;
  /** The treatment block being charted. Entry is impossible without it. */
  blockId?: string | null;
  /**
   * Collect settings in CREATE mode, before any block exists.
   *
   * SUPPLIED ONLY BY A HOST THAT CAN CARRY THEM. Without it the panel shows
   * the model's field contract read-only, exactly as before, because there is
   * nowhere to put a reading - and a form that collected one would have to
   * discard it. With it, the host's own Save writes the area and these
   * settings in one transaction through `create_block_with_initial_setup`.
   */
  /** The host form's save is unresolved, so the create-mode draft is frozen. */
  settingDraftFrozen?: boolean;
  /**
   * Report that a REVISION save's outcome is unknown, so the HOST can freeze
   * its own controls.
   *
   * The panel freezes what it owns. It cannot freeze the host form's Cancel,
   * and that is the control whose use destroys the retry key by unmounting
   * the entry (Codex, #860 4302176844).
   */
  onRevisionUnresolved?: (unresolved: boolean) => void;
  onSettingDraft?: (
    draft: {
      groups: GroupSubmission[];
      blocking: string | null;
    /**
     * WHAT THE READINGS MEAN - device, profile, version and mode.
     *
     * Supplied by the PANEL rather than by the collector, which knows the
     * profile and the mode but not which physical unit is chosen. The host
     * needs all four: a draft typed under one machine and saved under
     * another is numbers she never read off anything, and
     * `pending-setup.ts` refuses exactly that comparison.
     */
      identity: PendingSetupIdentity;
    } | null,
  ) => void;
  /** Owner-only affordances appear only when the SERVER says so. */
  canManageMachines?: boolean;
  /** The studio's most recent recorded setup, for next-visit prep. */
  priorSetup?: RecordedReading[];
  /**
   * What is ALREADY RECORDED against this block.
   *
   * Closes the defect that a recorded capture was permanent and invisible:
   * after a page load the only thing she saw was nothing, so her options were
   * to re-record - appending a second immutable capture - or to guess.
   */
  recordedSetup?: RecordedReading[];
  /**
   * The next-visit GUIDANCE read failed, as distinct from this client having
   * no previous treatment. Same rule as the field below, different surface
   * and quieter copy: that one prevents a duplicate immutable capture, this
   * is reference she can work without.
   */
  priorSetupUnavailable?: boolean;
  /**
   * The recorded-captures read FAILED. Forwarded rather than flattened: an
   * empty list and an unreadable one must not look alike on this surface
   * (Codex, #860 4290452722).
   */
  recordedSetupUnavailable?: boolean;
  /**
   * Persists the chosen machine as this practitioner's default. Supplied by
   * the connected wrapper.
   *
   * WHY THIS PROP EXISTS. The buttons below used to call `setDeviceId` and
   * nothing else, so a choice lived only in React state: the panel reported
   * `data-persistence="database"` while the database default never changed,
   * and a refresh silently restored the previous selection. The store and the
   * action were both correct and tested - the UI simply never called them
   * (Codex, 9c6fbbe5).
   *
   * Passing `null` forgets the selection, which is the "Change machine" path.
   */
  onSelectMachine?: (choice: {
    deviceId: string | null;
    modeKey: string | null;
  }) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Records ONE SAVE - every settings group at once. Supplied by the connected
   * wrapper.
   *
   * It used to record one GROUP, and the entry form looped. The command is
   * atomic now, so the save is one call and a partial outcome is unreachable.
   */
  onRecord?: (input: {
    blockId: string;
    machineId: string;
    modeKey: string;
    idempotencyKey: string;
    groups: Array<{
      /**
       * EXACTLY ONE OF THE TWO (Codex, #860 4305780322). Forwarded unchanged:
       * the entry decided which kind of group each one is, and this panel has
       * no business reinterpreting an identity on its way through.
       */
      groupKey: string | null;
      newGroupRef: string | null;
      channels: number[];
      readings: ReadingSubmission[];
    }>;
    /**
     * The recorded group keys the entry's draft was built from, for the
     * staleness refusal (Codex, #860 4305780322). Forwarded unchanged; the
     * comparison is the action's.
     */
    expectedGroupKeys?: string[];
  }) => Promise<{
    ok: boolean;
    error?: string;
    captures?: number;
    written?: number;
    reused?: boolean;
  }>;
};

/** Every profile a practitioner might expect to see, with its real status. */
/**
 * The models this catalogue withholds, with the reason each is withheld.
 *
 * EXPORTED, though this file no longer renders it. The treatment form used to
 * list all eleven entries with their full evidence reasons, which Sam's
 * screenshot rejected as procurement detail in the middle of charting - but
 * the data is correct and someone deciding what to REGISTER needs exactly
 * this. It belongs on an owner or support machine-readiness surface, and this
 * is the seam for it (#860 6156583955).
 *
 * tests/components/machine-first-setup-panel.test.ts asserts both halves: that
 * charting does not render it, and that this still returns it.
 */
export function withheld(catalogue: readonly MachineProfile[]) {
  return catalogue
    .filter((p) => p.availability !== "active")
    .map((p) => ({
      key: p.profileId,
      name: `${p.manufacturer} ${p.model}${p.variant ? ` (${p.variant})` : ""}`,
      availability: p.availability,
      reason: p.availabilityReason ?? "Not offered for new capture.",
      openQuestions: p.openQuestions.length,
    }));
}

export function MachineFirstSetupPanel({
  devices = [],
  scope = null,
  initialDeviceId = null,
  initialModeKey = null,
  catalogue = MACHINE_CATALOGUE,
  persistence = NO_PERSISTENCE,
  inventoryReason = null,
  blockId = null,
  canManageMachines = false,
  priorSetup = [],
  recordedSetup = [],
  priorSetupUnavailable = false,
  recordedSetupUnavailable = false,
  onSettingDraft,
  settingDraftFrozen = false,
  onRevisionUnresolved,
  unavailableSelection = null,
  unitNames = {},
  onSelectMachine,
  onRecord,
}: MachineFirstSetupPanelProps) {
  // SELECTION, STORED FACT AND NOTE MOVE TOGETHER, under one rule.
  //
  // They were three independent useState calls, and the status line was wrong
  // twice because two of them drifted apart: `deviceId` is optimistic and
  // `persistedDeviceId` is not, so every branch of `chooseDevice` had to
  // remember which was which. The rule now lives in lib/machines/selection-state,
  // where it has an exhaustive truth table, and this component only applies it.
  // That module's header records both failures.
  /**
   * THE LATEST SELECTION WRITE. Overlapping picks are ordinary - she taps one
   * machine, changes her mind, taps another - and the two requests can finish
   * in either order. Every completion used to be applied, so an earlier one
   * finishing last restored the older device as selected AND persisted.
   *
   * A ref, not state: it must be readable by a handler that started before
   * the newer pick, and bumping it must not re-render.
   */
  const selectionRequestRef = useRef(0);
  /**
   * A SELECTION WRITE IS IN FLIGHT.
   *
   * THE TOKEN ALONE WAS NOT ENOUGH, and the second review said so plainly:
   * it runs AFTER `onSelectMachine` has already committed, so discarding the
   * stale answer only fixes the panel. The older write still reached
   * `set_own_default_machine`, so the UI showed her latest choice until a
   * reload brought the older one back (Codex, #860 4296709037, then
   * 4297032722 on the half-fix).
   *
   * Overlapping writes cannot be ordered from here - the client does not
   * control which request the database serves first - so they are not
   * allowed to overlap. The picker is disabled for the duration, which is
   * also the honest thing to show: the choice is not yet made.
   */
  const [selectionPending, setSelectionPending] = useState(false);
  /**
   * A REVISION SAVE'S OUTCOME IS UNKNOWN.
   *
   * `settingDraftFrozen` is the CREATE form's unresolved save, reported by
   * the host. This is the other save path — `MachineReadingEntry` on an
   * existing block — whose unresolved state lived only in that child, so
   * the identity controls stayed live through it (Codex, #860 4300759930).
   *
   * The two are kept separate and combined at the point of use rather than
   * merged into one flag, because they are reported by different owners
   * and either can be true alone.
   */
  const [revisionUnresolved, setRevisionUnresolved] = useState(false);

  // AND THE HOST IS TOLD (Codex, #860 4302176844).
  //
  // This state froze the panel's OWN identity controls from round 12, and
  // stayed here. The host form's Cancel button is outside the panel, checks
  // only the create-mode flag, and unmounting the entry is what destroys
  // the retry key - so the one control that can lose the key never saw the
  // state that should have frozen it.
  const reportUnresolved = useRef<boolean | null>(null);
  useEffect(() => {
    if (reportUnresolved.current === revisionUnresolved) return;
    reportUnresolved.current = revisionUnresolved;
    onRevisionUnresolved?.(revisionUnresolved);
  }, [revisionUnresolved, onRevisionUnresolved]);
  // EITHER SAVE PATH FREEZES THE IDENTITY. The machine and the mode are
  // part of the payload both digests are bound to, and switching away can
  // unmount the component holding a retry key.
  const identityFrozen = settingDraftFrozen || revisionUnresolved;
  const [selection, setSelection] = useState<SelectionState>(() =>
    // A stored machine that cannot be charted on is NOT a selection, but it is
    // still stored, and the reason has to be visible. `unusableSelection`
    // keeps all three facts straight; see lib/machines/selection-state.
    unavailableSelection
      ? unusableSelection(unavailableSelection.deviceId, unavailableSelection.reason)
      : initialSelection(initialDeviceId),
  );
  const deviceId = selection.selected;
  const selectionNote = selection.note;
  // THE MODE IN FORCE. Seeded from the remembered one; falls back to the
  // profile's first active mode, which is all this used to do.
  const [modeKey, setModeKey] = useState<string | null>(initialModeKey);
  // How many readings this panel has actually saved in this mount. Drives the
  // "Recorded:" line, which previously claimed "nothing" even after a save.
  const [savedCount, setSavedCount] = useState(0);
  /**
   * Choose (or clear) the machine.
   *
   * A failed persist must be VISIBLE: the choice still applies to this block,
   * but it will not survive a reload, and saying nothing is what made the old
   * behaviour look like it had worked.
   */
  const chooseDevice = async (next: string | null) => {
    // THE MODE IS RESET TO THE NEW DEVICE'S OWN FIRST MODE. Carrying the
    // previous one over would persist a key from a different profile, which
    // means nothing - a mode exists only within the profile that declares it.
    const nextPick =
      next === null ? undefined : selectable.find((s) => s.device.deviceId === next);
    const nextMode = nextPick
      ? (supportedModes(nextPick.device, nextPick.profile)[0]?.key ?? null)
      : null;
    setModeKey(nextMode);
    // Step 1: the optimistic move, so the form stays responsive.
    setSelection((prev) => selectionRequested(prev, next));
    // Step 2: the acknowledged outcome. `null` means no persister is wired,
    // which is NOT the same as a successful write and must not be reported as
    // one - `selectionSettled` is what keeps those apart.
    // Step 2: the acknowledged outcome, APPLIED ONLY IF THIS IS STILL THE
    // LATEST REQUEST. Two picks in quick succession overlap, and the server
    // answers in whatever order it finishes: without this, an earlier
    // request completing last restored the OLDER device as both selected and
    // persisted, so the panel and the stored selection both disagreed with
    // what she last chose (Codex, #860 4296709037).
    const token = ++selectionRequestRef.current;
    setSelectionPending(true);
    let write: Awaited<ReturnType<NonNullable<typeof onSelectMachine>>> | null = null;
    try {
      write = onSelectMachine
        ? await onSelectMachine({ deviceId: next, modeKey: nextMode })
        : null;
    } catch (cause) {
      // A REJECTION IS A FAILED WRITE, not an absence of one.
      //
      // `finally` cleared the pending flag but the throw skipped
      // `selectionSettled` entirely, so the optimistic choice stayed on
      // screen with NO failure note while the database still held the
      // previous default — and a reload silently restored the old machine
      // (Codex, #860 4299408386). An unreachable server is the ordinary
      // case here, not an exotic one.
      //
      // Settled as `{ ok: false }` so it travels the SAME path a refusal
      // does: one definition of "the write did not happen", not two.
      write = {
        ok: false,
        error: cause instanceof Error ? cause.message : "That did not save.",
      };
    } finally {
      // CLEARED EVEN ON A THROW, or one failed write leaves the picker dead
      // for the rest of the treatment.
      setSelectionPending(false);
    }
    if (token !== selectionRequestRef.current) return;
    setSelection((prev) => selectionSettled(prev, next, write));
  };

  /**
   * Choose the MODE on the machine already chosen.
   *
   * Routed through the same rule as the device, so a failed persist is
   * reported the same way rather than silently kept: the mode applies to this
   * block either way, but it will not survive a reload.
   */
  const chooseMode = async (key: string) => {
    setModeKey(key);
    setSelection((prev) => selectionRequested(prev, deviceId));
    // SAME TOKEN AS THE DEVICE PICK, deliberately: a mode change and a device
    // change are both writes to one stored selection, so a stale mode
    // completion must not land after a newer device pick either. Two counters
    // would let exactly that through.
    const token = ++selectionRequestRef.current;
    setSelectionPending(true);
    let write: Awaited<ReturnType<NonNullable<typeof onSelectMachine>>> | null = null;
    try {
      write = onSelectMachine
        ? await onSelectMachine({ deviceId, modeKey: key })
        : null;
    } catch (cause) {
      // Same rule as the device pick: a rejection is a failed write.
      write = {
        ok: false,
        error: cause instanceof Error ? cause.message : "That did not save.",
      };
    } finally {
      setSelectionPending(false);
    }
    if (token !== selectionRequestRef.current) return;
    setSelection((prev) => selectionSettled(prev, deviceId, write));
  };

  // Only a real scope can produce a selectable list, because a device belongs
  // to a studio and the filter is studio-scoped. Without identity the panel
  // shows the catalogue status and nothing else, rather than guessing.
  const selectable = scope ? selectableDevices(scope, devices, catalogue) : [];
  const chosen = selectable.find((s) => s.device.deviceId === deviceId) ?? null;
  // A MODE KEY IS ONLY MEANINGFUL WITHIN ONE PROFILE, so an unrecognised one
  // falls back rather than blanking the panel: a remembered mode can outlive
  // the machine it was chosen on.
  // FROM THE PHYSICAL UNIT, not the model: a mode gated on an option this
  // device does not have is not a choice, and offering it only to have the
  // capture refused two layers down is worse than not offering it.
  const modes = chosen ? supportedModes(chosen.device, chosen.profile) : [];
  const mode = modes.find((m) => m.key === modeKey) ?? modes[0] ?? null;
  const groups = chosen && mode ? nativeFieldGroups(chosen.profile, mode) : [];

  /**
   * onRecord, plus the one side effect the status line needs. Counting here
   * rather than inside MachineReadingEntry keeps the claim and its evidence in
   * the same component: the panel may only say something was recorded if a
   * save it issued actually returned ok.
   */
  const recordAndCount: typeof onRecord = onRecord
    ? async (input) => {
        const out = await onRecord(input);
        if (out.ok) {
          // THE DATABASE'S OWN COUNT where it gave one, and it does. Summing
          // what was SENT is wrong on a reused submission: that call wrote
          // nothing, and the readings it reports are the ones the earlier
          // attempt recorded - which is the true answer and the one this
          // status line must show.
          const written =
            out.written ??
            input.groups.reduce((n, g) => n + g.readings.length, 0);
          setSavedCount((n) => n + written);
        }
        return out;
      }
    : undefined;

  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900"
      aria-labelledby="machine-first-heading"
      data-testid="machine-first-panel"
    >
      <div className="flex items-baseline justify-between gap-2">
        <SectionLabel as="h3" className="!text-neutral-700 dark:!text-neutral-300">
          <span id="machine-first-heading">Machine</span>
        </SectionLabel>
        {/*
          NO "CHANGE MACHINE" LINK ANY MORE. The dropdown below is always
          visible, so switching is just choosing a different option and
          clearing is choosing "Choose machine". A separate link would be a
          second way to do what the control already does.
        */}
      </div>

      {/*
        THE MACHINE DROPDOWN - compact, labelled, and ALWAYS VISIBLE.
        Sam's correction (19:16, recorded at #860 6156583955): "it should be a
        dropdown to select the machine then each machine's settings show up so
        we can do live charting."

        WHAT IT REPLACED: a row of pills that disappeared once something was
        chosen, with a separate "Change machine" link to get back. For a studio
        with several units that is a worse control than a list, and it hid the
        current choice behind a mode change.

        It lists the studio's own USABLE units - `selectableDevices` already
        excludes retired units, other studios' units, unknown or inactive
        profiles and stale contract versions - with the unit's own name first
        and the model qualifying it, because a studio names its rooms and two
        rooms can hold the same model.

        SHARED CONTROLS, not a hand-rolled select: `fieldControlClass` carries
        the 44px floor, the 16px type that stops iOS zooming on focus, the
        focus ring and the disabled treatment, and `FieldLabel` carries the
        label and required marker. The pills it replaced were hand-rolled at
        about 36px, under DESIGN.md LAW 6.
      */}
      {scope && (
        <FieldLabel
          label="Machine"
          hint={
            selectable.length === 0
              ? (inventoryReason ??
                "No verified machine is available for this studio yet.")
              : undefined
          }
        >
          <select
            className={fieldControlClass()}
            value={deviceId ?? ""}
            onChange={(e) => void chooseDevice(e.target.value || null)}
            // FROZEN BY THE HOST'S UNRESOLVED SAVE TOO, not only by a
            // selection write in flight.
            //
            // Round 6 froze the reading collector and I reported the
            // invariant closed; `settingDraftFrozen` was never applied to
            // the IDENTITY controls (Codex, #860 4299408376). What that
            // cost: clearing the machine replaces the host's draft with
            // null while the retry key is held, so Save retries down the
            // non-setup `create_block_with_entry` path and duplicates the
            // area if the first request committed. Switching instead
            // changes the payload and the digest refuses the retry.
            //
            // The machine and the mode are PART OF THE PAYLOAD the retry
            // key is bound to. A freeze that covers the readings and not
            // the identity is not a freeze.
            disabled={
              selectable.length === 0 || selectionPending || identityFrozen
            }
            data-testid="machine-select"
          >
            {/*
              THE EMPTY OPTION IS THE EXPLICIT "not chosen" STATE, and it is
              also how a selection is cleared. It stays present after a choice
              so clearing remains reachable.
            */}
            <option value="">Choose machine…</option>
            {selectable.map(({ device, profile }) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.displayName} — {profile.manufacturer} {profile.model}
                {profile.variant ? ` (${profile.variant})` : ""}
              </option>
            ))}
          </select>
        </FieldLabel>
      )}

      {/* Selection. An empty list is a legitimate answer and says why. */}
      {/*
        THE FAILURE NOTE LIVES ABOVE THE BRANCH, deliberately.
        It used to render only inside the chosen-machine block, so a failed
        CLEAR - which leaves nothing chosen - hid the very error that mattered
        most: the practitioner believes the machine is no longer remembered
        while the database default is still there (Codex, 7cae831b).
      */}
      {selectionNote && (
        <p
          className="text-xs text-amber-700 dark:text-amber-500"
          role="status"
          data-testid="machine-selection-not-remembered"
        >
          {selectionNote}
        </p>
      )}
      {/*
        NO COLLECTOR, NO DRAFT - AND THIS MUST LIVE ABOVE THE BRANCH, for the
        same reason the failure note above it does.
        ------------------------------------------------------------------
        It was nested inside the chosen-machine arm, and from there it could
        never fire on the one case it was written for. Clearing the machine
        takes the `!chosen` arm, so the whole subtree - this component included
        - unmounts, nothing reports, and the host form keeps the non-empty
        draft it was last told about. Press Save then and the readings are
        recorded under the PREVIOUSLY selected machine, as an immutable
        capture: numbers she never read off the unit now chosen, and no unit
        chosen at all (Codex, #860 4288424506).
        ------------------------------------------------------------------
        THE PRECEDENT WAS ALREADY IN THIS FILE, ten lines up: the selection
        note was moved above the branch because rendering it inside the
        chosen-machine block hid a failed CLEAR, which is the identical shape.
        I read that comment, wrote the same defect underneath it, and the
        earlier widening missed it too - it covered switch, mode and retire,
        and clearing to none is a fourth limb.
        ------------------------------------------------------------------
        The condition is unchanged - `!(chosen && mode)` already covered
        "nothing chosen"; only its position was wrong. It renders nothing, so
        sitting here costs nothing.
      */}
      {!blockId && onSettingDraft && !(chosen && mode) && (
        <MachineSettingDraftReset onSettingDraft={onSettingDraft} />
      )}
      {selectable.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          No verified machine is available to select yet.{" "}
          {!scope
            ? "This surface does not yet know which practitioner and studio is charting, so no machine list can be scoped to it."
            : (inventoryReason ??
              "This studio has no registered machine on a reviewed profile.")}
        </p>
      ) : !chosen ? (
        /*
          NOTHING CHOSEN YET - and the prompt is all this arm needs now.
          The pill row that used to live here is gone: the labelled dropdown
          above is always visible and does the same job better for a studio
          with more than one unit. Keeping both would give the form two
          controls for one decision, which is the "additional conflicting
          set" the assignment rules out (#860 6156583955).
        */
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Choose the machine you are working on, and its own settings appear
          here.
        </p>
      ) : (
        <div className="flex flex-col gap-3" data-testid="machine-chosen">
          <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            {chosen.device.displayName}
            <span className="ml-2 font-normal text-neutral-600 dark:text-neutral-400">
              {chosen.profile.manufacturer} {chosen.profile.model}
              {chosen.profile.variant ? ` (${chosen.profile.variant})` : ""}
              {mode ? ` - ${mode.nativeLabel}` : ""}
            </span>
          </p>

          {/*
            THE MODE PICKER, shown only when the machine offers a choice.
            One active mode needs no control; the heading above already names
            it. More than one and the practitioner must be able to say which,
            because the field contract - the labels, units and precision below
            - is per MODE, not per machine.
          */}
          {modes.length > 1 && (
            <div className="flex flex-col gap-1.5" data-testid="machine-mode-picker">
              <SectionLabel size="caption">Mode</SectionLabel>
              {/*
                THE SHARED PRIMITIVE, not hand-rolled pills.
                My first version was `text-xs py-1.5` with no minimum height -
                about 28px on a touch device, against DESIGN.md LAW 6's 44px
                floor. Button's `sm` size composes CONTROL_COMPACT_FINE_POINTER,
                which keeps the full 44px on every coarse pointer and relaxes to
                32px only behind the repository's explicit `pointer-fine` gate.
                The rule belongs in the primitive; a call site can forget it,
                and this one did (Codex, ebc69ff6).
              */}
              <div className="flex flex-wrap gap-2">
                {modes.map((m) => (
                  <Button
                    key={m.key}
                    type="button"
                    variant={m.key === mode?.key ? "primary" : "secondary"}
                    size="sm"
                    onClick={() => void chooseMode(m.key)}
                    // SERIALISED WITH THE DEVICE PICKER, from one flag: a
                    // mode change and a device change both write the same
                    // stored selection, so letting one start while the other
                    // is in flight is the same race by another route.
                    // Same freeze as the machine picker: the mode is part
                    // of the digest the held retry key is bound to.
                    disabled={selectionPending || identityFrozen}
                    aria-pressed={m.key === mode?.key}
                    data-testid={`machine-mode-${m.key}`}
                  >
                    {m.nativeLabel}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {/* The machine's own fields, in the machine's own grouping. Rendered
              as the model's contract: label, native unit and the precision the
              record will preserve. No inputs - see the file header. */}
          {/* ENTRY when we know which block is being charted; otherwise the
              field contract as a read-only reference. The panel never collects
              a reading it has nowhere to put. */}
          {/*
            THREE ARMS, and the middle one is new.
              block + a recorder -> record against it (MachineReadingEntry);
              NO block + a host that can carry a draft -> collect it;
              otherwise -> the field contract, read-only.
            The third is unchanged and is still the honest answer when nothing
            can carry a reading: the panel never collects one it has nowhere
            to put.
          */}
          {/*
            THE DRAFT RESET USED TO SIT HERE, and it could not do its job from
            inside this branch. See the hoisted copy above the branch.
          */}
          {!blockId && onSettingDraft && mode ? (
            <MachineSettingDraft
              // Same payload, same freeze — see block-setup-form.
              frozen={settingDraftFrozen}
              // REMOUNTED WHEN THE IDENTITY CHANGES, for the same reason the
              // entry form is: the draft is keyed by group, stage and field
              // and NOT by mode, so two modes sharing a field identity would
              // otherwise let a value typed under one be submitted under the
              // other without being re-read (Codex, ebc69ff6).
              key={`${chosen.device.deviceId}::${chosen.profile.profileId}::${chosen.profile.version}::${mode.key}`}
              profile={chosen.profile}
              mode={mode}
              // THE IDENTITY IS ADDED HERE, where the chosen unit is known.
              onDraftChange={(d) =>
                onSettingDraft({
                  ...d,
                  identity: {
                    deviceId: chosen.device.deviceId,
                    profileId: chosen.profile.profileId,
                    profileVersion: chosen.profile.version,
                    modeKey: mode.key,
                  },
                })
              }
            />
          ) : blockId && recordAndCount && mode && !recordedSetupUnavailable ? (
            <MachineReadingEntry
              // REMOUNTED WHEN THE IDENTITY CHANGES, which is the whole fix.
              //
              // The draft is keyed by group, stage and field - NOT by mode - so
              // when two modes reuse a field identity (the galvanic and adjunct
              // fixtures both declare `current`) a value typed under the old
              // mode stayed in the box and could be submitted under the NEW
              // mode's key without being re-read. Changing the mode changed
              // only `modeKey`; React kept the same component mounted with the
              // same draft. A number the practitioner entered for one mode
              // would have been stored as a reading for another
              // (Codex, ebc69ff6).
              //
              // The key covers device, profile version and mode because all
              // three change what the fields MEAN. Historical captures are
              // untouched - this clears an unsaved draft, never a stored row.
              key={`${chosen.device.deviceId}::${chosen.profile.profileId}::${chosen.profile.version}::${mode.key}`}
              profile={chosen.profile}
              mode={mode}
              blockId={blockId}
              deviceId={chosen.device.deviceId}
              // THE IDENTITIES THE BLOCK ALREADY HAS. The same list rendered
              // below as history, handed to the form for the one thing the
              // history cannot do: tell it which probes exist, so a change is
              // attributed to the one it was made on. `groupsFromRecorded`
              // scopes it to this mount's device, version and mode.
              recordedGroups={recordedSetup}
              // The revision path's half of the freeze: the entry owns that
              // save's state, and the controls that can discard its retry
              // key are out here.
              onUnresolvedChange={setRevisionUnresolved}
              onRecord={recordAndCount!}
            />
          ) : (
            groups.map((group) => (
            <div key={group.key} className="flex flex-col gap-1.5">
              <SectionLabel size="caption">{group.label}</SectionLabel>
              <ul className="flex flex-col gap-1">
                {group.fields.map((f) => (
                  <li
                    key={`${group.key}:${f.key}`}
                    className="text-sm text-neutral-700 dark:text-neutral-300"
                  >
                    {/*
                      TESTIDS ON THE LABEL AND UNIT, not because a test is
                      fussy, but because the field's advisory notes legitimately
                      contain the field's own name - "Current is documented in
                      microamps..." - so a page-wide getByText("Current") is a
                      3-way strict-mode violation. Targeting the label by
                      identity also makes the assertion mean what it says: the
                      MACHINE'S OWN label and unit are rendered, which prose
                      mentioning the word cannot satisfy.
                    */}
                    <span
                      className="font-medium"
                      data-testid={`field-label-${f.key}`}
                    >
                      {f.label}
                    </span>
                    {f.unit && (
                      <span
                        className="ml-1 text-neutral-500"
                        data-testid={`field-unit-${f.key}`}
                      >
                        ({f.unit})
                      </span>
                    )}
                    <span className="ml-2 text-xs text-neutral-500">
                      {f.decimals === 0
                        ? "whole numbers"
                        : `${f.decimals} decimal place${f.decimals === 1 ? "" : "s"}`}
                      {f.optional ? ", optional" : ""}
                      {f.editable ? "" : ", shown by the machine"}
                    </span>
                    {f.advisory.map((note, i) => (
                      <span
                        key={i}
                        className="mt-0.5 block text-xs text-neutral-500"
                      >
                        {note}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
            ))
          )}
        </div>
      )}

      {/*
        THE WITHHELD-MODEL CATALOGUE IS GONE FROM THE TREATMENT FORM.

        This rendered every unverified model in the catalogue with its full
        evidence reason - firmware conflicts, unread operating screens,
        403ing manuals - eleven entries deep. On a charting form, during a
        treatment, that is a wall of procurement detail between the
        practitioner and the fields she is trying to fill, and Sam's screenshot
        said so ("this looks weird ... is this all prepopulated").

        The information is not deleted: it is `withheld(catalogue)`, still
        computed from the same contract, and belongs on an owner or support
        machine-readiness surface where someone is actually deciding what to
        register. What charting needs is a concise reason when there is
        nothing to choose and a useful next action, which is the hint on the
        dropdown above and the owner line below (#860 6156583955).
      */}

      {canManageMachines && selectable.length === 0 && scope && (
        <p
          className="text-xs text-neutral-600 dark:text-neutral-400"
          data-testid="machine-owner-hint"
        >
          You own this studio, so you can register its machines. Only models
          that have passed their evidence review can be registered.
        </p>
      )}

      {/*
        WHAT SHE HAS ALREADY RECORDED TODAY, ABOVE what she did last time, and
        both above the entry fields. The order is the order of the questions
        she actually asks: which machine, what have I already recorded on this
        treatment, what did she have last time, and then what am I entering
        now. Putting today's record below last visit's reference would bury
        the one that stops a double capture.
      */}
      <MachineRecordedSetups
        readings={recordedSetup}
        catalogue={catalogue}
        unitNames={unitNames}
        unavailable={recordedSetupUnavailable}
      />

      <MachinePriorSetup
        readings={priorSetup}
        // AND WHETHER THAT READ FAILED. Without this the component cannot
        // tell "no previous treatment" from "could not find out", and the
        // quieter of the two renders as silence.
        unavailable={priorSetupUnavailable}
        catalogue={catalogue}
        unitNames={unitNames}
      />

      <PersistenceStatus
        hasScope={scope != null}
        persistence={persistence}
        savedCount={savedCount}
        rememberedDeviceId={selection.persisted}
      />
    </section>
  );
}

/**
 * What is and is not actually saved.
 *
 * Shown in the UI rather than left to a comment, because a demo audience and a
 * practitioner both reasonably assume a panel that lets you choose something
 * remembers it. Neither statement here is a limitation to be fixed before this
 * ships - they are the honest status of the slice, and they disappear when the
 * storage work lands.
 */
function PersistenceStatus({
  hasScope,
  persistence,
  savedCount,
  rememberedDeviceId,
}: {
  hasScope: boolean;
  persistence: PersistenceCapability;
  /** Readings this panel has actually saved, so the line below is derived. */
  savedCount: number;
  /**
   * The machine ACTUALLY remembered right now, or null.
   *
   * Separate from `persistence` on purpose. `persistence.persisted` says the
   * store CAN keep a choice; it says nothing about whether one exists. Reading
   * the answer off the capability made this line claim "Remembered: yes" for
   * every authenticated practitioner with a working database - before any
   * machine was chosen, and immediately after the selection was cleared
   * (Codex, a66f5ec9).
   */
  rememberedDeviceId: string | null;
}) {
  return (
    <dl
      className="flex flex-col gap-1 border-t border-neutral-200 pt-3 text-xs text-neutral-500 dark:border-neutral-800"
      data-testid="machine-first-status"
      data-persistence={persistence.kind}
    >
      <div className="flex gap-1.5">
        <dt className="font-medium">Remembered:</dt>
        {persistence.persisted ? (
          <dd>
            {persistence.kind === "test-store"
              ? "test store only. Not a database, and never reported to a practitioner."
              : rememberedDeviceId
                ? "yes, for you in this studio."
                : "nothing yet. The machine you choose will be kept for you in this studio."}
          </dd>
        ) : (
          <dd>
            no. {persistence.reason}{" "}
            {hasScope
              ? ""
              : "This surface does not know which practitioner and studio is charting either."}
          </dd>
        )}
      </div>
      <div className="flex gap-1.5">
        <dt className="font-medium">Recorded:</dt>
        <dd>
          {/*
            This line used to say "nothing from this panel" unconditionally,
            which stopped being true the moment reading entry shipped: after a
            successful save it contradicted both the success message and the
            rows actually inserted, leaving a practitioner unsure whether the
            settings were stored (Codex, 9c6fbbe5).
          */}
          {savedCount > 0
            ? `${savedCount} setting${savedCount === 1 ? "" : "s"} saved to this block's machine record. The treatment fields below are separate and unchanged.`
            : "nothing from this panel yet. The treatment fields below are unchanged and remain the record."}
        </dd>
      </div>
    </dl>
  );
}
