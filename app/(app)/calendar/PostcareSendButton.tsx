"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { sendPostcareEmailAction } from "./actions";
import {
  PostcareSendFooter,
  PostcareSendOutcomeNotice,
  postcareAutoCloses,
  postcareConfirmAvailable,
  runPostcareSend,
  type PostcareSendOutcome,
} from "./postcare-send-presenter";

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
  const [treatmentPerformed, setTreatmentPerformed] = useState(false);
  // B8 / 0177 review. This was a sent-boolean plus a separate error string,
  // which structurally could not express the third outcome: the provider
  // accepted the email and only the settlement failed. That pair forced the
  // case into the error branch, whose copy invites a retry that would duplicate
  // a real email. The outcome is now a closed union owned by
  // ./postcare-send-presenter, and every affordance derives from it.
  const [outcome, setOutcome] = useState<PostcareSendOutcome>({ kind: "idle" });

  // Briefly stay on the confirmation view so the practitioner reads it, then
  // close. ONLY an ordinary success auto-closes — the provider-accepted /
  // unrecorded state must stay on screen until it is dismissed, because it is
  // the one state that asks the practitioner to do something (refresh) rather
  // than reporting a finished fact.
  useEffect(() => {
    if (!postcareAutoCloses(outcome)) return;
    const handle = window.setTimeout(() => {
      setOpen(false);
      setOutcome({ kind: "idle" });
    }, 1800);
    return () => window.clearTimeout(handle);
  }, [outcome]);

  const isResend = alreadySentAt != null;
  const buttonLabel = isResend ? "Resend postcare" : "Send postcare";
  const canConfirm =
    !pending &&
    postcareConfirmAvailable(outcome) &&
    (!requiresConsultationConfirmation || treatmentPerformed);

  function openModal() {
    setTreatmentPerformed(false);
    setOutcome({ kind: "idle" });
    setOpen(true);
  }
  function closeModal() {
    if (pending) return;
    setOpen(false);
    setOutcome({ kind: "idle" });
  }
  function confirm() {
    setOutcome({ kind: "idle" });
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
      // ONE call, no retry. The presenter also owns WHEN the server component
      // is re-rendered: on an ordinary success so the trigger settles on the
      // provider-confirmed postcare_email_sent_at, and — the P1 fix — on the
      // provider-accepted/unrecorded outcome too, so the practitioner sees the
      // fresh server-rendered claim state instead of guessing at it. An
      // ordinary failure does not refresh: nothing changed and nothing claims
      // the email was sent.
      setOutcome(
        await runPostcareSend(
          { send: sendPostcareEmailAction, refresh: () => router.refresh() },
          fd,
        ),
      );
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
                  : "Review the email before sending. It is handed to the email provider immediately."}
              </p>
            </header>
            <pre className="flex-1 overflow-auto whitespace-pre-wrap rounded-md border border-neutral-200 bg-neutral-50 p-4 text-xs leading-relaxed text-neutral-800 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200">
              {previewText}
            </pre>
            {requiresConsultationConfirmation && outcome.kind === "idle" && (
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
            {/* Every outcome — success, provider-accepted-but-unrecorded, and
                ordinary failure — is rendered by the presenter, so the copy and
                the affordances cannot drift apart from the classification. */}
            <PostcareSendOutcomeNotice outcome={outcome} />
            <PostcareSendFooter
              outcome={outcome}
              pending={pending}
              canConfirm={canConfirm}
              isResend={isResend}
              onCancel={closeModal}
              onConfirm={confirm}
            />
          </div>
        </div>
      )}
    </>
  );
}
