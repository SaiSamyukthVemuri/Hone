"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Service } from "@/lib/types/database";
import {
  formatServiceLabel,
  groupServicesByModality,
} from "@/lib/booking/format";
import { fetchSlotsForClientBookingAction } from "./booking-actions";
import { bookAppointmentForClientAction } from "../../calendar/actions";
import { utcInstantFromLocal } from "@/lib/booking/tz";

type Slot = { start: string; end: string; startLabel: string };

type Props = {
  clientId: string;
  services: Service[];
  defaultDate: string; // YYYY-MM-DD in studio tz
  // Studio IANA timezone — required to interpret the owner override's local
  // time as a UTC instant (DST-safe via utcInstantFromLocal).
  timezone: string;
  // Owner-only outside-hours override. Non-owners never see the control; the
  // server (bookAppointmentForClientAction) enforces owner-only regardless.
  isOwner: boolean;
};

const OVERRIDE_TIME_RE = /^\d{2}:\d{2}$/;

export function BookAppointment({
  clientId,
  services,
  defaultDate,
  timezone,
  isOwner,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => groupServicesByModality(services), [services]);
  const firstServiceId = groups[0]?.services[0]?.id ?? "";
  const [serviceId, setServiceId] = useState(firstServiceId);
  const [date, setDate] = useState(defaultDate);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [pickedSlot, setPickedSlot] = useState<Slot | null>(null);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();
  const [booking, startBooking] = useTransition();
  // Owner-only override: same contract as the calendar Quick Book drawer —
  // allow_outside_availability=true + a UTC instant from the local time. Off by
  // default; requires an explicit confirmation.
  const [overrideEnabled, setOverrideEnabled] = useState(false);
  const [overrideTime, setOverrideTime] = useState("");
  const [overrideConfirmed, setOverrideConfirmed] = useState(false);
  const overrideTimeValid = OVERRIDE_TIME_RE.test(overrideTime);

  function loadSlots(nextServiceId: string, nextDate: string) {
    setError(null);
    setPickedSlot(null);
    startLoading(async () => {
      const r = await fetchSlotsForClientBookingAction({
        serviceId: nextServiceId,
        date: nextDate,
      });
      if (!r.ok) {
        setError(r.error);
        setSlots([]);
        return;
      }
      setSlots(r.slots);
    });
  }

  function handleOpen() {
    setOpen(true);
    if (serviceId && date) loadSlots(serviceId, date);
  }

  function handleService(v: string) {
    setServiceId(v);
    if (v && date) loadSlots(v, date);
  }
  function handleDate(v: string) {
    setDate(v);
    if (serviceId && v) loadSlots(serviceId, v);
  }

  // Owner override is usable only when the toggle is on, the time is valid, and
  // the owner has confirmed. Otherwise a normal slot must be picked.
  const overrideActive = isOwner && overrideEnabled;
  const canConfirm = overrideActive
    ? overrideTimeValid && overrideConfirmed
    : !!pickedSlot;

  function handleConfirm() {
    if (!serviceId || !canConfirm) return;
    setError(null);
    const fd = new FormData();
    fd.set("client_id", clientId);
    fd.set("service_id", serviceId);
    fd.set("notes", notes);
    if (overrideActive) {
      // Same contract as the calendar Quick Book override: a UTC instant from
      // the studio-local date + time, plus allow_outside_availability=true. The
      // server re-checks owner permission and every DB scheduling constraint.
      const utc = utcInstantFromLocal(date, overrideTime, timezone);
      fd.set("starts_at", utc.toISOString());
      fd.set("allow_outside_availability", "true");
    } else {
      if (!pickedSlot) return;
      fd.set("starts_at", pickedSlot.start);
    }
    startBooking(async () => {
      const r = await bookAppointmentForClientAction(fd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.push(`/calendar/${r.appointmentId}`);
    });
  }

  if (services.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-neutral-300 bg-neutral-50 p-3 text-xs text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
        Add services in Settings → Services to enable booking.
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={handleOpen}
        className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
      >
        + Book appointment
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-medium">Book appointment</h3>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-neutral-500 hover:underline"
        >
          Close
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Service
          </span>
          <select
            value={serviceId}
            onChange={(e) => handleService(e.target.value)}
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          >
            {groups.map((group) =>
              groups.length === 1 && group.modality === null ? (
                group.services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {formatServiceLabel(s)}
                  </option>
                ))
              ) : (
                <optgroup key={group.modality ?? "_other"} label={group.label}>
                  {group.services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {formatServiceLabel(s)}
                    </option>
                  ))}
                </optgroup>
              ),
            )}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Date
          </span>
          <input
            type="date"
            value={date}
            onChange={(e) => handleDate(e.target.value)}
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
        </label>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Available times
        </span>
        {loading ? (
          <p className="text-sm text-neutral-500">Loading slots…</p>
        ) : slots.length === 0 ? (
          <p className="text-sm text-neutral-500">
            No availability on that date.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {slots.map((slot) => {
              const picked = pickedSlot?.start === slot.start;
              return (
                <button
                  key={slot.start}
                  type="button"
                  onClick={() => setPickedSlot(slot)}
                  className={`rounded-md border px-3 py-1.5 text-sm transition ${
                    picked
                      ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                      : "border-neutral-300 hover:border-neutral-500 dark:border-neutral-700"
                  }`}
                >
                  {slot.startLabel}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Owner-only outside-hours override (parity with the calendar Quick Book
          drawer). Non-owners never see this; the server enforces owner-only. */}
      {isOwner && (
        <div className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={overrideEnabled}
              onChange={(e) => {
                setOverrideEnabled(e.target.checked);
                if (!e.target.checked) setOverrideConfirmed(false);
              }}
              className="h-4 w-4"
            />
            Book outside your normal availability
          </label>
          {overrideEnabled && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-amber-800 dark:text-amber-300">
                This time is outside your normal availability. Double-booking,
                buffer and time-off rules are still enforced.
              </p>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
                  Time (on {date})
                </span>
                <input
                  type="time"
                  value={overrideTime}
                  onChange={(e) => setOverrideTime(e.target.value)}
                  className="min-h-[44px] max-w-[10rem] rounded-md border border-neutral-300 bg-white px-3 py-2 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
                />
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={overrideConfirmed}
                  onChange={(e) => setOverrideConfirmed(e.target.checked)}
                  className="h-4 w-4"
                />
                I confirm I want to book this out-of-hours time.
              </label>
            </div>
          )}
        </div>
      )}

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Notes (optional)
        </span>
        <textarea
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
      </label>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleConfirm}
          disabled={!canConfirm || booking}
          className="rounded-md bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {booking ? "Booking…" : overrideActive ? "Book out-of-hours" : "Confirm"}
        </button>
        {error && (
          <span className="text-sm text-red-600 dark:text-red-400">{error}</span>
        )}
      </div>
    </div>
  );
}
