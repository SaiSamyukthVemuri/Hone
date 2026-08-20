import type { ReactNode } from "react";

import { CONTROL_DISABLED, FOCUS_RING, UI_TRANSITION, cx } from "./control-base";
import { SectionLabel } from "./section-label";

// Field foundations (UI0): one label shape, one control class string.
//
// THE PROBLEM THIS SOLVES CENTRALLY
// ---------------------------------
// iOS Safari zooms the viewport whenever a focused control's computed
// font-size is under 16px. Hone hit this in the pilot on 2026-06-12; two
// controls were promoted to `text-base` and the CLASS of bug was treated as
// closed. A census of production finds 132 of 254 text-entry fields still
// under 16px — ten of them in QuickBookDrawer alone.
//
// `text-base pointer-fine:text-sm` closes it for good. Any coarse pointer —
// phone AND tablet — gets 16px and cannot trigger the zoom; a mouse or
// trackpad gets 14px, so desktop density is unchanged. A `sm:`/`md:` width
// breakpoint would NOT be equivalent: a 768px iPad in portrait is still a
// thumb, and would have been handed 14px.
//
// This ships a class-string helper rather than an <Input> wrapper component on
// purpose. Hone has 235 inputs, 44 selects and 51 textareas whose native
// props, refs, `defaultValue`, server-action `name` bindings and validation
// attributes all work today; wrapping them would put a component between the
// form and the DOM for no gain. One truth for the LOOK, zero interference with
// the behaviour.
//
// Server-safe: no state, no directive.

/**
 * Base classes for <input>, <select> and <textarea>.
 *
 * Callers keep ownership of `type`, `name`, `required`, `pattern`,
 * `aria-invalid` and every other native attribute. Setting `aria-invalid`
 * paints the error border automatically, so the accessible state and the
 * visual state cannot drift apart.
 */
export function fieldControlClass(options?: {
  /** Defaults to true — the dominant house pattern is a full-width control. */
  fullWidth?: boolean;
  /** Additive layout classes only; see the note on `cx` in control-base.ts. */
  className?: string;
}): string {
  const { fullWidth = true, className } = options ?? {};
  return cx(
    "block rounded-md border border-line-strong bg-surface text-fg",
    "px-3 py-2 min-h-[44px]",
    "text-base pointer-fine:text-sm",
    "placeholder:text-fg-muted",
    // Accessible state drives the visual state, rather than a second prop that
    // can disagree with it.
    "aria-[invalid=true]:border-danger-solid",
    UI_TRANSITION,
    FOCUS_RING,
    CONTROL_DISABLED,
    fullWidth && "w-full",
    className,
  );
}

type FieldLabelProps = {
  /** The caption. Rendered through SectionLabel so field captions and section
   *  headers cannot drift apart. */
  label: ReactNode;
  /**
   * EXACTLY ONE form control. A <label> that wraps two controls is associated
   * with the first one only, so the second silently loses its accessible name.
   */
  children: ReactNode;
  /**
   * Marks the field visually and to assistive tech. The control itself must
   * still carry the native `required` attribute — this is the label, not the
   * validation.
   */
  required?: boolean;
  /** Help text under the control. */
  hint?: ReactNode;
  className?: string;
};

/**
 * Wrapping label: the control is associated implicitly, so no `id`/`htmlFor`
 * pair can go stale or collide. Six private label implementations exist in the
 * tree today and the required marker alone is spelled four incompatible ways
 * (one of them inverted, appending " (optional)" instead).
 */
export function FieldLabel({
  label,
  children,
  required = false,
  hint,
  className,
}: FieldLabelProps) {
  return (
    <label className={cx("flex flex-col gap-1.5", className)}>
      <SectionLabel size="caption">
        {label}
        {required && (
          <>
            <span aria-hidden="true" className="text-fg-muted">
              {" *"}
            </span>
            <span className="sr-only"> (required)</span>
          </>
        )}
      </SectionLabel>
      {children}
      {hint && <span className="text-xs text-fg-muted">{hint}</span>}
    </label>
  );
}
