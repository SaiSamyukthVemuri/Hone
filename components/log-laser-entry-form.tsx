"use client";

import { useState, useTransition } from "react";
import {
  FLUENCE_DEFAULT,
  FLUENCE_MAX,
  FLUENCE_MIN,
  LASER_OBSERVATION_CHIPS,
  LASER_ZONES,
} from "@/lib/constants";
import type { LaserEntry } from "@/lib/types/database";
import { appendComment } from "@/lib/comments";
import { ChipSelector } from "./chip-selector";

type FormState = {
  zone: string;
  session_number: string;
  fluence: string;
  pulse_width: string;
  spot_size: string;
  observation_notes: string;
};

function emptyState(): FormState {
  return {
    zone: "",
    session_number: "",
    fluence: String(FLUENCE_DEFAULT),
    pulse_width: "",
    spot_size: "",
    observation_notes: "",
  };
}

function fromLastEntry(e: LaserEntry | null): FormState {
  if (!e) return emptyState();
  const params = (e.equipment_params ?? {}) as Record<string, unknown>;
  return {
    zone: e.zone ?? "",
    session_number: e.session_number != null ? String(e.session_number) : "",
    fluence:
      typeof params.fluence === "string" && params.fluence
        ? params.fluence
        : String(FLUENCE_DEFAULT),
    pulse_width: typeof params.pulse_width === "string" ? params.pulse_width : "",
    spot_size: typeof params.spot_size === "string" ? params.spot_size : "",
    observation_notes: e.observation_notes ?? "",
  };
}

function suggestTreatmentNumber(
  zone: string,
  counts: Record<string, number>,
): string {
  if (!zone) return "";
  return String((counts[zone] ?? 0) + 1);
}

type Props = {
  sessionId: string;
  clientId: string;
  lastEntry: LaserEntry | null;
  treatmentCounts: Record<string, number>;
  action: (formData: FormData) => Promise<void>;
};

export function LogLaserEntryForm({
  sessionId,
  clientId,
  lastEntry,
  treatmentCounts,
  action,
}: Props) {
  const [state, setState] = useState<FormState>(emptyState);
  // Once the practitioner touches the treatment number we stop auto-suggesting from zone changes.
  const [treatmentTouched, setTreatmentTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setState((s) => ({ ...s, [key]: value }));
  }

  function handleZoneChange(zone: string) {
    setState((s) => ({
      ...s,
      zone,
      session_number: treatmentTouched
        ? s.session_number
        : suggestTreatmentNumber(zone, treatmentCounts),
    }));
  }

  function bumpFluence(delta: number) {
    const current = Number(state.fluence);
    const base = Number.isFinite(current) ? current : FLUENCE_DEFAULT;
    const next = Math.min(FLUENCE_MAX, Math.max(FLUENCE_MIN, base + delta));
    update("fluence", String(next));
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!state.zone.trim()) {
      setError("Zone is required.");
      return;
    }
    const fd = new FormData();
    fd.set("session_id", sessionId);
    fd.set("client_id", clientId);
    fd.set("zone", state.zone);
    fd.set("session_number", state.session_number);
    fd.set("fluence", state.fluence);
    fd.set("pulse_width", state.pulse_width);
    fd.set("spot_size", state.spot_size);
    fd.set("observation_notes", state.observation_notes);

    startTransition(async () => {
      try {
        await action(fd);
        setState(emptyState());
        setTreatmentTouched(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to add entry.");
      }
    });
  }

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
          onClick={() => {
            setState(fromLastEntry(lastEntry));
            setTreatmentTouched(true);
          }}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Copy from last session
        </button>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">
          Zone<span className="ml-1 text-red-500">*</span>
        </span>
        <ChipSelector
          options={LASER_ZONES}
          value={state.zone}
          onChange={handleZoneChange}
          otherPlaceholder="Describe zone"
        />
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Treatment #</span>
        <input
          type="number"
          min={1}
          inputMode="numeric"
          value={state.session_number}
          onChange={(e) => {
            setTreatmentTouched(true);
            update("session_number", e.target.value);
          }}
          className="w-32 rounded-md border border-neutral-300 bg-white px-3 py-3 text-base tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
        <span className="text-xs text-neutral-500">
          Number of laser treatments completed on this zone, including today.
        </span>
      </label>

      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium">Equipment</legend>
        <div className="grid gap-3 md:grid-cols-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-neutral-500">Fluence</span>
            <div className="flex items-stretch gap-2">
              <button
                type="button"
                onClick={() => bumpFluence(-1)}
                aria-label="Decrease fluence"
                className="rounded-md border border-neutral-300 px-3 text-lg font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
              >
                −
              </button>
              <input
                type="number"
                inputMode="numeric"
                min={FLUENCE_MIN}
                max={FLUENCE_MAX}
                value={state.fluence}
                onChange={(e) => update("fluence", e.target.value)}
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-3 text-center text-base tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
              />
              <button
                type="button"
                onClick={() => bumpFluence(1)}
                aria-label="Increase fluence"
                className="rounded-md border border-neutral-300 px-3 text-lg font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
              >
                +
              </button>
            </div>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-neutral-500">Pulse width</span>
            <input
              value={state.pulse_width}
              onChange={(e) => update("pulse_width", e.target.value)}
              placeholder="e.g. 30 ms"
              className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-neutral-500">Spot size</span>
            <input
              value={state.spot_size}
              onChange={(e) => update("spot_size", e.target.value)}
              placeholder="e.g. 18 mm"
              className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
            />
          </label>
        </div>
      </fieldset>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Observation notes</span>
        <div className="flex flex-wrap gap-2">
          {LASER_OBSERVATION_CHIPS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() =>
                update(
                  "observation_notes",
                  appendComment(state.observation_notes, c),
                )
              }
              className="rounded-full border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:border-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300 dark:hover:bg-neutral-900"
            >
              + {c}
            </button>
          ))}
        </div>
        <textarea
          rows={3}
          value={state.observation_notes}
          onChange={(e) => update("observation_notes", e.target.value)}
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
          onClick={() => {
            setState(emptyState());
            setTreatmentTouched(false);
          }}
          disabled={pending}
          className="rounded-md border border-neutral-300 px-5 py-3 text-base hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Clear
        </button>
      </div>
    </form>
  );
}
