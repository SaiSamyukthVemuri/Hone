"use client";

import { useState, useTransition } from "react";
import { publicCancelAppointmentAction } from "./actions";
import {
  CANCELLATION_REASONS,
  CANCELLATION_NOTE_MAX_LENGTH,
  RESCHEDULE_NUDGE_REASONS,
  type CancellationReasonValue,
} from "@/lib/booking/cancellation-reasons";

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
  // PR #144. The free-form textarea has been replaced with a
  // structured dropdown ("" means "no reason picked"), an optional
  // note textarea, and an optional follow-up permission checkbox.
  // All three are optional; the cancel button is never blocked by
  // them. The server-side action mirrors the same validation:
  // reason must be in the allowed set or blank; note has a hard
  // length cap; follow_up_allowed is derived from the literal
  // string "true".
  const [reason, setReason] = useState<"" | CancellationReasonValue>("");
  const [note, setNote] = useState("");
  const [followUpAllowed, setFollowUpAllowed] = useState(false);
  // PR #132. Required policy acknowledgement. Submit is disabled
  // until this is checked, and the server action rejects any
  // submission whose 'acknowledged_policy' form field is not
  // exactly 'true' (defence in depth: the disabled attribute is
  // not a security boundary).
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<"cancelled" | null>(null);

  // PR #144. Reschedule nudge. When the picked reason implies
  // "I want a different time, not no appointment", surface a small
  // callout above the destructive button so the client can pivot to
  // reschedule without committing to a cancel. The /reschedule/[token]
  // route accepts the same token the cancel page is already using.
  const showRescheduleNudge =
    reason !== "" && RESCHEDULE_NUDGE_REASONS.has(reason);
  const rescheduleHref = `/reschedule/${encodeURIComponent(token)}`;

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
    if (reason !== "") {
      fd.set("reason", reason);
    }
    if (note.trim().length > 0) {
      fd.set("note", note);
    }
    if (followUpAllowed) {
      // Server reads only the literal string "true". Anything else
      // is treated as false.
      fd.set("follow_up_allowed", "true");
    }
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
    <form onSubmit={submit} className="flex flex-col gap-8">
      {/* PR #144. Optional cancellation insight section. Reads as a
          single calm block above the destructive button so the
          client knows they can skip it and still cancel. The whole
          section is optional; the cancel button does not depend on
          any of these fields. */}
      <section className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h2
            className="font-[var(--font-fraunces)] text-[20px] font-bold leading-tight"
            style={{ letterSpacing: "-0.02em" }}
          >
            Reason for cancelling{" "}
            <span
              className="text-[13px] font-normal italic"
              style={{ color: "#6B6B6B" }}
            >
              optional
            </span>
          </h2>
          <p className="text-[14px] leading-relaxed text-[#6B6B6B]">
            This helps the studio understand what happened.
          </p>
        </div>

        <label className="flex flex-col gap-2">
          <span
            className="text-[12px] font-medium uppercase"
            style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
          >
            Select a reason{" "}
            <span className="lowercase italic">optional</span>
          </span>
          <select
            value={reason}
            onChange={(e) =>
              setReason(
                e.target.value === ""
                  ? ""
                  : (e.target.value as CancellationReasonValue),
              )
            }
            className="w-full bg-transparent py-2 text-[16px] outline-none"
            style={{ borderBottom: "1px solid #0A0A0A" }}
          >
            <option value="">Select a reason</option>
            {CANCELLATION_REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>

        {showRescheduleNudge && (
          // Inline nudge. Rendered inside the form (not as a separate
          // page surface) so the client sees it the moment they pick
          // a scheduling-shaped reason. The Reschedule link is a
          // plain anchor to /reschedule/[token]; this component does
          // not consume the token or call any server action when the
          // client clicks it. The cancel button below remains active
          // so the client can continue cancelling if they prefer.
          <div
            className="flex flex-col gap-3 p-5"
            style={{
              backgroundColor: "#FAFAF7",
              border: "1px solid #E5E2D9",
            }}
          >
            <h3
              className="font-[var(--font-fraunces)] text-[16px] font-bold leading-tight"
              style={{ letterSpacing: "-0.01em" }}
            >
              Would another time work better?
            </h3>
            <p className="text-[14px] leading-relaxed text-[#0A0A0A]">
              You can reschedule this appointment instead of cancelling.
            </p>
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <a
                href={rescheduleHref}
                className="px-5 py-2.5 text-[13px] font-medium uppercase"
                style={{
                  backgroundColor: "#0A0A0A",
                  color: "#FAFAF7",
                  letterSpacing: "0.1em",
                }}
              >
                Reschedule instead
              </a>
              <span className="text-[13px] text-[#6B6B6B]">
                or continue cancelling below
              </span>
            </div>
          </div>
        )}

        <label className="flex flex-col gap-2">
          <span
            className="text-[12px] font-medium uppercase"
            style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
          >
            Anything else you want the studio to know?{" "}
            <span className="lowercase italic">optional</span>
          </span>
          <textarea
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={CANCELLATION_NOTE_MAX_LENGTH}
            className="w-full resize-none bg-transparent py-2 text-[16px] outline-none"
            style={{ borderBottom: "1px solid #0A0A0A" }}
          />
          <span
            className="text-[12px] italic"
            style={{ color: "#6B6B6B" }}
          >
            {note.length}/{CANCELLATION_NOTE_MAX_LENGTH}
          </span>
        </label>

        <label
          className="flex items-start gap-3 text-[14px] leading-[1.5]"
          style={{ color: "#0A0A0A" }}
        >
          <input
            type="checkbox"
            checked={followUpAllowed}
            onChange={(e) => setFollowUpAllowed(e.target.checked)}
            className="mt-1 h-4 w-4 flex-none"
          />
          <span>The studio may contact me about this cancellation.</span>
        </label>
      </section>

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
