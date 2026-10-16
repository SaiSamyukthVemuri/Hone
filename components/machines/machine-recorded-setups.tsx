import { SectionLabel } from "@/components/ui/section-label";
import {
  changesWithin,
  chronology,
  type ChronologyEntry,
  type SettingChange,
} from "@/lib/machines/capture-chronology";
import { recordedUnitLabel } from "@/lib/machines/charting";
import type { RecordedReading } from "@/lib/machines/machine-queries";
import { findMode, modeFields } from "@/lib/machines/profile-contract";
import type { MachineProfile } from "@/lib/machines/profile-contract";

// MPX-03 — WHAT HAS ALREADY BEEN RECORDED ON THIS TREATMENT.
//
// THE DEFECT THIS CLOSES. A recorded capture was permanent and invisible:
// nothing read what had already been recorded against the settings block being
// charted, so after a page load the only thing the practitioner saw was
// nothing. Her options were to record it again - appending a second immutable
// capture indistinguishable from a genuine mid-treatment change - or to guess.
// `setup_capture_history_for_block` and `readingsForBlockAction` were both
// built, granted and proved against Postgres, and neither reached a screen.
//
// NOT THE SAME SURFACE AS "PREVIOUS TREATMENT", and the difference is the
// whole design. That panel answers "what did I do LAST TIME" and is reference
// for a value she has not re-read. This answers "what have I already recorded
// TODAY" and is the record itself.
//
// THE TIME OF DAY IS SHOWN HERE, AND DELIBERATELY NOT THERE.
// `machine-prior-setup` shows a DATE and no clock time, because it renders
// several groups under one heading and a time would invite reading the row set
// as "the setting at that instant". Here every entry is ONE capture with its
// OWN instant, and the time of day is exactly what distinguishes a change made
// twenty minutes ago from the setup she started with. Showing it is honest
// because nothing is collapsed; two groups of one save are two entries with
// their own times, never one.
//
// IT MAKES NO CLINICAL CLAIM. It does not say whether a change was correct,
// advisable, or in response to anything. It says what was recorded, and when.
//
// Server-safe: no state, no directive, no transport.

export type MachineRecordedSetupsProps = {
  /** Everything recorded against the block being charted. */
  readings: RecordedReading[];
  /**
   * The read FAILED, which is not the same as nothing being recorded.
   *
   * A failed read used to arrive here as an empty list, so this surface
   * rendered nothing at all - and "nothing recorded" is the one message that
   * invites her to record again, appending a second immutable capture
   * indistinguishable from a genuine mid-treatment change (Codex, #860
   * 4290452722). That is precisely the outcome this component exists to
   * prevent, reached through its own absence.
   *
   * The chart stays usable either way: a failed cosmetic read must not cost
   * her the treatment. What changes is that she is told the surface could not
   * answer, rather than told there is nothing to see.
   */
  unavailable?: boolean;
  catalogue: readonly MachineProfile[];
  /**
   * Recorded unit id -> the studio's own name for it.
   *
   * A NAME MAP, not the inventory, for the same reason `machine-prior-setup`
   * takes one: `listStudioMachines` excludes retired units in SQL, so a
   * device list can never resolve a unit that has since been retired - and a
   * treatment recorded on it is exactly the case that must still name it
   * (Codex, 27061e88).
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

function clockTime(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * The field's label, from the contract the reading was RECORDED under.
 *
 * Returns the recorded key whenever the version has moved on. Relabelling an
 * old number with a newer contract's words is how a record quietly starts
 * lying, and the unit is never taken from today's catalogue at all - see the
 * `nativeUnit` rule in machine-prior-setup.
 */
function labelsFor(
  entry: ChronologyEntry,
  catalogue: readonly MachineProfile[],
): { labels: Map<string, string>; historical: boolean } {
  const profile = catalogue.find((p) => p.profileId === entry.profileId);
  const historical = profile ? entry.profileVersion !== profile.version : true;
  const labels = new Map<string, string>();
  const mode = profile ? findMode(profile, entry.modeKey) : undefined;
  if (mode && !historical) {
    for (const { field } of modeFields(mode)) {
      labels.set(field.key, field.nativeLabel);
    }
  }
  return { labels, historical };
}

function ChangeLine({
  change,
  catalogue,
}: {
  change: SettingChange;
  catalogue: readonly MachineProfile[];
}) {
  // THE WORD "CHANGED" IS LIMITED BY WHAT changesWithin WILL PAIR, and that
  // is the point of deriving the copy from it rather than writing it here. It
  // never pairs the same field across groups (two probes at different
  // settings are not one setting that changed), across modes or profile
  // versions (the same field key can mean something else there), or a field
  // re-read at the SAME value (another capture, not an adjustment). So this
  // line cannot make any of those claims, whatever it says.
  const profile = catalogue.find((p) => p.profileId === change.to.profileId);
  const historical = profile ? change.to.profileVersion !== profile.version : true;
  const mode = profile ? findMode(profile, change.to.modeKey) : undefined;
  let label = change.to.fieldKey;
  if (mode && !historical) {
    for (const { field } of modeFields(mode)) {
      if (field.key === change.to.fieldKey) label = field.nativeLabel;
    }
  }
  const at = clockTime(change.to.recordedAt);
  return (
    <li
      className="text-sm text-neutral-700 dark:text-neutral-300"
      data-testid={`recorded-change-${change.groupKey}-${change.fieldKey}`}
    >
      <span className="text-neutral-500">{label}</span>{" "}
      <span className="font-medium">{formatValue(change.from)}</span>
      {/*
        THE UNIT COMES FROM EACH READING, not from one of them and not from
        the catalogue. Both sides are printed with their own recorded unit,
        because a profile version change can move the unit - and when it has,
        changesWithin refuses to pair them at all, so a mismatch here is
        visible rather than silently harmonised.
      */}
      {recordedUnitLabel(change.from.nativeUnit) ? (
        <span className="ml-0.5 text-neutral-500">
          {recordedUnitLabel(change.from.nativeUnit)}
        </span>
      ) : null}
      <span className="mx-1.5 text-neutral-500" aria-label="changed to">
        →
      </span>
      <span className="font-medium">{formatValue(change.to)}</span>
      {recordedUnitLabel(change.to.nativeUnit) ? (
        <span className="ml-0.5 text-neutral-500">
          {recordedUnitLabel(change.to.nativeUnit)}
        </span>
      ) : null}
      {at && <span className="ml-2 text-xs text-neutral-500">{at}</span>}
    </li>
  );
}

export function MachineRecordedSetups({
  readings,
  catalogue,
  unitNames = {},
  unavailable = false,
}: MachineRecordedSetupsProps) {
  // THE READ FAILED, AND THAT IS ITS OWN STATE. Checked BEFORE the empty case,
  // because a failed read arrives with no readings and would otherwise be
  // indistinguishable from a treatment with nothing recorded on it - which is
  // the message that invites a duplicate capture.
  if (unavailable) {
    return (
      <div
        className="flex flex-col gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800"
        data-testid="machine-recorded-setups-unavailable"
      >
        <SectionLabel size="caption">Recorded this treatment</SectionLabel>
        <p className="text-xs text-amber-700 dark:text-amber-500" role="status">
          What is already recorded on this treatment could not be read just
          now. This is NOT the same as nothing being recorded - do not re-enter
          settings on the assumption that they are missing, because a capture
          cannot be edited and a second one appends. Reload before recording
          anything you may already have saved.
        </p>
      </div>
    );
  }

  // NOTHING RECORDED IS NOT AN EMPTY SECTION. A heading over no content reads
  // as a surface that failed to load, which is the opposite of the
  // reassurance this exists to give.
  if (readings.length === 0) return null;

  const entries = chronology(readings);
  const changes = changesWithin(entries);

  return (
    <div
      className="flex flex-col gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800"
      data-testid="machine-recorded-setups"
    >
      <SectionLabel size="caption">Recorded this treatment</SectionLabel>

      {/*
        THE PERMANENCE IS SAID OUT LOUD, because it is the fact that decides
        what she does next. A capture cannot be edited, so "record it again to
        fix it" does not fix anything - it appends. Saying so is what makes
        the alternative (recording a genuine change) legible as a different
        act.
      */}
      <p className="text-xs text-neutral-500" data-testid="recorded-setups-note">
        {entries.length === 1
          ? "One capture is recorded against this treatment."
          : `${entries.length} captures are recorded against this treatment.`}{" "}
        Each one is permanent and cannot be edited. A setting that changes
        during the treatment is recorded as a new capture — the earlier one
        stays.
      </p>

      <ol className="flex flex-col gap-2">
        {entries.map((entry) => {
          const { labels, historical } = labelsFor(entry, catalogue);
          const at = clockTime(entry.recordedAt);
          const unitName = unitNames[entry.deviceId] ?? null;
          return (
            <li
              key={entry.captureId ?? `${entry.groupKey}:${entry.revision}:${entry.recordedAt}`}
              className="flex flex-col gap-0.5"
              data-testid={`recorded-capture-${entry.groupKey}-${entry.revision}`}
            >
              <p className="text-xs text-neutral-500">
                {/*
                  ITS OWN INSTANT. Each entry is one capture, so this time is
                  a fact about this capture alone - which is why showing a
                  clock time here is honest where it would not be on the
                  Previous treatment panel.
                */}
                {at && <span data-testid="recorded-capture-when">{at}</span>}
                {entry.channels.length > 0 && (
                  <span className="ml-2">Channels {entry.channels.join(", ")}</span>
                )}
                {/*
                  THE REVISION, named only when there IS an earlier one. On a
                  first capture "capture 1" is noise; on a later one it is the
                  thing that says this group has been recorded before.
                */}
                {entry.revision > 1 && (
                  <span className="ml-2">capture {entry.revision}</span>
                )}
                {unitName && <span className="ml-2">{unitName}</span>}
              </p>
              <ul className="flex flex-wrap gap-x-4 gap-y-1">
                {entry.readings.map((r) => (
                  <li
                    key={`${r.stageKey ?? ""}:${r.fieldKey}`}
                    className="text-sm text-neutral-700 dark:text-neutral-300"
                  >
                    <span className="text-neutral-500">
                      {labels.get(r.fieldKey) ?? r.fieldKey}
                    </span>{" "}
                    <span className="font-medium">{formatValue(r)}</span>
                    {/*
                      ALWAYS the recorded unit, never today's catalogue - but
                      through the sentinel rule, which this printed straight
                      past. `device-display` and `none` are not units, and
                      rendering them literally put "1.25 device-display" in the
                      history under an entry form showing the same reading as
                      plain "1.25" (Codex, #860 4288424526). A real unit,
                      including a historical one, still prints verbatim.
                    */}
                    {recordedUnitLabel(r.nativeUnit) ? (
                      <span className="ml-0.5 text-neutral-500">
                        {recordedUnitLabel(r.nativeUnit)}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
              {historical && (
                <span className="text-xs text-neutral-500">
                  The field contract has changed since this was recorded, so the
                  recorded keys are shown rather than today&apos;s labels.
                </span>
              )}
            </li>
          );
        })}
      </ol>

      {changes.length > 0 && (
        <div className="flex flex-col gap-0.5" data-testid="recorded-changes">
          <SectionLabel size="caption">Changed during this treatment</SectionLabel>
          <ul className="flex flex-col gap-0.5">
            {changes.map((c) => (
              <ChangeLine
                key={`${c.groupKey}:${c.fieldKey}:${c.to.recordedAt}`}
                change={c}
                catalogue={catalogue}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
