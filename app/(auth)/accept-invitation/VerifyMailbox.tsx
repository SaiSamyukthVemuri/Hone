"use client";

import { useActionState } from "react";
import { sendMailboxProofLinkAction, type ProofLinkState } from "./actions";

// Shown when the signed-in session has not proven control of its email address in THIS session (for example a password
// session on an account that was auto-confirmed). Sends a one-time link to the account's own address; opening it signs in
// again with proof and returns here.
export function VerifyMailbox({ email }: { email: string }) {
  const [state, formAction, pending] = useActionState<ProofLinkState, FormData>(sendMailboxProofLinkAction, { status: "idle" });
  return (
    <form action={formAction} className="mt-6 flex flex-col gap-4" data-testid="verify-mailbox">
      <p className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
        Before joining a studio, confirm that <strong className="text-neutral-900 dark:text-neutral-100">{email}</strong> is your
        address. We will email a one-time link to it; open it on this device to continue.
      </p>
      {state.status === "sent" && (
        <p role="status" data-testid="verify-mailbox-sent" className="text-sm text-neutral-700 dark:text-neutral-200">
          Check your email for the link.
        </p>
      )}
      {state.status === "error" && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.message}
        </p>
      )}
      <button
        type="submit"
        disabled={pending || state.status === "sent"}
        className="inline-flex min-h-[44px] items-center justify-center rounded-md bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        {pending ? "Sending…" : "Email me a link"}
      </button>
    </form>
  );
}
