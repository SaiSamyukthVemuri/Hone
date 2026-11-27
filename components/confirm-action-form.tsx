"use client";

import { useRef, useState, useTransition } from "react";
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
};

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
}: Props) {
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
      } catch {
        setError("That did not go through. Check the list, then try again.");
      } finally {
        inFlight.current = false;
      }
    });
  }

  return (
    <>
      <Button type="button" variant={triggerVariant} size="sm" aria-label={triggerAriaLabel} onClick={() => { setError(null); setOpen(true); }}>
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
