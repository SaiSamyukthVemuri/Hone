"use client";

import { useId } from "react";
import {
  ELECTROLYSIS_MODES,
  MACHINE_FREQUENCIES,
  APILUS_MODALITIES_BY_MODE,
  apilusModalityLabel,
  PULSE_COUNT_MIN,
  PULSE_COUNT_MAX,
} from "@/lib/constants";
import { MultiAreaEditor } from "@/components/multi-area-editor";
import { ProbePicker } from "@/components/probe-picker";
import type { BlockArea } from "@/lib/sessions/block-areas";
import { resolveModeSections } from "@/lib/sessions/mode-sections";
import {
  READING_INPUT_CLS,
  CHIP_BASE,
  CHIP_OFF,
  CHIP_ON,
} from "@/lib/sessions/charting-input-styles";
import type { CopyAreaDraft } from "@/lib/sessions/whole-session-copy";

const CUSTOM_DETAIL_MAX = 60;

// One EPHEMERAL, editable copy-preview card. It edits a CopyAreaDraft entirely in
// the parent's React state via onChange, it performs ZERO server actions and
// ZERO database writes. It reuses the SAME shared widgets/constants/mode-gating
// as the block charting form (MultiAreaEditor, ProbePicker, ELECTROLYSIS_MODES,
// MACHINE_FREQUENCIES, APILUS_MODALITIES_BY_MODE, resolveModeSections) so the two
// never drift. Performed treatment time is intentionally NOT editable here,
// today's minutes stay blank and are never copied.
export function CopyDraftCard({
  draft,
  onChange,
  onRemove,
}: {
  draft: CopyAreaDraft;
  onChange: (next: CopyAreaDraft) => void;
  onRemove: () => void;
}) {
  const idp = useId();
  const s = draft.setup;
  const sections = resolveModeSections(s.mode);
  // Mirror the charting form's modality-level rule (block-setup-form.tsx): OmniBlend
  // has NO thermolysis duration. Gate the duration input on !isOmniblend and clear
  // any typed value when the practitioner switches to OmniBlend, so a reviewed copy
  // card can't persist a thermolysis duration on an OmniBlend entry.
  const isOmniblend = s.apilusModality === "Omniblend";

  function patchSetup(patch: Partial<CopyAreaDraft["setup"]>) {
    onChange({ ...draft, setup: { ...draft.setup, ...patch } });
  }

  // Changing mode re-gates the card the same way the data layer does, so an
  // off-mode value never lingers in the UI (the server re-gates regardless).
  function setMode(mode: string) {
    const next = resolveModeSections(mode);
    onChange({
      ...draft,
      setup: {
        ...draft.setup,
        mode,
        apilusModality: next.showModality ? draft.setup.apilusModality : "",
        energyLevel: next.showModality ? draft.setup.energyLevel : "",
        thermolysisIntensityPercent: next.showThermo ? draft.setup.thermolysisIntensityPercent : "",
        thermolysisDurationSeconds: next.showThermo ? draft.setup.thermolysisDurationSeconds : "",
        galvanicMa: next.showGalv ? draft.setup.galvanicMa : "",
        galvanicDurationSeconds: next.showGalv ? draft.setup.galvanicDurationSeconds : "",
        // galvanic_intensity_percent is retired, no card field to re-gate.
        unitsOfLye: next.showGalv ? draft.setup.unitsOfLye : "",
      },
    });
  }

  function setAreas(areas: BlockArea[]) {
    onChange({
      ...draft,
      areas: areas.map((a) => ({ area: a.area, laterality: a.laterality })),
    });
  }

  const modalityOptions = sections.showModality
    ? (APILUS_MODALITIES_BY_MODE[s.mode as "thermo" | "blend"] ?? [])
    : [];
  const showPulseDelay = Number(s.pulseCount) > 1;

  return (
    <li
      data-testid={`copy-draft-${draft.key}`}
      className="flex flex-col gap-4 rounded-md border border-neutral-200 p-4 dark:border-neutral-800"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="text-sm font-medium">Area to copy</span>
        <button
          type="button"
          onClick={onRemove}
          data-testid={`copy-draft-remove-${draft.key}`}
          className="shrink-0 rounded-md border border-neutral-300 px-2 py-1 text-xs hover:border-neutral-500 dark:border-neutral-700"
        >
          Remove
        </button>
      </div>

      {/* Areas + laterality: shared MultiAreaEditor. */}
      <MultiAreaEditor
        value={draft.areas.map((a) => ({ area: a.area, laterality: a.laterality }) as BlockArea)}
        onChange={setAreas}
        idPrefix={`${idp}-areas`}
      />

      {/* Custom-area detail. */}
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Area detail (optional)</span>
        <input
          type="text"
          maxLength={CUSTOM_DETAIL_MAX}
          value={draft.customAreaDetail ?? ""}
          onChange={(e) => onChange({ ...draft, customAreaDetail: e.target.value })}
          data-testid={`copy-draft-${draft.key}-custom-detail`}
          className={READING_INPUT_CLS}
        />
      </label>

      {/* Mode. */}
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Mode</span>
        <div className="flex flex-wrap gap-1.5">
          {ELECTROLYSIS_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              aria-pressed={s.mode === m.value}
              onClick={() => setMode(m.value)}
              data-testid={`copy-draft-${draft.key}-mode-${m.value}`}
              className={`${CHIP_BASE} ${s.mode === m.value ? CHIP_ON : CHIP_OFF}`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Machine frequency. */}
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Machine frequency</span>
        <div className="flex flex-wrap gap-1.5">
          {MACHINE_FREQUENCIES.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={s.machineFrequency === f}
              onClick={() =>
                patchSetup({ machineFrequency: s.machineFrequency === f ? "" : f })
              }
              data-testid={`copy-draft-${draft.key}-freq-${f.replace(/\s+/g, "")}`}
              className={`${CHIP_BASE} ${s.machineFrequency === f ? CHIP_ON : CHIP_OFF}`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Apilus modality + energy (thermo/blend only). */}
      {sections.showModality && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Apilus modality</span>
            <select
              value={s.apilusModality}
              onChange={(e) => {
                const next = e.target.value;
                // OmniBlend has no thermolysis duration: clear it on switch so a
                // now-hidden reading can't be committed (mirrors the charting form).
                patchSetup({
                  apilusModality: next,
                  ...(next === "Omniblend" ? { thermolysisDurationSeconds: "" } : {}),
                });
              }}
              data-testid={`copy-draft-${draft.key}-apilus`}
              className={READING_INPUT_CLS}
            >
              <option value="">None</option>
              {modalityOptions.map((m) => (
                <option key={m} value={m}>
                  {apilusModalityLabel(m)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Energy level</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              value={s.energyLevel}
              onChange={(e) => patchSetup({ energyLevel: e.target.value })}
              data-testid={`copy-draft-${draft.key}-energy`}
              className={READING_INPUT_CLS}
            />
          </label>
        </div>
      )}

      {/* MACHINE ORDER (Chloe): energy level, then the complete galvanic group
          (units of lye → duration → mA), then thermolysis (duration → intensity
          → pulse count → pulse delay). Same order as the charting forms; the
          canonical list lives in lib/sessions/reading-field-order.ts. */}
      {/* Galvanic readings (galv/blend). */}
      {sections.showGalv && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Units of lye</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.1"
              min={0}
              value={s.unitsOfLye}
              onChange={(e) => patchSetup({ unitsOfLye: e.target.value })}
              data-testid={`copy-draft-${draft.key}-units-lye`}
              className={READING_INPUT_CLS}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Galvanic duration (s)</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              value={s.galvanicDurationSeconds}
              onChange={(e) => patchSetup({ galvanicDurationSeconds: e.target.value })}
              data-testid={`copy-draft-${draft.key}-galv-duration`}
              className={READING_INPUT_CLS}
            />
          </label>
          {/* The galvanic intensity reading is RETIRED (Phase A): no field here. */}
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Galvanic mA</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min={0}
              value={s.galvanicMa}
              onChange={(e) => patchSetup({ galvanicMa: e.target.value })}
              data-testid={`copy-draft-${draft.key}-galv-ma`}
              className={READING_INPUT_CLS}
            />
          </label>
        </div>
      )}

      {/* Thermolysis readings (thermo/blend). */}
      {sections.showThermo && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {!isOmniblend && (
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Thermolysis duration (s)</span>
              <input
                type="number"
                inputMode="decimal"
                step="0.001"
                min={0}
                value={s.thermolysisDurationSeconds}
                onChange={(e) => patchSetup({ thermolysisDurationSeconds: e.target.value })}
                data-testid={`copy-draft-${draft.key}-therm-duration`}
                className={READING_INPUT_CLS}
              />
            </label>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Thermolysis intensity %</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={100}
              value={s.thermolysisIntensityPercent}
              onChange={(e) => patchSetup({ thermolysisIntensityPercent: e.target.value })}
              data-testid={`copy-draft-${draft.key}-therm-intensity`}
              className={READING_INPUT_CLS}
            />
          </label>
          {/* Pulse control lives INSIDE the thermolysis section (Phase A): pulse
              is a thermolysis concept, shown only for thermo/blend. */}
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Thermolysis pulse count</span>
            <input
              type="number"
              inputMode="numeric"
              min={PULSE_COUNT_MIN}
              max={PULSE_COUNT_MAX}
              value={s.pulseCount}
              onChange={(e) => {
                const v = e.target.value;
                // single pulse clears the delay (UI mirror of the data-layer rule)
                patchSetup({ pulseCount: v, ...(Number(v) > 1 ? {} : { pulseDelay: "" }) });
              }}
              data-testid={`copy-draft-${draft.key}-pulse-count`}
              className={READING_INPUT_CLS}
            />
          </label>
          {showPulseDelay && (
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Pulse delay (s)</span>
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                value={s.pulseDelay}
                onChange={(e) => patchSetup({ pulseDelay: e.target.value })}
                data-testid={`copy-draft-${draft.key}-pulse-delay`}
                className={READING_INPUT_CLS}
              />
            </label>
          )}
        </div>
      )}

      {/* Pulse control moved INSIDE the thermolysis section above (Phase A:
          pulse is thermolysis-specific, shown only for thermo/blend). */}

      {/* Probe: shared ProbePicker (server derives decomposition from the key). */}
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Probe</span>
        <ProbePicker
          value={s.probeKey}
          onChange={(key) => patchSetup({ probeKey: key })}
        />
      </div>
    </li>
  );
}
