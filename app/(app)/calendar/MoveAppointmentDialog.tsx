"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { formatTimeForStudio, localDateString, localLongDate, localTimeString } from "@/lib/booking/tz";
import {
  loadMoveSlotsAction,
  moveAppointmentAction,
  type MoveSlot,
} from "./move-appointment-actions";

// Practitioner Move appointment — ONE shared responsive dialog + state machine used by
// mobile, tablet, and desktop (responsive by Tailwind; no separate mobile/desktop paths).
// Mobile: full-width bottom sheet (<= 90dvh, safe-area padding, sticky header/footer,
// 44px tap targets, 2-col time grid). Tablet/desktop: centered modal (wider time grid,
// keyboard-operable, focus trapped, Escape closes when idle, focus returns to the opener).

export type MoveDialogAppointment = {
  id: string;
  startsAt: string; // ISO UTC
  endsAt: string; // ISO UTC
  durationMinutes: number;
  clientName: string | null;
  serviceName: string | null;
  practitionerName?: string | null;
};

type Props = {
  open: boolean;
  onClose: () => void;
  onMoved: (r: { startsAt: string; endsAt: string; notificationStatus: string; message: string }) => void;
  appointment: MoveDialogAppointment;
  studioTimezone: string;
  timeFormat: "12h" | "24h";
};

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export default function MoveAppointmentDialog({ open, onClose, onMoved, appointment, studioTimezone, timeFormat }: Props) {
  const tz = studioTimezone;
  const currentLocalDate = useMemo(() => localDateString(new Date(appointment.startsAt), tz), [appointment.startsAt, tz]);
  const todayLocal = useMemo(() => localDateString(new Date(), tz), [tz]);

  const [date, setDate] = useState(currentLocalDate);
  const [slots, setSlots] = useState<MoveSlot[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MoveSlot | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [loadingSlots, startLoad] = useTransition();
  const [submitting, startSubmit] = useTransition();

  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const currentDayLabel = useMemo(() => localLongDate(new Date(appointment.startsAt), tz), [appointment.startsAt, tz]);
  const currentTimeLabel = useMemo(() => formatTimeForStudio(new Date(appointment.startsAt), tz, timeFormat), [appointment.startsAt, tz, timeFormat]);
  const newDayLabel = useMemo(() => (selected ? localLongDate(new Date(selected.start), tz) : null), [selected, tz]);

  // Load authorized available times for a given local date. Preserves the current
  // selection only when the new list still contains it (else clears the incompatible time).
  const load = useCallback(
    (forDate: string) => {
      setLoadError(null);
      startLoad(async () => {
        const res = await loadMoveSlotsAction({ appointmentId: appointment.id, localDate: forDate });
        if (!res.ok) {
          setSlots([]);
          setLoadError(res.error);
          setSelected(null);
          return;
        }
        setSlots(res.slots);
        setSelected((prev) => (prev && res.slots.some((s) => s.start === prev.start) ? prev : null));
      });
    },
    [appointment.id],
  );

  // On open: reset to the appointment's current date and load its times; capture the opener.
  useEffect(() => {
    if (!open) return;
    openerRef.current = (document.activeElement as HTMLElement) ?? null;
    setDate(currentLocalDate);
    setSelected(null);
    setMoveError(null);
    load(currentLocalDate);
    const t = window.setTimeout(() => panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus(), 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Focus trap + Escape (idle only). Focus returns to the opener on close.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Tab" && panelRef.current) {
        const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null);
        if (nodes.length === 0) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      openerRef.current?.focus?.();
    };
  }, [open, submitting, onClose]);

  const onPickDate = (d: string) => {
    setDate(d);
    setMoveError(null);
    load(d);
  };

  const confirmMove = () => {
    if (!selected || submitting) return;
    setMoveError(null);
    const localTime = localTimeString(new Date(selected.start), tz); // 24h HH:MM in the studio tz
    startSubmit(async () => {
      const res = await moveAppointmentAction({
        appointmentId: appointment.id,
        expectedStartsAt: appointment.startsAt,
        expectedEndsAt: appointment.endsAt,
        localDate: date,
        localTime,
      });
      if (res.ok) {
        onMoved(res);
        return;
      }
      if (res.code === "conflict") {
        setMoveError(res.error);
        setSelected(null);
        load(date); // refresh the times; the appointment did NOT move
        return;
      }
      // stale / no_change / generic — keep the dialog open, show safe copy.
      setMoveError(res.error);
      if (res.code === "stale") load(date);
    });
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label="Move appointment">
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={() => { if (!submitting) onClose(); }}
        className="absolute inset-0 bg-black/40 backdrop-blur-[1px]"
      />
      <div
        ref={panelRef}
        className="relative flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl dark:bg-neutral-950 sm:max-h-[85vh] sm:w-[540px] sm:rounded-2xl"
      >
        {/* Sticky header */}
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-neutral-200 bg-white px-5 py-4 dark:border-neutral-800 dark:bg-neutral-950">
          <h2 className="font-serif text-lg font-semibold">Move appointment</h2>
          <button type="button" onClick={() => { if (!submitting) onClose(); }} disabled={submitting} aria-label="Close" className="min-h-[44px] min-w-[44px] rounded-lg px-2 text-neutral-500 hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-900">✕</button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* Step 1 — current appointment */}
          <section className="rounded-xl bg-neutral-50 p-4 text-sm dark:bg-neutral-900">
            <div className="font-medium">{appointment.clientName ?? "Client"} · {appointment.serviceName ?? "Appointment"}</div>
            <div className="mt-1 text-neutral-600 dark:text-neutral-400">Currently {currentDayLabel} at {currentTimeLabel}</div>
            <div className="mt-0.5 text-neutral-500">{appointment.durationMinutes} min{appointment.practitionerName ? ` · ${appointment.practitionerName}` : ""}</div>
          </section>

          {/* Step 2 — choose date */}
          <label className="mt-5 block">
            <span className="text-sm font-medium">New date</span>
            <input
              type="date"
              value={date}
              min={todayLocal}
              onChange={(e) => onPickDate(e.target.value)}
              disabled={submitting}
              className="mt-1 block w-full rounded-lg border border-neutral-300 px-3 py-3 text-base focus:border-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900/10 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>

          {/* Step 3 — choose time */}
          <div className="mt-5">
            <span className="text-sm font-medium">New time</span>
            {loadingSlots ? (
              <p className="mt-3 text-sm text-neutral-500">Loading available times…</p>
            ) : loadError ? (
              <div className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                {loadError}{" "}
                <button type="button" onClick={() => load(date)} className="underline">Try again</button>
              </div>
            ) : slots && slots.length === 0 ? (
              <p className="mt-3 text-sm text-neutral-500">No available times on this date.</p>
            ) : (
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {(slots ?? []).map((s) => {
                  const isSel = selected?.start === s.start;
                  return (
                    <button
                      key={s.start}
                      type="button"
                      onClick={() => { setSelected(s); setMoveError(null); }}
                      disabled={submitting}
                      aria-pressed={isSel}
                      className={`min-h-[44px] rounded-lg border px-2 py-2 text-sm transition ${isSel ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900" : "border-neutral-300 hover:border-neutral-500 dark:border-neutral-700"}`}
                    >
                      {s.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Step 4 — confirm summary */}
          {selected && (
            <section className="mt-5 rounded-xl border border-neutral-200 p-4 text-sm dark:border-neutral-800">
              <div className="font-medium">Confirm move</div>
              <div className="mt-2 flex flex-col gap-1 text-neutral-600 dark:text-neutral-400">
                <span>From: {currentDayLabel} at {currentTimeLabel}</span>
                <span className="font-medium text-neutral-900 dark:text-neutral-100">To: {newDayLabel} at {selected.label}</span>
                <span>Duration unchanged: {appointment.durationMinutes} min</span>
              </div>
            </section>
          )}

          {moveError && (
            <div role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">{moveError}</div>
          )}
        </div>

        {/* Sticky footer (safe-area padded on mobile) */}
        <div className="sticky bottom-0 z-10 flex items-center justify-end gap-3 border-t border-neutral-200 bg-white px-5 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] dark:border-neutral-800 dark:bg-neutral-950 sm:pb-4">
          <button type="button" onClick={() => { if (!submitting) onClose(); }} disabled={submitting} className="min-h-[44px] rounded-lg px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-900">Keep current time</button>
          <button type="button" onClick={confirmMove} disabled={!selected || submitting} className="min-h-[44px] rounded-lg bg-neutral-900 px-5 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900">
            {submitting ? "Moving appointment…" : "Move appointment"}
          </button>
        </div>
      </div>
    </div>
  );
}
