"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  buildBookingConfirmationCopy,
  type ConfirmationEmailStatus,
} from "@/lib/booking/confirmation-presentation";
import { PORTAL_REBOOK_GENERIC_REFUSAL } from "@/lib/portal/rebook-copy";
import { nextCalendarDay } from "@/lib/portal/rebook-dates";
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
  // WHY THE OUTCOME IS TRACKED SEPARATELY FROM THE LIST. An empty list has
  // two causes with opposite meanings: the day really has no times, or the
  // read did not answer. Collapsing both into `slots.length === 0` renders
  // "No times are available on that date" after a failed read — which is the
  // exact false statement the server-side failure propagation exists to stop.
  const [slotLoad, setSlotLoad] = useState<
    "idle" | "loading" | "loaded" | "failed"
  >("loading");
  const [picked, setPicked] = useState<Slot | null>(null);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [noneInHorizon, setNoneInHorizon] = useState(false);
  // Bumping this re-runs the ONE slot effect below. It exists so a refusal
  // can ask for a refresh WITHOUT starting a second, parallel slot load that
  // would carry the service/date captured when the submit began.
  const [slotReloadNonce, setSlotReloadNonce] = useState(0);
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

  // THE SELECTION MUST NOT MOVE UNDERNEATH AN IN-FLIGHT REQUEST. Both the
  // booking and the next-available search read the service and the date when
  // they START and act on them when they FINISH, so anything the client changes
  // in between opens a gap between what was asked and what is applied.
  const inFlight = booking || findingNext;

  // The CURRENT selection, readable from inside an async closure that captured
  // an older one. Written from an effect rather than during render, so nothing
  // mutates a ref while React is rendering.
  const selectionRef = useRef({ serviceId, date });
  useEffect(() => {
    selectionRef.current = { serviceId, date };
  }, [serviceId, date]);

  // Any change to the service or date invalidates the slot list. Leaving a
  // stale list on screen would let someone submit a time that was offered for a
  // different service — refused by the server, but confusing to read.
  //
  // IT IS ALSO THE ONLY SLOT LOADER. A refusal that wants fresh times bumps
  // `slotReloadNonce` rather than calling the action itself: a second call sited
  // in the submit handler would close over the service and date as they were
  // when the submit STARTED, and writing its answer back could show one
  // service's times under another's if the client changed the selection while
  // the booking was in flight. Here the values are always the current ones, and
  // the cancellation flag retires any answer that arrives after they move.
  //
  // The error is NOT cleared here. Clearing it would wipe "that time is no
  // longer available" the moment the refusal asked for the refresh that proves
  // it. Changing the service or the date clears it instead, which is the moment
  // it actually stops being true.
  useEffect(() => {
    if (!serviceId || !date) {
      // NOTHING IS SELECTED, SO NEITHER AVAILABILITY CONCLUSION IS TRUE. This
      // branch used to return BEFORE the resets below, leaving `slotLoad` on
      // its previous `loaded` and `noneInHorizon` on a previous verdict — so
      // clearing the date rendered "No times are available on that date" for a
      // date that no longer existed. An early return must still leave the state
      // it skipped in a coherent place.
      setSlots([]);
      setPicked(null);
      setSlotLoad("idle");
      setNoneInHorizon(false);
      return;
    }
    let cancelled = false;
    setPicked(null);
    setNoneInHorizon(false);
    // Set synchronously, so a reload never shows the previous run's verdict.
    setSlotLoad("loading");
    startLoadingSlots(async () => {
      // A REJECTED ACTION MUST NOT REACH THE ERROR BOUNDARY. An unhandled
      // rejection inside this transition propagates to the route boundary and
      // can replace the whole portal page — for a transient network blip on a
      // background slot fetch. It is caught and reported like any other
      // unavailable, honouring the same cancellation flag.
      let res: Awaited<ReturnType<typeof loadPortalRebookSlotsAction>> | null = null;
      try {
        res = await loadPortalRebookSlotsAction({ serviceId, date });
      } catch {
        if (cancelled) return;
        setSlots([]);
        setSlotLoad("failed");
        setError(PORTAL_REBOOK_GENERIC_REFUSAL);
        return;
      }
      if (cancelled) return;
      if (!res.ok) {
        if (res.code === "session_expired") {
          router.push("/portal/login");
          return;
        }
        setError(res.error);
        setSlots([]);
        setSlotLoad("failed");
        return;
      }
      setSlots(res.slots);
      setSlotLoad("loaded");
    });
    return () => {
      cancelled = true;
    };
  }, [serviceId, date, slotReloadNonce, router]);

  function onNextAvailable() {
    if (!serviceId) return;
    // NOTHING SENSIBLE TO SEARCH FROM. The control is disabled in this state,
    // so this is the second line of defence rather than the first.
    const fromDate = nextCalendarDay(date);
    if (fromDate === null) return;
    setError(null);
    setNoneInHorizon(false);
    // The selection this search is ABOUT, captured before it starts.
    const asked = { serviceId, date };
    startFindingNext(async () => {
      // Same containment as the slot fetch: a rejected action here would reach
      // the route's error boundary instead of the card's own error line.
      let res: Awaited<
        ReturnType<typeof loadPortalRebookNextAvailableAction>
      > | null = null;
      let rejected = false;
      try {
        res = await loadPortalRebookNextAvailableAction({
          serviceId: asked.serviceId,
          // Walk forward from the day AFTER the one on screen, so pressing this
          // repeatedly keeps advancing instead of re-finding the same date.
          fromDate,
        });
      } catch {
        rejected = true;
      }
      // A SUPERSEDED ANSWER IS DISCARDED, WHOLE. The controls are inert while
      // this runs, so the selection should not have moved — but if it did, this
      // answer is about service A and would move service B to a date that is
      // not its next available one, or overwrite a date the client just picked
      // by hand. Every branch below is about `asked`, so the guard covers the
      // error and the none-in-horizon verdict too, not only the date.
      // The staleness guard runs ONCE, before every branch — including the
      // rejection branch, which is about `asked` exactly as the others are.
      const now = selectionRef.current;
      if (now.serviceId !== asked.serviceId || now.date !== asked.date) return;
      if (rejected || res === null) {
        setError(PORTAL_REBOOK_GENERIC_REFUSAL);
        return;
      }
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
    // A NEXT-AVAILABLE SEARCH IS IN FLIGHT, so the date on screen is about to
    // move. Submitting now books the slot the client picked for the PREVIOUS
    // date while the UI is visibly looking for a later one. The button is
    // disabled in this state; this covers a keyboard submit that bypasses it.
    if (inFlight) return;
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
      let res: Awaited<ReturnType<typeof bookAnotherAppointmentAction>>;
      try {
        res = await bookAnotherAppointmentAction(fd);
      } catch {
        // THE LATCH MUST NOT SURVIVE A REJECTION. A transient network failure or
        // an unexpected pre-commit exception rejects the action rather than
        // returning a structured refusal. React clears the pending flag, so the
        // button looks usable again — but without this the latch stays set and
        // every later press returns at it, leaving the client unable to book
        // until they reload the page. Nothing was committed on this path, so the
        // honest answer is retryable copy.
        submittedRef.current = false;
        setError(PORTAL_REBOOK_GENERIC_REFUSAL);
        return;
      }
      if (!res.ok) {
        // A refusal is retryable, so the one-press latch is released.
        submittedRef.current = false;
        if (res.code === "session_expired") {
          router.push("/portal/login");
          return;
        }
        setError(res.error);
        if (res.code === "slot_taken") {
          // The time is gone. Ask the ONE loader above for fresh times against
          // whatever is selected NOW, rather than loading them here against a
          // selection that may already have moved.
          setPicked(null);
          setSlotReloadNonce((n) => n + 1);
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
      // NO `router.refresh()` HERE, AND THAT IS MEASURED RATHER THAN ASSUMED.
      //
      // A review finding said one was needed: that the Appointments section
      // below would stay stale and could read "No upcoming appointments"
      // beneath a confirmation saying the opposite. It does not. Next re-renders
      // the route a Server Action was invoked from when that action completes,
      // and the client applies the returned payload — so the list is already
      // current by the time this state is set.
      //
      // MEASURED, in the browser journey, with the appointments assertions
      // scoped to the list and the scope itself pinned: the list is current
      // with `router.refresh()` removed, AND with `revalidatePath("/portal")`
      // removed as well. Neither call is what carries it. The refresh was a
      // second round trip buying nothing, so it is gone.
      //
      // `revalidatePath` STAYS, for what it actually does: invalidating the
      // cached route for OTHER entry points — a later soft navigation to
      // /portal, and the studio-side /calendar surfaces. This journey does not
      // depend on it, and no longer claims to prove it.
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
          disabled={inFlight}
          onChange={(e) => {
            setError(null);
            setServiceId(e.target.value);
          }}
          className="border border-neutral-300 px-3 py-2 text-[14px] disabled:opacity-50"
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
            disabled={inFlight}
            onChange={(e) => {
              setError(null);
              setDate(e.target.value);
            }}
            className="border border-neutral-300 px-3 py-2 text-[14px] disabled:opacity-50"
          />
          <button
            type="button"
            data-testid="portal-rebook-next-available"
            onClick={onNextAvailable}
            disabled={inFlight || date.length === 0 || noneInHorizon}
            className="border border-neutral-900 px-4 py-2 text-[12px] font-medium uppercase disabled:opacity-50"
            style={{ letterSpacing: "0.1em" }}
          >
            {findingNext ? "Looking…" : "Next available"}
          </button>
        </div>
      </label>

      {/* HORIZON EXHAUSTION IS TWO DIFFERENT FACTS, and saying the stronger
          one while bookable times are on screen is simply false.

          "Next available" searches forward from the day AFTER the one
          displayed. So a null answer on a day that HAS times means only that
          there is nothing LATER — not that the studio has nothing. The single
          sentence this replaced said "No open times left in <studio>'s booking
          window" directly above a list of still-bookable slots.

          Both sentences are the PUBLIC picker's own, verbatim
          (app/book/[slug]/PublicBookForm.tsx), which already distinguishes
          these two states. A second voice for the same fact is how the two
          surfaces start disagreeing. */}
      {noneInHorizon && (
        <p
          data-testid="portal-rebook-none-in-horizon"
          data-horizon-state={slots.length > 0 ? "no-later" : "none-in-window"}
          className="text-[13px]"
          style={{ color: "#3F3F3F" }}
        >
          {slots.length > 0
            ? "No later availability is currently published. Please contact the studio."
            : "No availability within the current booking window. Please check back later or contact the studio."}
        </p>
      )}

      {loadingSlots ? (
        <p className="text-[13px]" style={{ color: "#6B6B6B" }}>
          Loading times…
        </p>
      ) : slotLoad === "failed" || slotLoad === "idle" ? null : slots.length === 0 ? (
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
                disabled={inFlight}
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
        disabled={inFlight || picked == null}
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
