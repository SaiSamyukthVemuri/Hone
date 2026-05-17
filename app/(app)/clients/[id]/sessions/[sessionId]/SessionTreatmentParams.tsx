"use client";

import { useState, useTransition } from "react";
import {
  APILUS_MODALITIES_BY_MODE,
  ELECTROLYSIS_MODES,
  MACHINE_FREQUENCIES,
  PROBE_TYPES,
} from "@/lib/constants";
import type {
  ApilusModality,
  ElectrolysisMode,
  MachineFrequency,
  ProbeType,
  Session,
} from "@/lib/types/database";
import { updateSessionTreatmentParamsAction } from "./actions";

type FormState = {
  electrolysis_mode: ElectrolysisMode | "";
  apilus_modality: ApilusModality | "";
  intensity_pct: string;
  duration_seconds: string;
  pulses: string;
  minutes_performed: string;
  energy_level: string;
  probe_type: ProbeType | "";
  machine_frequency: MachineFrequency | "";
};

function initialFrom(session: Session): FormState {
  return {
    electrolysis_mode: session.electrolysis_mode ?? "",
    apilus_modality: session.apilus_modality ?? "",
    intensity_pct:
      session.intensity_pct != null ? String(session.intensity_pct) : "",
    duration_seconds:
      session.duration_seconds != null ? String(session.duration_seconds) : "",
    pulses: session.pulses != null ? String(session.pulses) : "",
    minutes_performed:
      session.minutes_performed != null
        ? String(session.minutes_performed)
        : "",
    energy_level:
      session.energy_level != null ? String(session.energy_level) : "",
    probe_type: session.probe_type ?? "",
    machine_frequency: session.machine_frequency ?? "",
  };
}

type Props = {
  sessionId: string;
  clientId: string;
  session: Session;
};

export function SessionTreatmentParams({ sessionId, clientId, session }: Props) {
  const [state, setState] = useState<FormState>(() => initialFrom(session));
  const [error, setError] = useState<string | null>(null);
  const [showSaved, setShowSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setState((s) => ({ ...s, [key]: value }));
  }

  function handleModeChange(mode: ElectrolysisMode | "") {
    setState((s) => ({
      ...s,
      electrolysis_mode: mode,
      // Galvanic carries no apilus modality and no energy level.
      apilus_modality: mode === "galv" ? "" : s.apilus_modality,
      energy_level: mode === "galv" ? "" : s.energy_level,
    }));
  }

  function handleSave() {
    setError(null);
    const fd = new FormData();
    fd.set("session_id", sessionId);
    fd.set("client_id", clientId);
    fd.set("electrolysis_mode", state.electrolysis_mode);
    fd.set("apilus_modality", state.apilus_modality);
    fd.set("intensity_pct", state.intensity_pct);
    fd.set("duration_seconds", state.duration_seconds);
    fd.set("pulses", state.pulses);
    fd.set("minutes_performed", state.minutes_performed);
    fd.set("energy_level", state.energy_level);
    fd.set("probe_type", state.probe_type);
    fd.set("machine_frequency", state.machine_frequency);

    startTransition(async () => {
      const result = await updateSessionTreatmentParamsAction(fd);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setShowSaved(true);
      window.setTimeout(() => setShowSaved(false), 1500);
    });
  }

  const mode = state.electrolysis_mode;
  const modalityOptions =
    mode === "thermo"
      ? APILUS_MODALITIES_BY_MODE.thermo
      : mode === "blend"
        ? APILUS_MODALITIES_BY_MODE.blend
        : [];
  const showModality = mode === "thermo" || mode === "blend";
  const showEnergyLevel = mode === "thermo" || mode === "blend";

  return (
    <section className="flex flex-col gap-6 rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-950">
      <header>
        <h3 className="text-base font-medium">Treatment parameters</h3>
        <p className="mt-1 text-xs text-neutral-500">
          Session-level settings from your machine. All fields optional.
        </p>
      </header>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Mode</span>
        <div className="flex flex-wrap gap-2">
          {ELECTROLYSIS_MODES.map((m) => {
            const selected = mode === m.value;
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
              update("apilus_modality", e.target.value as ApilusModality | "")
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
          value={state.intensity_pct}
          onChange={(v) => update("intensity_pct", v)}
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
        <SuffixField
          label="Pulses"
          value={state.pulses}
          onChange={(v) => update("pulses", v)}
          step="1"
          min={0}
          integer
        />
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

      <div className="border-t border-neutral-200 pt-5 dark:border-neutral-800">
        <h4 className="text-sm font-medium">Equipment</h4>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
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
              {PROBE_TYPES.map((opt) => (
                <option key={opt} value={opt}>
                  {opt} probe
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

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={pending}
          className="rounded-md bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {pending ? "Saving" : "Save parameters"}
        </button>
        {showSaved && (
          <span
            className="text-sm text-green-600 dark:text-green-400"
            aria-live="polite"
          >
            Saved
          </span>
        )}
        {error && (
          <span className="text-sm text-red-600 dark:text-red-400">{error}</span>
        )}
      </div>
    </section>
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
