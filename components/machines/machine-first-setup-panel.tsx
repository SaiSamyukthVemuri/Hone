"use client";

import { useState } from "react";

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
import type { MachineProfile } from "@/lib/machines/profile-contract";
import { activeModes } from "@/lib/machines/profile-contract";
import { nativeFieldGroups } from "@/lib/machines/charting";
import {
  selectableDevices,
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
  priorUnitNames?: Readonly<Record<string, string>>;
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
  /** Owner-only affordances appear only when the SERVER says so. */
  canManageMachines?: boolean;
  /** The studio's most recent recorded setup, for next-visit prep. */
  priorSetup?: RecordedReading[];
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
  /** Records one settings group. Supplied by the connected wrapper. */
  onRecord?: (input: {
    blockId: string;
    machineId: string;
    modeKey: string;
    groupKey: string;
    channels: number[];
    readings: ReadingSubmission[];
  }) => Promise<{ ok: boolean; error?: string }>;
};

/** Every profile a practitioner might expect to see, with its real status. */
function withheld(catalogue: readonly MachineProfile[]) {
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
  catalogue = MACHINE_CATALOGUE,
  persistence = NO_PERSISTENCE,
  inventoryReason = null,
  blockId = null,
  canManageMachines = false,
  priorSetup = [],
  unavailableSelection = null,
  priorUnitNames = {},
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
    // Step 1: the optimistic move, so the form stays responsive.
    setSelection((prev) => selectionRequested(prev, next));
    // Step 2: the acknowledged outcome. `null` means no persister is wired,
    // which is NOT the same as a successful write and must not be reported as
    // one - `selectionSettled` is what keeps those apart.
    const write = onSelectMachine
      ? await onSelectMachine({ deviceId: next, modeKey: null })
      : null;
    setSelection((prev) => selectionSettled(prev, next, write));
  };

  // Only a real scope can produce a selectable list, because a device belongs
  // to a studio and the filter is studio-scoped. Without identity the panel
  // shows the catalogue status and nothing else, rather than guessing.
  const selectable = scope ? selectableDevices(scope, devices, catalogue) : [];
  const chosen = selectable.find((s) => s.device.deviceId === deviceId) ?? null;
  const mode = chosen ? (activeModes(chosen.profile)[0] ?? null) : null;
  const groups = chosen && mode ? nativeFieldGroups(chosen.profile, mode) : [];
  const blocked = withheld(catalogue);

  /**
   * onRecord, plus the one side effect the status line needs. Counting here
   * rather than inside MachineReadingEntry keeps the claim and its evidence in
   * the same component: the panel may only say something was recorded if a
   * save it issued actually returned ok.
   */
  const recordAndCount: typeof onRecord = onRecord
    ? async (input) => {
        const out = await onRecord(input);
        if (out.ok) setSavedCount((n) => n + input.readings.length);
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
        {chosen && (
          <button
            type="button"
            onClick={() => void chooseDevice(null)}
            data-testid="machine-change"
            className="text-xs font-medium text-neutral-600 underline hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
          >
            Change machine
          </button>
        )}
      </div>

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
      {selectable.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          No verified machine is available to select yet.{" "}
          {!scope
            ? "This surface does not yet know which practitioner and studio is charting, so no machine list can be scoped to it."
            : (inventoryReason ??
              "This studio has no registered machine on a reviewed profile.")}
        </p>
      ) : !chosen ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Choose the machine you are working on before entering settings.
          </p>
          <div className="flex flex-wrap gap-2">
            {selectable.map(({ device, profile }) => (
              <button
                key={device.deviceId}
                type="button"
                onClick={() => void chooseDevice(device.deviceId)}
                data-testid={`machine-pick-${device.deviceId}`}
                className="rounded-full border border-neutral-300 bg-white px-4 py-2 text-sm text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300"
              >
                {device.displayName}
                <span className="ml-1.5 text-neutral-500">
                  {profile.manufacturer} {profile.model}
                </span>
              </button>
            ))}
          </div>
        </div>
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

          {/* The machine's own fields, in the machine's own grouping. Rendered
              as the model's contract: label, native unit and the precision the
              record will preserve. No inputs - see the file header. */}
          {/* ENTRY when we know which block is being charted; otherwise the
              field contract as a read-only reference. The panel never collects
              a reading it has nowhere to put. */}
          {blockId && recordAndCount && mode ? (
            <MachineReadingEntry
              profile={chosen.profile}
              mode={mode}
              blockId={blockId}
              deviceId={chosen.device.deviceId}
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

      {blocked.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <SectionLabel size="caption">Not yet selectable</SectionLabel>
          <ul className="flex flex-col gap-1.5">
            {blocked.map((b) => (
              <li
                key={b.key}
                className="text-xs text-neutral-600 dark:text-neutral-400"
              >
                <span className="font-medium text-neutral-800 dark:text-neutral-200">
                  {b.name}
                </span>
                {b.availability === "legacy-only" && (
                  <span className="ml-1.5 text-neutral-500">
                    (historical records only)
                  </span>
                )}
                <span className="mt-0.5 block">{b.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {canManageMachines && selectable.length === 0 && scope && (
        <p
          className="text-xs text-neutral-600 dark:text-neutral-400"
          data-testid="machine-owner-hint"
        >
          You own this studio, so you can register its machines. Only models
          that have passed their evidence review can be registered.
        </p>
      )}

      <MachinePriorSetup
        readings={priorSetup}
        catalogue={catalogue}
        unitNames={priorUnitNames}
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
