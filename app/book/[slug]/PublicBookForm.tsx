"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import type { Service } from "@/lib/types/database";
import {
  formatServiceLabel,
  groupServicesByModality,
} from "@/lib/booking/format";
import {
  fetchNextAvailableDateAction,
  fetchPublicSlotsAction,
  publicBookAppointmentAction,
} from "./actions";

type Slot = { start: string; end: string; startLabel: string };

type Props = {
  slug: string;
  studioName: string;
  studioAddress: string | null;
  services: Service[];
  defaultDate: string;
  minDate: string;
  maxDate: string;
};

type Confirmation = {
  when: string;
  dateLocal: string;
  service: Service | null;
  email: string;
};

// Render a local YYYY-MM-DD as "Tuesday, May 26" (or, with year, "Tuesday, May 26, 2026"
// if the date is not in the current year). Pure client-side formatting; no timezone
// conversion since the input is already a studio-local date and we construct a Date
// from explicit year/month/day so the runtime's local timezone offset does not shift it.
// Merge the optional "areas wanted treated" answer with the catch-all
// "anything else" notes into the single appointments.notes column the
// server already accepts. Both prefixes are labeled so the practitioner
// can see which line came from which field in the saved note. Either
// side may be blank.
function combineAreasAndNotes(areas: string, notes: string): string {
  const trimmedAreas = areas.trim();
  const trimmedNotes = notes.trim();
  const parts: string[] = [];
  if (trimmedAreas) parts.push(`Areas: ${trimmedAreas}`);
  if (trimmedNotes) parts.push(`Notes: ${trimmedNotes}`);
  return parts.join("\n");
}

// Add one calendar day to a YYYY-MM-DD studio-local date string. Used to
// advance the next-available scan past the date the user already saw as
// empty. Stays in local-date space (no UTC conversion) so DST has no
// effect: tomorrow's local-calendar date is the same regardless of time
// of day or zone offsets.
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

export function PublicBookForm({
  slug,
  studioName,
  studioAddress,
  services,
  defaultDate,
  minDate,
  maxDate,
}: Props) {
  const groups = useMemo(() => groupServicesByModality(services), [services]);
  const firstServiceId = groups[0]?.services[0]?.id ?? "";
  const [serviceId, setServiceId] = useState(firstServiceId);
  const [date, setDate] = useState(defaultDate);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [picked, setPicked] = useState<Slot | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  // Separate fields client-side; combined into the single `notes` form
  // value at submit time. `areasWanted` answers "what areas are you
  // wanting treated?", primarily for consultation context. `notes` is
  // the catch-all "anything else?" line. Both stored in
  // appointments.notes (no schema change).
  const [areasWanted, setAreasWanted] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Confirmation | null>(null);
  const [loadingSlots, startLoading] = useTransition();
  const [submitting, startSubmitting] = useTransition();
  // Next-available lookup state. Distinct from loadingSlots so the slot
  // panel can keep its existing "Loading slots…" message while the
  // dedicated "Next available" button shows its own pending text. When
  // the lookup resolves with date===null we surface a calm exhausted-
  // horizon message.
  const [findingNext, startFindingNext] = useTransition();
  const [nextSearched, setNextSearched] = useState(false);
  const [noneInHorizon, setNoneInHorizon] = useState(false);

  // Single source of truth for the slots fetch: re-runs only when slug,
  // serviceId, or date actually change. Race-safe via a cancellation flag.
  useEffect(() => {
    if (!serviceId || !date) {
      setSlots([]);
      return;
    }
    let cancelled = false;
    setError(null);
    setPicked(null);
    // Reset next-available state when the underlying query changes.
    // A previous "no availability in horizon" verdict was specific to the
    // old service/date pair; clear it so the new pair gets a fresh probe.
    setNextSearched(false);
    setNoneInHorizon(false);
    startLoading(async () => {
      const r = await fetchPublicSlotsAction({ slug, serviceId, date });
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
  }, [slug, serviceId, date]);

  function onService(v: string) {
    setServiceId(v);
  }
  function onDate(v: string) {
    setDate(v);
  }

  // Server-side "Next available" jump. One server round-trip walks
  // forward from today/selected-date through the booking horizon and
  // returns the first date with bookable future slots. The slot-fetch
  // useEffect above re-runs automatically when `date` changes.
  function onFindNext() {
    if (!serviceId) return;
    setError(null);
    setNextSearched(false);
    setNoneInHorizon(false);
    // Start the lookup from the day AFTER the currently-selected date,
    // since we already know that date has no slots (that's why this
    // button is visible). The server clamps to today.
    const startFrom = addOneDayLocal(date);
    startFindingNext(async () => {
      const r = await fetchNextAvailableDateAction({
        slug,
        serviceId,
        fromDate: startFrom,
      });
      setNextSearched(true);
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
    setError(null);
    const fd = new FormData();
    fd.set("slug", slug);
    fd.set("service_id", serviceId);
    fd.set("starts_at", picked.start);
    fd.set("name", name);
    fd.set("email", email);
    fd.set("phone", phone);
    fd.set("notes", combineAreasAndNotes(areasWanted, notes));
    startSubmitting(async () => {
      const r = await publicBookAppointmentAction(fd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // Snapshot the selected service + date + email at success time so the
      // confirmation card stays stable even if local form state is later
      // cleared on unmount or a re-render.
      const bookedService =
        services.find((s) => s.id === serviceId) ?? null;
      setDone({
        when: picked.startLabel,
        dateLocal: date,
        service: bookedService,
        email,
      });
    });
  }

  if (done) {
    return (
      <ConfirmationView
        confirmation={done}
        studioName={studioName}
        studioAddress={studioAddress}
      />
    );
  }

  if (services.length === 0) {
    return (
      <p className="text-sm text-[#6B6B6B]">
        This studio isn&rsquo;t accepting bookings yet. Please reach out
        directly.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-8">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Service" required>
          <select
            value={serviceId}
            onChange={(e) => onService(e.target.value)}
            className="w-full bg-transparent py-2 text-[16px] outline-none"
            style={{ borderBottom: "1px solid #0A0A0A" }}
          >
            {groups.map((group) =>
              groups.length === 1 && group.modality === null ? (
                // Single ungrouped bucket: skip the optgroup wrapper so the
                // dropdown reads as a flat list without an "Other" heading.
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
        </Field>
        <Field label="Date" required>
          <input
            type="date"
            value={date}
            min={minDate}
            max={maxDate}
            onChange={(e) => onDate(e.target.value)}
            className="w-full bg-transparent py-2 text-[16px] outline-none"
            style={{ borderBottom: "1px solid #0A0A0A" }}
          />
        </Field>
      </div>

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
              <div className="flex items-center gap-3">
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
                {nextSearched && (
                  <span className="text-xs text-[#6B6B6B]">
                    Tap a time to confirm.
                  </span>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {slots.map((s) => {
              const sel = picked?.start === s.start;
              return (
                <button
                  key={s.start}
                  type="button"
                  onClick={() => setPicked(s)}
                  className={`px-4 py-2 text-sm transition ${
                    sel
                      ? "bg-[#0A0A0A] text-[#FAFAF7]"
                      : "bg-white text-[#0A0A0A] hover:bg-[#F5F2EB]"
                  }`}
                  style={{ border: "1px solid #0A0A0A" }}
                >
                  {s.startLabel}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Your name" required>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full bg-transparent py-2 text-[16px] outline-none"
            style={{ borderBottom: "1px solid #0A0A0A" }}
          />
        </Field>
        <Field label="Email" required>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="w-full bg-transparent py-2 text-[16px] outline-none"
            style={{ borderBottom: "1px solid #0A0A0A" }}
          />
        </Field>
      </div>

      <Field label="Phone" required>
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          required
          className="w-full bg-transparent py-2 text-[16px] outline-none"
          style={{ borderBottom: "1px solid #0A0A0A" }}
        />
      </Field>

      <Field
        label="What areas are you wanting treated?"
        helperText="For example: upper lip, chin, underarms, bikini line."
      >
        <textarea
          rows={2}
          value={areasWanted}
          onChange={(e) => setAreasWanted(e.target.value)}
          className="w-full resize-none bg-transparent py-2 text-[16px] outline-none"
          style={{ borderBottom: "1px solid #0A0A0A" }}
        />
      </Field>

      <Field label="Anything else?">
        <textarea
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="w-full resize-none bg-transparent py-2 text-[16px] outline-none"
          style={{ borderBottom: "1px solid #0A0A0A" }}
        />
      </Field>

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={submitting}
          className="px-8 py-4 text-[14px] font-medium uppercase disabled:opacity-50"
          style={{
            backgroundColor: "#0A0A0A",
            color: "#FAFAF7",
            letterSpacing: "0.1em",
          }}
        >
          {submitting ? "Booking…" : "Book appointment"}
        </button>
        {error && (
          <span className="text-[13px] text-red-600">{error}</span>
        )}
      </div>
    </form>
  );
}

function Field({
  label,
  required,
  helperText,
  children,
}: {
  label: string;
  required?: boolean;
  helperText?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span
        className="text-[12px] font-medium uppercase"
        style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
      >
        {label}
        {required && (
          <span
            aria-hidden
            className="ml-1 text-red-600 normal-case"
            style={{ letterSpacing: "0" }}
          >
            *
          </span>
        )}
      </span>
      {children}
      {helperText && (
        <span className="text-xs text-[#6B6B6B]">{helperText}</span>
      )}
    </label>
  );
}

// Public booking confirmation surface. Pure display — no actions, no
// fetches, no side effects. The booking has already been created and
// the confirmation email already dispatched by the server action by
// the time this renders.
function ConfirmationView({
  confirmation,
  studioName,
  studioAddress,
}: {
  confirmation: Confirmation;
  studioName: string;
  studioAddress: string | null;
}) {
  const formattedDate = formatLocalDate(confirmation.dateLocal);
  const serviceName = confirmation.service?.name ?? null;
  const durationMinutes =
    confirmation.service?.default_duration_minutes ?? null;
  return (
    <div className="flex flex-col gap-8">
      <div>
        <span
          className="text-[12px] font-medium uppercase"
          style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
        >
          Confirmed
        </span>
        <h2
          className="font-[var(--font-fraunces)] mt-3 text-[32px] font-bold leading-tight md:text-[40px]"
          style={{ letterSpacing: "-0.025em" }}
        >
          Your appointment is booked
        </h2>
      </div>

      {/* Appointment summary card. Service + date + time + studio, in
          that scan order. */}
      <dl
        className="flex flex-col gap-3 p-6"
        style={{
          backgroundColor: "#FAFAF7",
          border: "1px solid #E5E2D9",
        }}
      >
        {serviceName && (
          <ConfirmationRow label="Service">
            {serviceName}
            {durationMinutes != null && (
              <span style={{ color: "#6B6B6B" }}> · {durationMinutes} min</span>
            )}
          </ConfirmationRow>
        )}
        <ConfirmationRow label="When">
          <span className="font-medium">{formattedDate}</span>
          <span style={{ color: "#6B6B6B" }}> · {confirmation.when}</span>
        </ConfirmationRow>
        <ConfirmationRow label="Where">
          <span className="font-medium">{studioName}</span>
          {studioAddress && (
            <>
              <br />
              <span style={{ color: "#6B6B6B" }}>{studioAddress}</span>
            </>
          )}
        </ConfirmationRow>
      </dl>

      {/* What happens next — three short lines. */}
      <div className="flex flex-col gap-3">
        <h3
          className="text-[12px] font-medium uppercase"
          style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
        >
          What happens next
        </h3>
        <ul className="flex flex-col gap-2 text-[16px] leading-relaxed text-[#0A0A0A]">
          <li>
            We sent a confirmation to{" "}
            <strong>{confirmation.email}</strong>, with a calendar invite.
          </li>
          <li>
            The email includes links to cancel or reschedule if your plans
            change.
          </li>
          <li>
            If your studio asks for a health intake, you&rsquo;ll receive
            that link too.
          </li>
        </ul>
      </div>

      {/* Subtle payment reassurance. Phase 1 booking does not collect
          cards; making this explicit prevents the "did I miss a step?"
          worry. Kept small + muted. */}
      <p className="text-[13px]" style={{ color: "#6B6B6B" }}>
        No payment was collected for this booking.
      </p>
    </div>
  );
}

function ConfirmationRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
      <dt
        className="flex-none text-[11px] font-medium uppercase sm:w-20"
        style={{ letterSpacing: "0.18em", color: "#6B6B6B" }}
      >
        {label}
      </dt>
      <dd className="text-[15px] text-[#0A0A0A]">{children}</dd>
    </div>
  );
}
