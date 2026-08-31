"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
  // B7 / 0176. Server-generated hash of the EXACT policy snapshot this
  // page rendered. Posted back unchanged; the browser neither supplies
  // policy text nor computes the authoritative hash.
  presentedPolicyHash: string;
  // EMERG-01. SERVER-DERIVED on the page from the appointment's own service
  // and studio rows. PRESENTATION ONLY — it changes what this form says, never
  // what it is allowed to do. Cancellation stays available exactly as before.
  freeConsultationWaitlistOnly: boolean;
  // The studio's public booking slug, non-null only when the flag above is
  // true. Builds the post-cancellation "Join the waitlist" link into the
  // studio's existing public booking surface.
  waitlistBookingSlug: string | null;
};

export function CancelForm({
  token,
  requiresAcknowledgement,
  presentedPolicyHash,
  freeConsultationWaitlistOnly,
  waitlistBookingSlug,
}: Props) {
  const router = useRouter();
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

  const rescheduleHref = `/reschedule/${encodeURIComponent(token)}`;

  if (done === "cancelled") {
    return <CancelledSuccess waitlistBookingSlug={waitlistBookingSlug} />;
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
    // ALWAYS posted, including for a studio with no policy, where it is the
    // hash of the empty snapshot. Sending it only when a policy exists would
    // leave the "policy added after render" case with nothing to compare.
    fd.set("presented_policy_hash", presentedPolicyHash);
    startTransition(async () => {
      const r = await publicCancelAppointmentAction(fd);
      if (!r.ok) {
        // B7 / 0176. Exactly ONE outcome is branched on, and it is not a
        // token state: the studio edited its policy while this page was
        // open. A changed policy can never be silently accepted, and it
        // must not be retried automatically: the client has to see the
        // NEW text and consent to it.
        //
        // So: clear the acknowledgement, tell them plainly what happened,
        // and refresh the server component so the policy card re-renders
        // with the current text and a fresh presented hash. The next
        // submit is a genuine second consent, not a replay of the first.
        if (r.code === "policy_changed") {
          setAcknowledged(false);
          setError(r.error);
          router.refresh();
          return;
        }
        // Everything else uses the same generic collapse as the fetch
        // surface. The UI does not branch on it.
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

        <CancellationNudge
          reason={reason}
          freeConsultationWaitlistOnly={freeConsultationWaitlistOnly}
          rescheduleHref={rescheduleHref}
        />

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

// ===========================================================================
// The two surfaces whose CONTENT depends on the free-consultation policy.
// ===========================================================================
//
// They are separate exported components, not inline JSX, for one reason: each
// has two mutually exclusive renderings and only one of them is reachable from
// a given piece of form state. Pulled out, both are pure functions of their
// props, so a test can render each branch and assert on the REAL output rather
// than grepping this file for a phrase. That is what makes "no reschedule CTA
// for a free consultation" a proof instead of a claim.
//
// Neither reads the policy itself. The verdict is derived on the server from
// the appointment's own service and studio rows and arrives here as a prop.

/**
 * PR #144's reschedule nudge, plus EMERG-01's replacement for it.
 *
 * When the picked reason implies "I want a different time, not no
 * appointment", the client is normally offered a way to pivot. For a free
 * consultation at a waitlisted studio that offer would be a link to a refusal,
 * so the same trigger explains the waitlist instead. Cancellation is never
 * blocked either way; the cancel button below this block stays active.
 */
export function CancellationNudge({
  reason,
  freeConsultationWaitlistOnly,
  rescheduleHref,
}: {
  reason: string;
  freeConsultationWaitlistOnly: boolean;
  rescheduleHref: string;
}) {
  const triggered =
    reason !== "" &&
    RESCHEDULE_NUDGE_REASONS.has(reason as CancellationReasonValue);
  if (!triggered) return null;

  if (freeConsultationWaitlistOnly) {
    // EMERG-01. NO link, NO route back into available times — not even a
    // disabled one. The visitor is told the truth about what happens next so
    // they can decide, and the decision stays theirs.
    return (
      <div
        className="flex flex-col gap-3 p-5"
        style={{ backgroundColor: "#FAFAF7", border: "1px solid #E5E2D9" }}
      >
        <h3
          className="font-[var(--font-fraunces)] text-[16px] font-bold leading-tight"
          style={{ letterSpacing: "-0.01em" }}
        >
          This consultation can&rsquo;t be moved to another time
        </h3>
        <p className="text-[14px] leading-relaxed text-[#0A0A0A]">
          Free consultations can&rsquo;t be rescheduled. If you cancel, you can
          join the waitlist for the next available consultation.
        </p>
      </div>
    );
  }

  // Unchanged from PR #144 for every other studio and service.
  return (
    <div
      className="flex flex-col gap-3 p-5"
      style={{ backgroundColor: "#FAFAF7", border: "1px solid #E5E2D9" }}
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
  );
}

/**
 * The post-cancellation surface.
 *
 * For a policy-matched free consultation it also names the way back: the
 * studio's EXISTING public booking page, which already switches a closed
 * studio into the waitlist experience.
 *
 * IT IS A LINK, AND ONLY A LINK. No waitlist row is created, no client detail
 * is copied into a waitlist command, and nothing is pre-filled — the person
 * must submit the existing public waitlist form themselves. Converting a
 * cancelled appointment into a waitlist record automatically is not within
 * that surface's authority: it is an explicit public contact submission, and
 * consent to be contacted about a treatment cannot be inherited from an
 * appointment the person just cancelled.
 */
export function CancelledSuccess({
  waitlistBookingSlug,
}: {
  waitlistBookingSlug: string | null;
}) {
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
      {waitlistBookingSlug ? (
        <>
          <p className="text-[16px] leading-relaxed text-[#0A0A0A]">
            To request another free consultation, join the waitlist.
          </p>
          <a
            href={`/book/${encodeURIComponent(waitlistBookingSlug)}`}
            className="self-start px-6 py-3 text-[13px] font-medium uppercase"
            style={{
              backgroundColor: "#0A0A0A",
              color: "#FAFAF7",
              letterSpacing: "0.1em",
            }}
          >
            Join the waitlist
          </a>
        </>
      ) : (
        // Back-to-portal exit. /portal handles its own session check: if the
        // visitor has a live portal session they land on their home; if not,
        // the portal page redirects to /portal/login. We do not promise they
        // are already signed in.
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
      )}
    </div>
  );
}
