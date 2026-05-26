"use client";

import { useState, useTransition } from "react";
import {
  APILUS_MODALITIES_BY_MODE,
  ELECTROLYSIS_MODES,
  MACHINE_FREQUENCIES,
  PROBE_SIZES,
  PROBE_TYPES,
} from "@/lib/constants";
import type {
  ApilusModality,
  ElectrolysisMode,
  MachineFrequency,
  ProbeType,
  SessionBlock,
  SessionBlockSide,
} from "@/lib/types/database";
import { ChipSelector } from "@/components/chip-selector";
import { AreaPicker } from "@/components/area-picker";
import { createSessionBlockAction } from "./block-actions";

const PRIMARY_AREA_MAX = 60;
const CUSTOM_AREA_DETAIL_MAX = 60;

// Side options for paired anatomy. The DB CHECK (migration 0039) enforces
// the same five values plus NULL. UI displays a Title-case label but
// stores the canonical lowercase value.
const SIDE_OPTIONS: ReadonlyArray<{ value: SessionBlockSide; label: string }> = [
  { value: "center", label: "Center" },
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "bilateral", label: "Bilateral" },
  { value: "n/a", label: "n/a" },
];

type Props = {
  sessionId: string;
  clientId: string;
  previousBlock: SessionBlock | null;
  onCancel: () => void;
};

type Draft = {
  blockName: string;
  mode: string;
  apilusModality: string;
  energyLevel: string;
  probeType: string;
  probeSize: string;
  machineFrequency: string;
  // Body Chart v1 Phase B fields. All optional; empty → null on save.
  primaryArea: string;
  side: string; // SessionBlockSide | ""
  customAreaDetail: string;
};

const EMPTY: Draft = {
  blockName: "",
  mode: "",
  apilusModality: "",
  energyLevel: "",
  probeType: "",
  probeSize: "",
  machineFrequency: "",
  primaryArea: "",
  side: "",
  customAreaDetail: "",
};

const PROBE_SIZE_OPTIONS: ReadonlyArray<string> = [...PROBE_SIZES, "Other"];

function fromPrevious(prev: SessionBlock | null): Draft {
  if (!prev) return EMPTY;
  return {
    blockName: "",
    mode: prev.mode ?? "",
    apilusModality: prev.apilus_modality ?? "",
    energyLevel: prev.energy_level != null ? String(prev.energy_level) : "",
    probeType: prev.probe_type ?? "",
    probeSize: prev.probe_size ?? "",
    machineFrequency: prev.machine_frequency ?? "",
    // Copy-from-previous-block carries structured area forward — same
    // ergonomic shortcut Mode/Modality/Probe already get.
    primaryArea: prev.primary_area ?? "",
    side: prev.side ?? "",
    customAreaDetail: prev.custom_area_detail ?? "",
  };
}

export function BlockSetupForm({
  sessionId,
  clientId,
  previousBlock,
  onCancel,
}: Props) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function copyFromPrevious() {
    if (!previousBlock) return;
    setDraft(fromPrevious(previousBlock));
  }

  function submit() {
    setError(null);
    const el = draft.energyLevel.trim();
    const elNum = el === "" ? null : Number(el);
    if (el !== "" && (!Number.isFinite(elNum) || (elNum as number) < 0)) {
      setError("Energy level must be a non-negative number.");
      return;
    }
    // Body Chart v1 Phase B fields. The server action also validates;
    // these client-side checks just surface friendlier errors earlier.
    const trimmedArea = draft.primaryArea.trim();
    if (trimmedArea.length > PRIMARY_AREA_MAX) {
      setError(`Primary area must be ${PRIMARY_AREA_MAX} characters or fewer.`);
      return;
    }
    const trimmedDetail = draft.customAreaDetail.trim();
    if (trimmedDetail.length > CUSTOM_AREA_DETAIL_MAX) {
      setError(`Specifics must be ${CUSTOM_AREA_DETAIL_MAX} characters or fewer.`);
      return;
    }
    startTransition(async () => {
      const res = await createSessionBlockAction({
        clientId,
        sessionId,
        blockName: draft.blockName.trim() || null,
        mode: (draft.mode || null) as ElectrolysisMode | null,
        apilusModality: (draft.apilusModality || null) as
          | ApilusModality
          | null,
        energyLevel: elNum,
        probeType: (draft.probeType || null) as ProbeType | null,
        probeSize: draft.probeSize.trim() || null,
        machineFrequency: (draft.machineFrequency || null) as
          | MachineFrequency
          | null,
        primaryArea: trimmedArea || null,
        side: draft.side || null,
        customAreaDetail: trimmedDetail || null,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // Page re-renders via revalidatePath; the new block + its simplified
      // entry form appear automatically.
      onCancel();
    });
  }

  const mode = draft.mode;
  const showModality = mode === "thermo" || mode === "blend";
  const modalityOptions =
    mode === "thermo"
      ? APILUS_MODALITIES_BY_MODE.thermo
      : mode === "blend"
        ? APILUS_MODALITIES_BY_MODE.blend
        : [];

  return (
    <div className="flex flex-col gap-5 rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-medium">New block</h3>
        {previousBlock && (
          <button
            type="button"
            onClick={copyFromPrevious}
            disabled={pending}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Copy from previous block
          </button>
        )}
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Block name</span>
        <input
          type="text"
          value={draft.blockName}
          onChange={(e) => update("blockName", e.target.value)}
          placeholder="e.g. Face, Big toe, Underarms"
          maxLength={60}
          className="max-w-sm rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
        />
        <span className="text-xs text-neutral-500">
          Optional. If left blank, this will display as &ldquo;Treatment&rdquo;
          plus its order.
        </span>
      </label>

      {/* Body Chart v1 Phase B: optional structured anatomical area.
          Independent of block_name — never derived from it. Side and
          Specifics only surface once Area is picked so the form stays
          calm for practitioners who skip this section. */}
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Treatment area</span>
        <span className="text-xs text-neutral-500">
          Optional. Used later for area-level progress. This does not change
          the block name.
        </span>
        <AreaPicker
          value={draft.primaryArea}
          onChange={(next) => {
            // Clearing the area also clears side + specifics to keep the
            // saved row internally consistent (no orphan side without an
            // area). DB allows it, but the UX is cleaner this way.
            if (!next) {
              setDraft((d) => ({
                ...d,
                primaryArea: "",
                side: "",
                customAreaDetail: "",
              }));
            } else {
              update("primaryArea", next);
            }
          }}
          idPrefix={`block-create-${sessionId}`}
        />

        {draft.primaryArea.trim().length > 0 && (
          <>
            <div className="flex flex-col gap-1.5 pt-1">
              <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
                Side
              </span>
              <div className="flex flex-wrap gap-1.5">
                {SIDE_OPTIONS.map((opt) => {
                  const selected = draft.side === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() =>
                        update("side", selected ? "" : opt.value)
                      }
                      aria-pressed={selected}
                      className={
                        "rounded-full border px-2.5 py-1 text-xs " +
                        (selected
                          ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                          : "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300")
                      }
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <label className="flex flex-col gap-1.5 pt-1">
              <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
                Specifics
              </span>
              <input
                type="text"
                value={draft.customAreaDetail}
                onChange={(e) => update("customAreaDetail", e.target.value)}
                placeholder="midline, under-chin, knuckles, jawline edge…"
                maxLength={CUSTOM_AREA_DETAIL_MAX}
                className="max-w-sm rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
              />
            </label>
          </>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Mode</span>
        <div className="flex flex-wrap gap-2">
          {ELECTROLYSIS_MODES.map((m) => {
            const selected = draft.mode === m.value;
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

      {showModality && (
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Modality</span>
          <select
            value={draft.apilusModality}
            onChange={(e) => update("apilusModality", e.target.value)}
            className="max-w-sm rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
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

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Energy level (EL)</span>
        <input
          type="number"
          inputMode="decimal"
          step="1"
          min={0}
          value={draft.energyLevel}
          onChange={(e) => update("energyLevel", e.target.value)}
          className="max-w-[16rem] rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Probe type</span>
        <select
          value={draft.probeType}
          onChange={(e) => update("probeType", e.target.value)}
          className="max-w-sm rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
        >
          <option value="">Select…</option>
          {PROBE_TYPES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Probe size</span>
        <ChipSelector
          options={PROBE_SIZE_OPTIONS}
          value={draft.probeSize}
          onChange={(v) => update("probeSize", v)}
          otherPlaceholder="Describe probe size"
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Machine frequency</span>
        <div className="flex flex-wrap gap-2">
          {MACHINE_FREQUENCIES.map((f) => {
            const selected = draft.machineFrequency === f;
            return (
              <button
                key={f}
                type="button"
                onClick={() =>
                  update("machineFrequency", selected ? "" : (f as string))
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

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-neutral-200 pt-4 dark:border-neutral-800">
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="rounded-md bg-neutral-900 px-5 py-3 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {pending ? "Creating…" : "Create block"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="rounded-md border border-neutral-300 px-5 py-3 text-sm hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
