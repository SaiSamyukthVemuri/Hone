"use client";

// Phase B calendar-first booking drawer.
//
// Drives an internal practitioner-side booking for an EXISTING client.
// Reuses, without modification, two existing server actions:
//   - bookAppointmentForClientAction (../calendar/actions.ts)
//   - fetchSlotsForClientBookingAction (../clients/[id]/booking-actions.ts)
//
// The drawer does not touch slot computation, conflict detection,
// reservation logic, public booking, Stripe, payment collection, or
// require_card_on_file. It only assembles the same FormData the
// existing client-profile booking form already submits and forwards
// it to the same server action.
//
// New-client inline creation is intentionally out of scope. The
// drawer renders a small hint pointing practitioners to /clients for
// that case; Phase C will handle inline new-client creation.

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Service } from "@/lib/types/database";
import {
  formatServiceLabel,
  groupServicesByModality,
} from "@/lib/booking/format";
import { fetchSlotsForClientBookingAction } from "../clients/[id]/booking-actions";
import { bookAppointmentForClientAction } from "./actions";

export type QuickBookDraft = {
  // YYYY-MM-DD in studio local time
  localDate: string;
  // HH:MM in studio local time, snapped to 15-minute increments
  localTime: string;
};

// Trimmed shape sent from the calendar server component. Avoids
// pushing the full Client row (notes, intake fields, timestamps)
// into the RSC payload for the drawer.
export type QuickBookClient = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  pronouns: string | null;
};

type Slot = { start: string; end: string; startLabel: string };

type Props = {
  open: boolean;
  draft: QuickBookDraft | null;
  clients: QuickBookClient[];
  services: Service[];
  onClose: () => void;
};

const MAX_CLIENT_RESULTS = 12;

// Local-only client search. Mirrors ClientSearch's matching rules
// (name OR email OR phone, case-insensitive substring) but is a
// selection control rather than a navigation control. ClientSearch
// renders <Link> rows that would navigate away from /calendar and
// destroy the drawer state, so it cannot be reused here.
function matchClient(c: QuickBookClient, queryLower: string): boolean {
  if (queryLower.length === 0) return true;
  return (
    (c.name ?? "").toLowerCase().includes(queryLower) ||
    (c.email ?? "").toLowerCase().includes(queryLower) ||
    (c.phone ?? "").toLowerCase().includes(queryLower)
  );
}

function formatLocalDate(localDate: string): string {
  const [y, m, d] = localDate.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return localDate;
  }
  const dt = new Date(y, m - 1, d);
  const sameYear = dt.getFullYear() === new Date().getFullYear();
  return dt.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}

function formatLocalTime(localTime: string): string {
  const [hStr, mStr] = localTime.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return localTime;
  const dt = new Date(2000, 0, 1, h, m, 0);
  return dt.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function QuickBookDrawer({
  open,
  draft,
  clients,
  services,
  onClose,
}: Props) {
  const router = useRouter();
  const serviceGroups = useMemo(
    () => groupServicesByModality(services),
    [services],
  );
  const firstServiceId = serviceGroups[0]?.services[0]?.id ?? "";

  const [clientQuery, setClientQuery] = useState("");
  const [selectedClient, setSelectedClient] =
    useState<QuickBookClient | null>(null);
  const [serviceId, setServiceId] = useState(firstServiceId);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [pickedSlot, setPickedSlot] = useState<Slot | null>(null);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loadingSlots, startLoadingSlots] = useTransition();
  const [booking, startBooking] = useTransition();

  // Reset all drawer state whenever the drawer closes or a fresh
  // draft is shown. Keeping this in a single effect avoids a tangle
  // of "did the draft change?" checks scattered across handlers.
  useEffect(() => {
    if (!open) {
      setClientQuery("");
      setSelectedClient(null);
      setServiceId(firstServiceId);
      setSlots([]);
      setPickedSlot(null);
      setNotes("");
      setError(null);
    }
  }, [open, firstServiceId]);

  // Close on Esc.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Fetch slots whenever (serviceId, draft.localDate) changes. The
  // clicked time from Phase A is only a hint — we preselect it if it
  // matches an available slot exactly, otherwise the practitioner picks
  // from the offered slots. We never send an arbitrary time to the
  // booking action.
  useEffect(() => {
    if (!open || !draft || !serviceId) {
      setSlots([]);
      setPickedSlot(null);
      return;
    }
    let cancelled = false;
    const targetDate = draft.localDate;
    const targetHint = draft.localTime;
    startLoadingSlots(async () => {
      const r = await fetchSlotsForClientBookingAction({
        serviceId,
        date: targetDate,
      });
      if (cancelled) return;
      if (!r.ok) {
        setError(r.error);
        setSlots([]);
        setPickedSlot(null);
        return;
      }
      setError(null);
      setSlots(r.slots);
      const exact = r.slots.find((s) => s.startLabel === targetHint);
      setPickedSlot(exact ?? null);
    });
    return () => {
      cancelled = true;
    };
    // startLoadingSlots is a stable transition starter and intentionally
    // excluded to avoid a re-fetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft?.localDate, draft?.localTime, serviceId]);

  if (!open || !draft) return null;

  const formattedDate = formatLocalDate(draft.localDate);
  const formattedTime = formatLocalTime(draft.localTime);

  const queryLower = clientQuery.trim().toLowerCase();
  const clientMatches = selectedClient
    ? []
    : clients.filter((c) => matchClient(c, queryLower)).slice(
        0,
        MAX_CLIENT_RESULTS,
      );
  const totalMatches = selectedClient
    ? 0
    : clients.filter((c) => matchClient(c, queryLower)).length;

  const canBook =
    !!selectedClient && !!serviceId && !!pickedSlot && !booking;

  function handleSubmit() {
    if (!selectedClient || !serviceId || !pickedSlot) return;
    setError(null);
    const fd = new FormData();
    fd.set("client_id", selectedClient.id);
    fd.set("service_id", serviceId);
    fd.set("starts_at", pickedSlot.start);
    if (notes.trim().length > 0) fd.set("notes", notes);
    const targetDate = draft!.localDate;
    startBooking(async () => {
      const r = await bookAppointmentForClientAction(fd);
      if (!r.ok) {
        setError(r.error);
        // Race-safe UX: if the booking server tells us the slot was
        // taken (or any failure), refetch slots so the picker reflects
        // current availability without reloading the page.
        const refetch = await fetchSlotsForClientBookingAction({
          serviceId,
          date: targetDate,
        });
        if (refetch.ok) {
          setSlots(refetch.slots);
          setPickedSlot(null);
        }
        return;
      }
      router.refresh();
      onClose();
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New appointment"
      className="fixed inset-0 z-50 flex items-stretch justify-end"
    >
      <button
        type="button"
        aria-label="Close drawer"
        onClick={onClose}
        className="absolute inset-0 bg-black/30 backdrop-blur-[1px]"
      />

      <div className="relative flex h-full w-full flex-col gap-5 overflow-y-auto bg-white p-6 shadow-xl dark:bg-neutral-950 sm:w-[440px]">
        <header className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wider text-neutral-500">
              New appointment
            </p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight">
              {formattedDate}
            </h2>
            <p className="mt-0.5 text-sm text-neutral-600 dark:text-neutral-400">
              clicked at {formattedTime}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-900"
          >
            Esc
          </button>
        </header>

        {/* Step 1: client */}
        <section className="flex flex-col gap-2">
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Client
          </span>
          {selectedClient ? (
            <div className="flex items-center justify-between gap-3 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700">
              <div className="min-w-0">
                <div className="truncate font-medium">{selectedClient.name}</div>
                {(selectedClient.email || selectedClient.phone) && (
                  <div className="truncate text-xs text-neutral-500">
                    {[selectedClient.email, selectedClient.phone]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelectedClient(null);
                  setClientQuery("");
                }}
                className="shrink-0 text-xs text-neutral-500 hover:underline"
              >
                Change
              </button>
            </div>
          ) : (
            <>
              <input
                type="search"
                value={clientQuery}
                onChange={(e) => setClientQuery(e.target.value)}
                placeholder="Find existing client"
                autoComplete="off"
                autoCapitalize="none"
                className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
              />
              {clientMatches.length === 0 ? (
                <p className="rounded-md border border-dashed border-neutral-300 px-3 py-3 text-xs text-neutral-500 dark:border-neutral-700">
                  No clients match.
                </p>
              ) : (
                <ul className="max-h-56 divide-y divide-neutral-200 overflow-y-auto rounded-md border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
                  {clientMatches.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedClient(c)}
                        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{c.name}</div>
                          {(c.email || c.phone) && (
                            <div className="truncate text-xs text-neutral-500">
                              {[c.email, c.phone].filter(Boolean).join(" · ")}
                            </div>
                          )}
                        </div>
                        <span className="text-xs text-neutral-400">›</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {totalMatches > clientMatches.length && (
                <p className="text-[11px] text-neutral-500">
                  Showing first {clientMatches.length} of {totalMatches}. Keep
                  typing to narrow down.
                </p>
              )}
              <p className="text-[11px] text-neutral-500">
                New clients can still be added from{" "}
                <span className="font-medium">Clients</span> for now.
              </p>
            </>
          )}
        </section>

        {/* Step 2: service */}
        <section className="flex flex-col gap-2">
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Service
          </span>
          {services.length === 0 ? (
            <p className="rounded-md border border-dashed border-neutral-300 px-3 py-3 text-xs text-neutral-500 dark:border-neutral-700">
              No active services. Add one in Settings → Services.
            </p>
          ) : (
            <select
              value={serviceId}
              onChange={(e) => setServiceId(e.target.value)}
              className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
            >
              {serviceGroups.map((group) =>
                serviceGroups.length === 1 && group.modality === null ? (
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
          )}
        </section>

        {/* Step 3: time */}
        <section className="flex flex-col gap-2">
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Available times
          </span>
          {loadingSlots ? (
            <p className="text-sm text-neutral-500">Loading slots…</p>
          ) : !serviceId ? (
            <p className="text-sm text-neutral-500">
              Pick a service to see times.
            </p>
          ) : slots.length === 0 ? (
            <p className="text-sm text-neutral-500">
              No availability on that day.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {slots.map((slot) => {
                const picked = pickedSlot?.start === slot.start;
                const isHint = slot.startLabel === draft.localTime;
                return (
                  <button
                    key={slot.start}
                    type="button"
                    onClick={() => setPickedSlot(slot)}
                    className={`rounded-md border px-3 py-1.5 text-sm transition ${
                      picked
                        ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                        : isHint
                          ? "border-neutral-500 hover:border-neutral-900 dark:border-neutral-500 dark:hover:border-white"
                          : "border-neutral-300 hover:border-neutral-500 dark:border-neutral-700"
                    }`}
                  >
                    {slot.startLabel}
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* Step 4: notes */}
        <section className="flex flex-col gap-2">
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Notes (optional)
          </span>
          <textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Anything to remember about this session?"
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
        </section>

        {error && (
          <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}

        <footer className="mt-auto flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canBook}
            className="rounded-md bg-neutral-900 px-5 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            {booking ? "Booking…" : "Book appointment"}
          </button>
        </footer>
      </div>
    </div>
  );
}
