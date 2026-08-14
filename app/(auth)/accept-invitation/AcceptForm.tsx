"use client";

import { useActionState, useState } from "react";
import { acceptInvitationAction } from "./actions";

// Explicit current-policy acceptance. The checkbox is unchecked by default and
// the submit stays disabled until it is checked: access is never granted
// without an affirmative confirmation.
export function AcceptForm({
  studioName,
  role,
}: {
  studioName: string;
  role: string;
}) {
  const [state, formAction, pending] = useActionState(
    acceptInvitationAction,
    null,
  );
  const [agreed, setAgreed] = useState(false);

  return (
    <form action={formAction} className="mt-6 flex flex-col gap-4">
      <label className="flex items-start gap-3 text-sm text-neutral-700 dark:text-neutral-200">
        <input
          type="checkbox"
          name="consent"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-neutral-900 dark:accent-white"
        />
        <span>
          I agree to the current{" "}
          <a href="/terms" className="underline" target="_blank" rel="noreferrer">
            Terms of Service
          </a>{" "}
          and{" "}
          <a
            href="/privacy"
            className="underline"
            target="_blank"
            rel="noreferrer"
          >
            Privacy Policy
          </a>
          .
        </span>
      </label>

      {state?.error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={!agreed || pending}
        className="inline-flex min-h-[44px] items-center justify-center rounded-md bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        {pending ? "Joining…" : `Join ${studioName} as ${role}`}
      </button>
    </form>
  );
}
