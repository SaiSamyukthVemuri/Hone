"use client";

// Treatment-area editor for an electrolysis session.
//
// Session Logging Phase A: practitioner-facing language is "treatment
// area," not "block." The underlying schema (session_blocks) and the
// create/update server actions are unchanged — this is an area-first UI
// over the existing fields:
//   - Treatment area (primary_area / side / custom_area_detail, 0039) is
//     the section identity and comes first.
//   - block_name is NOT collected in this flow. New areas save with a
//     null block_name; legacy rows keep their block_name (we never send
//     it in the edit patch, so it's preserved).
//   - Minutes performed is optional: session_blocks.minutes_performed is
//     nullable and createSessionBlockAction defaults blank → null, so a
//     blank field saves as null (not 0).
//
// Dual mode: with `block` it edits that row via updateSessionBlockAction;
// without, it creates a new row via createSessionBlockAction. Both
// actions already accept every field used here — no action behavior
// change.

import { useState, useTransition } from "react";
import {
  APILUS_MODALITIES_BY_MODE,
  ELECTROLYSIS_MODES,
  MACHINE_FREQUENCIES,
} from "@/lib/constants";
import {
  PROBE_BRANDS,
  findProbeOptionByKey,
  getMaterialsForBrand,
  getProbeOptionsFor,
  type ProbeBrand,
  type ProbeMaterial,
} from "@/lib/probes";
import type {
  ApilusModality,
  ElectrolysisMode,
  MachineFrequency,
  SessionBlock,
  SessionBlockSide,
  SessionMode,
} from "@/lib/types/database";
import { AreaPicker } from "@/components/area-picker";
import {
  createSessionBlockAction,
  updateSessionBlockAction,
} from "./block-actions";

const PRIMARY_AREA_MAX = 60;
const CUSTOM_AREA_DETAIL_MAX = 60;
const MINUTES_MAX = 1440;

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
  // For "Copy settings from last treatment area" (create mode only).
  previousBlock: SessionBlock | null;
  // When present, the form edits this existing area instead of creating.
  block?: SessionBlock | null;
  onCancel: () => void;
};

type Draft = {
  mode: string;
  apilusModality: string;
  energyLevel: string;
  // Session Logging Phase B: a single structured probe catalog key
  // (lib/probes.ts). Empty string = no probe. Replaces the old flat
  // probeType / probeSize dropdowns.
  probeKey: string;
  machineFrequency: string;
  minutes: string;
  // Treatment area (0039). All optional; empty → null on save.
  primaryArea: string;
  side: string; // SessionBlockSide | ""
  customAreaDetail: string;
};

const EMPTY: Draft = {
  mode: "",
  apilusModality: "",
  energyLevel: "",
  probeKey: "",
  machineFrequency: "",
  minutes: "",
  primaryArea: "",
  side: "",
  customAreaDetail: "",
};

function fromBlock(b: SessionBlock): Draft {
  return {
    mode: b.mode ?? "",
    apilusModality: b.apilus_modality ?? "",
    energyLevel: b.energy_level != null ? String(b.energy_level) : "",
    probeKey: b.probe_key ?? "",
    machineFrequency: b.machine_frequency ?? "",
    minutes: b.minutes_performed != null ? String(b.minutes_performed) : "",
    primaryArea: b.primary_area ?? "",
    side: b.side ?? "",
    customAreaDetail: b.custom_area_detail ?? "",
  };
}

export function BlockSetupForm({
  sessionId,
  clientId,
  previousBlock,
  block,
  onCancel,
}: Props) {
  const isEdit = !!block;
  const [draft, setDraft] = useState<Draft>(block ? fromBlock(block) : EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  // "Copy settings from last treatment area" copies machine configuration
  // only — never the area identity (primary_area / side / specifics) or
  // minutes. The practitioner chooses the new area fresh. Local UI state
  // only; no server/action change.
  function copySettings() {
    if (!previousBlock) return;
    setDraft((d) => ({
      ...d,
      mode: previousBlock.mode ?? "",
      apilusModality: previousBlock.apilus_modality ?? "",
      energyLevel:
        previousBlock.energy_level != null
          ? String(previousBlock.energy_level)
          : "",
      probeKey: previousBlock.probe_key ?? "",
      machineFrequency: previousBlock.machine_frequency ?? "",
    }));
  }

  function submit() {
    setError(null);
    const el = draft.energyLevel.trim();
    const elNum = el === "" ? null : Number(el);
    if (el !== "" && (!Number.isFinite(elNum) || (elNum as number) < 0)) {
      setError("Energy level must be a non-negative number.");
      return;
    }
    const min = draft.minutes.trim();
    const minutesNum = min === "" ? null : parseInt(min, 10);
    if (
      min !== "" &&
      (!Number.isFinite(minutesNum) ||
        (minutesNum as number) < 0 ||
        (minutesNum as number) > MINUTES_MAX)
    ) {
      setError(`Minutes must be between 0 and ${MINUTES_MAX}.`);
      return;
    }
    const trimmedArea = draft.primaryArea.trim();
    if (trimmedArea.length > PRIMARY_AREA_MAX) {
      setError(`Treatment area must be ${PRIMARY_AREA_MAX} characters or fewer.`);
      return;
    }
    const trimmedDetail = draft.customAreaDetail.trim();
    if (trimmedDetail.length > CUSTOM_AREA_DETAIL_MAX) {
      setError(`Specifics must be ${CUSTOM_AREA_DETAIL_MAX} characters or fewer.`);
      return;
    }

    startTransition(async () => {
      if (block) {
        // Edit: patch the existing row. block_name is intentionally NOT
        // included so any legacy value is preserved.
        const res = await updateSessionBlockAction({
          clientId,
          sessionId,
          blockId: block.id,
          // Legacy probe_type / probe_size are intentionally omitted so
          // any value on an existing row is preserved. The structured
          // probe is sent separately via probeOptionKey.
          probeOptionKey: draft.probeKey || null,
          patch: {
            mode: (draft.mode || null) as SessionMode | null,
            apilus_modality: (draft.apilusModality || null) as
              | ApilusModality
              | null,
            energy_level: elNum,
            machine_frequency: (draft.machineFrequency || null) as
              | MachineFrequency
              | null,
            minutes_performed: minutesNum,
            primary_area: trimmedArea || null,
            side: (draft.side || null) as SessionBlockSide | null,
            custom_area_detail: trimmedDetail || null,
          },
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        onCancel();
        return;
      }
      // Create: new treatment area. block_name omitted (null) — the
      // section title falls back to the area, then a muted placeholder.
      const res = await createSessionBlockAction({
        clientId,
        sessionId,
        mode: (draft.mode || null) as ElectrolysisMode | null,
        apilusModality: (draft.apilusModality || null) as ApilusModality | null,
        energyLevel: elNum,
        minutesPerformed: minutesNum,
        probeOptionKey: draft.probeKey || null,
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
        <h3 className="text-base font-medium">
          {isEdit ? "Edit treatment area" : "New treatment area"}
        </h3>
        {!isEdit && previousBlock && (
          <button
            type="button"
            onClick={copySettings}
            disabled={pending}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Copy settings from last treatment area
          </button>
        )}
      </div>

      {/* Treatment area first — it's the identity of this section. */}
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Treatment area</span>
        <span className="text-xs text-neutral-500">
          Optional — the area this section treats. Side and specifics appear
          once an area is chosen.
        </span>
        <AreaPicker
          value={draft.primaryArea}
          onChange={(next) => {
            // Clearing the area also clears side + specifics so the saved
            // row stays internally consistent (no orphan side).
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
          idPrefix={`area-${block?.id ?? "new"}-${sessionId}`}
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
                      onClick={() => update("side", selected ? "" : opt.value)}
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

      {/* Settings come after the area. */}
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

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Probe</span>
        <span className="text-xs text-neutral-500">
          Optional. Used for accurate electrolysis charting.
        </span>
        <ProbePicker
          value={draft.probeKey}
          onChange={(key) => update("probeKey", key)}
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

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Minutes performed (optional)</span>
        <input
          type="number"
          inputMode="numeric"
          step="1"
          min={0}
          max={MINUTES_MAX}
          value={draft.minutes}
          onChange={(e) => update("minutes", e.target.value)}
          className="max-w-[16rem] rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
        />
        <span className="text-xs text-neutral-500">
          Used for total treatment time if you track it.
        </span>
      </label>

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
          {pending ? "Saving…" : "Save treatment area"}
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

// Cascading probe picker (Session Logging Phase B). Brand → material →
// valid option chips. Only combinations present in the lib/probes.ts
// catalog are ever offered, so impossible probes can't be selected. The
// value is a single catalog key (or "" for none); the server re-validates
// it. Probe is optional — leaving it blank is fine.
const CHIP_BASE =
  "rounded-full border px-3 py-1.5 text-xs transition disabled:opacity-50";
const CHIP_OFF =
  "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300";
const CHIP_ON =
  "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900";

function ProbePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (key: string) => void;
}) {
  const selected = findProbeOptionByKey(value);

  // Drill-down state. Seeded from the selected option so "Change" reopens
  // on the right brand/material. Editing is true while the practitioner is
  // actively choosing (no selection yet, or they tapped "Change").
  const [editing, setEditing] = useState(!selected);
  const [brand, setBrand] = useState<ProbeBrand | "">(selected?.brand ?? "");
  const [material, setMaterial] = useState<ProbeMaterial | "">(
    selected?.material ?? "",
  );

  // Collapsed summary once a probe is chosen.
  if (selected && !editing) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md border border-neutral-300 bg-neutral-50 px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900">
          {selected.displayLabel}
        </span>
        <button
          type="button"
          onClick={() => {
            setBrand(selected.brand);
            setMaterial(selected.material);
            setEditing(true);
          }}
          className="text-xs text-neutral-500 underline hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          Change
        </button>
        <button
          type="button"
          onClick={() => {
            onChange("");
            setBrand("");
            setMaterial("");
            setEditing(true);
          }}
          className="text-xs text-neutral-500 underline hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          Clear
        </button>
      </div>
    );
  }

  const materials = brand ? getMaterialsForBrand(brand) : [];
  const options = brand && material ? getProbeOptionsFor(brand, material) : [];

  return (
    <div className="flex flex-col gap-3 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      {/* Brand */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Brand
        </span>
        <div className="flex flex-wrap gap-1.5">
          {PROBE_BRANDS.map((b) => (
            <button
              key={b}
              type="button"
              aria-pressed={brand === b}
              onClick={() => {
                setBrand(b);
                setMaterial("");
              }}
              className={`${CHIP_BASE} ${brand === b ? CHIP_ON : CHIP_OFF}`}
            >
              {b}
            </button>
          ))}
        </div>
      </div>

      {/* Material / type family */}
      {brand && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Material
          </span>
          <div className="flex flex-wrap gap-1.5">
            {materials.map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={material === m}
                onClick={() => setMaterial(m)}
                className={`${CHIP_BASE} ${material === m ? CHIP_ON : CHIP_OFF}`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Valid options */}
      {brand && material && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Probe
          </span>
          <div className="flex flex-wrap gap-1.5">
            {options.map((o) => (
              <button
                key={o.key}
                type="button"
                aria-pressed={value === o.key}
                onClick={() => {
                  onChange(o.key);
                  setEditing(false);
                }}
                className={`${CHIP_BASE} ${value === o.key ? CHIP_ON : CHIP_OFF}`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {selected && (
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="self-start text-xs text-neutral-500 underline hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          Done
        </button>
      )}
    </div>
  );
}
