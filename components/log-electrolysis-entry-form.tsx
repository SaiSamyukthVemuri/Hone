"use client";

import { useState, useTransition } from "react";
import {
  AREAS,
  COMMON_COMMENTS,
  ELECTROLYSIS_MODES,
  PROBE_SIZES,
  PULSE_COUNT_DEFAULT,
  PULSE_COUNT_MAX,
  PULSE_COUNT_MIN,
} from "@/lib/constants";
import type { ElectrolysisEntry, ProbeLot } from "@/lib/types/database";
import { ChipSelector } from "./chip-selector";

type FormState = {
  area: string;
  probe_size: string;
  probe_lot_id: string;
  mode: string;
  intensity: string;
  duration_seconds: string;
  pulse_count: string;
  comments: string;
};

const EMPTY: FormState = {
  area: "",
  probe_size: "",
  probe_lot_id: "",
  mode: "",
  intensity: "",
  duration_seconds: "",
  pulse_count: String(PULSE_COUNT_DEFAULT),
  comments: "",
};

function fromLastEntry(e: ElectrolysisEntry | null): FormState {
  if (!e) return EMPTY;
  return {
    area: e.area ?? "",
    probe_size: e.probe_size ?? "",
    probe_lot_id: e.probe_lot_id ?? "",
    mode: e.mode ?? "",
    intensity: e.intensity != null ? String(e.intensity) : "",
    duration_seconds:
      e.duration_seconds != null ? String(e.duration_seconds) : "",
    pulse_count:
      e.pulse_count != null ? String(e.pulse_count) : String(PULSE_COUNT_DEFAULT),
    comments: e.comments ?? "",
  };
}

function appendComment(existing: string, chip: string): string {
  if (!existing.trim()) return chip;
  // Avoid appending the same chip back-to-back (only the most recent token matters).
  const lastToken = existing.split(/,\s*/).pop()?.trim().toLowerCase();
  if (lastToken === chip.toLowerCase()) return existing;
  return `${existing.replace(/\s*,?\s*$/, "")}, ${chip}`;
}

type Props = {
  sessionId: string;
  clientId: string;
  probeLots: ProbeLot[];
  lastEntry: ElectrolysisEntry | null;
  action: (formData: FormData) => Promise<void>;
};

export function LogElectrolysisEntryForm({
  sessionId,
  clientId,
  probeLots,
  lastEntry,
  action,
}: Props) {
  const [state, setState] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setState((s) => ({ ...s, [key]: value }));
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
    fd.set("intensity", state.intensity);
    fd.set("duration_seconds", state.duration_seconds);
    fd.set("pulse_count", state.pulse_count);
    fd.set("comments", state.comments);

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

      <div className="grid gap-5 md:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Probe size</span>
          <select
            value={state.probe_size}
            onChange={(e) => update("probe_size", e.target.value)}
            className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          >
            <option value="">Select…</option>
            {PROBE_SIZES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Probe lot</span>
          <select
            value={state.probe_lot_id}
            onChange={(e) => update("probe_lot_id", e.target.value)}
            className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          >
            <option value="">—</option>
            {probeLots.map((l) => (
              <option key={l.id} value={l.id}>
                {l.probe_size}
                {l.lot_number ? ` · ${l.lot_number}` : ""}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Mode</span>
        <div className="flex flex-wrap gap-2">
          {ELECTROLYSIS_MODES.map((m) => {
            const selected = state.mode === m.value;
            return (
              <button
                key={m.value}
                type="button"
                onClick={() => update("mode", selected ? "" : m.value)}
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

      <div className="grid gap-5 md:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Intensity</span>
          <input
            type="number"
            step="0.1"
            inputMode="decimal"
            value={state.intensity}
            onChange={(e) => update("intensity", e.target.value)}
            className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Duration (seconds)</span>
          <input
            type="number"
            step="0.1"
            inputMode="decimal"
            value={state.duration_seconds}
            onChange={(e) => update("duration_seconds", e.target.value)}
            className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
        </label>
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
            Pulses per hair (1–{PULSE_COUNT_MAX}).
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-2">
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
