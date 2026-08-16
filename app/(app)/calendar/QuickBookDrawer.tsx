"use client";

// Phase C calendar-first booking drawer.
//
// Drives an internal practitioner-side booking for an existing OR
// newly-created client. Reuses three server actions:
//   - bookAppointmentForClientAction       (./actions, unchanged)
//   - fetchSlotsForClientBookingAction     (../clients/[id]/booking-actions, unchanged)
//   - createClientForCalendarBookingAction (./actions, added in
//     Phase C: narrow authenticated insert that mirrors the
//     existing createClientAction but returns the new row instead
//     of redirecting)
//
// The drawer does not touch slot computation, conflict detection,
// reservation logic, public booking, Stripe, payment collection, or
// require_card_on_file. The new-client action uses the user-scoped
// Supabase client (RLS-enforced), no createAdminClient. Only the
// minimal name/email/phone/pronouns fields are collected; the full
// client profile is filled in later from /clients/[id].

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Service } from "@/lib/types/database";
import {
  formatServiceLabel,
  groupServicesByModality,
} from "@/lib/booking/format";
import {
  utcInstantFromLocal,
  formatClockLabel,
  type TimeFormat,
} from "@/lib/booking/tz";
import {
  decideManualTime,
  type AvailabilityWindow,
} from "@/lib/booking/availability-window";
import {
  fetchSlotsForClientBookingAction,
  fetchEligiblePractitionersAction,
  type EligiblePractitioner,
} from "../clients/[id]/booking-actions";
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
  // Studio 12h/24h preference (migration 0109). Formats the DISPLAYED header
  // time only; localTime stays a 24h HH:MM machine value used for submission.
  timeFormat: TimeFormat;
  // Part 4 Item 6: practitioner capacity. When ON + owner, a practitioner
  // selector is shown and drives target-specific slots + assignment. Identical
  // targeting rules on desktop (DayColumn) and mobile (CalendarMobileDayView).
  practitionerCapacityEnabled: boolean;
  isOwner: boolean;
  currentPractitionerId: string;
  currentPractitionerName: string;
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


export function QuickBookDrawer({
  open,
  draft,
  clients,
  services,
  studioTimezone,
  timeFormat,
  practitionerCapacityEnabled,
  isOwner,
  currentPractitionerId,
  currentPractitionerName,
  onClose,
}: Props) {
  const router = useRouter();
  const serviceGroups = useMemo(
    () => groupServicesByModality(services),
    [services],
  );
  const firstServiceId = serviceGroups[0]?.services[0]?.id ?? "";

  // Item 6: owner practitioner selector (same rules as the client-profile
  // surface). Shown ONLY when capacity is ON and the actor is an owner; members
  // and Legacy studios always book the acting practitioner.
  const showSelector = practitionerCapacityEnabled && isOwner;
  const [eligible, setEligible] = useState<EligiblePractitioner[]>([]);
  const [eligibleError, setEligibleError] = useState<string | null>(null);
  const [target, setTarget] = useState<string>(currentPractitionerId);
  const [loadingPractitioners, startLoadingPractitioners] = useTransition();
  const eligibleReq = useRef(0);
  // Default-target rule (identical to BookAppointment): preserve a still-eligible
  // selection → else the current owner when eligible → else the first eligible.
  function resolveDefaultTarget(list: EligiblePractitioner[], current: string): string {
    if (list.some((p) => p.id === current)) return current;
    if (list.some((p) => p.id === currentPractitionerId)) return currentPractitionerId;
    return list[0]?.id ?? "";
  }

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
  // "Choose another time". Defaults off so the suggestion flow stays identical.
  // When on, the suggestion list is replaced by a free-form HH:MM input seeded
  // with the time the practitioner clicked.
  //
  // Turning this on is NOT, by itself, an availability override. What the typed
  // time IS gets decided against the real working-hours window (below):
  //
  //   inside the window  -> an ordinary booking. No warning, no acknowledgement,
  //                         and allow_outside_availability is NOT posted.
  //   outside the window -> the existing owner-only outside-hours path, with its
  //                         warning and its explicit acknowledgement.
  //
  // Before this split there was only the second branch, so deliberately picking
  // 15:30 on a 09:00-17:00 day made a practitioner assert something false and
  // recorded the booking as an out-of-hours exception.
  const [manualTimeEnabled, setManualTimeEnabled] = useState(false);
  const [outsideHoursConfirmed, setOutsideHoursConfirmed] = useState(false);
  const [manualLocalTime, setManualLocalTime] = useState<string>("");
  // THE BUFFER OVERRIDE, offered only in response to the server refusing.
  // Same contract as the client-profile Book form: the soft buffer (0152) is
  // not an availability fact and cannot be decided from the window, so the
  // database is the one that says `buffer_conflict`. Reaching a buffer-proximate
  // time is a real capability -- the suggestion list hides those times by
  // design, so the override is the only route -- and it is offered AFTER the
  // refusal so the flag stays a deliberate opt-in with a reason on screen.
  //
  // BOUND TO ONE CANDIDATE, not held as a standing permission. The offer stores
  // the IDENTITY of the booking it was issued for, so picking a different slot,
  // time, service, target or drag length revokes it automatically. Requiring
  // every mutation site to remember a clear() is how this leaked the first
  // time: approving a buffer conflict for slot A and then choosing slot B kept
  // the approval and posted allow_outside_availability for a booking the server
  // had never refused.
  const [bufferOverrideFor, setBufferOverrideFor] = useState<string | null>(null);
  const [bufferOverrideConfirmed, setBufferOverrideConfirmed] = useState(false);
  function clearBufferOverride() {
    setBufferOverrideFor(null);
    setBufferOverrideConfirmed(false);
  }
  // The REAL availability window for the loaded (service, date, target),
  // resolved server-side and returned alongside the suggestions. null until the
  // first successful load, cleared before every refetch, and reset on every
  // failure -- so an unknown window is never mistaken for an open one, and a
  // window belonging to a previous target/date is never reused for a new one.
  // While it is null the manual path is blocked outright rather than routed
  // through the outside-hours override; see the note on ManualTimeDecision.
  const [availabilityWindow, setAvailabilityWindow] =
    useState<AvailabilityWindow | null>(null);
  // Drag-derived duration (minutes). Empty string when the drawer was
  // opened by a bare click; the override duration input is hidden in
  // that case and the booking uses the service default. When the
  // practitioner drags out a range, this is pre-filled and the input
  // is shown so the duration is editable before save.
  const [manualDurationMinutes, setManualDurationMinutes] =
    useState<string>("");
  // Soft-vs-explicit override tracking (PR #128). A drag-opened drawer
  // auto-enables the override path because a custom drag duration
  // cannot be matched against the standard service-default slot list
  // up front. That auto-enable is a HINT, not the practitioner's
  // intent: when the picked service has an exact standard slot at the
  // drag's start time (Part 1), or when the practitioner picks a
  // different service after the drag (Part 2), the soft override
  // should drop back to standard mode and use the service duration.
  // Any explicit interaction with the override controls (toggle the
  // checkbox, edit the start time, edit the duration field, or tick
  // the confirmation) promotes the override to "explicit" so the
  // drop-out logic stops touching it. Ref-backed so the slot-fetch
  // effect can read the current value without re-running on toggles.
  const autoManualTimeRef = useRef(false);
  function markManualTimeExplicit() {
    autoManualTimeRef.current = false;
  }
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
      setEligible([]);
      setEligibleError(null);
      setTarget(currentPractitionerId);
      setManualTimeEnabled(false);
      setOutsideHoursConfirmed(false);
      setManualLocalTime("");
      clearBufferOverride();
      setManualDurationMinutes("");
      autoManualTimeRef.current = false;
    }
  }, [open, firstServiceId, currentPractitionerId]);

  // When the drawer opens (or the draft time changes), seed the
  // override time field with the time the practitioner clicked on
  // the grid. They can edit it freely before saving. Standard slot
  // flow ignores this value.
  useEffect(() => {
    if (open && draft?.localTime) {
      setManualLocalTime(draft.localTime);
    }
  }, [open, draft?.localTime]);

  // Drag-to-create: when the draft carries a durationMinutes value (always
  // 15-min granular from DayColumn) the manual-time flow is soft-enabled and
  // the duration field pre-filled, because a dragged length cannot be matched
  // against the service-default suggestion list up front.
  //
  // Soft-enabling the manual TIME is no longer the same thing as asserting the
  // booking is outside availability: the drag start is classified against the
  // real window like any other manual time, so a drag inside working hours books
  // calmly. What still forces the override is a genuinely CUSTOM LENGTH, which
  // is owner-only in the database and out of scope to change here.
  //
  // autoManualTimeRef tracks that the enable was a drag hint, not the
  // practitioner's choice; the slot-fetch effect and the service-change effect
  // (PR #128) can drop back out when a suggestion covers the same start time or
  // when the picked service implies a different duration. The acknowledgement is
  // never pre-ticked. A bare click leaves both flags off and the duration field
  // empty. Effect runs only on draft identity so toggling the manual-time
  // checkbox by hand is not undone by a re-render.
  useEffect(() => {
    if (!open) return;
    const dragMinutes = draft?.durationMinutes;
    if (dragMinutes && dragMinutes > 0) {
      setManualDurationMinutes(String(dragMinutes));
      setManualTimeEnabled(true);
      setOutsideHoursConfirmed(false);
      clearBufferOverride();
      autoManualTimeRef.current = true;
    } else {
      // Bare click on a NEW slot: the outside-availability override must start
      // OFF for each new booking attempt. It is never sticky across slots
      // (Chloe feedback). A drag soft-enables above; a plain click resets.
      setManualDurationMinutes("");
      setManualTimeEnabled(false);
      setOutsideHoursConfirmed(false);
      autoManualTimeRef.current = false;
      clearBufferOverride();
    }
    // This effect keys on the DRAFT identity, so a new slot always resets the
    // override above. Within the SAME draft it does not re-fire, so a manual
    // override toggle sticks until the slot changes or the drawer closes: we
    // intentionally do NOT add manualTimeEnabled / outsideHoursConfirmed to the deps.
  }, [open, draft?.localDate, draft?.localTime, draft?.durationMinutes]);

  // A dragged length that EQUALS the service default is not a custom length.
  // Dropping the hint here is what lets an ordinary drag -- say 15:30 to 16:30
  // for a 60-minute service, inside working hours -- book calmly instead of
  // being pushed through the owner-only override for a length that is not
  // actually custom. Only fires while the manual-time state is still the drag's
  // soft hint; an explicitly typed duration is left alone.
  const draftDragMinutes = draft?.durationMinutes;
  useEffect(() => {
    if (!open) return;
    if (!autoManualTimeRef.current) return;
    if (!draftDragMinutes || draftDragMinutes <= 0) return;
    const svc = services.find((s) => s.id === serviceId);
    if (svc && svc.default_duration_minutes === draftDragMinutes) {
      setManualDurationMinutes("");
    }
  }, [open, draftDragMinutes, serviceId, services]);

  // Service change after a drag (PR #128, Part 2). A drag of 105 min
  // followed by picking a 60-minute service should book at the
  // service duration, not at 105 minutes. When the soft override is
  // still active (autoManualTimeRef.current) and the practitioner
  // changes serviceId, we drop the drag-derived duration hint so the
  // service default takes over. The slot-fetch effect below will then
  // re-evaluate against the new service and, if a standard slot
  // exists at the drag start time, drop out of override entirely.
  // Practitioner can still type a custom duration; once they do, the
  // explicit-promote in the input onChange disables this snap.
  useEffect(() => {
    if (!open) return;
    if (autoManualTimeRef.current) {
      setManualDurationMinutes("");
    }
    // Intentionally deps on serviceId only (plus open as a render
    // gate); the snap should fire when the practitioner picks a
    // different service, not on every override-mode toggle.
  }, [open, serviceId]);

  // Item 6: load the eligible practitioners for the selected service (owner +
  // capacity ON only). Resolves the default target; FAILS CLOSED: a lookup
  // error or an empty list leaves target "" so the slot effect below does not
  // fetch and booking is blocked (never a silent self-slot fallback).
  // Latest-request-wins: a stale service response cannot overwrite a newer one.
  useEffect(() => {
    if (!open || !showSelector || !serviceId) return;
    const req = ++eligibleReq.current;
    setEligibleError(null);
    startLoadingPractitioners(async () => {
      const r = await fetchEligiblePractitionersAction(serviceId);
      if (req !== eligibleReq.current) return; // stale service response
      if (!r.ok) {
        setEligibleError(r.error);
        setEligible([]);
        setTarget("");
        return;
      }
      setEligible(r.practitioners);
      setTarget((prev) => resolveDefaultTarget(r.practitioners, prev));
    });
    // resolveDefaultTarget + startLoadingPractitioners are stable; excluded to
    // avoid re-fetching the eligible list on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, showSelector, serviceId]);

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

  // Fetch the suggestions AND the real availability window whenever
  // (serviceId, draft.localDate, target) changes. The clicked time is only a
  // hint: it is preselected when a suggestion falls on exactly that instant,
  // otherwise the practitioner picks a suggestion or chooses their own time.
  useEffect(() => {
    // Fail closed: when the owner selector is shown but no eligible target is
    // resolved (empty/failed lookup), do NOT fetch self slots as a fallback.
    if (!open || !draft || !serviceId || (showSelector && !target)) {
      setSlots([]);
      setPickedSlot(null);
      setAvailabilityWindow(null);
      return;
    }
    let cancelled = false;
    const targetDate = draft.localDate;
    const targetHint = draft.localTime;
    // DROP THE PREVIOUS WINDOW BEFORE REFETCHING.
    //
    // The window belongs to a specific (studio, target, date). Changing the
    // practitioner re-runs this effect, and holding the OLD target's window
    // while the new one is in flight would let the drawer classify a time
    // against a practitioner it is no longer booking. If the old window said
    // "closed" and the new target actually works then, the drawer would show
    // the outside-hours warning and post allow_outside_availability for an
    // ordinary working time -- the original defect, re-entered through stale
    // state. Unknown is the honest value here; the manual path is blocked
    // until the real window lands.
    setAvailabilityWindow(null);
    // A new (service, date, target) is a different booking; a buffer refusal
    // for the previous one says nothing about it.
    clearBufferOverride();
    startLoadingSlots(async () => {
      const r = await fetchSlotsForClientBookingAction({
        serviceId,
        date: targetDate,
        // Item 6: the EXACT target drives the slots. Changing target re-runs this
        // effect (cleanup cancels the old response), so an A slot is never treated
        // as valid for B and the picked time is recomputed for the new target.
        practitionerId: showSelector ? target : undefined,
      });
      if (cancelled) return;
      if (!r.ok) {
        setError(r.error);
        setSlots([]);
        setPickedSlot(null);
        // An unknown window must never read as an open one -- and equally must
        // never read as an out-of-hours one. A failed load leaves it null, and
        // null BLOCKS the manual path rather than routing it through the owner
        // override: routing it there would post allow_outside_availability for
        // a time that may well be inside working hours, which is the very
        // defect this split exists to remove.
        setAvailabilityWindow(null);
        return;
      }
      setError(null);
      setAvailabilityWindow(r.window);
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
      // Match on the INSTANT, not on the rendered label.
      //
      // This compared `slot.startLabel === targetHint`, and those two values are
      // in different formats and always have been: startLabel is the 12-hour
      // client-facing label from localTimeString12h ("3:10 PM") while
      // draft.localTime is the 24-hour machine value from the calendar grid
      // ("15:10"). The comparison could therefore never be true for any input,
      // which silently disabled three things: the clicked time was never
      // preselected even when an exact suggestion existed, the highlight below
      // never rendered, and the PR #128 drag drop-out immediately after this
      // could never fire -- so every drag stayed on the override path and showed
      // the outside-availability warning even when the drag landed exactly on a
      // suggestion. Comparing the UTC instants removes the format question
      // entirely.
      const hintMs = utcInstantFromLocal(
        targetDate,
        targetHint,
        studioTimezone,
      ).getTime();
      const exact = futureSlots.find(
        (s) => new Date(s.start).getTime() === hintMs,
      );
      // PR #128 Part 1. If the picked service has an exact-match suggestion at
      // the drag's start time AND the manual path was only soft-enabled by the
      // drag (not explicitly chosen by the practitioner), drop back to the
      // suggestion flow and preselect that slot: drag 12:00 to 1:45, then pick a
      // 60-min service whose 12:00 suggestion is inside availability, and the
      // drawer books the suggestion at the service duration. An explicit choice,
      // or a drag with no matching suggestion, is untouched.
      if (exact && autoManualTimeRef.current) {
        setManualTimeEnabled(false);
        setOutsideHoursConfirmed(false);
        setManualDurationMinutes("");
        autoManualTimeRef.current = false;
      }
      setPickedSlot(exact ?? null);
    });
    return () => {
      cancelled = true;
    };
    // startLoadingSlots is a stable transition starter and intentionally
    // excluded to avoid a re-fetch on every render. target/showSelector are in
    // the deps so changing the practitioner refetches target-specific slots.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft?.localDate, draft?.localTime, serviceId, showSelector, target]);

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
  const formattedTime = formatClockLabel(draft.localTime, timeFormat);
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
      ? formatClockLabel(
          addMinutesToLocalHHMM(draft.localTime, dragDurationForHeader),
          timeFormat,
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

  // Save-enabled rule: the suggestion flow needs a picked slot; the manual flow
  // needs a typed HH:MM, a valid duration if the field is shown (drag-to-create),
  // and -- ONLY when the chosen time genuinely needs the outside-hours override
  // -- the explicit acknowledgement. Manual and suggestion flows cannot both be
  // active because the picker is hidden when manualTimeEnabled is true.
  const parsedManualDuration = (() => {
    if (!manualDurationMinutes) return null;
    const n = parseInt(manualDurationMinutes, 10);
    if (!Number.isFinite(n)) return null;
    if (n < 15 || n > 360) return null;
    if (n % 15 !== 0) return null;
    return n;
  })();
  const manualDurationValid =
    manualDurationMinutes === "" || parsedManualDuration != null;

  // WHAT THE TYPED TIME ACTUALLY IS, via the ONE shared decision function.
  //
  // decideManualTime wraps classifyAgainstWindow -- the same pure predicate the
  // booking action applies server-side before it accepts anything -- and is
  // shared with the client-profile Book form, so the two internal surfaces
  // cannot drift into different laws again.
  //
  // The verdict decides COPY ONLY. The server re-resolves the window itself and
  // is the authority; nothing here is sent back as a claim.
  const selectedService = services.find((s) => s.id === serviceId) ?? null;
  const manualDecision = decideManualTime({
    window: availabilityWindow,
    // The date and zone are required so the END is derived from the real UTC
    // instant, exactly as the database derives it. Wall-clock addition
    // disagreed with the validator by an hour on DST-transition days.
    localDate: draft.localDate,
    localTime: manualLocalTime,
    timezone: studioTimezone,
    serviceDurationMinutes: selectedService?.default_duration_minutes ?? null,
    customDurationMinutes: parsedManualDuration,
  });
  // The FACTUAL reason an override is required, which is not the same question
  // as whether one is required. Copy must follow this, never the boolean.
  const manualOverrideReason = manualDecision.overrideReason;
  const manualTimeValid = manualDecision.timeValid;
  // Whether the real window actually loaded. Until it has, nothing may be
  // asserted about the typed time -- see the note on ManualTimeDecision.
  const windowKnown = manualDecision.windowKnown;
  const requiresOutsideOverride =
    manualTimeEnabled && manualDecision.requiresOutsideOverride;

  // Item 6: when the owner selector is shown, the current target MUST be a
  // resolved eligible practitioner (fail closed: empty/failed lookup → "").
  const targetValid = !showSelector || eligible.some((p) => p.id === target);
  // The practitioner this booking assigns (for the "With <name>" line).
  const assignedName = showSelector
    ? (eligible.find((p) => p.id === target)?.displayName ?? "")
    : currentPractitionerName;
  // WHICH APPOINTMENT IS ON SCREEN, as one comparable identity: the exact
  // instant, the service, the assigned practitioner, and the drag length when
  // there is one. A buffer approval is scoped to this and nothing else.
  const candidateStartsAt = manualTimeEnabled
    ? manualTimeValid
      ? utcInstantFromLocal(draft.localDate, manualLocalTime, studioTimezone).toISOString()
      : null
    : (pickedSlot?.start ?? null);
  const candidateKey =
    candidateStartsAt && serviceId
      ? `${serviceId}|${showSelector ? target : currentPractitionerId}|${candidateStartsAt}|${parsedManualDuration ?? ""}`
      : null;
  // Derived, never stored: the approval applies only while the candidate it was
  // issued for is still the one being booked.
  const bufferOverrideOffered =
    bufferOverrideFor !== null && bufferOverrideFor === candidateKey;

  // The flag is posted for EITHER reason the server accepts it for: a time
  // genuinely outside working hours, or an owner deliberately overriding the
  // soft buffer after the database refused. Both are explicit; neither fires
  // on its own.
  const postsOutsideAvailability =
    requiresOutsideOverride || (bufferOverrideOffered && bufferOverrideConfirmed);
  const canBook = !booking && !!selectedClient && !!serviceId && targetValid &&
    // An outstanding buffer refusal blocks re-submission until the owner
    // acknowledges it; re-submitting unchanged would just be refused again.
    (!bufferOverrideOffered || (isOwner && bufferOverrideConfirmed)) && (
    manualTimeEnabled
      ? // An unknown window blocks the manual path outright rather than
        // routing it through the override. Booking here would either wave a
        // time through unchecked or, worse, record an in-hours appointment as
        // an out-of-hours exception.
        windowKnown &&
        manualTimeValid &&
        manualDurationValid &&
        (!requiresOutsideOverride || outsideHoursConfirmed)
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
    // Item 6: an owner selector with no resolved eligible target blocks booking.
    if (showSelector && !eligible.some((p) => p.id === target)) return;
    // An outstanding buffer refusal must be acknowledged by an owner before a
    // re-submit; the button is a hint, this is the gate.
    if (bufferOverrideOffered && !(isOwner && bufferOverrideConfirmed)) return;
    if (manualTimeEnabled) {
      if (!manualTimeValid) return;
      // No window, no submission. allow_outside_availability below is an
      // assertion the database keeps forever; it may only be made against a
      // window that actually loaded.
      if (!windowKnown) return;
      // The acknowledgement is required ONLY for a time that genuinely needs the
      // outside-hours override. An ordinary working time is not asked to confirm
      // something untrue.
      if (requiresOutsideOverride && !outsideHoursConfirmed) return;
    } else if (!pickedSlot) {
      return;
    }
    setError(null);
    const fd = new FormData();
    fd.set("client_id", selectedClient.id);
    fd.set("service_id", serviceId);
    // Item 6: an owner (capacity ON) assigns the selected target on BOTH the
    // normal-slot and outside-hours paths; the server re-validates it. Members /
    // Legacy send none → the server books the acting practitioner.
    if (showSelector && target) fd.set("practitioner_id", target);
    if (manualTimeEnabled) {
      // Compute the UTC instant from the practitioner's typed time
      // interpreted in the studio's timezone. DST-safe via the
      // existing utcInstantFromLocal helper; we never use naive
      // browser-local Date math.
      const utc = utcInstantFromLocal(
        draft!.localDate,
        manualLocalTime,
        studioTimezone,
      );
      fd.set("starts_at", utc.toISOString());
      // THE FLAG IS POSTED ONLY WHEN IT IS TRUE.
      //
      // allow_outside_availability is not a UI mode, it is an assertion about
      // the world that the database persists: booked_outside_availability on the
      // appointment row, an outside_availability entry in the audit record, an
      // authorising owner stamped alongside it (0174), and the buffer trigger
      // permanently disabled for that appointment (0152). Sending it for a time
      // the practitioner genuinely works would file an ordinary booking as an
      // out-of-hours exception forever.
      //
      // The server does not take our word for it either: it re-resolves the
      // window itself and refuses an out-of-hours time that arrives without the
      // flag. This decides what we ASK for, never what is allowed.
      // Drag-to-create custom length. Only ever sent alongside the flag,
      // because the server (and the DB command) refuse a custom duration
      // without it, and a custom length is owner-only. A custom length always
      // forces requiresOutsideOverride, so the flag below is guaranteed set.
      if (requiresOutsideOverride && parsedManualDuration != null) {
        fd.set("duration_minutes_override", String(parsedManualDuration));
      }
    } else {
      fd.set("starts_at", pickedSlot!.start);
    }
    // ONE posting site, covering both acknowledged reasons. It sits outside the
    // manual/suggestion branch because a suggested slot can hit the buffer too
    // if it went stale between fetch and submit.
    if (postsOutsideAvailability) {
      fd.set("allow_outside_availability", "true");
    }
    if (notes.trim().length > 0) fd.set("notes", notes);
    const targetDate = draft!.localDate;
    startBooking(async () => {
      const r = await bookAppointmentForClientAction(fd);
      if (!r.ok) {
        setError(r.error);
        if (r.code === "buffer_conflict") {
          // Scope the offer to the candidate that was actually refused.
          // THE ONE REFUSAL AN OWNER MAY ACT ON. Offer the override instead of
          // resetting: wiping the manual time here would throw away the very
          // time they are being asked about, leaving no way to accept the
          // offer. The acknowledgement is never pre-ticked, and the reset below
          // still applies to every other failure.
          setBufferOverrideFor(candidateKey);
          setBufferOverrideConfirmed(false);
          return;
        }
        clearBufferOverride();
        // A failed attempt must NOT leave the outside-availability override
        // stuck on for the next attempt (Chloe feedback). Reset it off; the
        // practitioner must explicitly re-check it to retry outside
        // availability. The error copy stays visible so the reason is clear.
        setManualTimeEnabled(false);
        setOutsideHoursConfirmed(false);
        autoManualTimeRef.current = false;
        // Race-safe UX: if the booking server tells us the slot was
        // taken (or any failure), refetch slots so the picker reflects
        // current availability without reloading the page. Skip the
        // refetch when override was used; those slots are not the
        // source of truth for the override flow.
        if (!manualTimeEnabled) {
          const refetch = await fetchSlotsForClientBookingAction({
            serviceId,
            date: targetDate,
            // The failure refetch stays scoped to the CURRENT target.
            practitionerId: showSelector ? target : undefined,
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
              "Use this service" just selects it: the same path as picking
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

        {/* Item 6: owner practitioner selector: active, service-eligible,
            same-studio practitioners only (display names only, ids never shown).
            Changing the target re-runs the slot effect for that practitioner. */}
        {showSelector && (
          <section className="flex flex-col gap-2">
            <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
              Practitioner
            </span>
            {loadingPractitioners ? (
              <p className="text-sm text-neutral-500">Loading practitioners…</p>
            ) : eligibleError ? (
              <p className="text-sm text-red-600 dark:text-red-400">{eligibleError}</p>
            ) : eligible.length === 0 ? (
              <p className="text-sm text-neutral-500">
                No practitioner is set up for this service.
              </p>
            ) : (
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                aria-label="Practitioner"
                className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
              >
                {eligible.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            )}
          </section>
        )}

        {/* Step 3: time */}
        <section className="flex flex-col gap-2">
          {/* SUGGESTED, not "available". This list is a deliberately packed
              subset of the times that are legal to book -- opening edge, the
              boundary either side of each existing reservation, an hourly
              fallback, the closing edge. Calling it "Available times" told the
              practitioner that everything else was unavailable, which is what
              sent an ordinary 15:30 down the outside-hours path. */}
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Suggested times
          </span>
          {/* Choose another time. Default off; when on, the suggestion list
              hides and a free-form time field appears. This is NOT an
              availability override on its own -- what the typed time IS gets
              decided below against the real working-hours window. Public
              booking has neither this control nor the flag. */}
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-neutral-200 p-3 text-xs dark:border-neutral-800">
            <input
              type="checkbox"
              checked={manualTimeEnabled}
              onChange={(e) => {
                setManualTimeEnabled(e.target.checked);
                if (!e.target.checked) {
                  setOutsideHoursConfirmed(false);
                }
                // Explicit toggle (either direction) means the
                // practitioner owns the manual-time state from here on.
                // The soft-drag drop-out logic stops touching it.
                markManualTimeExplicit();
              }}
              className="mt-0.5 h-4 w-4 flex-none rounded border-neutral-400"
            />
            <span>
              <span className="font-medium">Choose another time</span>
              <span className="block text-neutral-500">
                Book any time you are working, not just the suggestions.
              </span>
            </span>
          </label>

          {manualTimeEnabled ? (
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
                    value={manualLocalTime}
                    onChange={(e) => {
                      setManualLocalTime(e.target.value);
                      clearBufferOverride();
                      markManualTimeExplicit();
                    }}
                    className="w-40 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
                  />
                </label>
                {manualDurationMinutes !== "" && (
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
                      value={manualDurationMinutes}
                      onChange={(e) => {
                        setManualDurationMinutes(e.target.value);
                        clearBufferOverride();
                        markManualTimeExplicit();
                      }}
                      className="w-28 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
                    />
                  </label>
                )}
              </div>
              {manualDurationMinutes !== "" && !manualDurationValid && (
                <p className="text-[11px] text-red-700 dark:text-red-400">
                  Duration must be a 15-minute multiple between 15 and 360.
                </p>
              )}
              {/* Drag-to-book explanatory line. Renders only when the drawer
                  was opened via drag (manualDurationMinutes is pre-filled) AND
                  that custom length is what forces the override path. A custom
                  length is owner-only in the database, so this stays as-is. */}
              {/* THE WARNING IS CONDITIONAL NOW.
                  It renders only when the chosen time genuinely needs the
                  outside-hours override. A time inside the practitioner's real
                  working hours gets the calm confirmation line instead: no
                  amber, no acknowledgement, and no allow_outside_availability
                  on submit.

                  An UNKNOWN window is neither of those, and neither is an
                  EMPTY time field. decideManualTime reports
                  requiresOutsideOverride for both because it fails closed --
                  the right answer for "may this be booked?" and the wrong one
                  for "what is this time?". Rendering the amber off it told the
                  practitioner a blank field was outside their availability and
                  offered an acknowledgement for no time at all. Save is already
                  blocked in both states (canBook requires windowKnown AND
                  manualTimeValid), so this is purely about not claiming
                  something untrue. */}
              {!windowKnown ? (
                <p className="text-xs text-neutral-600 dark:text-neutral-400">
                  {loadingSlots
                    ? "Checking your working hours…"
                    : !serviceId
                      ? "Pick a service to check this time against your working hours."
                      : "Could not load your working hours, so this time cannot be checked. Refresh and try again."}
                </p>
              ) : !manualTimeValid ? null : requiresOutsideOverride ? (
                <>
                  <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
                    {manualOverrideReason === "practitioner_closed"
                      ? "You are not working on this day. Booking here needs the outside-hours override, and public booking remains unchanged."
                      : manualOverrideReason === "custom_duration"
                        ? "That time is inside your working hours, but a custom appointment length needs an exception. Public booking remains unchanged."
                        : "This appointment will be booked outside your published availability. Public booking remains unchanged."}
                  </div>
                  <label className="flex items-start gap-2 text-xs text-neutral-700 dark:text-neutral-300">
                    <input
                      type="checkbox"
                      checked={outsideHoursConfirmed}
                      onChange={(e) => {
                        setOutsideHoursConfirmed(e.target.checked);
                        markManualTimeExplicit();
                      }}
                      className="mt-0.5 h-4 w-4 flex-none rounded border-neutral-400"
                    />
                    <span>
                      {manualOverrideReason === "custom_duration"
                        ? "I confirm this custom length needs an exception."
                        : "I understand this is outside my normal availability."}
                    </span>
                  </label>
                </>
              ) : (
                // manualTimeValid is already guaranteed by the branch above.
                <p className="text-xs text-neutral-600 dark:text-neutral-400">
                  {formatClockLabel(manualLocalTime, timeFormat)} is inside your
                  working hours. Booking normally.
                </p>
              )}
            </div>
          ) : loadingSlots ? (
            <p className="text-sm text-neutral-500">Loading slots…</p>
          ) : !serviceId ? (
            <p className="text-sm text-neutral-500">
              Pick a service to see times.
            </p>
          ) : slots.length === 0 ? (
            <p className="text-sm text-neutral-500">
              No suggested times on that day. Use “Choose another time” to book
              a time you are working.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {slots.map((slot) => {
                const picked = pickedSlot?.start === slot.start;
                // The clicked-grid highlight, matched on the INSTANT. It used to
                // compare a 12-hour label against a 24-hour machine value, so it
                // never rendered. See the preselect note in the fetch effect.
                const isHint =
                  new Date(slot.start).getTime() ===
                  utcInstantFromLocal(
                    draft.localDate,
                    draft.localTime,
                    studioTimezone,
                  ).getTime();
                return (
                  <button
                    key={slot.start}
                    type="button"
                    onClick={() => {
                      setPickedSlot(slot);
                      // A different suggestion is a different candidate; a
                      // buffer approval for the previous one does not travel.
                      clearBufferOverride();
                    }}
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

        {/* THE BUFFER OVERRIDE, offered only after the database refused. Outside
            the manual-time panel because a stale suggested slot can hit the
            buffer too. Owner-only, never pre-ticked. */}
        {bufferOverrideOffered && (
          <div className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
            <p>
              That time is within the buffer around another appointment. It does
              not overlap one — double-booking is refused separately and cannot
              be overridden.
            </p>
            {isOwner ? (
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={bufferOverrideConfirmed}
                  onChange={(e) => setBufferOverrideConfirmed(e.target.checked)}
                  className="mt-0.5 h-4 w-4 flex-none rounded border-neutral-400"
                />
                <span>
                  Book it anyway. This records the appointment as an
                  outside-availability exception.
                </span>
              </label>
            ) : (
              <p>Only the studio owner can book inside the buffer.</p>
            )}
          </div>
        )}

        {assignedName && (
          <p
            className="text-xs text-neutral-500"
            data-testid="assigned-practitioner"
          >
            With {assignedName}
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
