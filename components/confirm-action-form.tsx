"use client";

import { useId, useRef, useState, useTransition } from "react";
import { Button, type ButtonVariant } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";

// HON-124 item 14. A destructive server-action button that asks first, through the house ConfirmDialog (the in-DOM replacement for
// window.confirm: it names the action and its consequence, has Cancel, traps focus, closes on Escape while idle, and restores focus to this
// trigger on close). The CALLER's server action is unchanged and still does its own owner/role checks; this component only gates the press.
//
// One request per confirmation: Confirm is disabled while the action runs. A failure keeps the dialog open with a fixed, safe sentence
// (never the action's own error text) so the person can Cancel or try again.
type Props = {
  /** The existing server action, passed from a server component. */
  action: (formData: FormData) => Promise<void>;
  /** Hidden fields the action reads (for example { id }). */
  fields: Record<string, string>;
  triggerLabel: string;
  /** Names WHO the trigger acts on when the visible label alone would be ambiguous in a list. */
  triggerAriaLabel?: string;
  title: string;
  /** What will happen, in plain words: the consequence, not just the verb. */
  description: string;
  confirmLabel: string;
  busyLabel?: string;
  tone?: "default" | "danger";
  triggerVariant?: ButtonVariant;
  /**
   * After a SUCCESS the row this trigger lives in is usually gone, so focus would fall to <body>. When set, focus moves to `focusId` (a stable
   * element such as the list's heading, which must have tabIndex={-1}) once the trigger has left the page, and `message` is written into the
   * live region `announceId`, which lives outside the row and so survives it.
   */
  afterSuccess?: { focusId: string; announceId: string; message: string };
};

const SETTLE_POLL_MS = 50;
const SETTLE_MAX_MS = 3000;

/** Wait until `trigger` has left the document (or give up), then focus the stable target and announce. Plain timers: this must outlive the unmounting row. */
function moveFocusAfterRemoval(trigger: HTMLElement | null, after: NonNullable<Props["afterSuccess"]>) {
  const started = Date.now();
  const tick = () => {
    const gone = !trigger || !trigger.isConnected;
    if (gone || Date.now() - started > SETTLE_MAX_MS) {
      const target = document.getElementById(after.focusId);
      if (target && (document.activeElement === document.body || document.activeElement === null || gone)) target.focus();
      const live = document.getElementById(after.announceId);
      if (live) live.textContent = after.message;
      return;
    }
    window.setTimeout(tick, SETTLE_POLL_MS);
  };
  window.setTimeout(tick, SETTLE_POLL_MS);
}

export function ConfirmActionForm({
  action,
  fields,
  triggerLabel,
  triggerAriaLabel,
  title,
  description,
  confirmLabel,
  busyLabel = "Working…",
  tone = "danger",
  triggerVariant = "secondary",
  afterSuccess,
}: Props) {
  const triggerId = useId();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // One request per confirmation, even if two presses land before the disabled state paints.
  const inFlight = useRef(false);

  function onConfirm() {
    if (inFlight.current) return;
    inFlight.current = true;
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    setError(null);
    startTransition(async () => {
      try {
        await action(fd);
        setOpen(false);
        if (afterSuccess) moveFocusAfterRemoval(document.getElementById(triggerId), afterSuccess);
      } catch {
        setError("That did not go through. Check the list, then try again.");
      } finally {
        inFlight.current = false;
      }
    });
  }

  return (
    <>
      <Button id={triggerId} type="button" variant={triggerVariant} size="sm" aria-label={triggerAriaLabel} onClick={() => { setError(null); setOpen(true); }}>
        {triggerLabel}
      </Button>
      <ConfirmDialog
        open={open}
        title={title}
        description={description}
        confirmLabel={confirmLabel}
        busyLabel={busyLabel}
        tone={tone}
        pending={pending}
        error={error}
        onConfirm={onConfirm}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}
