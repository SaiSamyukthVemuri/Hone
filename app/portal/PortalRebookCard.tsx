"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  buildBookingConfirmationCopy,
  type ConfirmationEmailStatus,
} from "@/lib/booking/confirmation-presentation";
import {
  bookAnotherAppointmentAction,
  loadPortalRebookNextAvailableAction,
  loadPortalRebookSlotsAction,
} from "./rebook-actions";

// EMERG-PORTAL-REBOOK-01 — "Book another appointment" for a signed-in client.
//
// THE THIRD SIDE OF A TRIANGLE THAT HAD TWO. `/book/<slug>` sends a returning
// client to the portal, and the portal could only manage appointments that
// already existed. There was no way back to booking.
//
// WHAT THIS COMPONENT DELIBERATELY DOES NOT COLLECT: email, name, phone, or any
// client identifier. It posts a service, a start time and an optional note.
// Identity is resolved server-side from the portal session, which is the
// property the whole unit rests on — see rebook-actions.ts. Adding an identity
// field here would be the regression, so its absence is the contract and
// tests/source-guards/portal-rebook-identity.test.ts pins it.
//
// THIS IS A CAPABILITY, NOT A TASK. It renders wherever the portal puts it,
// independently of whether the client currently owes paperwork — an established
// client with nothing outstanding is exactly the person most likely to want it.
// The "is it rendered at all" decision belongs to the page and is pinned there.
//
// The slot list is fetched through a server action rather than rendered ahead
// of time: availability moves, and a list baked into the page at request time
// would invite a stale pick. The server re-checks the chosen start against the
// same public authority, and the database re-checks it again under the studio
// lock.

type Service = {
  id: string;
  name: string;
  default_duration_minutes: number;
};

type Slot = { start: string; end: string; startLabel: string };

type Confirmation = {
  startsAt: string;
  whenLabel: string;
  serviceName: string;
  manageUrl: string;
  email: string | null;
  emailStatus: ConfirmationEmailStatus;
};

export function PortalRebookCard({
  services,
  timezone,
  minDate,
  maxDate,
  studioName,
}: {
  services: readonly Service[];
  timezone: string;
  /** Today in the STUDIO's calendar, resolved server-side. */
  minDate: string;
  /** The last date inside the studio's public booking horizon. */
  maxDate: string;
  studioName: string;
}) {
  const router = useRouter();

  const [serviceId, setServiceId] = useState<string>(services[0]?.id ?? "");
  const [date, setDate] = useState<string>(minDate);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [picked, setPicked] = useState<Slot | null>(null);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [noneInHorizon, setNoneInHorizon] = useState(false);
  const [done, setDone] = useState<Confirmation | null>(null);
  const [loadingSlots, startLoadingSlots] = useTransition();
  const [findingNext, startFindingNext] = useTransition();
  const [booking, startBooking] = useTransition();

  // ONE PRESS, ONE ATTEMPT. `useTransition`'s pending flag disables the button,
  // but a second activation dispatched in the same tick (a double click, a
  // repeated Enter, an assistive-tech double activation) can still reach this
  // handler before React re-renders. The ref closes that window synchronously.
  // It is released again on a REFUSAL — "that time is gone" is meant to be
  // retried — and deliberately not on success, where the form is replaced.
  //
  // THE DURABLE GUARANTEE IS NOT THIS REF. `create_public_appointment` takes the
  // studio lock, re-derives the slot grid and re-checks the overlap constraint,
  // so a second submission for the same instant is refused BY THE DATABASE even
  // if two browsers press at once. This only spares the client a pointless round
  // trip and a confusing second error.
  const submittedRef = useRef(false);

  // Any change to the service or date invalidates the slot list. Leaving a
  // stale list on screen would let someone submit a time that was offered for a
  // different service — refused by the server, but confusing to read.
  useEffect(() => {
    if (!serviceId || !date) {
      setSlots([]);
      setPicked(null);
      return;
    }
    let cancelled = false;
    setError(null);
    setPicked(null);
    setNoneInHorizon(false);
    startLoadingSlots(async () => {
      const res = await loadPortalRebookSlotsAction({ serviceId, date });
      if (cancelled) return;
      if (!res.ok) {
        if (res.code === "session_expired") {
          router.push("/portal/login");
          return;
        }
        setError(res.error);
        setSlots([]);
        return;
      }
      setSlots(res.slots);
    });
    return () => {
      cancelled = true;
    };
  }, [serviceId, date, router]);

  function onNextAvailable() {
    if (!serviceId) return;
    setError(null);
    setNoneInHorizon(false);
    startFindingNext(async () => {
      const res = await loadPortalRebookNextAvailableAction({
        serviceId,
        // Walk forward from the day AFTER the one on screen, so pressing this
        // repeatedly keeps advancing instead of re-finding the same date.
        fromDate: addOneDay(date),
      });
      if (!res.ok) {
        if (res.code === "session_expired") {
          router.push("/portal/login");
          return;
        }
        setError(res.error);
        return;
      }
      if (res.date == null) {
        setNoneInHorizon(true);
        return;
      }
      setDate(res.date);
    });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submittedRef.current) return;
    if (!picked || !serviceId) {
      setError("Please choose a time first.");
      return;
    }
    setError(null);
    submittedRef.current = true;

    const fd = new FormData();
    // CHOICES ONLY — no identity travels with this request.
    fd.set("serviceId", serviceId);
    fd.set("startsAt", picked.start);
    fd.set("notes", notes.trim());

    const chosen = picked;
    startBooking(async () => {
      const res = await bookAnotherAppointmentAction(fd);
      if (!res.ok) {
        // A refusal is retryable, so the one-press latch is released.
        submittedRef.current = false;
        if (res.code === "session_expired") {
          router.push("/portal/login");
          return;
        }
        setError(res.error);
        if (res.code === "slot_taken") {
          // The time is gone: drop the stale pick and refresh the day rather
          // than leaving a dead button selected.
          setPicked(null);
          const refreshed = await loadPortalRebookSlotsAction({ serviceId, date });
          if (refreshed.ok) setSlots(refreshed.slots);
        }
        return;
      }
      setDone({
        startsAt: res.startsAt,
        whenLabel: chosen.startLabel,
        serviceName: res.serviceName,
        manageUrl: res.manageUrl,
        email: res.confirmationEmail,
        emailStatus: res.confirmationEmailStatus,
      });
    });
  }

  if (services.length === 0) return null;

  if (done) {
    // TRUTHFUL ACKNOWLEDGEMENT. The narrative comes from the SAME pure builder
    // the public booking confirmation uses, so the two surfaces cannot drift
    // into describing one provider outcome two different ways. The management
    // link is unconditional: it is the client's guaranteed path to this
    // appointment and depends on no provider.
    const copy = buildBookingConfirmationCopy({
      emailStatus: done.emailStatus,
      email: done.email ?? "the address on file",
    });
    return (
      <div data-testid="portal-rebook-confirmed" className="flex flex-col gap-3">
        <h3 className="text-[15px] font-medium text-[#0A0A0A]">
          You&rsquo;re booked.
        </h3>
        <p className="text-[14px]" style={{ color: "#3F3F3F" }}>
          {done.serviceName} —{" "}
          <span data-testid="portal-rebook-confirmed-when">
            {new Date(done.startsAt).toLocaleString(undefined, {
              timeZone: timezone,
              dateStyle: "full",
              timeStyle: "short",
            })}
          </span>
        </p>
        <ul className="flex flex-col gap-1">
          {copy.steps.map((step) => (
            <li key={step} className="text-[13px]" style={{ color: "#6B6B6B" }}>
              {step}
            </li>
          ))}
        </ul>
        <a
          href={done.manageUrl}
          data-testid="portal-rebook-manage-link"
          className="self-start px-5 py-2 text-[12px] font-medium uppercase"
          style={{
            border: "1px solid #0A0A0A",
            color: "#0A0A0A",
            letterSpacing: "0.1em",
          }}
        >
          {copy.manageLabel}
        </a>
        <p className="text-[13px]" style={{ color: "#6B6B6B" }}>
          It is now listed with your upcoming appointments.
        </p>
      </div>
    );
  }

  return (
    <form
      data-testid="portal-rebook"
      onSubmit={submit}
      className="flex flex-col gap-4"
    >
      <div>
        <h3 className="text-[15px] font-medium text-[#0A0A0A]">
          Book another appointment
        </h3>
        <p className="mt-1 text-[13px]" style={{ color: "#6B6B6B" }}>
          You are signed in, so there is nothing to re-enter.
        </p>
      </div>

      <label className="flex flex-col gap-1 text-[13px]">
        <span style={{ color: "#6B6B6B" }}>Service</span>
        <select
          data-testid="portal-rebook-service"
          value={serviceId}
          onChange={(e) => setServiceId(e.target.value)}
          className="border border-neutral-300 px-3 py-2 text-[14px]"
        >
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.default_duration_minutes} min
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-[13px]">
        <span style={{ color: "#6B6B6B" }}>Date</span>
        <div className="flex flex-wrap items-center gap-3">
          <input
            data-testid="portal-rebook-date"
            type="date"
            value={date}
            min={minDate}
            max={maxDate}
            onChange={(e) => setDate(e.target.value)}
            className="border border-neutral-300 px-3 py-2 text-[14px]"
          />
          <button
            type="button"
            data-testid="portal-rebook-next-available"
            onClick={onNextAvailable}
            disabled={findingNext}
            className="border border-neutral-900 px-4 py-2 text-[12px] font-medium uppercase disabled:opacity-50"
            style={{ letterSpacing: "0.1em" }}
          >
            {findingNext ? "Looking…" : "Next available"}
          </button>
        </div>
      </label>

      {noneInHorizon && (
        <p
          data-testid="portal-rebook-none-in-horizon"
          className="text-[13px]"
          style={{ color: "#3F3F3F" }}
        >
          No open times left in {studioName}&rsquo;s booking window. Please
          contact the studio.
        </p>
      )}

      {loadingSlots ? (
        <p className="text-[13px]" style={{ color: "#6B6B6B" }}>
          Loading times…
        </p>
      ) : slots.length === 0 ? (
        <p
          data-testid="portal-rebook-no-slots"
          className="text-[13px]"
          style={{ color: "#3F3F3F" }}
        >
          No times are available on that date. Please choose another date.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2" data-testid="portal-rebook-slots">
          {slots.map((s) => {
            const selected = picked?.start === s.start;
            return (
              <button
                key={s.start}
                type="button"
                data-testid="portal-rebook-slot"
                data-slot-start={s.start}
                aria-pressed={selected}
                onClick={() => setPicked(s)}
                className="border border-neutral-900 px-4 py-2 text-[13px]"
                style={{
                  backgroundColor: selected ? "#0A0A0A" : "transparent",
                  color: selected ? "#FAFAF7" : "#0A0A0A",
                }}
              >
                {s.startLabel}
              </button>
            );
          })}
        </div>
      )}

      <label className="flex flex-col gap-1 text-[13px]">
        <span style={{ color: "#6B6B6B" }}>
          Anything {studioName} should know? (optional)
        </span>
        <textarea
          data-testid="portal-rebook-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          className="border border-neutral-300 px-3 py-2 text-[14px]"
        />
      </label>

      {error && (
        <p
          data-testid="portal-rebook-error"
          role="alert"
          className="text-[13px]"
          style={{ color: "#8A1C1C" }}
        >
          {error}
        </p>
      )}

      <button
        type="submit"
        data-testid="portal-rebook-submit"
        disabled={booking || picked == null}
        className="self-start px-5 py-2 text-[12px] font-medium uppercase disabled:opacity-50"
        style={{
          backgroundColor: "#0A0A0A",
          color: "#FAFAF7",
          letterSpacing: "0.1em",
        }}
      >
        {booking ? "Booking…" : "Book appointment"}
      </button>
    </form>
  );
}

/** Next calendar day for a YYYY-MM-DD string, in that same local calendar. */
function addOneDay(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const next = new Date(Date.UTC(y, (m ?? 1) - 1, (d ?? 1) + 1));
  return next.toISOString().slice(0, 10);
}
