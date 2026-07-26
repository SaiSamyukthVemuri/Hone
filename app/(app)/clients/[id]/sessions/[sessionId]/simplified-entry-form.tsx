"use client";

import { useState, useTransition } from "react";
import {
  AREAS,
  PULSE_COUNT_DEFAULT,
  PULSE_COUNT_MAX,
  PULSE_COUNT_MIN,
  PULSE_DELAY_DEFAULT,
  PULSE_DELAY_MIN,
  PULSE_DELAY_MAX,
} from "@/lib/constants";
import type { SessionBlock } from "@/lib/types/database";
import {
  isChipSelected,
  toggleFindingChip,
  MERGED_OBSERVATION_CHIPS,
} from "@/lib/observation-chips";
import { SelectedObservations } from "@/components/selected-observations";
import {
  OBSERVATIONS_RESPONSE_HEADING,
  OBSERVATIONS_RESPONSE_HELPER,
  ADDITIONAL_NOTES_HEADING,
  ADDITIONAL_NOTES_HELPER,
} from "@/lib/sessions/charting-labels";
import { pickSavedLabel } from "@/lib/saved-label";
import { MultiChipSelector } from "@/components/multi-chip-selector";
import { addElectrolysisEntryAction } from "./actions";

// SimplifiedEntryForm is the primary entry-creation surface inside a block.
// Treatment params (mode, modality, energy_level, probe_type, probe_size,
// machine_frequency) come FROM the block and are stamped onto the entry as
// the historical snapshot. They are not editable here. To override mode or
// other params on a specific entry, use the legacy form via "Edit" on the
// entry row after it has been created.

type Props = {
  block: SessionBlock;
  sessionId: string;
  clientId: string;
  clientTagLabels?: ReadonlyArray<string>;
};

type Draft = {
  areas: string[];
  // Phase 3: structured thermolysis / galvanic readings (replacing the old
  // generic intensity / duration), mode-aware from the block's mode.
  thermolysisIntensityPercent: string;
  thermolysisDurationSeconds: string;
  galvanicMa: string;
  galvanicDurationSeconds: string;
  galvanicIntensityPercent: string;
  unitsOfLye: string;
  pulse_count: string;
  pulse_delay: string;
  hairs_treated: string;
  comments: string;
  // Chip-loading fix: structured observation chips (canonical labels), stored in
  // electrolysis_entries.observation_chips — NOT appended into `comments`. Toggle
  // state so a chip can be selected AND deselected, and persists after refresh.
  observationChips: string[];
};

function emptyDraft(): Draft {
  return {
    areas: [],
    thermolysisIntensityPercent: "",
    thermolysisDurationSeconds: "",
    galvanicMa: "",
    galvanicDurationSeconds: "",
    galvanicIntensityPercent: "",
    unitsOfLye: "",
    pulse_count: String(PULSE_COUNT_DEFAULT),
    pulse_delay: String(PULSE_DELAY_DEFAULT),
    hairs_treated: "",
    comments: "",
    observationChips: [],
  };
}

export function SimplifiedEntryForm({
  block,
  sessionId,
  clientId,
  clientTagLabels = [],
}: Props) {
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [error, setError] = useState<string | null>(null);
  // Set when a save PERSISTED but its observations couldn't be confirmed. The
  // write is not atomic (no rollback in scope), so a blind resubmit would create
  // a SECOND clinical entry. While set, the form locks: the save button is
  // disabled and the only way forward is to reload + inspect the record.
  const [recovery, setRecovery] = useState<string | null>(null);
  const [savedLabel, setSavedLabel] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function bumpPulse(delta: number) {
    const current = parseInt(draft.pulse_count, 10);
    const base = Number.isFinite(current) ? current : PULSE_COUNT_DEFAULT;
    const next = Math.min(
      PULSE_COUNT_MAX,
      Math.max(PULSE_COUNT_MIN, base + delta),
    );
    update("pulse_count", String(next));
  }

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // In the persisted-but-unverified recovery state, refuse to resubmit — the
    // row may already exist and a second insert would duplicate it.
    if (recovery) return;
    setError(null);
    if (draft.areas.length === 0) {
      setError("Pick at least one area.");
      return;
    }

    const fd = new FormData();
    fd.set("session_id", sessionId);
    fd.set("client_id", clientId);
    fd.set("block_id", block.id);
    fd.set("areas", JSON.stringify(draft.areas));
    // Entry-level snapshot fields: stamped from the block so this entry's
    // historical row carries what was actually used at this moment.
    fd.set("mode", block.mode ?? "");
    fd.set("apilus_modality", block.apilus_modality ?? "");
    fd.set("energy_level", block.energy_level != null ? String(block.energy_level) : "");
    fd.set(
      "minutes_performed",
      block.minutes_performed != null ? String(block.minutes_performed) : "",
    );
    fd.set("probe_type", block.probe_type ?? "");
    fd.set("probe_size", block.probe_size ?? "");
    fd.set("machine_frequency", block.machine_frequency ?? "");
    // Work-level fields the practitioner just filled in. Structured
    // thermolysis / galvanic readings; the action mode-gates which apply.
    // Legacy intensity / duration_seconds are no longer sent.
    fd.set("thermolysis_intensity_percent", draft.thermolysisIntensityPercent);
    fd.set("thermolysis_duration_seconds", draft.thermolysisDurationSeconds);
    fd.set("galvanic_ma", draft.galvanicMa);
    fd.set("galvanic_duration_seconds", draft.galvanicDurationSeconds);
    fd.set("galvanic_intensity_percent", draft.galvanicIntensityPercent);
    fd.set("units_of_lye", draft.unitsOfLye);
    fd.set("pulse_count", draft.pulse_count);
    fd.set("pulse_delay_seconds", draft.pulse_delay);
    fd.set("hairs_treated", draft.hairs_treated);
    fd.set("comments", draft.comments);
    // Structured chips as a JSON array (the action normalizes + persists to
    // observation_chips). Kept SEPARATE from the free-text comments above.
    fd.set("observation_chips", JSON.stringify(draft.observationChips));

    startTransition(async () => {
      try {
        const res = await addElectrolysisEntryAction(fd);
        if (res.ok) {
          setDraft(emptyDraft());
          setSavedLabel(pickSavedLabel());
          window.setTimeout(() => setSavedLabel(null), 1500);
          return;
        }
        if (res.code === "unverified") {
          // A row MAY exist but its observations weren't confirmed. Lock the
          // form so the practitioner can't blind-resubmit and duplicate the
          // clinical entry; the draft is preserved for reference.
          setRecovery(res.error);
          return;
        }
        // invalid_input / not_persisted → nothing was inserted. Safe to fix and
        // retry; keep the form + draft as-is and show the error.
        setError(res.error);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to add entry.");
      }
    });
  }

  return (
    <form
      onSubmit={submit}
      data-testid="add-pass-form"
      className="flex flex-col gap-4 rounded-md border border-dashed border-neutral-300 bg-neutral-50 p-4 dark:border-neutral-700 dark:bg-neutral-900/50"
    >
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">Add another pass</h4>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">
          Areas<span className="ml-1 text-red-500">*</span>
        </span>
        <MultiChipSelector
          options={AREAS}
          values={draft.areas}
          onChange={(v) => update("areas", v)}
          otherPlaceholder="Describe area"
        />
      </div>

      {/* Mode-aware readings (Phase 3), same as the one-page form. The
          block's mode drives which groups show. */}
      {(block.mode === "thermo" || block.mode === "blend") && (
        <div className="flex flex-col gap-3">
          {block.mode === "blend" && (
            <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
              Thermolysis
            </span>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Thermolysis intensity %</span>
              <input
                type="number"
                inputMode="numeric"
                step="1"
                min={0}
                max={100}
                value={draft.thermolysisIntensityPercent}
                onChange={(e) =>
                  update("thermolysisIntensityPercent", e.target.value)
                }
                className="rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Thermolysis duration (s)</span>
              <input
                type="number"
                inputMode="decimal"
                step="0.001"
                min={0}
                value={draft.thermolysisDurationSeconds}
                onChange={(e) =>
                  update("thermolysisDurationSeconds", e.target.value)
                }
                className="rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
              />
            </label>
          </div>
          {/* Pulse count is a THERMOLYSIS concept (Chloe): inside the thermolysis
              section, labeled "Thermolysis pulse count". Shown for thermolysis +
              blend; pure galvanic has none. */}
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Thermolysis pulse count</span>
            <div className="flex items-stretch gap-2">
              <button
                type="button"
                onClick={() => bumpPulse(-1)}
                aria-label="Decrease thermolysis pulse count"
                className="rounded-md border border-neutral-300 px-4 text-lg font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
              >
                −
              </button>
              <input
                type="number"
                inputMode="numeric"
                min={PULSE_COUNT_MIN}
                max={PULSE_COUNT_MAX}
                value={draft.pulse_count}
                onChange={(e) => update("pulse_count", e.target.value)}
                className="w-20 rounded-md border border-neutral-300 bg-white px-3 py-3 text-center text-base tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
              />
              <button
                type="button"
                onClick={() => bumpPulse(1)}
                aria-label="Increase thermolysis pulse count"
                className="rounded-md border border-neutral-300 px-4 text-lg font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
              >
                +
              </button>
              <span className="self-center text-xs text-neutral-500">
                Pulses per hair (1 to {PULSE_COUNT_MAX}).
              </span>
            </div>
            {Number(draft.pulse_count) > 1 && (
              <div className="mt-2 flex flex-col gap-1.5">
                <span className="text-sm font-medium">Pulse delay</span>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min={PULSE_DELAY_MIN}
                    max={PULSE_DELAY_MAX}
                    value={draft.pulse_delay}
                    onChange={(e) => update("pulse_delay", e.target.value)}
                    aria-label="Pulse delay in seconds"
                    className="w-24 rounded-md border border-neutral-300 bg-white px-3 py-3 text-center text-base tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
                  />
                  <span className="text-sm text-neutral-500">seconds</span>
                </div>
                <span className="text-xs text-neutral-500">
                  Time between high-frequency pulses ({PULSE_DELAY_MIN} to{" "}
                  {PULSE_DELAY_MAX}s; default {PULSE_DELAY_DEFAULT}).
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {(block.mode === "galv" || block.mode === "blend") && (
        <div className="flex flex-col gap-3">
          {block.mode === "blend" && (
            <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
              Galvanic
            </span>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Galvanic mA</span>
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                min={0}
                value={draft.galvanicMa}
                onChange={(e) => update("galvanicMa", e.target.value)}
                className="rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Galvanic duration (s)</span>
              <input
                type="number"
                inputMode="numeric"
                step="1"
                min={0}
                value={draft.galvanicDurationSeconds}
                onChange={(e) =>
                  update("galvanicDurationSeconds", e.target.value)
                }
                className="rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
              />
            </label>
            {/* Galvanic intensity % removed as an active input (Chloe / PicoBlend).
                This form is create-only, so there is no historical value to
                round-trip; new entries leave it NULL. No migration. */}
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Units of lye (UL)</span>
              <input
                type="number"
                inputMode="decimal"
                step="0.1"
                min={0}
                value={draft.unitsOfLye}
                onChange={(e) => update("unitsOfLye", e.target.value)}
                className="rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
              />
            </label>
          </div>
        </div>
      )}

      <label className="flex flex-col gap-1.5 md:max-w-[16rem]">
        <span className="text-sm font-medium">Hairs treated</span>
        <input
          type="number"
          inputMode="numeric"
          step="1"
          min={0}
          value={draft.hairs_treated}
          onChange={(e) => update("hairs_treated", e.target.value)}
          placeholder="500"
          className="rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
        />
      </label>

      <div className="flex flex-col gap-2 border-t border-neutral-200 pt-4 dark:border-neutral-800">
        {clientTagLabels.length > 0 && (
          <div className="flex flex-col gap-1.5 rounded-md border border-neutral-200 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-950">
            <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
              Client tags
            </span>
            <div className="flex flex-wrap gap-1.5">
              {clientTagLabels.map((label) => (
                <span
                  key={label}
                  className="rounded-full bg-neutral-50 px-2.5 py-1 text-xs font-medium text-neutral-700 ring-1 ring-neutral-300 dark:bg-neutral-900 dark:text-neutral-200 dark:ring-neutral-700"
                >
                  {label}
                </span>
              ))}
            </div>
          </div>
        )}
        <div>
          <span className="text-sm font-medium">
            {OBSERVATIONS_RESPONSE_HEADING}
          </span>
          <p className="text-xs text-neutral-500">
            {OBSERVATIONS_RESPONSE_HELPER}
          </p>
        </div>
        {/* Chip-loading fix: observation chips are STRUCTURED multi-select
            TOGGLES — tap to select (shows pressed), tap again to deselect. They
            persist to observation_chips (not the notes), so they render as pills
            and reload after refresh. Free-text notes are the separate box below. */}
        <div className="flex flex-wrap gap-2">
          {MERGED_OBSERVATION_CHIPS.map((c) => {
            const selected = isChipSelected(draft.observationChips, c);
            return (
              <button
                key={c}
                type="button"
                data-testid={`obs-chip-${c}`}
                aria-pressed={selected}
                onClick={() =>
                  update("observationChips", toggleFindingChip(draft.observationChips, c))
                }
                className={
                  selected
                    ? "rounded-full bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-neutral-900"
                    : "rounded-full border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:border-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300 dark:hover:bg-neutral-900"
                }
              >
                {selected ? c : `+ ${c}`}
              </button>
            );
          })}
        </div>
        {/* Chip confidence (Chloe): the selected observations read-out sits
            between the chips and the free-text note, so a tap visibly "takes". */}
        <SelectedObservations chips={draft.observationChips} />
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">{ADDITIONAL_NOTES_HEADING}</span>
          <textarea
            rows={8}
            value={draft.comments}
            onChange={(e) => update("comments", e.target.value)}
            data-testid="additional-notes"
            placeholder="Add any details not covered by the findings above"
            className="w-full min-h-[12rem] resize-y rounded-md border border-neutral-300 bg-white px-3 py-3 text-base leading-relaxed outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
          />
          <span className="text-xs text-neutral-500">
            {ADDITIONAL_NOTES_HELPER}
          </span>
        </label>
      </div>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      {recovery && (
        <div
          role="alert"
          data-testid="add-pass-recovery"
          className="flex flex-col gap-2 rounded-md border border-amber-400 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-600 dark:bg-amber-950/40 dark:text-amber-100"
        >
          <span>{recovery}</span>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="self-start rounded-md border border-amber-500 px-3 py-1.5 text-xs font-medium hover:bg-amber-100 dark:hover:bg-amber-900"
          >
            Reload session
          </button>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          data-testid="add-pass-submit"
          disabled={pending || recovery !== null}
          className="rounded-md bg-neutral-900 px-5 py-3 text-base font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {pending ? "Adding…" : "Add pass"}
        </button>
        {savedLabel && (
          <span
            className="text-sm text-green-600 dark:text-green-400"
            aria-live="polite"
          >
            {savedLabel}
          </span>
        )}
      </div>
    </form>
  );
}
