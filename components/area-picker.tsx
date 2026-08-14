"use client";

import { useState } from "react";
import { AREA_REGIONS, OTHER_AREA } from "@/lib/constants";
import { isCanonicalTreatmentArea } from "@/lib/sessions/area-validation";
import { CUSTOM_AREA_MAX, canCommitCustomArea } from "@/lib/sessions/area-input";

const PRIMARY_AREA_MAX = CUSTOM_AREA_MAX;

// Canonical iff the value is in the FLAT AREAS list (incl. "Full face"/"Other"),
// case-insensitive, NOT AREA_REGIONS alone, which decomposes "Full face" and
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
//
// CUSTOM-TEXT COMMIT MODE (Chloe charting hotfix)
// ----------------------------------------------
// `customCommit` decides what the free-text "Other" input does:
//
//   "live" (DEFAULT, unchanged legacy contract), every keystroke calls
//     `onChange`. Correct when the parent holds ONE controlled area value and
//     wants live editing (a single-area field).
//
//   "explicit", keystrokes NEVER call `onChange`. The text is local draft
//     state; the practitioner commits it with the "Add area" button or Enter,
//     which calls `onCommitCustom` exactly once. This is REQUIRED by any parent
//     that treats a callback as "append a new area", because a live per-
//     keystroke callback appended one row per character ("N", "Ni", "Nip", …)
//     and persisted every fragment.
//
// Canonical chips are unchanged in BOTH modes: one tap = one immediate
// `onChange`, because a chip tap is already an explicit, complete choice.
export function AreaPicker({
  value,
  onChange,
  idPrefix,
  customCommit = "live",
  onCommitCustom,
  customAddLabel = "Add area",
}: {
  value: string;
  onChange: (next: string) => void;
  idPrefix: string;
  customCommit?: "live" | "explicit";
  // Called with the RAW draft text on an explicit commit (button or Enter).
  // The parent owns normalization + duplicate policy (lib/sessions/area-input).
  // Return `true` when the draft should be cleared; `false` keeps it so the
  // practitioner can correct it. Ignored in "live" mode.
  onCommitCustom?: (raw: string) => boolean;
  customAddLabel?: string;
}) {
  const explicit = customCommit === "explicit";
  const isCanonical = isCanonicalArea(value);
  const startsAsOther = value.length > 0 && !isCanonical;
  const [otherSelected, setOtherSelected] = useState(startsAsOther);
  const [customValue, setCustomValue] = useState(startsAsOther ? value : "");

  function pickCanonical(area: string) {
    setOtherSelected(false);
    onChange(area);
  }

  function pickOther() {
    // Explicit mode: revealing the input is NOT a commit, so it must not call
    // onChange, doing so would append the (possibly partial) draft.
    if (explicit) {
      setOtherSelected((open) => !open);
      return;
    }
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
    // Explicit mode: typing is DRAFT ONLY. Never notify the parent here.
    if (explicit) return;
    onChange(next);
  }

  // Explicit commit (button click or Enter). Guarded so a blank /
  // whitespace-only draft can never commit, and so a repeated Enter after a
  // successful commit is a no-op (the draft is empty by then).
  function commitCustom() {
    if (!explicit || !onCommitCustom) return;
    if (!canCommitCustomArea(customValue)) return;
    const accepted = onCommitCustom(customValue);
    if (accepted) setCustomValue("");
  }

  const showOtherInput = otherSelected || startsAsOther;
  const canCommit = canCommitCustomArea(customValue);

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
        {!explicit && value && (
          <button
            type="button"
            onClick={clear}
            className="rounded-full border border-dashed border-neutral-300 px-2.5 py-1 text-xs text-neutral-500 hover:border-neutral-500 dark:border-neutral-700"
          >
            Clear
          </button>
        )}
      </div>
      {showOtherInput &&
        (explicit ? (
          // Explicit-commit custom area: draft text + a deliberate commit.
          // Mirrors the treatment-plan MultiAreaPicker, which has always
          // worked this way.
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              id={`${idPrefix}-area-custom`}
              data-testid={`${idPrefix}-area-custom`}
              type="text"
              value={customValue}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  // The picker is rendered inside a form; Enter must commit
                  // the area, never submit the settings block.
                  e.preventDefault();
                  commitCustom();
                }
              }}
              maxLength={PRIMARY_AREA_MAX}
              placeholder="Custom area (e.g. midline glabella)"
              className="min-w-[12rem] flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
            />
            <button
              type="button"
              data-testid={`${idPrefix}-area-custom-add`}
              onClick={commitCustom}
              disabled={!canCommit}
              className="min-h-[36px] rounded-md bg-neutral-900 px-3 py-2 text-xs font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-neutral-900"
            >
              {customAddLabel}
            </button>
          </div>
        ) : (
          <input
            id={`${idPrefix}-area-custom`}
            type="text"
            value={customValue}
            onChange={(e) => setCustom(e.target.value)}
            maxLength={PRIMARY_AREA_MAX}
            placeholder="Custom area (e.g. midline glabella)"
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
          />
        ))}
    </div>
  );
}
