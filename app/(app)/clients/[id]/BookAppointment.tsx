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

type Slot = { start: string; end: string; startLabel: string };

type Props = {
  clientId: string;
  services: Service[];
  defaultDate: string; // YYYY-MM-DD in studio tz
};

export function BookAppointment({ clientId, services, defaultDate }: Props) {
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

  function handleConfirm() {
    if (!serviceId || !pickedSlot) return;
    setError(null);
    const fd = new FormData();
    fd.set("client_id", clientId);
    fd.set("service_id", serviceId);
    fd.set("starts_at", pickedSlot.start);
    fd.set("notes", notes);
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
          disabled={!pickedSlot || booking}
          className="rounded-md bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {booking ? "Booking…" : "Confirm"}
        </button>
        {error && (
          <span className="text-sm text-red-600 dark:text-red-400">{error}</span>
        )}
      </div>
    </div>
  );
}
