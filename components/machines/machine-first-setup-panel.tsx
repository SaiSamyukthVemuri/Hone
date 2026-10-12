"use client";

import { useState } from "react";

import { SectionLabel } from "@/components/ui/section-label";
import { MACHINE_CATALOGUE } from "@/lib/machines/catalogue";
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
  /** Injectable for tests and for a future studio-scoped catalogue. */
  catalogue?: readonly MachineProfile[];
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
}: MachineFirstSetupPanelProps) {
  const [deviceId, setDeviceId] = useState<string | null>(initialDeviceId);

  // Only a real scope can produce a selectable list, because a device belongs
  // to a studio and the filter is studio-scoped. Without identity the panel
  // shows the catalogue status and nothing else, rather than guessing.
  const selectable = scope ? selectableDevices(scope, devices, catalogue) : [];
  const chosen = selectable.find((s) => s.device.deviceId === deviceId) ?? null;
  const mode = chosen ? (activeModes(chosen.profile)[0] ?? null) : null;
  const groups = chosen && mode ? nativeFieldGroups(chosen.profile, mode) : [];
  const blocked = withheld(catalogue);

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
            onClick={() => setDeviceId(null)}
            className="text-xs font-medium text-neutral-600 underline hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
          >
            Change machine
          </button>
        )}
      </div>

      {/* Selection. An empty list is a legitimate answer and says why. */}
      {selectable.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          No verified machine is available to select yet.{" "}
          {scope
            ? "This studio has no registered machine on a reviewed profile."
            : "This surface does not yet know which practitioner and studio is charting, so no machine list can be scoped to it."}
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
                onClick={() => setDeviceId(device.deviceId)}
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
        <div className="flex flex-col gap-3">
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
          {groups.map((group) => (
            <div key={group.key} className="flex flex-col gap-1.5">
              <SectionLabel size="caption">{group.label}</SectionLabel>
              <ul className="flex flex-col gap-1">
                {group.fields.map((f) => (
                  <li
                    key={`${group.key}:${f.key}`}
                    className="text-sm text-neutral-700 dark:text-neutral-300"
                  >
                    <span className="font-medium">{f.label}</span>
                    {f.unit && (
                      <span className="ml-1 text-neutral-500">({f.unit})</span>
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
          ))}
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

      <PersistenceStatus hasScope={scope != null} />
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
function PersistenceStatus({ hasScope }: { hasScope: boolean }) {
  return (
    <dl
      className="flex flex-col gap-1 border-t border-neutral-200 pt-3 text-xs text-neutral-500 dark:border-neutral-800"
      data-testid="machine-first-status"
    >
      <div className="flex gap-1.5">
        <dt className="font-medium">Remembered:</dt>
        <dd>
          no. Your choice lasts for this form only.{" "}
          {hasScope
            ? "Saving it per practitioner and studio needs a stored field, which is not in the database yet."
            : "This surface does not know which practitioner and studio is charting, and the stored field does not exist yet."}
        </dd>
      </div>
      <div className="flex gap-1.5">
        <dt className="font-medium">Recorded:</dt>
        <dd>
          nothing from this panel. The treatment fields below are unchanged and
          remain the record.
        </dd>
      </div>
    </dl>
  );
}
