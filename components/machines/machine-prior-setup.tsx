import { SectionLabel } from "@/components/ui/section-label";
import {
  observationSourceLabel,
  recordedUnitLabel,
} from "@/lib/machines/charting";
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
  /**
   * The read FAILED, which an empty list cannot express.
   *
   * Separate from `readings` for the same reason
   * `recordedSetupUnavailable` is separate: "there is no previous
   * treatment" and "I could not find out" are different facts and only one
   * of them is safe to act on.
   */
  unavailable?: boolean;
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
  unavailable = false,
}: MachinePriorSetupProps) {
  // THE READ FAILED, WHICH IS NOT "NO PREVIOUS TREATMENT".
  //
  // Checked BEFORE the empty case, because a failed read arrives with no
  // readings and would otherwise render as silence — telling her this
  // client has never been treated on a machine, so she charts without
  // reference to settings that exist (Codex, #860 4300759932 found the
  // same conflation on the recorded-history read; this one came from
  // enumerating every failure-to-empty conversion).
  //
  // Quieter copy than the recorded-history warning, and deliberately: that
  // one is preventing a DUPLICATE IMMUTABLE CAPTURE, while this is
  // reference material she can work without. It says what happened and
  // does not alarm.
  if (unavailable) {
    return (
      <div
        className="flex flex-col gap-1 border-t border-neutral-200 pt-3 dark:border-neutral-800"
        data-testid="machine-prior-setup-unavailable"
      >
        <SectionLabel size="caption">Previous treatment</SectionLabel>
        <p className="text-xs text-neutral-600 dark:text-neutral-400" role="status">
          Previous settings could not be loaded just now. This does NOT mean
          there are none — reload if you want to see them before charting.
        </p>
      </div>
    );
  }

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

  // WHEN IT WAS RECORDED, from the reading's own timestamp.
  //
  // The DATE only, deliberately: a time of day invites reading it as "the
  // setting at that moment", and with several groups these rows can carry
  // different instants. The date answers the question that matters - this is a
  // previous visit, not today - without implying a precision the row set does
  // not have.
  const recordedOn = (() => {
    const iso = first.recordedAt;
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? null
      : d.toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        });
  })();

  return (
    <div
      className="flex flex-col gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800"
      data-testid="machine-prior-setup"
    >
      {/*
        "PREVIOUS TREATMENT", in Sam's own words, and dated.

        Sam's screenshot asked "is this all prepopulated" - which is the
        question a reader asks when past values are rendered in the same visual
        register as the fields they are about to fill in. Nothing here ever WAS
        prepopulated: the entry draft starts empty and
        tests/.../setting-groups prove a new capture begins blank. The defect
        was that it READ as prepopulated.

        So this says what it is, in three ways at once: the label names it as
        previous rather than "last recorded", the date makes it unambiguously a
        past event, and the line below states that these are not today's
        entries. Honest timing is also what the engineering decision requires -
        independently timed revisions must not be presented as one instant
        (#860 6156583955, 6157725545).
      */}
      <SectionLabel size="caption">Previous treatment</SectionLabel>
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
        {recordedOn && (
          <span className="ml-2 text-neutral-500" data-testid="prior-setup-when">
            {recordedOn}
          </span>
        )}
      </p>
      {/*
        THE ONE LINE THAT ANSWERS SAM'S QUESTION. Reference, not entries, and
        not a default: a value she has not re-read off the machine today is not
        a reading, and the record must not be able to acquire one by her
        failing to notice a pre-filled box.
      */}
      <p
        className="text-xs text-neutral-500"
        data-testid="prior-setup-reference-note"
      >
        For reference only — these are the previous values, not today&apos;s
        entries. Enter today&apos;s settings below.
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
                  // ADDRESSABLE PER GROUP AND FIELD, so a proof can ask what
                  // THIS probe's current reads rather than searching the
                  // panel's text. Two attempts at the latter failed on
                  // coincidences - "202" inside the rendered year, then "300"
                  // inside another field's "300.5" - and a substring search
                  // over a surface that prints dates, units and several
                  // numbers cannot tell a clinical value from any of them.
                  data-testid={`prior-setup-${groupKey}-${r.fieldKey}`}
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
                  {/*
                    THROUGH THE SENTINEL RULE, which this printed straight
                    past. `device-display` and `none` are not units: rendering
                    them literally put "1.25 device-display" in PREVIOUS
                    TREATMENT while the recorded-history surface beside it
                    showed the same reading as plain "1.25" (Codex, #860
                    4296709059, the same defect that was repaired there in
                    4288424526 and not here). A real unit, including a
                    historical one, still prints verbatim.
                  */}
                  {recordedUnitLabel(r.nativeUnit) ? (
                    <span className="ml-0.5 text-neutral-500">
                      {recordedUnitLabel(r.nativeUnit)}
                    </span>
                  ) : null}
                  {/*
                    SAME RULE, THE OTHER SURFACE. Codex named the recorded
                    history; this renderer dropped the source too, and here
                    it is guidance she may reproduce — reproducing an
                    ESTIMATE as though it were a machine reading is the
                    error worth preventing.
                  */}
                  {observationSourceLabel(r.observationSource) ? (
                    <span
                      className="ml-1 text-xs text-neutral-500"
                      data-testid={`prior-source-${r.fieldKey}`}
                    >
                      ({observationSourceLabel(r.observationSource)})
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {/*
        ONE DATE, ONE TIMEZONE (Codex, #860 4301722743).

        This footer formatted the instant with `toISOString()` while the
        heading above used `toLocaleDateString()`. For a capture near
        midnight UTC a practitioner in a negative offset read "Oct 16, 2026"
        in the heading and "Recorded 2026-10-17" directly beneath it, for ONE
        setup — which reads as two visits.

        It reuses the heading's own derived value rather than formatting a
        second time, so the two cannot drift apart again. That also removes a
        latent throw: `new Date(invalid).toISOString()` raises a RangeError,
        where the shared value is simply null.
      */}
      <p className="text-xs text-neutral-500">
        {recordedOn ? `Recorded ${recordedOn}` : "Recorded earlier"}
        {historical
          ? ". The field contract has changed since, so the recorded keys are shown rather than today's labels."
          : "."}
      </p>
    </div>
  );
}
