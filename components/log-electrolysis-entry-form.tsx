"use client";

import { useState, useTransition } from "react";
import {
  APILUS_MODALITIES_BY_MODE,
  AREAS,
  COMMON_COMMENTS,
  ELECTROLYSIS_MODES,
  MACHINE_FREQUENCIES,
  PROBE_SIZES,
  PROBE_TYPES,
  PULSE_COUNT_DEFAULT,
  PULSE_COUNT_MAX,
  PULSE_COUNT_MIN,
} from "@/lib/constants";
import type {
  ApilusModality,
  ElectrolysisEntry,
  MachineFrequency,
  ProbeLot,
  ProbeType,
} from "@/lib/types/database";
import { appendComment } from "@/lib/comments";
import { ChipSelector } from "./chip-selector";

type FormState = {
  area: string;
  probe_size: string;
  probe_lot_id: string;
  mode: string;
  apilus_modality: string;
  intensity: string;
  duration_seconds: string;
  pulse_count: string;
  energy_level: string;
  minutes_performed: string;
  probe_type: string;
  machine_frequency: string;
  comments: string;
};

const EMPTY: FormState = {
  area: "",
  probe_size: "",
  probe_lot_id: "",
  mode: "",
  apilus_modality: "",
  intensity: "",
  duration_seconds: "",
  pulse_count: String(PULSE_COUNT_DEFAULT),
  energy_level: "",
  minutes_performed: "",
  probe_type: "",
  machine_frequency: "",
  comments: "",
};

// Sticky fields: when the practitioner saves an entry or hits Clear, only
// these two values carry forward. Everything else resets so the next hair
// area gets a fresh entry.
type StickyDefaults = {
  probe_type: string;
  machine_frequency: string;
};

function blankStateWithStickyFrom(state: FormState): FormState {
  return {
    ...EMPTY,
    probe_type: state.probe_type,
    machine_frequency: state.machine_frequency,
  };
}

function fromLastEntry(e: ElectrolysisEntry | null): FormState {
  if (!e) return EMPTY;
  return {
    area: e.area ?? "",
    probe_size: e.probe_size ?? "",
    probe_lot_id: e.probe_lot_id ?? "",
    mode: e.mode ?? "",
    apilus_modality: e.apilus_modality ?? "",
    intensity: e.intensity != null ? String(e.intensity) : "",
    duration_seconds:
      e.duration_seconds != null ? String(e.duration_seconds) : "",
    pulse_count:
      e.pulse_count != null ? String(e.pulse_count) : String(PULSE_COUNT_DEFAULT),
    energy_level: e.energy_level != null ? String(e.energy_level) : "",
    minutes_performed:
      e.minutes_performed != null ? String(e.minutes_performed) : "",
    probe_type: e.probe_type ?? "",
    machine_frequency: e.machine_frequency ?? "",
    comments: e.comments ?? "",
  };
}

type Props = {
  sessionId: string;
  clientId: string;
  probeLots: ProbeLot[];
  lastEntry: ElectrolysisEntry | null;
  /** Sticky defaults for probe_type + machine_frequency (latest in-session entry). */
  stickyDefaults: StickyDefaults;
  action: (formData: FormData) => Promise<void>;
};

const PROBE_SIZE_OPTIONS: ReadonlyArray<string> = [...PROBE_SIZES, "Other"];

export function LogElectrolysisEntryForm({
  sessionId,
  clientId,
  probeLots,
  lastEntry,
  stickyDefaults,
  action,
}: Props) {
  const [state, setState] = useState<FormState>(() => ({
    ...EMPTY,
    probe_type: stickyDefaults.probe_type,
    machine_frequency: stickyDefaults.machine_frequency,
  }));
  const [error, setError] = useState<string | null>(null);
  const [showSaved, setShowSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setState((s) => ({ ...s, [key]: value }));
  }

  function handleModeChange(next: string) {
    setState((s) => ({
      ...s,
      mode: next,
      // Galvanic carries no apilus modality or energy level.
      apilus_modality: next === "galv" ? "" : s.apilus_modality,
      energy_level: next === "galv" ? "" : s.energy_level,
    }));
  }

  function bumpPulse(delta: number) {
    const current = parseInt(state.pulse_count, 10);
    const base = Number.isFinite(current) ? current : PULSE_COUNT_DEFAULT;
    const next = Math.min(
      PULSE_COUNT_MAX,
      Math.max(PULSE_COUNT_MIN, base + delta),
    );
    update("pulse_count", String(next));
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!state.area) {
      setError("Area is required.");
      return;
    }
    const fd = new FormData();
    fd.set("session_id", sessionId);
    fd.set("client_id", clientId);
    fd.set("area", state.area);
    fd.set("probe_size", state.probe_size);
    fd.set("probe_lot_id", state.probe_lot_id);
    fd.set("mode", state.mode);
    fd.set("apilus_modality", state.apilus_modality);
    fd.set("intensity", state.intensity);
    fd.set("duration_seconds", state.duration_seconds);
    fd.set("pulse_count", state.pulse_count);
    fd.set("energy_level", state.energy_level);
    fd.set("minutes_performed", state.minutes_performed);
    fd.set("probe_type", state.probe_type);
    fd.set("machine_frequency", state.machine_frequency);
    fd.set("comments", state.comments);

    startTransition(async () => {
      try {
        await action(fd);
        // After save, reset everything except the sticky pair.
        setState((s) => blankStateWithStickyFrom(s));
        setShowSaved(true);
        window.setTimeout(() => setShowSaved(false), 1500);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to add entry.");
      }
    });
  }

  const mode = state.mode;
  const showModality = mode === "thermo" || mode === "blend";
  const showEnergyLevel = mode === "thermo" || mode === "blend";
  const modalityOptions =
    mode === "thermo"
      ? APILUS_MODALITIES_BY_MODE.thermo
      : mode === "blend"
        ? APILUS_MODALITIES_BY_MODE.blend
        : [];

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-5 rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-950"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-base font-medium">Add entry</h3>
        <button
          type="button"
          disabled={!lastEntry}
          onClick={() => setState(fromLastEntry(lastEntry))}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Copy from last session
        </button>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">
          Area<span className="ml-1 text-red-500">*</span>
        </span>
        <ChipSelector
          options={AREAS}
          value={state.area}
          onChange={(v) => update("area", v)}
          otherPlaceholder="Describe area"
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Probe size</span>
        <ChipSelector
          options={PROBE_SIZE_OPTIONS}
          value={state.probe_size}
          onChange={(v) => update("probe_size", v)}
          otherPlaceholder="Describe probe size"
        />
      </div>

      {probeLots.length > 0 && (
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Probe lot</span>
          <select
            value={state.probe_lot_id}
            onChange={(e) => update("probe_lot_id", e.target.value)}
            className="max-w-sm rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          >
            <option value="">No lot</option>
            {probeLots.map((l) => (
              <option key={l.id} value={l.id}>
                {l.probe_size}
                {l.lot_number ? ` · ${l.lot_number}` : ""}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="flex flex-col gap-4 border-t border-neutral-200 pt-5 dark:border-neutral-800">
        <p className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Treatment parameters
        </p>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Mode</span>
          <div className="flex flex-wrap gap-2">
            {ELECTROLYSIS_MODES.map((m) => {
              const selected = state.mode === m.value;
              return (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => handleModeChange(selected ? "" : m.value)}
                  className={`rounded-full border px-4 py-2 text-sm transition ${
                    selected
                      ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                      : "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300"
                  }`}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>

        {showModality && (
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Modality</span>
            <select
              value={state.apilus_modality}
              onChange={(e) =>
                update(
                  "apilus_modality",
                  e.target.value as ApilusModality | "",
                )
              }
              className="max-w-sm rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
            >
              <option value="">Select…</option>
              {modalityOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <SuffixField
            label="Intensity"
            suffix="%"
            value={state.intensity}
            onChange={(v) => update("intensity", v)}
            step="0.1"
            min={0}
            max={100}
          />
          <SuffixField
            label="Duration"
            suffix="s"
            value={state.duration_seconds}
            onChange={(v) => update("duration_seconds", v)}
            step="0.001"
            min={0}
            placeholder="0.0"
          />
        </div>

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
              value={state.pulse_count}
              onChange={(e) => update("pulse_count", e.target.value)}
              className="w-20 rounded-md border border-neutral-300 bg-white px-3 py-3 text-center text-base tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
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
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {showEnergyLevel && (
            <SuffixField
              label="Energy Level (EL)"
              value={state.energy_level}
              onChange={(v) => update("energy_level", v)}
              step="1"
              min={0}
              integer
            />
          )}
          <SuffixField
            label="Minutes performed"
            suffix="min"
            value={state.minutes_performed}
            onChange={(v) => update("minutes_performed", v)}
            step="1"
            min={0}
            integer
          />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Probe type</span>
            <select
              value={state.probe_type}
              onChange={(e) =>
                update("probe_type", e.target.value as ProbeType | "")
              }
              className="rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
            >
              <option value="">Select…</option>
              {PROBE_TYPES.map((p) => (
                <option key={p} value={p}>
                  {p} probe
                </option>
              ))}
            </select>
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Machine frequency</span>
            <div className="flex flex-wrap gap-2">
              {MACHINE_FREQUENCIES.map((f) => {
                const selected = state.machine_frequency === f;
                return (
                  <button
                    key={f}
                    type="button"
                    onClick={() =>
                      update(
                        "machine_frequency",
                        selected ? "" : (f as MachineFrequency),
                      )
                    }
                    className={`rounded-full border px-4 py-2 text-sm transition ${
                      selected
                        ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                        : "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300"
                    }`}
                  >
                    {f}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t border-neutral-200 pt-5 dark:border-neutral-800">
        <span className="text-sm font-medium">Comments</span>
        <div className="flex flex-wrap gap-2">
          {COMMON_COMMENTS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() =>
                update("comments", appendComment(state.comments, c))
              }
              className="rounded-full border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:border-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300 dark:hover:bg-neutral-900"
            >
              + {c}
            </button>
          ))}
        </div>
        <textarea
          rows={2}
          value={state.comments}
          onChange={(e) => update("comments", e.target.value)}
          placeholder="Tap a chip or type a note"
          className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-900 px-5 py-3 text-base font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {pending ? "Adding…" : "Add entry"}
        </button>
        <button
          type="button"
          onClick={() => setState((s) => blankStateWithStickyFrom(s))}
          disabled={pending}
          className="rounded-md border border-neutral-300 px-5 py-3 text-base hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Clear
        </button>
        {showSaved && (
          <span
            className="text-sm text-green-600 dark:text-green-400"
            aria-live="polite"
          >
            Saved
          </span>
        )}
      </div>
    </form>
  );
}

function SuffixField({
  label,
  suffix,
  value,
  onChange,
  step,
  min,
  max,
  placeholder,
  integer = false,
}: {
  label: string;
  suffix?: string;
  value: string;
  onChange: (v: string) => void;
  step?: string;
  min?: number;
  max?: number;
  placeholder?: string;
  integer?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex items-stretch">
        <input
          type="number"
          inputMode={integer ? "numeric" : "decimal"}
          step={step}
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={`w-full rounded-md ${
            suffix ? "rounded-r-none" : ""
          } border border-neutral-300 bg-white px-3 py-2.5 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100`}
        />
        {suffix && (
          <span className="inline-flex items-center rounded-md rounded-l-none border border-l-0 border-neutral-300 bg-neutral-50 px-3 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
            {suffix}
          </span>
        )}
      </div>
    </label>
  );
}
