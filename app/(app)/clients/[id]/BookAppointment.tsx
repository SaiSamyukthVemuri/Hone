"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Service } from "@/lib/types/database";
import {
  formatServiceLabel,
  groupServicesByModality,
} from "@/lib/booking/format";
import {
  fetchSlotsForClientBookingAction,
  fetchEligiblePractitionersAction,
  type EligiblePractitioner,
} from "./booking-actions";
import { bookAppointmentForClientAction } from "../../calendar/actions";
import { utcInstantFromLocal } from "@/lib/booking/tz";
import {
  decideManualTime,
  type AvailabilityWindow,
} from "@/lib/booking/availability-window";

type Slot = { start: string; end: string; startLabel: string };

type Props = {
  clientId: string;
  services: Service[];
  defaultDate: string; // YYYY-MM-DD in studio tz
  // Studio IANA timezone: required to interpret the owner override's local
  // time as a UTC instant (DST-safe via utcInstantFromLocal).
  timezone: string;
  // Owner-only outside-hours override. Non-owners never see the control; the
  // server (bookAppointmentForClientAction) enforces owner-only regardless.
  isOwner: boolean;
  // Part 4 Item 6: practitioner capacity. When ON + owner, a practitioner
  // selector is shown; the target drives target-specific slots + assignment.
  practitionerCapacityEnabled: boolean;
  currentPractitionerId: string;
  currentPractitionerName: string;
};

export function BookAppointment({
  clientId,
  services,
  defaultDate,
  timezone,
  isOwner,
  practitionerCapacityEnabled,
  currentPractitionerId,
  currentPractitionerName,
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
  // "Choose another time": same contract as the calendar Quick Book drawer.
  // Turning it on is not itself an availability override -- the typed time is
  // classified against the real working-hours window, and only a time genuinely
  // outside that window takes the owner-only outside-hours path with its
  // acknowledgement and allow_outside_availability=true.
  const [manualTimeEnabled, setManualTimeEnabled] = useState(false);
  const [manualTime, setManualTime] = useState("");
  const [outsideHoursConfirmed, setOutsideHoursConfirmed] = useState(false);
  // THE BUFFER OVERRIDE, offered only in response to the server refusing.
  //
  // The soft buffer (0152) is not an availability fact, so it cannot be decided
  // from the window: a time can be squarely inside working hours and still sit
  // in the gap around a neighbouring appointment. Only the database knows, and
  // it says so by returning `buffer_conflict`.
  //
  // Reaching such a time is a real, shipped capability -- 0152 exists for it,
  // and the suggestion list deliberately hides those times, so the override is
  // the only route. It is offered HERE, after the refusal, rather than as a
  // standing control, so allow_outside_availability is still posted only on a
  // deliberate opt-in with a concrete reason on screen.
  //
  // Owner-only, because the same flag is what the server gates on role.
  const [bufferOverrideOffered, setBufferOverrideOffered] = useState(false);
  const [bufferOverrideConfirmed, setBufferOverrideConfirmed] = useState(false);
  // Any change to WHICH booking this is invalidates a buffer offer: it was a
  // fact about one (time, date, service, target), not a standing permission.
  function clearBufferOverride() {
    setBufferOverrideOffered(false);
    setBufferOverrideConfirmed(false);
  }
  // The REAL availability window for the loaded (service, date, target),
  // resolved server-side and returned with the suggestions. null until a
  // successful load, cleared before every refetch, and cleared on every failure
  // -- so an unknown window is never mistaken for an open one, and a window
  // belonging to a previous target/date is never reused for a new one. While it
  // is null the manual path is blocked outright rather than routed through the
  // outside-hours override; see the note on ManualTimeDecision.
  const [availabilityWindow, setAvailabilityWindow] =
    useState<AvailabilityWindow | null>(null);

  // Item 6: owner practitioner selector. The selector is shown ONLY when capacity
  // is ON and the actor is an owner; members and Legacy studios always book the
  // acting practitioner (target === self, no selector).
  const showSelector = practitionerCapacityEnabled && isOwner;
  const [eligible, setEligible] = useState<EligiblePractitioner[]>([]);
  const [eligibleError, setEligibleError] = useState<string | null>(null);
  const [target, setTarget] = useState<string>(currentPractitionerId);
  const [loadingPractitioners, startLoadingPractitioners] = useTransition();
  // Item 6 (1C): latest-request-wins guards. A stale eligible/slot response from
  // an earlier service/date/practitioner must never overwrite the current state.
  const eligibleReq = useRef(0);
  const slotReq = useRef(0);

  // Default-target rule (documented): preserve an already-selected valid target;
  // otherwise prefer the current owner when eligible; otherwise the first
  // eligible practitioner. Never silently keep an ineligible target.
  function resolveDefaultTarget(
    list: EligiblePractitioner[],
    current: string,
  ): string {
    if (list.some((p) => p.id === current)) return current;
    if (list.some((p) => p.id === currentPractitionerId)) return currentPractitionerId;
    return list[0]?.id ?? "";
  }

  function loadSlots(nextServiceId: string, nextDate: string, nextTarget: string) {
    setError(null);
    setPickedSlot(null);
    // DROP THE PREVIOUS WINDOW BEFORE REFETCHING. It belongs to the OLD
    // (target, date); keeping it while the new one is in flight would classify
    // the typed time against a practitioner or a day this booking is no longer
    // for. If the stale window said "closed" and the new one is open, the form
    // would show the outside-hours warning and post
    // allow_outside_availability for an ordinary working time -- the original
    // defect, re-entered through stale state.
    setAvailabilityWindow(null);
    // A new (date, target) is a different booking; a buffer refusal for the old
    // one says nothing about it.
    clearBufferOverride();
    const req = ++slotReq.current;
    startLoading(async () => {
      const r = await fetchSlotsForClientBookingAction({
        serviceId: nextServiceId,
        date: nextDate,
        practitionerId: showSelector ? nextTarget : undefined,
      });
      if (req !== slotReq.current) return; // stale: a newer request superseded this
      if (!r.ok) {
        setError(r.error);
        setSlots([]);
        // Fail closed, in BOTH directions: a failed load leaves the window
        // null, and null blocks the manual path rather than routing it through
        // the outside-hours override. Routing it there would post
        // allow_outside_availability for a time that may well be inside working
        // hours -- the very defect this split exists to remove.
        setAvailabilityWindow(null);
        return;
      }
      setSlots(r.slots);
      setAvailabilityWindow(r.window);
    });
  }

  // Load the eligible practitioners for a service, resolve the default target,
  // then load that target's slots. Owner + capacity-ON only. FAILS CLOSED: a
  // lookup error or an empty list clears the target/slots and never falls back to
  // self slots.
  function loadForService(nextServiceId: string, nextDate: string) {
    if (!showSelector) {
      loadSlots(nextServiceId, nextDate, currentPractitionerId);
      return;
    }
    const req = ++eligibleReq.current;
    setEligibleError(null);
    // The eligible lookup can change the TARGET, which changes the window. Drop
    // it now rather than after the round trip, for the same reason as loadSlots.
    setAvailabilityWindow(null);
    startLoadingPractitioners(async () => {
      const r = await fetchEligiblePractitionersAction(nextServiceId);
      if (req !== eligibleReq.current) return; // stale service response
      if (!r.ok) {
        setEligibleError(r.error);
        setEligible([]);
        setTarget("");
        setSlots([]);
        setPickedSlot(null);
        setAvailabilityWindow(null);
        return;
      }
      const list = r.practitioners;
      setEligible(list);
      const nextTarget = resolveDefaultTarget(list, target);
      setTarget(nextTarget);
      if (!nextTarget) {
        // Empty eligible list → do NOT request slots; booking is blocked.
        setSlots([]);
        setPickedSlot(null);
        setAvailabilityWindow(null);
        return;
      }
      loadSlots(nextServiceId, nextDate, nextTarget);
    });
  }

  function handleOpen() {
    setOpen(true);
    if (serviceId && date) loadForService(serviceId, date);
  }
  function handleService(v: string) {
    setServiceId(v);
    if (v && date) loadForService(v, date);
  }
  function handleDate(v: string) {
    setDate(v);
    if (serviceId && v) loadSlots(serviceId, v, target);
  }
  function handleTarget(v: string) {
    setTarget(v);
    // Changing the practitioner refreshes target-specific slots and clears any
    // previously selected time (loadSlots resets pickedSlot).
    if (serviceId && date) loadSlots(serviceId, date, v);
  }

  // When the selector is shown, the current target MUST be present in the
  // eligible list (fail closed: an empty/failed lookup leaves target "" →
  // booking blocked).
  const targetValid = !showSelector || eligible.some((p) => p.id === target);

  // "Choose another time" is available to EVERY active practitioner, not just
  // the owner. It used to be gated on isOwner, which meant a member had no way
  // at all to book a perfectly ordinary working time that was not one of the
  // suggestions. What stays owner-only is the genuine outside-hours override
  // below, enforced by the server and again by the DB command.
  const manualTimeActive = manualTimeEnabled;

  // WHAT THE TYPED TIME ACTUALLY IS. The SAME shared decision function the
  // calendar Quick Book drawer uses, over the same server-resolved window, so
  // the two internal surfaces cannot run different laws. Decides COPY ONLY; the
  // server re-resolves the window and is the authority.
  //
  // This surface has no drag-to-create, so there is never a custom length here.
  const selectedService = services.find((s) => s.id === serviceId) ?? null;
  const manualDecision = decideManualTime({
    window: availabilityWindow,
    localTime: manualTime,
    serviceDurationMinutes: selectedService?.default_duration_minutes ?? null,
    customDurationMinutes: null,
  });
  const manualVerdict = manualDecision.verdict;
  const manualTimeValid = manualDecision.timeValid;
  // Whether the real window actually loaded. Until it has, nothing may be
  // asserted about the typed time -- see the note on ManualTimeDecision.
  const windowKnown = manualDecision.windowKnown;
  const requiresOutsideOverride =
    manualTimeActive && manualDecision.requiresOutsideOverride;

  // The flag is posted for EITHER reason the server will accept it for: a time
  // genuinely outside working hours, or an owner deliberately overriding the
  // soft buffer after the database refused. Both are explicit acknowledgements;
  // neither fires on its own.
  const postsOutsideAvailability =
    requiresOutsideOverride || (bufferOverrideOffered && bufferOverrideConfirmed);

  const canConfirm =
    targetValid &&
    // An outstanding buffer refusal blocks re-submission until the owner
    // acknowledges it. Re-submitting unchanged would just be refused again.
    (!bufferOverrideOffered || (isOwner && bufferOverrideConfirmed)) &&
    (manualTimeActive
      ? // An unknown window blocks the manual path outright rather than routing
        // it through the override, which would file an in-hours appointment as
        // an out-of-hours exception.
        windowKnown &&
        manualTimeValid &&
        (!requiresOutsideOverride || (isOwner && outsideHoursConfirmed))
      : !!pickedSlot);

  // The practitioner this booking will be assigned to (for the confirmation line).
  const assignedName = showSelector
    ? (eligible.find((p) => p.id === target)?.displayName ?? "")
    : currentPractitionerName;

  function handleConfirm() {
    if (!serviceId || !canConfirm) return;
    // An outstanding buffer refusal must be acknowledged by an owner before a
    // re-submit; the button is a hint, this is the gate.
    if (bufferOverrideOffered && !(isOwner && bufferOverrideConfirmed)) return;
    setError(null);
    const fd = new FormData();
    fd.set("client_id", clientId);
    fd.set("service_id", serviceId);
    fd.set("notes", notes);
    // Item 6: an owner (capacity ON) assigns the selected target; the server
    // re-validates it (active, same-studio, eligible). Members/Legacy send no
    // practitioner_id → the server books the acting practitioner.
    if (showSelector && target) fd.set("practitioner_id", target);
    if (manualTimeActive) {
      // No window, no submission. allow_outside_availability below is an
      // assertion the database keeps forever; it may only be made against a
      // window that actually loaded.
      if (!windowKnown) return;
      // Same contract as the calendar Quick Book drawer: a UTC instant from the
      // studio-local date + time. allow_outside_availability is posted ONLY when
      // the chosen time is genuinely outside the working-hours window, because
      // that flag is persisted on the appointment row, stamped into the audit
      // record with an authorising owner, and disables the buffer trigger for
      // that appointment. The server re-resolves the window, re-checks owner
      // permission, and enforces every DB scheduling constraint regardless.
      const utc = utcInstantFromLocal(date, manualTime, timezone);
      fd.set("starts_at", utc.toISOString());
    } else {
      if (!pickedSlot) return;
      fd.set("starts_at", pickedSlot.start);
    }
    // ONE posting site, covering both acknowledged reasons. A suggested slot can
    // also hit the buffer if it went stale between fetch and submit, so this sits
    // outside the manual/suggestion branch rather than inside it.
    if (postsOutsideAvailability) {
      fd.set("allow_outside_availability", "true");
    }
    startBooking(async () => {
      const r = await bookAppointmentForClientAction(fd);
      if (!r.ok) {
        setError(r.error);
        // The database refused on the SOFT buffer. That is the one refusal an
        // owner may legitimately override, so offer it here rather than leaving
        // them at a dead end. Non-owners are told who can, and nothing is
        // pre-ticked.
        if (r.code === "buffer_conflict") {
          setBufferOverrideOffered(true);
          setBufferOverrideConfirmed(false);
        } else {
          clearBufferOverride();
        }
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

      {/* Item 6: owner practitioner selector: active, service-eligible, same-studio
          practitioners only (display names only, ids never shown). */}
      {showSelector && (
        <label className="flex flex-col gap-1.5">
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
              onChange={(e) => handleTarget(e.target.value)}
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
        </label>
      )}

      <div className="flex flex-col gap-2">
        {/* SUGGESTED, not "available": a packed subset of the legal times.
            Calling it "Available times" implied everything else was
            unavailable, which is what pushed ordinary manual times through the
            outside-hours override. */}
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Suggested times
        </span>
        {loading ? (
          <p className="text-sm text-neutral-500">Loading slots…</p>
        ) : slots.length === 0 ? (
          <p className="text-sm text-neutral-500">
            No suggested times on that date. Use “Choose another time” to book a
            time you are working.
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

      {/* Choose another time. Available to EVERY active practitioner, and the
          container is NEUTRAL: turning it on is not an admission of anything.
          The amber treatment and the acknowledgement appear only once the typed
          time is genuinely outside the working-hours window, which is also the
          only case that is owner-only. Parity with the calendar Quick Book
          drawer; the server enforces both rules regardless. */}
      <div className="flex flex-col gap-2 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={manualTimeEnabled}
            onChange={(e) => {
              setManualTimeEnabled(e.target.checked);
              if (!e.target.checked) setOutsideHoursConfirmed(false);
            }}
            className="h-4 w-4"
          />
          Choose another time
        </label>
        {manualTimeEnabled && (
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
                Time (on {date})
              </span>
              <input
                type="time"
                value={manualTime}
                onChange={(e) => {
                  setManualTime(e.target.value);
                  // A different time is a different question for the buffer.
                  clearBufferOverride();
                }}
                className="min-h-[44px] max-w-[10rem] rounded-md border border-neutral-300 bg-white px-3 py-2 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
              />
            </label>
            {/* NOTHING IS ASSERTED UNTIL THERE IS SOMETHING TO ASSERT ABOUT.
                An UNKNOWN window is not an outside-hours time, and neither is
                an EMPTY time field -- decideManualTime reports
                requiresOutsideOverride for both (it fails closed), which is the
                right answer for "may this be booked?" and the wrong one for
                "what is this time?". Rendering the amber off it told the
                practitioner a blank field was outside their availability, and
                handed an owner an acknowledgement for no time at all. Confirm
                is already blocked in both states (canConfirm requires
                windowKnown AND manualTimeValid), so this is purely about not
                claiming something untrue. */}
            {!windowKnown ? (
              <p className="text-xs text-neutral-600 dark:text-neutral-400">
                {loading || loadingPractitioners
                  ? "Checking your working hours…"
                  : "Could not load your working hours, so this time cannot be checked. Refresh and try again."}
              </p>
            ) : !manualTimeValid ? null : requiresOutsideOverride ? (
              <div className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
                <p className="text-xs text-amber-800 dark:text-amber-300">
                  {manualVerdict === "practitioner_closed"
                    ? "You are not working on this date. Double-booking, buffer and time-off rules are still enforced."
                    : "This time is outside your normal availability. Double-booking, buffer and time-off rules are still enforced."}
                </p>
                {isOwner ? (
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={outsideHoursConfirmed}
                      onChange={(e) => setOutsideHoursConfirmed(e.target.checked)}
                      className="h-4 w-4"
                    />
                    I confirm I want to book this out-of-hours time.
                  </label>
                ) : (
                  <p className="text-xs text-amber-800 dark:text-amber-300">
                    Only the studio owner can book outside normal availability.
                  </p>
                )}
              </div>
            ) : (
              // manualTimeValid is already guaranteed by the branch above.
              <p className="text-xs text-neutral-600 dark:text-neutral-400">
                That time is inside your working hours. Booking normally.
              </p>
            )}
          </div>
        )}
      </div>

      {/* THE BUFFER OVERRIDE, offered only after the database refused. It sits
          outside the manual-time panel because a stale suggested slot can hit
          the buffer too. Owner-only, never pre-ticked. */}
      {bufferOverrideOffered && (
        <div className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
          <p className="text-xs text-amber-800 dark:text-amber-300">
            That time is within the buffer around another appointment. It does
            not overlap one — double-booking is refused separately and cannot be
            overridden.
          </p>
          {isOwner ? (
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={bufferOverrideConfirmed}
                onChange={(e) => setBufferOverrideConfirmed(e.target.checked)}
                className="h-4 w-4"
              />
              Book it anyway. This records the appointment as an
              outside-availability exception.
            </label>
          ) : (
            <p className="text-xs text-amber-800 dark:text-amber-300">
              Only the studio owner can book inside the buffer.
            </p>
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

      <div className="flex flex-col gap-2">
        {assignedName && (
          <p className="text-xs text-neutral-500" data-testid="assigned-practitioner">
            With {assignedName}
          </p>
        )}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm || booking}
            className="rounded-md bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            {/* The button only says "out-of-hours" when it genuinely is. A
                manual time inside working hours is an ordinary Confirm. */}
            {booking
              ? "Booking…"
              : bufferOverrideOffered
                ? "Book anyway"
                : requiresOutsideOverride && windowKnown
                  ? "Book out-of-hours"
                  : "Confirm"}
          </button>
          {error && (
            <span className="text-sm text-red-600 dark:text-red-400">{error}</span>
          )}
        </div>
      </div>
    </div>
  );
}
