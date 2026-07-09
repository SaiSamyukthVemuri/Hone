"use client";

import { useState } from "react";
import { AREA_REGIONS, OTHER_AREA } from "@/lib/constants";
import { isCanonicalTreatmentArea } from "@/lib/sessions/area-validation";

const PRIMARY_AREA_MAX = 60;

// Canonical iff the value is in the FLAT AREAS list (incl. "Full face"/"Other"),
// case-insensitive — NOT AREA_REGIONS alone, which decomposes "Full face" and
// would wrongly route a legitimate "Full face" value into the Other input.
function isCanonicalArea(value: string): boolean {
  return isCanonicalTreatmentArea(value);
}

// Region-grouped chip picker for a structured anatomical area. Used by
// both the treatment plan creator/notes editor (Body Chart v1 Phase A)
// and the session block setup form (Phase B). Optional: an empty value
// persists as NULL on the parent row. Selecting "Other" reveals a
// free-text input so practitioner-specific labels still flow without
// polluting the canonical list. The value lives in component state; the
// parent renders this inside a form and reads back the resolved string
// via the controlled `value` + `onChange`.
export function AreaPicker({
  value,
  onChange,
  idPrefix,
}: {
  value: string;
  onChange: (next: string) => void;
  idPrefix: string;
}) {
  const isCanonical = isCanonicalArea(value);
  const startsAsOther = value.length > 0 && !isCanonical;
  const [otherSelected, setOtherSelected] = useState(startsAsOther);
  const [customValue, setCustomValue] = useState(startsAsOther ? value : "");

  function pickCanonical(area: string) {
    setOtherSelected(false);
    onChange(area);
  }

  function pickOther() {
    setOtherSelected(true);
    onChange(customValue);
  }

  function clear() {
    setOtherSelected(false);
    setCustomValue("");
    onChange("");
  }

  function setCustom(next: string) {
    setCustomValue(next);
    onChange(next);
  }

  const showOtherInput = otherSelected || startsAsOther;

  return (
    <div className="flex flex-col gap-2">
      {AREA_REGIONS.map((group) => (
        <div key={group.region} className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-neutral-500">
            {group.region}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {group.areas.map((area) => {
              const selected = !showOtherInput && value === area;
              return (
                <button
                  key={area}
                  type="button"
                  onClick={() => pickCanonical(area)}
                  aria-pressed={selected}
                  className={
                    "rounded-full border px-2.5 py-1 text-xs " +
                    (selected
                      ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                      : "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300")
                  }
                >
                  {area}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={pickOther}
          aria-pressed={showOtherInput}
          className={
            "rounded-full border px-2.5 py-1 text-xs " +
            (showOtherInput
              ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
              : "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300")
          }
        >
          {OTHER_AREA}
        </button>
        {value && (
          <button
            type="button"
            onClick={clear}
            className="rounded-full border border-dashed border-neutral-300 px-2.5 py-1 text-xs text-neutral-500 hover:border-neutral-500 dark:border-neutral-700"
          >
            Clear
          </button>
        )}
      </div>
      {showOtherInput && (
        <input
          id={`${idPrefix}-area-custom`}
          type="text"
          value={customValue}
          onChange={(e) => setCustom(e.target.value)}
          maxLength={PRIMARY_AREA_MAX}
          placeholder="Custom area (e.g. midline glabella)"
          className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
        />
      )}
    </div>
  );
}
