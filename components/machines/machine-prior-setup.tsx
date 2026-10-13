import { SectionLabel } from "@/components/ui/section-label";
import { unitLabel } from "@/lib/machines/charting";
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

export function MachinePriorSetup({ readings, catalogue }: MachinePriorSetupProps) {
  if (readings.length === 0) return null;

  const first = readings[0]!;
  const profile = catalogue.find((p) => p.profileId === first.profileId);
  const historical = profile ? first.profileVersion !== profile.version : true;
  const mode = profile ? findMode(profile, first.modeKey) : undefined;

  const labels = new Map<string, { label: string; unit: string }>();
  if (mode && !historical) {
    for (const { field } of modeFields(mode)) {
      labels.set(field.key, {
        label: field.nativeLabel,
        unit: unitLabel(field.unit),
      });
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

  return (
    <div
      className="flex flex-col gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800"
      data-testid="machine-prior-setup"
    >
      <SectionLabel size="caption">Last recorded setup</SectionLabel>
      <p className="text-sm text-neutral-700 dark:text-neutral-300">
        {machine}
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
                    THE RECORDED UNIT, falling back when the catalogue's is
                    deliberately unavailable.
                    `named` is intentionally undefined when the recorded
                    profile version differs from today's, or the profile has
                    left the catalogue - that is correct, because today's
                    labels must not be put on a historical reading. But
                    suppressing the UNIT too showed bare numbers like "120"
                    with no µA, mA or ms, which defeats the entire reason the
                    reading stores its own native unit. The reading's unit is
                    not today's opinion; it is what the machine displayed at
                    capture time, so it is exactly what a historical setup
                    should show (Codex, 7cae831b).
                  */}
                  {named?.unit ?? r.nativeUnit ? (
                    <span className="ml-0.5 text-neutral-500">
                      {named?.unit ?? r.nativeUnit}
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
