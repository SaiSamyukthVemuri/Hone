"use client";

import { useState, useTransition } from "react";
import { publicCancelAppointmentAction } from "./actions";

// The page-level fetch surface only renders this component when the
// supplied token maps to a future appointment with status='confirmed'.
// Every other state (cancelled / completed / no_show / past-start /
// unknown token) is collapsed to a generic invalid-link message at the
// fetch surface, so this component does NOT need to handle an
// "already cancelled" branch and does NOT accept an alreadyCancelled
// prop.
type Props = {
  token: string;
};

export function CancelForm({ token }: Props) {
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<"cancelled" | null>(null);

  if (done === "cancelled") {
    return (
      <div className="flex flex-col gap-4">
        <h2
          className="font-[var(--font-fraunces)] text-[24px] font-bold leading-tight"
          style={{ letterSpacing: "-0.02em" }}
        >
          Your appointment is cancelled.
        </h2>
        <p className="text-[16px] leading-relaxed text-[#0A0A0A]">
          The studio has been notified.
        </p>
        {/* Back-to-portal exit. /portal handles its own session
            check: if the visitor has a live portal session they land
            on their home; if not, the portal page redirects to
            /portal/login. We do not promise they are already signed
            in. */}
        <a
          href="/portal"
          className="self-start px-6 py-3 text-[13px] font-medium uppercase"
          style={{
            border: "1px solid #0A0A0A",
            color: "#0A0A0A",
            letterSpacing: "0.1em",
          }}
        >
          Back to client portal
        </a>
      </div>
    );
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const fd = new FormData();
    fd.set("token", token);
    fd.set("reason", reason);
    startTransition(async () => {
      const r = await publicCancelAppointmentAction(fd);
      if (!r.ok) {
        // The mutation surface uses the same generic collapse as the
        // fetch surface. The error string is whatever the action
        // chose to surface; the UI does not branch on it.
        setError(r.error);
        return;
      }
      setDone("cancelled");
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <label className="flex flex-col gap-2">
        <span
          className="text-[12px] font-medium uppercase"
          style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
        >
          Reason (optional)
        </span>
        <textarea
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full resize-none bg-transparent py-2 text-[16px] outline-none"
          style={{ borderBottom: "1px solid #0A0A0A" }}
        />
      </label>
      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="px-8 py-4 text-[14px] font-medium uppercase disabled:opacity-50"
          style={{
            backgroundColor: "#0A0A0A",
            color: "#FAFAF7",
            letterSpacing: "0.1em",
          }}
        >
          {pending ? "Cancelling…" : "Cancel appointment"}
        </button>
        {error && <span className="text-[13px] text-red-600">{error}</span>}
      </div>
    </form>
  );
}
