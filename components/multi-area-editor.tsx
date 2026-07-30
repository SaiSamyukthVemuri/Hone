"use client";

// Multi-area + per-area laterality editor for a settings block (migration 0128).
//
// One settings block may treat several areas with the SAME machine settings,
// each with its own laterality. The practitioner adds areas from the region
// picker (adding never replaces prior selections), sets a side per area, and can
// apply one side to all. The value is the ordered structured area set; the
// server persists canonical session_block_areas rows + a safe legacy projection.

import { useState } from "react";
import { AreaPicker } from "@/components/area-picker";
import { commitAreaToSet } from "@/lib/sessions/area-input";
import {
  LATERALITY_VALUES,
  LATERALITY_LABELS,
  formatAreaLabel,
  type BlockArea,
  type Laterality,
} from "@/lib/sessions/block-areas";

export function MultiAreaEditor({
  value,
  onChange,
  idPrefix,
}: {
  value: BlockArea[];
  onChange: (areas: BlockArea[]) => void;
  idPrefix: string;
}) {
  // The region picker is an ADD affordance: selecting an area appends it (with a
  // default "N/A" side) unless it is already present, then resets.
  //
  // CANONICAL CHIP vs CUSTOM TEXT (Chloe charting hotfix). A chip tap is a
  // complete, deliberate choice, so it still adds immediately. Free text is NOT:
  // the picker used to call this on every keystroke, so typing "Glabella" appended
  // (and persisted) "G", "Gl", "Gla", "Glab", "Glabe", "Glabel", "Glabell", "Glabella". Custom text is
  // now local draft state inside the picker and only reaches `commitCustomArea`
  // on an explicit Add / Enter.
  const [pending, setPending] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  function addArea(next: string) {
    setPending("");
    setNotice(null);
    const result = commitAreaToSet(value, next);
    // Blank → nothing to add. Duplicate → the set is returned unchanged, so one
    // submission still adds exactly one row (or none).
    if (result.status === "added") onChange([...result.value]);
  }

  // Explicit custom-area commit. Returns true when the picker should clear its
  // draft: on a successful add AND on a duplicate (the area is already in the
  // list, so the draft has served its purpose). A blank draft never gets here.
  function commitCustomArea(raw: string): boolean {
    const result = commitAreaToSet(value, raw);
    if (result.status === "blank") {
      setNotice(null);
      return false;
    }
    if (result.status === "duplicate") {
      setNotice(`“${result.area}” is already in this settings block.`);
      return true;
    }
    setNotice(null);
    onChange([...result.value]);
    return true;
  }

  // Any edit to the SET invalidates the notice — it asserts a fact about the
  // current set ("X is already in this settings block"), so leaving it up after
  // the practitioner removes that very area would state something false.
  function setLaterality(index: number, lat: Laterality) {
    setNotice(null);
    onChange(value.map((a, i) => (i === index ? { ...a, laterality: lat } : a)));
  }

  function remove(index: number) {
    setNotice(null);
    onChange(value.filter((_, i) => i !== index));
  }

  function applyToAll(lat: Laterality) {
    setNotice(null);
    onChange(value.map((a) => ({ ...a, laterality: lat })));
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">Areas treated with these settings</span>
        <p className="text-xs text-neutral-500">
          Select every area treated using this settings setup. Add another
          settings block only when the treatment settings change.
        </p>
      </div>

      {/* Selected areas — each with its own laterality + remove. */}
      {value.length > 0 ? (
        <ul className="flex flex-col gap-2" data-testid="selected-areas">
          {value.map((a, i) => (
            <li
              key={`${a.area}-${i}`}
              data-testid={`area-row-${a.area}`}
              className="flex flex-col gap-2 rounded-md border border-neutral-200 p-2.5 dark:border-neutral-800"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{formatAreaLabel(a)}</span>
                <button
                  type="button"
                  onClick={() => remove(i)}
                  aria-label={`Remove ${a.area}`}
                  className="min-h-[36px] rounded-md px-2 text-sm text-neutral-500 hover:text-red-600 dark:hover:text-red-400"
                >
                  Remove
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {LATERALITY_VALUES.map((lat) => {
                  const selected = a.laterality === lat;
                  return (
                    <button
                      key={lat}
                      type="button"
                      data-testid={`laterality-${a.area}-${lat}`}
                      aria-pressed={selected}
                      onClick={() => setLaterality(i, lat)}
                      className={
                        "min-h-[36px] rounded-full border px-3 py-1.5 text-xs " +
                        (selected
                          ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                          : "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300")
                      }
                    >
                      {LATERALITY_LABELS[lat]}
                    </button>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-md border border-dashed border-neutral-300 px-3 py-3 text-xs text-neutral-500 dark:border-neutral-700">
          No areas selected yet. Choose from the body regions below.
        </p>
      )}

      {value.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-neutral-500">Apply this side to all:</span>
          {LATERALITY_VALUES.map((lat) => (
            <button
              key={lat}
              type="button"
              data-testid={`apply-all-${lat}`}
              onClick={() => applyToAll(lat)}
              className="min-h-[36px] rounded-full border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:text-neutral-300"
            >
              {LATERALITY_LABELS[lat]}
            </button>
          ))}
        </div>
      )}

      {/* Add-area affordance: the region picker appends to the list. Canonical
          chips add on tap; custom text needs an explicit Add area / Enter. */}
      <div className="flex flex-col gap-1.5 border-t border-neutral-100 pt-3 dark:border-neutral-900">
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Add an area
        </span>
        <AreaPicker
          value={pending}
          onChange={addArea}
          idPrefix={`${idPrefix}-add`}
          customCommit="explicit"
          onCommitCustom={commitCustomArea}
          customAddLabel="Add area"
        />
        {notice && (
          <p
            role="status"
            data-testid={`${idPrefix}-add-area-notice`}
            className="text-xs text-neutral-600 dark:text-neutral-400"
          >
            {notice}
          </p>
        )}
      </div>
    </div>
  );
}
