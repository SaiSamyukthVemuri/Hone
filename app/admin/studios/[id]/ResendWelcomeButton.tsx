"use client";

import { useState, useTransition } from "react";
import { resendWelcomeEmailAction } from "./actions";

export function ResendWelcomeButton({ studioId }: { studioId: string }) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setMsg(null);
            const res = await resendWelcomeEmailAction(studioId);
            if (!res.ok) {
              setMsg(res.error ?? "Send failed.");
            } else if (res.status === "not_sent") {
              setMsg("Email not configured in this environment (nothing sent).");
            } else {
              setMsg("Welcome email sent.");
            }
          })
        }
        className="inline-flex min-h-[40px] items-center justify-center rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-900"
      >
        {pending ? "Sending…" : "Resend welcome email"}
      </button>
      {msg && (
        <span
          role="status"
          aria-live="polite"
          className="text-xs text-neutral-500 dark:text-neutral-400"
        >
          {msg}
        </span>
      )}
    </div>
  );
}
