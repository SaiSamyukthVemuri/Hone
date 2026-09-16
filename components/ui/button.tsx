import type { ButtonHTMLAttributes } from "react";

import {
  CONTROL_COMPACT_FINE_POINTER,
  CONTROL_DISABLED,
  CONTROL_MIN_TOUCH,
  CONTROL_PRESS,
  FOCUS_RING,
  cx,
} from "./control-base";
import { Spinner } from "./spinner";

// The Hone button primitive (UI0).
//
// DUAL-MODE ON PURPOSE. There is no "use client" here and there must not be:
// the component holds no state, no effect and no browser API, so it renders in
// a Server Component (the common case — settings, records, launch) and is also
// safe to import from a Client Component, which simply compiles it into that
// island. `pending` is a PROP, not internal state, so the one genuinely
// client-side concern (useFormStatus / useTransition) stays with the caller
// that already owns a client boundary. A visual foundation must never be the
// reason a server-rendered clinical page starts hydrating.
//
// Four variants, deliberately. The census behind this file found 105 primary
// and 131 secondary call sites; "quiet" covers the borderless action strips
// (the dashboard row, timeline rows) and "danger" the destructive confirms.
// Nothing else earned a name.

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
export type ButtonSize = "sm" | "md";

const VARIANT: Record<ButtonVariant, string> = {
  // Solid action. `active:` repeats the hover fill on purpose: on a touch
  // screen :hover never fires, so the active state IS the acknowledgement.
  primary: "bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-hover",
  secondary:
    "border border-line-strong bg-surface text-fg hover:bg-surface-sunken active:bg-line",
  quiet: "text-fg-muted hover:bg-surface-sunken hover:text-fg active:bg-line active:text-fg",
  danger:
    "bg-danger-solid text-on-accent hover:bg-danger-solid-hover active:bg-danger-solid-hover",
};

const SIZE: Record<ButtonSize, string> = {
  // 44px on every touch device; 32px only where the pointer is precise. The
  // TYPE SIZE does not change between them — density comes from the box.
  sm: cx("px-3 text-xs", CONTROL_COMPACT_FINE_POINTER),
  md: "px-4 text-sm",
};

/**
 * The class string behind <Button>, exported so a `next/link` <Link> can be
 * styled as a button without this file taking on a polymorphism dependency
 * (no `asChild`, no Slot, no Radix). Hone has ~189 <Link> elements and several
 * of them are visually buttons; they call this.
 *
 * NEVER apply this to an element nested inside another interactive element.
 * The dashboard row already had to hoist a disclosure out of a <Link> because
 * an <a> inside an <a> has undefined activation behaviour.
 */
export function buttonClasses(options?: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  className?: string;
}): string {
  const {
    variant = "secondary",
    size = "md",
    fullWidth = false,
    className,
  } = options ?? {};
  return cx(
    CONTROL_MIN_TOUCH,
    // Tailwind v4's preflight leaves a <button> at `cursor: default`. Restoring
    // the pointer is also what makes iOS Safari apply :active to the control,
    // so the press acknowledgement above actually paints on a phone.
    // `relative` is load-bearing for the pending spinner below: it is the
    // positioning context the overlay centres itself in. It changes nothing
    // about a resting control.
    "relative cursor-pointer rounded-md font-medium",
    // Carries PRESS_TRANSITION itself, so the marker is not emitted twice.
    CONTROL_PRESS,
    FOCUS_RING,
    CONTROL_DISABLED,
    SIZE[size],
    VARIANT[variant],
    fullWidth && "w-full",
    className,
  );
}

export type ButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className"
> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  /**
   * In-flight state for a server action or transition. Disables the control
   * (so a consequential action cannot be double-submitted), marks it
   * `aria-busy`, and swaps the label when `busyLabel` is supplied — which is
   * the behaviour 57 hand-rolled `{pending ? "Saving…" : "Save"}` ternaries
   * across 47 files currently each re-implement.
   */
  pending?: boolean;
  busyLabel?: string;
  className?: string;
};

export function Button({
  variant = "secondary",
  size = "md",
  fullWidth,
  pending = false,
  busyLabel,
  className,
  children,
  disabled,
  // Default to "button". A bare <button> inside a <form> submits it, which is
  // the kind of accident a shared primitive should not leave available.
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      data-pending={pending ? "true" : undefined}
      className={buttonClasses({ variant, size, fullWidth, className })}
    >
      {pending && busyLabel ? (
        // EXISTING CONTRACT, UNCHANGED. 16 call sites and
        // tests/components/ui-foundations.test.ts ("pending swaps the label
        // only when a busyLabel is supplied") depend on this exact behaviour,
        // so UI-R01 does not touch it.
        //
        // It is, however, the WIDTH-CHANGING form: the recon counted 47 label
        // swaps whose two strings differ in length, and a swap resizes the
        // control mid-press. Prefer the spinner form below for new call sites;
        // UI-R02+ migrates the existing ones deliberately, with proofs.
        busyLabel
      ) : pending ? (
        // THE GEOMETRY-STABLE FORM, and the new default.
        //
        // Before UI-R01 this branch rendered `children` unchanged, so a
        // `pending` Button with no busyLabel showed NO pending state at all
        // beyond the disabled dimming — a dead click by the recon's definition.
        //
        // The mechanism is the one PendingLink already proved: keep the label
        // in flow at `opacity-0` so the control cannot resize and its
        // accessible name cannot collapse, and centre the mark over it. The
        // mark is decorative; `aria-busy` on the <button> is what actually
        // announces the state, which is why the Spinner carries no label here.
        <>
          {/* NOT aria-hidden. The first draft of UI-R01 put aria-hidden="true"
              here and it contradicted the sentence directly above it: hiding
              the label collapses the button's ACCESSIBLE NAME to empty for
              exactly the duration it is busy, so a screen-reader user is told
              "busy" about a control that no longer says what it is.

              This is the trap pending-link.tsx already documents — it chose
              `opacity-0` over `visibility:hidden` for this precise reason, and
              adding aria-hidden re-created the defect that choice avoided.
              opacity-0 alone keeps BOTH the box and the name. */}
          <span className="opacity-0">
            {children}
          </span>
          <span
            data-pending-mark="true"
            className="pointer-events-none absolute inset-0 m-auto flex items-center justify-center"
          >
            <Spinner size={size === "sm" ? "sm" : "md"} />
          </span>
        </>
      ) : (
        children
      )}
    </button>
  );
}
