"use client";

import { useState, useTransition } from "react";
import {
  AREAS,
  COMMON_COMMENTS,
  PULSE_COUNT_DEFAULT,
  PULSE_COUNT_MAX,
  PULSE_COUNT_MIN,
  PULSE_DELAY_DEFAULT,
  PULSE_DELAY_MIN,
  PULSE_DELAY_MAX,
} from "@/lib/constants";
import type { SessionBlock } from "@/lib/types/database";
import { appendComment } from "@/lib/comments";
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

    startTransition(async () => {
      try {
        await addElectrolysisEntryAction(fd);
        setDraft(emptyDraft());
        setSavedLabel(pickSavedLabel());
        window.setTimeout(() => setSavedLabel(null), 1500);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to add entry.");
      }
    });
  }

  return (
    <form
      onSubmit={submit}
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
                inputMode="numeric"
                step="1"
                min={0}
                value={draft.thermolysisDurationSeconds}
                onChange={(e) =>
                  update("thermolysisDurationSeconds", e.target.value)
                }
                className="rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
              />
            </label>
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
                step="0.1"
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
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Galvanic intensity %</span>
              <input
                type="number"
                inputMode="numeric"
                step="1"
                min={0}
                max={100}
                value={draft.galvanicIntensityPercent}
                onChange={(e) =>
                  update("galvanicIntensityPercent", e.target.value)
                }
                className="rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
              />
            </label>
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

      {block.mode !== "galv" && (
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Pulse count</span>
          <div className="flex items-stretch gap-2">
            <button
              type="button"
              onClick={() => bumpPulse(-1)}
              aria-label="Decrease pulse count"
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
              aria-label="Increase pulse count"
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
        <span className="text-sm font-medium">Comments</span>
        <div className="flex flex-wrap gap-2">
          {COMMON_COMMENTS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() =>
                update("comments", appendComment(draft.comments, c))
              }
              className="rounded-full border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:border-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300 dark:hover:bg-neutral-900"
            >
              + {c}
            </button>
          ))}
        </div>
        <textarea
          rows={2}
          value={draft.comments}
          onChange={(e) => update("comments", e.target.value)}
          placeholder="Tap a chip or type a note"
          className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
        />
      </div>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
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
