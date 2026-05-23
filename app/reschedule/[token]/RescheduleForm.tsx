"use client";

import { useEffect, useState, useTransition } from "react";
import {
  fetchRescheduleSlotsAction,
  rescheduleAppointmentViaTokenAction,
} from "./actions";

type Slot = { start: string; end: string; startLabel: string };

type Props = {
  token: string;
  durationMinutes: number;
  studioTimezone: string;
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

// Today + 90 days in studio tz, matching BOOKING_HORIZON_DAYS in
// lib/booking/horizon.ts. Computed here to avoid pulling a server
// helper into a client component.
function horizonInStudio(tz: string): { min: string; max: string } {
  const min = todayInStudio(tz);
  const [y, m, d] = min.split("-").map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  noon.setUTCDate(noon.getUTCDate() + 90);
  const max = `${noon.getUTCFullYear()}-${String(noon.getUTCMonth() + 1).padStart(2, "0")}-${String(noon.getUTCDate()).padStart(2, "0")}`;
  return { min, max };
}

export function RescheduleForm({ token, studioTimezone }: Props) {
  const horizon = horizonInStudio(studioTimezone);
  const [date, setDate] = useState(horizon.min);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [picked, setPicked] = useState<Slot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ when: string } | null>(null);
  const [loadingSlots, startLoading] = useTransition();
  const [submitting, startSubmitting] = useTransition();

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setPicked(null);
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

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!picked) {
      setError("Pick a time first.");
      return;
    }
    setError(null);
    const fd = new FormData();
    fd.set("token", token);
    fd.set("starts_at", picked.start);
    startSubmitting(async () => {
      const r = await rescheduleAppointmentViaTokenAction(fd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setDone({ when: picked.startLabel });
    });
  }

  if (done) {
    return (
      <div className="flex flex-col gap-4">
        <h2
          className="font-[var(--font-fraunces)] text-[28px] font-bold leading-tight"
          style={{ letterSpacing: "-0.02em" }}
        >
          You&rsquo;re rescheduled.
        </h2>
        <p className="text-[16px] leading-relaxed text-[#0A0A0A]">
          Your new appointment is set. A confirmation email is on its way.
        </p>
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
          Available times
        </span>
        {loadingSlots ? (
          <p className="text-sm text-[#6B6B6B]">Loading slots…</p>
        ) : slots.length === 0 ? (
          <p className="text-sm text-[#6B6B6B]">
            No availability on that date.
          </p>
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

      {error && <p className="text-sm text-red-700">{error}</p>}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!picked || submitting}
          className="rounded-md bg-[#0A0A0A] px-5 py-3 text-base font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? "Rescheduling…" : "Confirm new time"}
        </button>
      </div>
    </form>
  );
}
