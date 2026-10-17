import { useId } from "react";
import { cx, CONTROL_MIN_TOUCH, FOCUS_RING } from "@/components/ui/control-base";
import {
  TREATMENT_AREA_REGIONS,
  treatmentAreaLabel,
  type TreatmentAreaId,
} from "@/lib/waitlist/treatment-area-catalog";
import { AREAS_HELP, AREAS_LEGEND } from "@/lib/waitlist/join-copy";

// ===========================================================================
// WAIT-04A — TREATMENT AREA MULTI-SELECT
// ===========================================================================
//
// NATIVE CHECKBOXES, NOT A ROLL-YOUR-OWN LISTBOX. A group of real
// `<input type="checkbox">` inside a `<fieldset>` with a `<legend>` gets, for
// free and correctly: keyboard reachability in source order, space to toggle,
// the checked state announced on focus, the group name announced when entering
// it, and every assistive technology's own multi-select idioms. An ARIA
// listbox re-implements all of that and gets some of it wrong on some
// combination of screen reader and browser. There is no interaction here that
// a checkbox cannot express, so there is no reason to.
//
// THE CATALOG IS RENDERED, NOT FILTERED. Every option comes from
// `TREATMENT_AREA_REGIONS`, and the value submitted is the id — never the
// label, which can be re-worded. There is no "Other" option and no text input
// in this component at all: the absence is structural, not a disabled control.
//
// THE WHOLE ROW IS THE TARGET. The 44px floor is on the `<label>`, which wraps
// both the box and the text, so the text is not a smaller second target beside
// a tiny one. `CONTROL_MIN_TOUCH` carries its own `inline-flex`, which is
// load-bearing: `min-height` does nothing to an inline box.
//
// PRESENTATION + INTERACTION, NO DATA. Selection lives in the parent. This
// component performs no fetch, no action and no validation — but it is NOT
// inert: every control has a real handler, so binding it costs nothing.
// ===========================================================================

const MUTED = "#6B6B6B";
const INK = "#0A0A0A";

export function TreatmentAreaPicker({
  selected,
  onToggle,
  error,
  disabled = false,
}: {
  selected: ReadonlyArray<TreatmentAreaId>;
  onToggle: (id: TreatmentAreaId, next: boolean) => void;
  /** Rendered and announced when the group as a whole is invalid. */
  error?: string | null;
  disabled?: boolean;
}) {
  const helpId = useId();
  const errorId = useId();
  const chosen = new Set<TreatmentAreaId>(selected);

  return (
    <fieldset
      className="flex w-full max-w-full flex-col gap-3 border-0 p-0"
      data-testid="waitlist-area-picker"
      // Points at the help text always, and additionally at the error when
      // there is one, so entering the group announces the constraint and the
      // current problem together rather than one replacing the other.
      aria-describedby={error ? `${helpId} ${errorId}` : helpId}
      aria-invalid={error ? true : undefined}
      disabled={disabled}
    >
      <legend className="text-[12px] uppercase tracking-[0.1em]" style={{ color: MUTED }}>
        {AREAS_LEGEND} <span aria-hidden="true">*</span>
      </legend>
      <p id={helpId} className="text-[13px] leading-[1.6]" style={{ color: MUTED }}>
        {AREAS_HELP}
      </p>

      {TREATMENT_AREA_REGIONS.map((group) => (
        <div key={group.region} className="flex flex-col gap-1">
          {/* A heading, not a nested fieldset: the region is a visual grouping
              of one flat multi-select, and nesting fieldsets would announce a
              second group the person has not actually entered. */}
          <p
            className="text-[12px] uppercase tracking-[0.08em]"
            style={{ color: MUTED }}
            data-testid={`waitlist-area-region-${group.region}`}
          >
            {group.region}
          </p>
          <div className="flex flex-col">
            {group.areaIds.map((id) => {
              const isChosen = chosen.has(id);
              return (
                <label
                  key={id}
                  data-testid={`waitlist-area-option-${id}`}
                  data-selected={isChosen ? "true" : "false"}
                  className={cx(
                    CONTROL_MIN_TOUCH,
                    "w-full cursor-pointer justify-start gap-3 py-1 text-[15px]",
                    disabled && "cursor-not-allowed opacity-60",
                  )}
                  style={{ color: INK }}
                >
                  <input
                    type="checkbox"
                    name="treatment_area_ids"
                    value={id}
                    checked={isChosen}
                    disabled={disabled}
                    onChange={(e) => onToggle(id, e.target.checked)}
                    className={cx("h-5 w-5 shrink-0 accent-black", FOCUS_RING)}
                  />
                  <span>{treatmentAreaLabel(id)}</span>
                </label>
              );
            })}
          </div>
        </div>
      ))}

      {error && (
        <span
          id={errorId}
          role="alert"
          data-testid="waitlist-area-error"
          className="text-[13px] text-red-600"
        >
          {error}
        </span>
      )}
    </fieldset>
  );
}
