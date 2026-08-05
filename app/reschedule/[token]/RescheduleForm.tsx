"use client";

import { useEffect, useState, useTransition } from "react";
import {
  fetchNextAvailableDateForRescheduleAction,
  fetchRescheduleSlotsAction,
  rescheduleAppointmentViaTokenAction,
} from "./actions";

// Pretty-print a local YYYY-MM-DD as "Monday, June 1" (with year only
// when not the current calendar year). Pure client-side formatting; no
// timezone math since the input is already studio-local.
function formatLocalDate(localDate: string): string {
  const [y, m, d] = localDate.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return localDate;
  }
  const date = new Date(y, m - 1, d);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}

// Add one local calendar day to YYYY-MM-DD. Used to advance the next-
// available scan past the date the user already saw as empty. DST-safe:
// pure local-date arithmetic, no UTC conversion.
function addOneDayLocal(localDate: string): string {
  const [y, m, d] = localDate.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return localDate;
  }
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + 1);
  const yy = String(date.getFullYear()).padStart(4, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

type Slot = { start: string; end: string; startLabel: string };

type Props = {
  token: string;
  durationMinutes: number;
  studioTimezone: string;
  // Migration 0036: per-studio public booking horizon (3, 4, or 6
  // months). The date picker max is computed from this so it mirrors
  // the server-side check in fetchRescheduleSlotsAction.
  studioPublicBookingHorizonMonths: number;
  // PR #133. True when the resolved studio has at least one of
  // cancellation_policy_text or no_show_policy_text configured.
  // False for studios with no policy text on file. When false we
  // render no checkbox and post no acknowledged_policy field; the
  // server-side action mirrors the same predicate against the
  // resolved studio row.
  requiresAcknowledgement: boolean;
  // 0171. SERVER-GENERATED hash of the exact policy text rendered above this
  // form. Posted back verbatim with the checkbox so the command can prove the
  // visitor acknowledged what they were actually shown. This component never
  // computes it, never inspects it, and never sees the policy text itself —
  // it is an opaque proof-of-display string. null when no policy is on file.
  presentedPolicyHash: string | null;
};

// Today in the studio's local calendar, not the visitor's UTC date.
// A reschedule page opened at 10pm Toronto must default to today's
// remaining slots, not tomorrow's.
function todayInStudio(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Today + (months × 31 days) in studio tz. Mirrors
// horizonDaysForMonths() in lib/booking/horizon.ts; computed here to
// avoid pulling a server helper into a client component. Unknown
// horizon values fall back to 3 months so the picker still renders.
function horizonInStudio(
  tz: string,
  months: number,
): { min: string; max: string } {
  const safeMonths =
    Number.isInteger(months) && months >= 1 && months <= 12 ? months : 3;
  const min = todayInStudio(tz);
  const [y, m, d] = min.split("-").map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  noon.setUTCDate(noon.getUTCDate() + safeMonths * 31);
  const max = `${noon.getUTCFullYear()}-${String(noon.getUTCMonth() + 1).padStart(2, "0")}-${String(noon.getUTCDate()).padStart(2, "0")}`;
  return { min, max };
}

export function RescheduleForm({
  token,
  studioTimezone,
  studioPublicBookingHorizonMonths,
  requiresAcknowledgement,
  presentedPolicyHash,
}: Props) {
  const horizon = horizonInStudio(
    studioTimezone,
    studioPublicBookingHorizonMonths,
  );
  const [date, setDate] = useState(horizon.min);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [picked, setPicked] = useState<Slot | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 0171 amendment. The success state carries the successor's MANAGEMENT URL
  // and the TRUE email outcome, so the page never claims a confirmation is on
  // its way that the provider refused — and the client always leaves with a
  // usable path to the new appointment.
  const [done, setDone] = useState<{
    when: string;
    manageUrl: string;
    emailStatus: "sent" | "failed" | "disabled";
  } | null>(null);
  const [loadingSlots, startLoading] = useTransition();
  const [submitting, startSubmitting] = useTransition();
  // PR #132. Required policy acknowledgement. Submit is disabled
  // until this is checked; the server action rejects any submission
  // whose 'acknowledged_policy' form field is not exactly 'true'.
  const [acknowledged, setAcknowledged] = useState(false);
  // Next-available lookup (mirrors PublicBookForm). One server roundtrip
  // per click; bounded server-side scan from the day AFTER the date the
  // user already saw as empty.
  const [findingNext, startFindingNext] = useTransition();
  const [noneInHorizon, setNoneInHorizon] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setPicked(null);
    // Reset next-available state on any service/date change so an old
    // "no availability in horizon" verdict from a stale probe doesn't
    // linger after the user picks a different date.
    setNoneInHorizon(false);
    startLoading(async () => {
      const r = await fetchRescheduleSlotsAction({ token, date });
      if (cancelled) return;
      if (!r.ok) {
        setError(r.error);
        setSlots([]);
        return;
      }
      setSlots(r.slots);
    });
    return () => {
      cancelled = true;
    };
  }, [token, date]);

  function onFindNext() {
    setError(null);
    setNoneInHorizon(false);
    // Skip the day we already know is empty (that's why this button
    // showed up). The server clamps to today.
    const startFrom = addOneDayLocal(date);
    startFindingNext(async () => {
      const r = await fetchNextAvailableDateForRescheduleAction({
        token,
        fromDate: startFrom,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      if (r.date == null) {
        setNoneInHorizon(true);
        return;
      }
      setDate(r.date);
    });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!picked) {
      setError("Pick a time first.");
      return;
    }
    if (requiresAcknowledgement && !acknowledged) {
      // Client-side mirror of the server validation. The disabled
      // submit button blocks this from reaching the action in
      // practice, but a stale event handler or test harness could
      // still send the FormData; the action re-checks. Only fires
      // when the studio actually has policy text.
      setError(
        "Please review and acknowledge the appointment policies before rescheduling.",
      );
      return;
    }
    setError(null);
    const fd = new FormData();
    fd.set("token", token);
    fd.set("starts_at", picked.start);
    if (requiresAcknowledgement) {
      // Only post the ack field when it is required. A studio with
      // no policy on file accepts the submit without this field
      // entirely; sending an unsolicited 'true' would be misleading.
      fd.set("acknowledged_policy", "true");
      // 0171. Posted back exactly as the server issued it. If the studio edited
      // its policies since this page rendered, the command sees the mismatch
      // and returns policy_changed rather than recording acceptance of text
      // this visitor never saw.
      if (presentedPolicyHash) {
        fd.set("presented_policy_hash", presentedPolicyHash);
      }
    }
    startSubmitting(async () => {
      const r = await rescheduleAppointmentViaTokenAction(fd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setDone({
        when: picked.startLabel,
        manageUrl: r.manageUrl,
        emailStatus: r.confirmationEmailStatus,
      });
    });
  }

  if (done) {
    // Copy is chosen by the ACTUAL email outcome. "A confirmation email is on
    // its way" used to render unconditionally — including when the studio had
    // confirmations switched off entirely, and when the provider had just
    // failed. The management link renders in ALL THREE states, because it is
    // the client's guaranteed path to the successor and does not depend on any
    // provider.
    const body =
      done.emailStatus === "sent"
        ? "Your new appointment is set, and a confirmation email has been sent."
        : done.emailStatus === "failed"
          ? "Your appointment moved successfully, but we couldn't send the confirmation email. Use the link below to manage your new appointment."
          : "Your appointment moved successfully. Use the link below to manage your new appointment.";

    return (
      <div className="flex flex-col gap-4">
        <h2
          className="font-[var(--font-fraunces)] text-[28px] font-bold leading-tight"
          style={{ letterSpacing: "-0.02em" }}
        >
          You&rsquo;re rescheduled.
        </h2>
        <p className="text-[16px] leading-relaxed text-[#0A0A0A]">{body}</p>

        {/* PRIMARY exit. Always present, whatever the email did. */}
        <a
          href={done.manageUrl}
          className="self-start px-6 py-3 text-[13px] font-medium uppercase"
          style={{
            backgroundColor: "#0A0A0A",
            color: "#FFFFFF",
            letterSpacing: "0.1em",
          }}
        >
          Manage new appointment
        </a>

        {/* Secondary exit. /portal handles its own session check: if the
            visitor has a live portal session they land on their home; if not,
            the portal page redirects to /portal/login. We do not promise they
            are already signed in. */}
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

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <label className="flex flex-col gap-2">
        <span
          className="text-[12px] font-medium uppercase"
          style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
        >
          Pick a new date
        </span>
        <input
          type="date"
          value={date}
          min={horizon.min}
          max={horizon.max}
          onChange={(e) => setDate(e.target.value)}
          className="w-full max-w-[16rem] bg-transparent py-2 text-[16px] outline-none"
          style={{ borderBottom: "1px solid #0A0A0A" }}
        />
      </label>

      <div className="flex flex-col gap-3">
        <span
          className="text-[12px] font-medium uppercase"
          style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
        >
          {`Available times for ${formatLocalDate(date)}`}
        </span>
        {loadingSlots ? (
          <p className="text-sm text-[#6B6B6B]">Loading slots…</p>
        ) : slots.length === 0 ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-[#6B6B6B]">
              {`No availability on ${formatLocalDate(date)}.`}
            </p>
            {noneInHorizon ? (
              <p className="text-sm text-[#6B6B6B]">
                No availability within the current booking window. Please
                check back later or contact the studio.
              </p>
            ) : (
              <div>
                <button
                  type="button"
                  onClick={onFindNext}
                  disabled={findingNext}
                  className="px-3 py-1.5 text-xs font-medium uppercase disabled:opacity-50"
                  style={{
                    border: "1px solid #0A0A0A",
                    backgroundColor: "transparent",
                    color: "#0A0A0A",
                    letterSpacing: "0.1em",
                  }}
                >
                  {findingNext ? "Finding…" : "Next available"}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {slots.map((slot) => {
              const isPicked = picked?.start === slot.start;
              return (
                <button
                  key={slot.start}
                  type="button"
                  onClick={() => setPicked(slot)}
                  className={`rounded-md border px-3 py-1.5 text-sm transition ${
                    isPicked
                      ? "border-[#0A0A0A] bg-[#0A0A0A] text-white"
                      : "border-neutral-300 hover:border-neutral-500"
                  }`}
                >
                  {slot.startLabel}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* PR #132. Required policy acknowledgement. Sits directly
          above the destructive reschedule button so the visitor
          reads the studio's policies (rendered higher up the page in
          the shared PublicPolicyReminderCard) and ticks the box
          before they can submit. Server rejects any non-'true'
          value.
          PR #133. The whole block renders only when the studio
          actually has policy text; otherwise the reschedule
          surface omits the checkbox entirely. */}
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

      {error && <p className="text-sm text-red-700">{error}</p>}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={
            !picked
            || submitting
            || (requiresAcknowledgement && !acknowledged)
          }
          className="rounded-md bg-[#0A0A0A] px-5 py-3 text-base font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? "Rescheduling…" : "Confirm new time"}
        </button>
      </div>
    </form>
  );
}
