import { SectionLabel } from "@/components/ui/section-label";
import type { RecordedReading } from "@/lib/machines/machine-queries";
import type { MachineProfile } from "@/lib/machines/profile-contract";
import { findMode, modeFields } from "@/lib/machines/profile-contract";

// MPX-03 — the next-visit payoff.
//
// WHY THIS EXISTS AT ALL. New capture without accurate retrieval is incomplete:
// the reason to record what the machine showed is to be able to reproduce or
// adjust it next time. This renders the most recent recorded setup in the
// studio, which is the question a practitioner actually asks.
//
// IT RENDERS AGAINST THE RECORDED VERSION. When a reading's
// `machine_profile_version` is not the catalogue's current one, the field's
// label and unit are NOT taken from today's contract - the recorded key is
// shown instead and the difference is stated. Relabelling an old number with a
// newer contract's words is how a record quietly starts lying.
//
// Server-safe: no state, no directive, no transport.

export type MachinePriorSetupProps = {
  readings: RecordedReading[];
  catalogue: readonly MachineProfile[];
  /**
   * Recorded unit id -> the studio's own name for it.
   *
   * A NAME MAP, not the inventory. The first version of this took
   * `StudioDevice[]` and looked the unit up in it, which could never resolve a
   * RETIRED unit: `listStudioMachines` excludes those in SQL so they cannot
   * reach a picker, so the production device list never contains one. The
   * retired-unit test passed only because it injected a retired device
   * directly - a fixture creating a state the loader cannot produce
   * (Codex, 27061e88).
   *
   * The server now names the recorded units by id through `machinesByIds`,
   * which has no retired filter, and passes only what this component needs.
   */
  unitNames?: Readonly<Record<string, string>>;
};

function formatValue(r: RecordedReading): string {
  if (r.value.kind === "absent") {
    return r.value.reason === "not-applicable"
      ? "—"
      : r.value.reason === "not-legible"
        ? "not legible"
        : "not recorded";
  }
  const own = String(r.value.value).split(".")[1]?.length ?? 0;
  return r.value.value.toFixed(Math.max(r.decimals, own));
}

export function MachinePriorSetup({
  readings,
  catalogue,
  unitNames = {},
}: MachinePriorSetupProps) {
  if (readings.length === 0) return null;

  const first = readings[0]!;
  const profile = catalogue.find((p) => p.profileId === first.profileId);
  const historical = profile ? first.profileVersion !== profile.version : true;
  const mode = profile ? findMode(profile, first.modeKey) : undefined;

  // LABELS ONLY, NO UNITS. The unit always comes from the reading itself
  // (see the render below), so this map deliberately does not carry one -
  // the component cannot print today's unit because it never holds it.
  const labels = new Map<string, { label: string }>();
  if (mode && !historical) {
    for (const { field } of modeFields(mode)) {
      labels.set(field.key, { label: field.nativeLabel });
    }
  }

  // Group the readings the way they were recorded, so two probe groups stay two.
  const byGroup = new Map<string, RecordedReading[]>();
  for (const r of readings) {
    const list = byGroup.get(r.groupKey) ?? [];
    list.push(r);
    byGroup.set(r.groupKey, list);
  }

  const machine = profile
    ? `${profile.manufacturer} ${profile.model}${profile.variant ? ` (${profile.variant})` : ""}`
    : first.profileId;

  // THE PHYSICAL UNIT, named where the studio can recognise it. The id itself
  // is never shown - a bare uuid is noise to a practitioner - so an unresolved
  // unit simply leaves the model standing alone, as before.
  const unitName = unitNames[first.deviceId] ?? null;

  return (
    <div
      className="flex flex-col gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800"
      data-testid="machine-prior-setup"
    >
      <SectionLabel size="caption">Last recorded setup</SectionLabel>
      <p className="text-sm text-neutral-700 dark:text-neutral-300">
        {unitName ? (
          <>
            <span data-testid="prior-setup-unit">{unitName}</span>
            <span className="ml-1.5 text-neutral-500">{machine}</span>
          </>
        ) : (
          machine
        )}
        <span className="ml-2 text-neutral-500">
          {historical ? first.modeKey : (mode?.nativeLabel ?? first.modeKey)}
        </span>
      </p>

      {[...byGroup.entries()].map(([groupKey, rows]) => (
        <div key={groupKey} className="flex flex-col gap-0.5">
          {rows[0]!.channels.length > 0 && (
            <span className="text-xs text-neutral-500">
              Channels {rows[0]!.channels.join(", ")}
            </span>
          )}
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {rows.map((r) => {
              const named = labels.get(r.fieldKey);
              return (
                <li
                  key={`${groupKey}:${r.stageKey ?? ""}:${r.fieldKey}`}
                  className="text-sm text-neutral-700 dark:text-neutral-300"
                >
                  <span className="text-neutral-500">
                    {named?.label ?? r.fieldKey}
                  </span>{" "}
                  <span className="font-medium">{formatValue(r)}</span>
                  {/*
                    ALWAYS THE RECORDED UNIT. Never the catalogue's, not even
                    as a preference when the versions appear to match.
                    This first suppressed the unit with the label, showing bare
                    numbers like "120" with no µA, mA or ms - which defeats the
                    entire reason a reading stores its own native unit. The
                    repair fell back to `r.nativeUnit`, which still PREFERRED
                    today's metadata whenever a version matched, and that is
                    the same defect one step quieter: the published database
                    contract is immutable per version, but the application
                    catalogue is a source file that can have a unit edited
                    without a version bump, and nothing enforces agreement
                    between the two for the same version number. Today's
                    opinion would then be printed on an older measurement.
                    `nativeUnit` is what the contract said at capture time, so
                    it is the only unit that cannot go obsolete. Where the
                    catalogue is honest the two strings are identical and
                    nothing is lost (Codex, 87c88017).
                  */}
                  {r.nativeUnit ? (
                    <span className="ml-0.5 text-neutral-500">
                      {r.nativeUnit}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      <p className="text-xs text-neutral-500">
        Recorded {new Date(first.recordedAt).toISOString().slice(0, 10)}
        {historical
          ? ". The field contract has changed since, so the recorded keys are shown rather than today's labels."
          : "."}
      </p>
    </div>
  );
}
