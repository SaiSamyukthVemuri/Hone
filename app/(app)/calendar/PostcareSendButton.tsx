"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { sendPostcareEmailAction } from "./actions";

// Manual postcare send + preview modal.
//
// Two render variants based on `requiresConsultationConfirmation`:
//
//   - false (treatment / non-consultation services): existing behavior.
//     Modal shows the preview and Confirm sends immediately.
//
//   - true (consultation services): the modal additionally renders a
//     "I performed electrolysis or a test treatment during this
//     consultation" checkbox. The Confirm button is disabled until
//     checked. On Confirm, the form posts
//     treatment_performed_during_consultation=true; the server action
//     gates on that flag (the checkbox alone is not the security
//     boundary; the server is).
//
// First send vs Resend: parent passes `alreadySentAt`. If null, label
// is "Send postcare" and the action runs the atomic first-send claim;
// if non-null, label is "Resend postcare" and posts is_resend=true.
//
// Race protection: startTransition + isPending disables Confirm
// during the server roundtrip so a fast double-click cannot double-
// submit on the same modal session.

type Props = {
  appointmentId: string;
  alreadySentAt: string | null;
  // PR #311: postcare send-state correctness. failedAt is set when the last
  // provider send failed (sent_at is only set AFTER provider success now).
  // `sending` is a server-computed "claim is fresh, no outcome yet" flag.
  failedAt: string | null;
  sending: boolean;
  sendAttempts: number;
  // Pre-rendered preview text from the server (same composition the
  // email will use). Rendered as monospace inside the modal so it
  // reads as a literal preview, not a styled card.
  previewText: string;
  // True when the appointment's service modality is "consultation".
  // When true, the modal requires the practitioner to explicitly tick
  // a checkbox that treatment was performed; the server validates the
  // same boolean independently.
  requiresConsultationConfirmation: boolean;
};

export function PostcareSendButton({
  appointmentId,
  alreadySentAt,
  failedAt,
  sending,
  sendAttempts,
  previewText,
  requiresConsultationConfirmation,
}: Props) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [treatmentPerformed, setTreatmentPerformed] = useState(false);
  // After a successful send the modal switches to a "Sent" confirmation
  // state instead of closing instantly. The trigger button reload
  // (parent server-component re-renders alreadySentAt) is the durable
  // signal; this transient state is the immediate "yes, it went"
  // feedback the practitioner asked for during the Willow retest.
  const [justSent, setJustSent] = useState(false);

  // Briefly stay on the "Sent" view so the practitioner reads it, then
  // close the modal. The next page render shows the updated "Last sent"
  // timestamp on the trigger.
  useEffect(() => {
    if (!justSent) return;
    const handle = window.setTimeout(() => {
      setOpen(false);
      setJustSent(false);
    }, 1800);
    return () => window.clearTimeout(handle);
  }, [justSent]);

  const isResend = alreadySentAt != null;
  const buttonLabel = isResend ? "Resend postcare" : "Send postcare";
  const canConfirm =
    !pending &&
    !justSent &&
    (!requiresConsultationConfirmation || treatmentPerformed);

  function openModal() {
    setError(null);
    setTreatmentPerformed(false);
    setJustSent(false);
    setOpen(true);
  }
  function closeModal() {
    if (pending) return;
    setOpen(false);
    setJustSent(false);
  }
  function confirm() {
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("appointment_id", appointmentId);
      fd.set("is_resend", isResend ? "true" : "false");
      if (requiresConsultationConfirmation) {
        // Posted only when the practitioner explicitly ticked the
        // checkbox above. Server action independently verifies this
        // flag is present + true for consultation services.
        fd.set(
          "treatment_performed_during_consultation",
          treatmentPerformed ? "true" : "false",
        );
      }
      const r = await sendPostcareEmailAction(fd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // DURABLE state, not just the transient confirmation. The modal's
      // "Sent" view is immediate feedback; this re-renders the server
      // component so the parent settles on the provider-confirmed
      // postcare_email_sent_at and the trigger becomes "Resend postcare".
      // Only a successful provider handoff refreshes — a failure leaves the
      // modal open with its error, and nothing claims the email was sent.
      router.refresh();
      // Stay in the modal in a confirmation state so the send does not
      // look silent. The useEffect above closes it shortly after.
      setJustSent(true);
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
        {alreadySentAt ? (
          // PR #311: "Sent" now means a CONFIRMED provider hand-off (sent_at is
          // stamped only after provider success), NOT delivery/receipt — the
          // copy stays "sent", never "delivered" / "received" / "opened".
          // If a later RESEND failed after this success, sent_at stays and we
          // add a small sub-note (failedAt is cleared on any success).
          <div className="flex flex-col gap-1">
            <p className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
                <span aria-hidden>✓</span> Postcare sent
              </span>
              <span className="text-neutral-500">
                {new Date(alreadySentAt).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
                {sendAttempts > 1 ? ` · ${sendAttempts} attempts` : null}
              </span>
            </p>
            {failedAt ? (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Last resend failed. Try again.
              </p>
            ) : null}
          </div>
        ) : failedAt ? (
          // Provider send failed before any success — never claim "sent".
          <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
            Postcare send failed. Try again.
          </p>
        ) : sending ? (
          <p className="text-xs text-neutral-500">Sending…</p>
        ) : (
          <p className="text-xs text-neutral-500">Not sent yet.</p>
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
            {requiresConsultationConfirmation && !justSent && (
              <label className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
                <input
                  type="checkbox"
                  checked={treatmentPerformed}
                  onChange={(e) => setTreatmentPerformed(e.target.checked)}
                  className="mt-0.5 h-4 w-4 flex-none rounded border-amber-400"
                />
                <span>
                  I performed electrolysis or a test treatment during this
                  consultation.
                </span>
              </label>
            )}
            {/* Explicit success confirmation. Replaces the previous
                silent close so the practitioner knows the email
                actually went. The trigger button on the parent page
                will re-render with the updated "Last sent" timestamp
                on the next render. */}
            {justSent && (
              <div
                role="status"
                className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm font-medium text-emerald-900 dark:border-emerald-700/50 dark:bg-emerald-950/30 dark:text-emerald-100"
              >
                Postcare sent. The client will receive it within a
                minute. This window will close automatically.
              </div>
            )}
            {error && (
              <p className="text-sm text-red-700 dark:text-red-300">
                Could not send. {error} Try again, or check the
                client&rsquo;s email on their profile.
              </p>
            )}
            <footer className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={closeModal}
                disabled={pending}
                className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium disabled:opacity-50 dark:border-neutral-700"
              >
                {justSent ? "Close" : "Cancel"}
              </button>
              {!justSent && (
                <button
                  type="button"
                  onClick={confirm}
                  disabled={!canConfirm}
                  className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-950"
                >
                  {pending
                    ? "Sending..."
                    : isResend
                      ? "Confirm resend"
                      : "Send postcare"}
                </button>
              )}
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
