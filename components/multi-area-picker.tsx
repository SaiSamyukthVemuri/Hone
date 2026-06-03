"use client";

import { useState } from "react";
import { AREA_REGIONS, OTHER_AREA } from "@/lib/constants";

const AREA_VALUE_MAX = 60;
const MAX_SELECTED = 12;

// Multi-area chip picker for a treatment plan's treatment_areas[].
// Mirrors AreaPicker (single-select) but toggles instead of replaces:
// clicking a canonical area chip adds or removes it from the selected
// list; the Other chip reveals a free-text input that adds custom
// areas one at a time. Selected areas render above the picker as
// removable chips so the practitioner can see what's chosen and undo
// a misclick without scrolling.
//
// Cap matches the DB CHECK in migration 0051 (1..12 entries). Single-
// area selection still works fine: select one chip, save, you get a
// one-element array (which the writers mirror into primary_area for
// backward compatibility with the session-area defaulting and the
// legacy banner).
export function MultiAreaPicker({
  selected,
  onChange,
  idPrefix,
}: {
  selected: ReadonlyArray<string>;
  onChange: (next: string[]) => void;
  idPrefix: string;
}) {
  const [customDraft, setCustomDraft] = useState("");
  const [otherOpen, setOtherOpen] = useState(false);

  function toggle(area: string) {
    if (selected.includes(area)) {
      onChange(selected.filter((a) => a !== area));
      return;
    }
    if (selected.length >= MAX_SELECTED) return;
    onChange([...selected, area]);
  }

  function removeOne(area: string) {
    onChange(selected.filter((a) => a !== area));
  }

  function addCustom() {
    const trimmed = customDraft.trim().slice(0, AREA_VALUE_MAX);
    if (!trimmed) return;
    if (selected.includes(trimmed)) {
      setCustomDraft("");
      return;
    }
    if (selected.length >= MAX_SELECTED) return;
    onChange([...selected, trimmed]);
    setCustomDraft("");
  }

  function clearAll() {
    onChange([]);
    setCustomDraft("");
    setOtherOpen(false);
  }

  const capReached = selected.length >= MAX_SELECTED;

  return (
    <div className="flex flex-col gap-2">
      {/* Selected-area chips at the top so the practitioner sees the
          current selection without scrolling past the region groups. */}
      {selected.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {selected.map((area) => (
            <span
              key={area}
              className="inline-flex items-center gap-1 rounded-full border border-neutral-900 bg-neutral-900 px-2.5 py-1 text-xs text-white dark:border-white dark:bg-white dark:text-neutral-900"
            >
              {area}
              <button
                type="button"
                onClick={() => removeOne(area)}
                aria-label={`Remove ${area}`}
                className="text-[14px] leading-none opacity-70 hover:opacity-100"
              >
                ×
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={clearAll}
            className="rounded-full border border-dashed border-neutral-300 px-2.5 py-1 text-xs text-neutral-500 hover:border-neutral-500 dark:border-neutral-700"
          >
            Clear all
          </button>
        </div>
      )}

      {AREA_REGIONS.map((group) => (
        <div key={group.region} className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-neutral-500">
            {group.region}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {group.areas.map((area) => {
              const isSelected = selected.includes(area);
              const disabled = !isSelected && capReached;
              return (
                <button
                  key={area}
                  type="button"
                  onClick={() => toggle(area)}
                  disabled={disabled}
                  aria-pressed={isSelected}
                  className={
                    "rounded-full border px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50 " +
                    (isSelected
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
          onClick={() => setOtherOpen((o) => !o)}
          aria-pressed={otherOpen}
          className={
            "rounded-full border px-2.5 py-1 text-xs " +
            (otherOpen
              ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
              : "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300")
          }
        >
          {OTHER_AREA}
        </button>
        <span className="text-[11px] text-neutral-500">
          Pick one or more areas. {selected.length} of {MAX_SELECTED} selected.
        </span>
      </div>

      {otherOpen && (
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            id={`${idPrefix}-multi-area-custom`}
            type="text"
            value={customDraft}
            onChange={(e) => setCustomDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addCustom();
              }
            }}
            maxLength={AREA_VALUE_MAX}
            placeholder="Custom area (e.g. midline glabella)"
            className="flex-1 min-w-[14rem] rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
          />
          <button
            type="button"
            onClick={addCustom}
            disabled={!customDraft.trim() || capReached}
            className="rounded-md bg-neutral-900 px-3 py-2 text-xs font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            Add area
          </button>
        </div>
      )}
    </div>
  );
}
