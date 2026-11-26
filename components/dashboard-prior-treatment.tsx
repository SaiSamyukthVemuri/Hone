import type { AppointmentPrepMemory, AreaNarrativeItem, NarrativeItem } from "@/lib/sessions/appointment-prep-memory";

type Readings = AppointmentPrepMemory["areas"][number]["setup"]["readings"];

function ReadingList({ readings }: { readings: Readings }) {
  if (!readings.length) return null;
  return <dl className="my-2 flex flex-wrap gap-x-4 gap-y-1">{readings.map(reading => (
    <div key={reading.field}><dt className="text-[11px] text-fg-muted">{reading.label}</dt><dd className="text-sm font-semibold">{reading.value}</dd></div>
  ))}</dl>;
}

/** The appointment summary already identifies the previous visit. On opening it,
 * the settings, outcome and narrative for each area share one heading. */
export function DashboardPriorTreatment({ memory }: { memory: AppointmentPrepMemory }) {
  const { notes } = memory;
  const areaNotes = [...notes.cautions, ...notes.responses, ...notes.additional];
  const blockIds = new Set(memory.areas.map(area => area.key));
  const otherNotes = areaNotes.filter(note => !blockIds.has(note.areaKey));
  const renderNote = (note: NarrativeItem | AreaNarrativeItem, withArea = false) => (
    <p key={note.key} data-testid="prep-note-item" className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-fg-muted">
      <span className="font-semibold">{note.label}{withArea && "areaLabel" in note && note.areaLabel ? ` · ${note.areaLabel}` : ""}</span>{" · "}{note.text}
    </p>
  );

  return (
    <section data-testid="appointment-prep-memory" aria-label="Last treatment" className="min-w-0 space-y-2">
      {memory.supersededByEmptySession && <p data-testid="prep-superseded" className="text-xs text-fg-muted">Most recent charted treatment. A newer session has no treatment details yet.</p>}
      {memory.areas.length ? (
        <ul data-testid="prep-areas" className="divide-y divide-line">
          {memory.areas.map(area => {
            const { outcome, setup } = area;
            const hardware = [setup.frequency, setup.probeLine].filter(Boolean);
            const { changedPasses } = area;
            const sharedMode = changedPasses.every(pass => pass.modeLabel === setup.modeLabel);
            const mode = [sharedMode && setup.modeLabel, setup.modalityLabel].filter(Boolean);
            const sharedReadings = changedPasses.length
              ? setup.readings.filter(reading => reading.field === "energyLevel" &&
                  changedPasses.every(pass => pass.readings.some(value => value.field === reading.field)))
              : setup.readings;
            const outcomes = [
              outcome.minutes == null ? null : `${outcome.minutes} min`,
              outcome.hairs == null ? null : `${outcome.hairs} hairs`,
              area.passCount > 1 ? `${area.passCount} passes` : null,
              outcome.toleranceLine && `Tolerance ${outcome.toleranceLine}`,
              outcome.responseLine, outcome.numbing?.label,
            ].filter(Boolean);
            return (
              <li key={area.key} data-testid="prep-setup-area" className="min-w-0 py-2 first:pt-0 last:pb-0">
                <h4 data-testid="prep-area-label" className="break-words text-sm font-semibold">{area.areaLabel}</h4>
                {hardware.length > 0 && <p className="mt-1 break-words text-xs leading-5">{hardware.join(" · ")}</p>}
                {mode.length > 0 && <p className="text-xs leading-5">{mode.join(" · ")}</p>}
                <ReadingList readings={sharedReadings} />
                {!area.setupRecorded && !changedPasses.length && <p className="text-xs text-fg-muted">Setup not recorded</p>}
                {changedPasses.length > 0 && (
                  <ol data-testid="prep-settings-changed" className="space-y-2" aria-label="Settings by pass">
                    {changedPasses.map((pass, index) => {
                      const readings = pass.readings.filter(reading => !sharedReadings.some(shared => shared.field === reading.field));
                      return (
                        <li key={index} className="border-l-2 border-line pl-3">
                          <h5 className="text-xs font-semibold">Pass {index + 1}{!sharedMode && pass.modeLabel && ` · ${pass.modeLabel}`}</h5>
                          {readings.length ? <ReadingList readings={readings} /> : <p className="text-xs text-fg-muted">No readings recorded for this pass.</p>}
                        </li>
                      );
                    })}
                  </ol>
                )}
                {!!outcomes.length && <p data-testid="prep-outcome-area" className="text-xs leading-5 text-fg-muted">{outcomes.join(" · ")}</p>}
                {areaNotes.filter(note => note.areaKey === area.key).map(note => renderNote(note))}
              </li>
            );
          })}
        </ul>
      ) : (
        <div data-testid="prep-no-blocks" className="text-xs text-fg-muted">
          <p>{memory.blocklessNote ?? "No treatment settings recorded."}</p>
          <p>{[
            memory.totalMinutes == null ? null : `${memory.totalMinutes} min`,
            memory.totalHairs == null ? null : `${memory.totalHairs} hairs`,
          ].filter(Boolean).join(" · ")}</p>
        </div>
      )}
      <div data-testid="prep-notes">
        {notes.general.map(note => renderNote(note))}
        {otherNotes.map(note => renderNote(note, true))}
      </div>
    </section>
  );
}
