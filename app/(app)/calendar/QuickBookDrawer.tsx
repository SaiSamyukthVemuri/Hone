"use client";

// Phase C calendar-first booking drawer.
//
// Drives an internal practitioner-side booking for an existing OR
// newly-created client. Reuses three server actions:
//   - bookAppointmentForClientAction       (./actions, unchanged)
//   - fetchSlotsForClientBookingAction     (../clients/[id]/booking-actions, unchanged)
//   - createClientForCalendarBookingAction (./actions, added in
//     Phase C — narrow authenticated insert that mirrors the
//     existing createClientAction but returns the new row instead
//     of redirecting)
//
// The drawer does not touch slot computation, conflict detection,
// reservation logic, public booking, Stripe, payment collection, or
// require_card_on_file. The new-client action uses the user-scoped
// Supabase client (RLS-enforced) — no createAdminClient. Only the
// minimal name/email/phone/pronouns fields are collected; the full
// client profile is filled in later from /clients/[id].

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Service } from "@/lib/types/database";
import {
  formatServiceLabel,
  groupServicesByModality,
} from "@/lib/booking/format";
import { utcInstantFromLocal } from "@/lib/booking/tz";
import { fetchSlotsForClientBookingAction } from "../clients/[id]/booking-actions";
import {
  bookAppointmentForClientAction,
  createClientForCalendarBookingAction,
  fetchLastServiceForClientAction,
} from "./actions";

// Rebook shortcut: a client's "last service" (lazy-fetched when an
// existing client is selected). serviceName/durationMinutes describe the
// last appointment; serviceId is validated against the active service
// list before the "Use this service" button is offered.
type LastService = {
  serviceId: string;
  serviceName: string;
  durationMinutes: number;
  lastLocalDate: string;
};

export type QuickBookDraft = {
  // YYYY-MM-DD in studio local time
  localDate: string;
  // HH:MM in studio local time, snapped to 15-minute increments
  localTime: string;
  // Optional duration in minutes, snapped to 15-minute increments,
  // produced by the click-and-drag selection in DayColumn. When
  // present, the drawer auto-enables the "Outside your regular
  // availability" override (because a custom duration cannot match
  // the service default's slot list) and pre-fills the override
  // duration input. A bare click (no drag) leaves this undefined and
  // the drawer keeps the standard slot-picker flow.
  durationMinutes?: number;
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
  // Studio IANA timezone. Required by the "Outside your regular
  // availability" override path to interpret the free-form time
  // input as studio-local before posting an ISO UTC instant. The
  // standard slot picker does not need it (slots arrive pre-built
  // with ISO start strings).
  studioTimezone: string;
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
  studioTimezone,
  onClose,
}: Props) {
  const router = useRouter();
  const serviceGroups = useMemo(
    () => groupServicesByModality(services),
    [services],
  );
  const firstServiceId = serviceGroups[0]?.services[0]?.id ?? "";

  const [clientMode, setClientMode] = useState<"search" | "new">("search");
  const [clientQuery, setClientQuery] = useState("");
  const [selectedClient, setSelectedClient] =
    useState<QuickBookClient | null>(null);
  // Clients created during this drawer session. The server-passed
  // `clients` prop only updates after a full router.refresh(), which
  // happens after booking. We merge `clients + extraClients` so a
  // freshly-created client is immediately searchable + selectable
  // without a page reload.
  const [extraClients, setExtraClients] = useState<QuickBookClient[]>([]);
  const [newClientName, setNewClientName] = useState("");
  const [newClientEmail, setNewClientEmail] = useState("");
  const [newClientPhone, setNewClientPhone] = useState("");
  const [newClientPronouns, setNewClientPronouns] = useState("");
  const [newClientError, setNewClientError] = useState<string | null>(null);
  const [creatingClient, startCreatingClient] = useTransition();
  const [serviceId, setServiceId] = useState(firstServiceId);
  const [lastService, setLastService] = useState<LastService | null>(null);
  const [loadingLastService, startLoadingLastService] = useTransition();
  const [slots, setSlots] = useState<Slot[]>([]);
  const [pickedSlot, setPickedSlot] = useState<Slot | null>(null);
  const [notes, setNotes] = useState("");
  // Override toggle. Defaults off so the standard slot flow stays
  // identical to today. When on:
  //   - the slot picker is replaced by a free-form HH:MM input that
  //     defaults to the drag-time the practitioner clicked.
  //   - a confirmation checkbox must be ticked before Save enables.
  //   - the form posts allow_outside_availability=true and a UTC
  //     instant computed from the local time + studio timezone.
  const [overrideEnabled, setOverrideEnabled] = useState(false);
  const [overrideConfirmed, setOverrideConfirmed] = useState(false);
  const [overrideLocalTime, setOverrideLocalTime] = useState<string>("");
  // Drag-derived duration (minutes). Empty string when the drawer was
  // opened by a bare click; the override duration input is hidden in
  // that case and the booking uses the service default. When the
  // practitioner drags out a range, this is pre-filled and the input
  // is shown so the duration is editable before save.
  const [overrideDurationMinutes, setOverrideDurationMinutes] =
    useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loadingSlots, startLoadingSlots] = useTransition();
  const [booking, startBooking] = useTransition();

  // Reset all drawer state whenever the drawer closes or a fresh
  // draft is shown. Keeping this in a single effect avoids a tangle
  // of "did the draft change?" checks scattered across handlers.
  useEffect(() => {
    if (!open) {
      setClientMode("search");
      setClientQuery("");
      setSelectedClient(null);
      setExtraClients([]);
      setNewClientName("");
      setNewClientEmail("");
      setNewClientPhone("");
      setNewClientPronouns("");
      setNewClientError(null);
      setServiceId(firstServiceId);
      setLastService(null);
      setSlots([]);
      setPickedSlot(null);
      setNotes("");
      setError(null);
      setOverrideEnabled(false);
      setOverrideConfirmed(false);
      setOverrideLocalTime("");
      setOverrideDurationMinutes("");
    }
  }, [open, firstServiceId]);

  // When the drawer opens (or the draft time changes), seed the
  // override time field with the time the practitioner clicked on
  // the grid. They can edit it freely before saving. Standard slot
  // flow ignores this value.
  useEffect(() => {
    if (open && draft?.localTime) {
      setOverrideLocalTime(draft.localTime);
    }
  }, [open, draft?.localTime]);

  // Drag-to-create: when the draft carries a durationMinutes value
  // (always 15-min granular from DayColumn), the override flow is
  // auto-enabled and the duration field pre-filled because a custom
  // duration cannot match the service-default slot list. The
  // confirmation checkbox is NOT pre-ticked: the practitioner must
  // explicitly acknowledge they are booking outside their published
  // availability before the Save button enables. A bare click leaves
  // both flags off and the duration field empty. Effect runs only on
  // draft identity so toggling the override checkbox manually is not
  // undone by a re-render.
  useEffect(() => {
    if (!open) return;
    const dragMinutes = draft?.durationMinutes;
    if (dragMinutes && dragMinutes > 0) {
      setOverrideDurationMinutes(String(dragMinutes));
      setOverrideEnabled(true);
      setOverrideConfirmed(false);
    } else {
      setOverrideDurationMinutes("");
    }
    // We intentionally do NOT add overrideEnabled / overrideConfirmed
    // to the deps; a user toggle off should stick until the drawer
    // closes or a new draft arrives.
  }, [open, draft?.localDate, draft?.localTime, draft?.durationMinutes]);

  // Lazy rebook lookup: fetch the selected client's last service only
  // when a client is selected (never prefetched for the whole list).
  // Brand-new inline-created clients have no history, so this returns
  // null and the rebook card stays hidden. Runs on client change only;
  // does not touch slot fetching, availability, or booking.
  useEffect(() => {
    if (!open || !selectedClient) {
      setLastService(null);
      return;
    }
    let cancelled = false;
    setLastService(null);
    const clientId = selectedClient.id;
    startLoadingLastService(async () => {
      const r = await fetchLastServiceForClientAction(clientId);
      if (cancelled) return;
      setLastService(r.ok ? r.lastService : null);
    });
    return () => {
      cancelled = true;
    };
    // startLoadingLastService is a stable transition starter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedClient?.id]);

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
      // Display-only past-time guard for the internal calendar: never offer a
      // slot whose start instant is already in the past (today's earlier
      // hours). Absolute UTC comparison on the ISO slot.start. The shared
      // slot fetcher and public booking are untouched; the server action
      // re-checks this on submit.
      const nowMs = Date.now();
      const futureSlots = r.slots.filter(
        (s) => new Date(s.start).getTime() > nowMs,
      );
      setSlots(futureSlots);
      const exact = futureSlots.find((s) => s.startLabel === targetHint);
      setPickedSlot(exact ?? null);
    });
    return () => {
      cancelled = true;
    };
    // startLoadingSlots is a stable transition starter and intentionally
    // excluded to avoid a re-fetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft?.localDate, draft?.localTime, serviceId]);

  // extraClients (created this drawer session) sort first so a
  // just-added client lands at the top of the list before the user
  // has typed anything. Hook is invoked unconditionally so its
  // call-order is stable across open/closed states.
  const allClients = useMemo(
    () => [...extraClients, ...clients],
    [extraClients, clients],
  );

  if (!open || !draft) return null;

  const formattedDate = formatLocalDate(draft.localDate);
  const formattedTime = formatLocalTime(draft.localTime);
  // Compute the end label when a drag duration is present so the
  // drawer header reads "11:00 AM to 11:45 AM" instead of just the
  // start. Pure local-clock math against the HH:MM start; no UTC.
  function addMinutesToLocalHHMM(hhmm: string, minutes: number): string {
    const [hStr, mStr] = hhmm.split(":");
    const h = Number(hStr);
    const m = Number(mStr);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
    const total = h * 60 + m + minutes;
    const wrapped = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
    const eh = Math.floor(wrapped / 60);
    const em = wrapped % 60;
    return `${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}`;
  }
  const dragDurationForHeader = draft.durationMinutes ?? null;
  const dragEndTimeLabel =
    dragDurationForHeader != null && dragDurationForHeader > 0
      ? formatLocalTime(
          addMinutesToLocalHHMM(draft.localTime, dragDurationForHeader),
        )
      : null;

  const queryLower = clientQuery.trim().toLowerCase();
  const clientMatches = selectedClient
    ? []
    : allClients.filter((c) => matchClient(c, queryLower)).slice(
        0,
        MAX_CLIENT_RESULTS,
      );
  const totalMatches = selectedClient
    ? 0
    : allClients.filter((c) => matchClient(c, queryLower)).length;

  // Save-enabled rule: standard flow needs a picked slot; override
  // flow needs a typed HH:MM AND the explicit confirmation
  // checkbox; if the duration field is shown (drag-to-create flow)
  // it must parse to a 15-min multiple in [15, 360]. Override and
  // standard cannot both be active because the slot picker is hidden
  // when overrideEnabled is true.
  const overrideTimeValid = /^\d{2}:\d{2}$/.test(overrideLocalTime);
  const parsedOverrideDuration = (() => {
    if (!overrideDurationMinutes) return null;
    const n = parseInt(overrideDurationMinutes, 10);
    if (!Number.isFinite(n)) return null;
    if (n < 15 || n > 360) return null;
    if (n % 15 !== 0) return null;
    return n;
  })();
  const overrideDurationValid =
    overrideDurationMinutes === "" || parsedOverrideDuration != null;
  const canBook = !booking && !!selectedClient && !!serviceId && (
    overrideEnabled
      ? overrideTimeValid && overrideConfirmed && overrideDurationValid
      : !!pickedSlot
  );

  function handleCreateClient() {
    const name = newClientName.trim();
    if (!name) {
      setNewClientError("Name is required.");
      return;
    }
    setNewClientError(null);
    const fd = new FormData();
    fd.set("name", name);
    if (newClientEmail.trim()) fd.set("email", newClientEmail.trim());
    if (newClientPhone.trim()) fd.set("phone", newClientPhone.trim());
    if (newClientPronouns.trim()) fd.set("pronouns", newClientPronouns.trim());
    startCreatingClient(async () => {
      const r = await createClientForCalendarBookingAction(fd);
      if (!r.ok) {
        setNewClientError(r.error);
        return;
      }
      setExtraClients((prev) => [r.client, ...prev]);
      setSelectedClient(r.client);
      setClientMode("search");
      setClientQuery("");
      setNewClientName("");
      setNewClientEmail("");
      setNewClientPhone("");
      setNewClientPronouns("");
      setNewClientError(null);
    });
  }

  function handleSubmit() {
    if (!selectedClient || !serviceId) return;
    if (overrideEnabled) {
      if (!overrideTimeValid || !overrideConfirmed) return;
    } else if (!pickedSlot) {
      return;
    }
    setError(null);
    const fd = new FormData();
    fd.set("client_id", selectedClient.id);
    fd.set("service_id", serviceId);
    if (overrideEnabled) {
      // Compute the UTC instant from the practitioner's typed time
      // interpreted in the studio's timezone. DST-safe via the
      // existing utcInstantFromLocal helper; we never use naive
      // browser-local Date math.
      const utc = utcInstantFromLocal(
        draft!.localDate,
        overrideLocalTime,
        studioTimezone,
      );
      fd.set("starts_at", utc.toISOString());
      fd.set("allow_outside_availability", "true");
      // Drag-to-create duration override (only sent when present).
      // The booking action validates the value server-side; an
      // unsupplied or empty field falls through to service default.
      if (parsedOverrideDuration != null) {
        fd.set(
          "duration_minutes_override",
          String(parsedOverrideDuration),
        );
      }
    } else {
      fd.set("starts_at", pickedSlot!.start);
    }
    if (notes.trim().length > 0) fd.set("notes", notes);
    const targetDate = draft!.localDate;
    startBooking(async () => {
      const r = await bookAppointmentForClientAction(fd);
      if (!r.ok) {
        setError(r.error);
        // Race-safe UX: if the booking server tells us the slot was
        // taken (or any failure), refetch slots so the picker reflects
        // current availability without reloading the page. Skip the
        // refetch when override was used; those slots are not the
        // source of truth for the override flow.
        if (!overrideEnabled) {
          const refetch = await fetchSlotsForClientBookingAction({
            serviceId,
            date: targetDate,
          });
          if (refetch.ok) {
            setSlots(refetch.slots);
            setPickedSlot(null);
          }
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
              {dragEndTimeLabel
                ? `${formattedTime} to ${dragEndTimeLabel} (${dragDurationForHeader} min)`
                : `clicked at ${formattedTime}`}
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
              <div
                role="tablist"
                aria-label="Client source"
                className="flex gap-1 rounded-md border border-neutral-200 bg-neutral-50 p-1 text-xs dark:border-neutral-800 dark:bg-neutral-900"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={clientMode === "search"}
                  onClick={() => setClientMode("search")}
                  className={`flex-1 rounded-[5px] px-3 py-1.5 transition ${
                    clientMode === "search"
                      ? "bg-white font-medium text-neutral-900 shadow-sm dark:bg-neutral-950 dark:text-neutral-100"
                      : "text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
                  }`}
                >
                  Search existing
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={clientMode === "new"}
                  onClick={() => setClientMode("new")}
                  className={`flex-1 rounded-[5px] px-3 py-1.5 transition ${
                    clientMode === "new"
                      ? "bg-white font-medium text-neutral-900 shadow-sm dark:bg-neutral-950 dark:text-neutral-100"
                      : "text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
                  }`}
                >
                  Add a new client
                </button>
              </div>

              {clientMode === "search" ? (
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
                      Showing first {clientMatches.length} of {totalMatches}.
                      Keep typing to narrow down.
                    </p>
                  )}
                </>
              ) : (
                <div className="flex flex-col gap-2">
                  <p className="text-[11px] text-neutral-500">
                    Create a basic client record now. You can finish their full
                    profile later.
                  </p>
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] uppercase tracking-wider text-neutral-500">
                      Name <span aria-hidden="true">*</span>
                    </span>
                    <input
                      type="text"
                      value={newClientName}
                      onChange={(e) => setNewClientName(e.target.value)}
                      placeholder="Full name"
                      autoComplete="off"
                      required
                      className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] uppercase tracking-wider text-neutral-500">
                        Email
                      </span>
                      <input
                        type="email"
                        value={newClientEmail}
                        onChange={(e) => setNewClientEmail(e.target.value)}
                        placeholder="name@example.com"
                        autoComplete="off"
                        className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] uppercase tracking-wider text-neutral-500">
                        Phone
                      </span>
                      <input
                        type="tel"
                        value={newClientPhone}
                        onChange={(e) => setNewClientPhone(e.target.value)}
                        placeholder="555-0100"
                        autoComplete="off"
                        className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
                      />
                    </label>
                  </div>
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] uppercase tracking-wider text-neutral-500">
                      Pronouns
                    </span>
                    <input
                      type="text"
                      value={newClientPronouns}
                      onChange={(e) => setNewClientPronouns(e.target.value)}
                      placeholder="she/her"
                      autoComplete="off"
                      className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
                    />
                  </label>
                  {newClientError && (
                    <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
                      {newClientError}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={handleCreateClient}
                    disabled={creatingClient || newClientName.trim().length === 0}
                    className="self-start rounded-md border border-neutral-900 bg-white px-4 py-1.5 text-sm font-medium text-neutral-900 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white dark:bg-neutral-950 dark:text-neutral-100 dark:hover:bg-neutral-900"
                  >
                    {creatingClient ? "Adding…" : "Add client"}
                  </button>
                </div>
              )}
            </>
          )}
        </section>

        {/* Step 2: service */}
        <section className="flex flex-col gap-2">
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Service
          </span>

          {/* Rebook shortcut. Only for an existing selected client with a
              last service that is still active (present in `services`).
              "Use this service" just selects it — the same path as picking
              it manually, which re-triggers slot loading. Never auto-books,
              never bypasses availability. Hidden entirely (no placeholder)
              when there's no eligible last service. */}
          {selectedClient && loadingLastService && (
            <p className="text-xs text-neutral-500">Loading last service…</p>
          )}
          {selectedClient &&
            !loadingLastService &&
            lastService &&
            services.some((s) => s.id === lastService.serviceId) && (
              <div className="flex flex-col gap-1.5 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2.5 dark:border-neutral-800 dark:bg-neutral-900">
                <p className="text-xs font-medium text-neutral-800 dark:text-neutral-200">
                  Rebook last service?
                </p>
                <p className="text-xs text-neutral-600 dark:text-neutral-400">
                  Last time: {lastService.durationMinutes} min{" "}
                  {lastService.serviceName} ·{" "}
                  {formatLocalDate(lastService.lastLocalDate)}
                </p>
                <button
                  type="button"
                  onClick={() => setServiceId(lastService.serviceId)}
                  className="self-start rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-white dark:border-neutral-700 dark:hover:bg-neutral-900"
                >
                  Use this service
                </button>
              </div>
            )}

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
          {/* Override toggle. Default off; when on, the slot picker
              hides and a free-form time field appears below with a
              confirmation checkbox. Public booking does not have or
              read this flag. */}
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-neutral-200 p-3 text-xs dark:border-neutral-800">
            <input
              type="checkbox"
              checked={overrideEnabled}
              onChange={(e) => {
                setOverrideEnabled(e.target.checked);
                if (!e.target.checked) {
                  setOverrideConfirmed(false);
                }
              }}
              className="mt-0.5 h-4 w-4 flex-none rounded border-neutral-400"
            />
            <span>
              <span className="font-medium">
                Outside your regular availability
              </span>
              <span className="block text-neutral-500">
                Book at a time outside your published hours. Public booking
                stays unchanged.
              </span>
            </span>
          </label>

          {overrideEnabled ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-3">
                <label className="flex flex-col gap-1">
                  <span
                    className="text-xs text-neutral-600 dark:text-neutral-400"
                    id="override-time-label"
                  >
                    Start (studio local)
                  </span>
                  <input
                    id="override-time"
                    aria-labelledby="override-time-label"
                    type="time"
                    step={900}
                    value={overrideLocalTime}
                    onChange={(e) => setOverrideLocalTime(e.target.value)}
                    className="w-40 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
                  />
                </label>
                {overrideDurationMinutes !== "" && (
                  <label className="flex flex-col gap-1">
                    <span
                      className="text-xs text-neutral-600 dark:text-neutral-400"
                      id="override-duration-label"
                    >
                      Duration (minutes)
                    </span>
                    <input
                      id="override-duration"
                      aria-labelledby="override-duration-label"
                      type="number"
                      min={15}
                      max={360}
                      step={15}
                      value={overrideDurationMinutes}
                      onChange={(e) =>
                        setOverrideDurationMinutes(e.target.value)
                      }
                      className="w-28 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
                    />
                  </label>
                )}
              </div>
              {overrideDurationMinutes !== "" && !overrideDurationValid && (
                <p className="text-[11px] text-red-700 dark:text-red-400">
                  Duration must be a 15-minute multiple between 15 and 360.
                </p>
              )}
              {/* Drag-to-book explanatory line. Renders only when the
                  drawer was opened via drag (overrideDurationMinutes
                  is pre-filled). Tells the practitioner why the
                  override path lit up and what they need to do next.
                  Manual override (checkbox clicked, no drag) keeps the
                  shorter amber warning below as its sole explanation. */}
              {overrideDurationMinutes !== "" && (
                <p className="text-[11px] text-neutral-600 dark:text-neutral-400">
                  This custom duration uses the internal override. Confirm
                  before booking.
                </p>
              )}
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
                This appointment will be booked outside your published
                availability. Public booking remains unchanged.
              </div>
              <label className="flex items-start gap-2 text-xs text-neutral-700 dark:text-neutral-300">
                <input
                  type="checkbox"
                  checked={overrideConfirmed}
                  onChange={(e) => setOverrideConfirmed(e.target.checked)}
                  className="mt-0.5 h-4 w-4 flex-none rounded border-neutral-400"
                />
                <span>
                  I understand this is outside my normal availability.
                </span>
              </label>
            </div>
          ) : loadingSlots ? (
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
