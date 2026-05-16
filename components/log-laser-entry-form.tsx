"use client";

import { useState, useTransition } from "react";
import type { LaserEntry } from "@/lib/types/database";

type FormState = {
  zone: string;
  session_number: string;
  fluence: string;
  pulse_width: string;
  spot_size: string;
  observation_notes: string;
};

const EMPTY: FormState = {
  zone: "",
  session_number: "",
  fluence: "",
  pulse_width: "",
  spot_size: "",
  observation_notes: "",
};

function fromLastEntry(e: LaserEntry | null): FormState {
  if (!e) return EMPTY;
  const params = (e.equipment_params ?? {}) as Record<string, unknown>;
  return {
    zone: e.zone ?? "",
    session_number: e.session_number != null ? String(e.session_number) : "",
    fluence: typeof params.fluence === "string" ? params.fluence : "",
    pulse_width: typeof params.pulse_width === "string" ? params.pulse_width : "",
    spot_size: typeof params.spot_size === "string" ? params.spot_size : "",
    observation_notes: e.observation_notes ?? "",
  };
}

type Props = {
  sessionId: string;
  clientId: string;
  lastEntry: LaserEntry | null;
  action: (formData: FormData) => Promise<void>;
};

export function LogLaserEntryForm({
  sessionId,
  clientId,
  lastEntry,
  action,
}: Props) {
  const [state, setState] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setState((s) => ({ ...s, [key]: value }));
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
        setState(EMPTY);
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
          onClick={() => setState(fromLastEntry(lastEntry))}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Copy from last session
        </button>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">
            Zone<span className="ml-1 text-red-500">*</span>
          </span>
          <input
            value={state.zone}
            onChange={(e) => update("zone", e.target.value)}
            required
            className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Session number</span>
          <input
            type="number"
            inputMode="numeric"
            value={state.session_number}
            onChange={(e) => update("session_number", e.target.value)}
            className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
        </label>
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium">Equipment</legend>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-neutral-500">Fluence</span>
            <input
              value={state.fluence}
              onChange={(e) => update("fluence", e.target.value)}
              placeholder="e.g. 18 J/cm²"
              className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
            />
          </label>
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

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Observation notes</span>
        <textarea
          rows={3}
          value={state.observation_notes}
          onChange={(e) => update("observation_notes", e.target.value)}
          className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
      </label>

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
          onClick={() => setState(EMPTY)}
          disabled={pending}
          className="rounded-md border border-neutral-300 px-5 py-3 text-base hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Clear
        </button>
      </div>
    </form>
  );
}
