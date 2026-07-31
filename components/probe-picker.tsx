"use client";

import { useState } from "react";
import {
  PROBE_BRANDS,
  findProbeOptionByKey,
  getMaterialsForBrand,
  getProbeOptionsFor,
  type ProbeBrand,
  type ProbeMaterial,
} from "@/lib/probes";
import { CHIP_BASE, CHIP_OFF, CHIP_ON } from "@/lib/sessions/charting-input-styles";

// Cascading probe picker (Session Logging Phase B). Brand → material → valid
// option chips. Only combinations present in the lib/probes.ts catalog are ever
// offered, so impossible probes can't be selected. The value is a single catalog
// key (or "" for none); the server re-validates it. Probe is optional — leaving
// it blank is fine. Shared by the block charting form and the whole-session copy
// editor (single source of truth — no drifting duplicate).
export function ProbePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (key: string) => void;
}) {
  const selected = findProbeOptionByKey(value);

  const [editing, setEditing] = useState(!selected);
  const [brand, setBrand] = useState<ProbeBrand | "">(selected?.brand ?? "");
  const [material, setMaterial] = useState<ProbeMaterial | "">(selected?.material ?? "");

  if (selected && !editing) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md border border-neutral-300 bg-neutral-50 px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900">
          {selected.displayLabel}
        </span>
        <button
          type="button"
          data-testid="probe-change"
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
