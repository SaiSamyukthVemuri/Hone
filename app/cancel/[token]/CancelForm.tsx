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
  // PR #133. True when the resolved studio has at least one of
  // cancellation_policy_text or no_show_policy_text configured.
  // False for studios with no policy text on file ("My Studio",
  // any fresh studio). When false we render no checkbox and post
  // no acknowledged_policy field; the server-side action mirrors
  // the same predicate against the resolved studio row.
  requiresAcknowledgement: boolean;
};

export function CancelForm({ token, requiresAcknowledgement }: Props) {
  const [reason, setReason] = useState("");
  // PR #132. Required policy acknowledgement. Submit is disabled
  // until this is checked, and the server action rejects any
  // submission whose 'acknowledged_policy' form field is not
  // exactly 'true' (defence in depth: the disabled attribute is
  // not a security boundary).
  const [acknowledged, setAcknowledged] = useState(false);
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
    if (requiresAcknowledgement && !acknowledged) {
      // Client-side mirror of the server validation so the visitor
      // sees the same message whether they bypassed the disabled
      // submit (impossible from the rendered UI but defensive) or
      // clicked it normally. Only fires when the studio actually
      // has policy text; otherwise both branches skip the ack
      // entirely.
      setError(
        "Please review and acknowledge the appointment policies before cancelling.",
      );
      return;
    }
    const fd = new FormData();
    fd.set("token", token);
    fd.set("reason", reason);
    if (requiresAcknowledgement) {
      // Only post the ack field when it is required. A studio with
      // no policy on file accepts the submit without this field
      // entirely; sending an unsolicited 'true' would be misleading.
      fd.set("acknowledged_policy", "true");
    }
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
      {/* PR #132. Required policy acknowledgement. Sits directly
          above the destructive cancel button so the visitor reads
          the studio's policies (rendered higher up the page in the
          shared PublicPolicyReminderCard) and ticks the box before
          they can submit. Server rejects any non-'true' value.
          PR #133. The whole block renders only when the studio
          actually has policy text; otherwise the cancel surface
          omits the checkbox entirely (no policy on file => no
          policy to acknowledge). */}
      {requiresAcknowledgement && (
        <label
          className="flex items-start gap-3 text-[14px] leading-[1.5]"
          style={{ color: "#0A0A0A" }}
        >
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-1 h-4 w-4 flex-none"
          />
          <span>
            I have reviewed and understand the cancellation and no-show
            policies.
          </span>
        </label>
      )}

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={pending || (requiresAcknowledgement && !acknowledged)}
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
