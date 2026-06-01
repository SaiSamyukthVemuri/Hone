"use client";

import { useState, useTransition } from "react";
import { sendPostcareEmailAction } from "./actions";

// Manual postcare send + preview modal. Mounted on the appointment
// detail page when:
//   - the appointment's service is NOT a consultation
//   - the client has an email on file
// The button is hidden entirely otherwise (the parent server component
// makes that decision; this client component assumes it should render).
//
// The preview modal shows the rendered postcare email text (plain text
// version is sufficient for review; the actual send uses HTML) so the
// practitioner sees exactly what the client will receive before send.
// Confirm fires the server action; Cancel dismisses.
//
// First send vs Resend: the parent passes `alreadySentAt`. If null,
// label is "Send postcare" and the server action runs the first-send
// atomic claim. If non-null, label is "Resend postcare", the modal
// surfaces the last-sent timestamp + total attempts, and the form
// posts is_resend=true.
//
// Race protection: the in-flight button uses startTransition + an
// isPending flag to disable Confirm during the server roundtrip,
// preventing a double-click double-submit on the same modal session.

type Props = {
  appointmentId: string;
  alreadySentAt: string | null;
  sendAttempts: number;
  // Pre-rendered preview text from the server (same composition the
  // email will use). Rendered as monospace inside the modal so it reads
  // as a literal preview, not a styled card.
  previewText: string;
};

export function PostcareSendButton({
  appointmentId,
  alreadySentAt,
  sendAttempts,
  previewText,
}: Props) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const isResend = alreadySentAt != null;
  const buttonLabel = isResend ? "Resend postcare" : "Send postcare";

  function openModal() {
    setError(null);
    setOpen(true);
  }
  function closeModal() {
    if (pending) return;
    setOpen(false);
  }
  function confirm() {
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("appointment_id", appointmentId);
      fd.set("is_resend", isResend ? "true" : "false");
      const r = await sendPostcareEmailAction(fd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setOpen(false);
    });
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={openModal}
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          {buttonLabel}
        </button>
        {alreadySentAt && (
          <p className="text-xs text-neutral-500">
            Last sent{" "}
            {new Date(alreadySentAt).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
            {sendAttempts > 1 ? ` · ${sendAttempts} attempts` : null}
          </p>
        )}
      </div>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Send postcare preview"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="flex max-h-[85vh] w-full max-w-2xl flex-col gap-4 overflow-hidden rounded-lg border border-neutral-200 bg-white p-6 shadow-xl dark:border-neutral-800 dark:bg-neutral-950">
            <header className="flex flex-col gap-1">
              <h2 className="text-base font-medium">
                {isResend
                  ? "Resend postcare email"
                  : "Send postcare email"}
              </h2>
              <p className="text-xs text-neutral-500">
                {isResend
                  ? "This will send the postcare email to the client again. Each send is recorded."
                  : "Review the email before sending. The client will receive this immediately."}
              </p>
            </header>
            <pre className="flex-1 overflow-auto whitespace-pre-wrap rounded-md border border-neutral-200 bg-neutral-50 p-4 text-xs leading-relaxed text-neutral-800 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200">
              {previewText}
            </pre>
            {error && (
              <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
            )}
            <footer className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={closeModal}
                disabled={pending}
                className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium disabled:opacity-50 dark:border-neutral-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirm}
                disabled={pending}
                className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-950"
              >
                {pending
                  ? "Sending…"
                  : isResend
                    ? "Confirm resend"
                    : "Send postcare"}
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
