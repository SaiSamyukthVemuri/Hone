"use client";

// Accessible in-app confirmation dialog (Chloe workflow fix).
//
// Replaces native window.confirm() for consequential practitioner actions
// (Mark completed / Mark no-show). window.confirm is unreliable on iOS
// Safari — WebKit can suppress the dialog and return false silently, which
// the caller cannot distinguish from a real "Cancel" tap, so the action
// never runs and nothing changes on screen. An in-DOM dialog removes that
// entire class of failure and is keyboard/screen-reader accessible.
//
// The dialog is presentational + accessible only: it NEVER calls a server
// action itself. The caller owns the mutation and passes `pending`, `error`,
// `onConfirm`, and `onCancel`. That keeps the trusted server actions and
// their gates untouched, and keeps "one request per confirmation" the
// caller's single source of truth (the caller runs the action once inside a
// transition; the Confirm button here is disabled while `pending`).
//
// Accessibility affordances (modelled on the house MoveAppointmentDialog +
// OnboardingModal patterns, which are the only dialogs implementing the full
// set):
//   * role="alertdialog" + aria-modal + aria-labelledby + aria-describedby
//   * focus is moved into the dialog on open and RESTORED to the opener on
//     close (so a mobile keyboard user is never dropped at the top of the page)
//   * a focus trap cycles Tab/Shift+Tab within the dialog; if every control is
//     disabled mid-submit, focus parks on the panel so Tab cannot escape behind
//   * Escape closes ONLY while idle (never abandons an in-flight request)
//   * backdrop mousedown closes ONLY while idle
//   * >=44px touch targets on every button
//   * header/footer are shrink-0 flex siblings of the scroll body (NOT
//     position:sticky) with safe-area bottom padding, because sticky-inside-
//     overflow footers can vanish mid-paint on iOS Safari

import { useEffect, useId, useRef } from "react";

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  // Label shown on the confirm button while the caller's action is running.
  busyLabel?: string;
  // "danger" tints the confirm button red (e.g. a no-show); "default" uses
  // the neutral primary style.
  tone?: "default" | "danger";
  // Controlled by the caller: true while its server action is in flight. Locks
  // the dialog (buttons disabled, Escape/backdrop close suppressed).
  pending?: boolean;
  // A SAFE, fixed, caller-supplied failure string (the calendar actions map
  // every RPC failure to curated copy — never raw DB/provider text). Rendered
  // in an assertive alert region; the dialog stays open so the practitioner
  // can read it and Cancel or retry.
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
};

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  busyLabel,
  tone = "default",
  pending = false,
  error = null,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const descId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<Element | null>(null);

  // Capture the opener and move focus into the dialog on open; restore focus
  // to the opener on close. Keyed ONLY on `open` so a mid-submit re-render
  // (pending flips) never yanks focus back to the page.
  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement;
    // Focus the confirm button so a keyboard user can proceed immediately;
    // Escape / Cancel remain one keystroke away.
    confirmRef.current?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [open]);

  // Focus trap + idle-gated Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (!pending) onCancel();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null);
      if (focusables.length === 0) {
        // Everything disabled mid-submit: keep focus on the panel so Tab
        // cannot move behind the modal.
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, pending, onCancel]);

  if (!open) return null;

  const confirmClass =
    tone === "danger"
      ? "bg-red-600 text-white hover:bg-red-700"
      : "bg-neutral-900 text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4"
      onMouseDown={(e) => {
        // Backdrop mousedown closes only while idle; a mousedown on the panel
        // never bubbles a close (target !== currentTarget).
        if (e.target === e.currentTarget && !pending) onCancel();
      }}
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-black/40 backdrop-blur-[1px]"
      />
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        aria-busy={pending || undefined}
        tabIndex={-1}
        data-testid="confirm-dialog"
        className="relative flex max-h-[90dvh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl outline-none dark:bg-neutral-950 sm:rounded-2xl"
      >
        {/* Header: shrink-0, never sticky (iOS Safari paint safety). */}
        <div className="shrink-0 px-5 pt-5">
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
        </div>

        {/* Body: the scrollable region. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          <p id={descId} className="text-sm text-neutral-700 dark:text-neutral-300">
            {description}
          </p>
          {error && (
            <p
              role="alert"
              className="mt-3 text-sm text-red-700 dark:text-red-400"
            >
              {error}
            </p>
          )}
        </div>

        {/* Footer: shrink-0, safe-area bottom padding so it stays painted on
            iOS Safari even as the keyboard/URL bar animate. */}
        <div className="flex shrink-0 flex-col-reverse gap-2 px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-3 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            data-testid="confirm-dialog-cancel"
            className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-neutral-300 px-4 text-sm font-medium hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={pending}
            data-testid="confirm-dialog-confirm"
            className={`inline-flex min-h-[44px] items-center justify-center rounded-md px-4 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${confirmClass}`}
          >
            {pending ? busyLabel ?? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
