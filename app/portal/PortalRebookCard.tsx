"use client";

import { useEffect, useState, useTransition } from "react";
import {
  bookAnotherAppointmentAction,
  loadPortalRebookSlotsAction,
  type PortalRebookResult,
} from "./rebook-actions";

// EMERG-PORTAL-REBOOK-01 — "Book another appointment" for a signed-in client.
//
// THE THIRD SIDE OF A TRIANGLE THAT HAD TWO. `/book/<slug>` sends a returning
// client to the portal, and the portal could only manage appointments that
// already existed. There was no way back to booking.
//
// WHAT THIS COMPONENT DELIBERATELY DOES NOT COLLECT: email, name, phone, or any
// client identifier. It posts a service and a start time. Identity is resolved
// server-side from the portal session, which is the property the whole unit
// rests on — see rebook-actions.ts. Adding an identity field here would be the
// regression, so its absence is the contract and
// tests/source-guards/portal-rebook-identity.test.ts pins it.
//
// The slot list is fetched through a server action rather than rendered ahead of
// time: availability moves, and a list baked into the page at request time would
// invite a stale pick. The server re-checks the chosen start anyway, and the
// database re-checks it again under the studio lock.

type Service = { id: string; name: string };

export function PortalRebookCard({
  services,
  timezone,
}: {
  services: readonly Service[];
  timezone: string;
}) {
  const [serviceId, setServiceId] = useState<string>(services[0]?.id ?? "");
  const [date, setDate] = useState<string>("");
  const [slots, setSlots] = useState<readonly string[] | null>(null);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [result, setResult] = useState<PortalRebookResult | null>(null);
  const [loadingSlots, startLoadingSlots] = useTransition();
  const [booking, startBooking] = useTransition();

  // Any change to the service or date invalidates the slot list. Leaving a
  // stale list on screen would let someone submit a time that was offered for
  // a different service — refused by the server, but confusing to read.
  useEffect(() => {
    setSlots(null);
    setSlotsError(null);
    setResult(null);
    if (serviceId.length === 0 || date.length === 0) return;
    startLoadingSlots(async () => {
      const res = await loadPortalRebookSlotsAction(serviceId, date);
      if (res.ok) setSlots(res.slots);
      else setSlotsError(res.error);
    });
  }, [serviceId, date]);

  if (services.length === 0) return null;

  if (result?.ok) {
    return (
      <div data-testid="portal-rebook-confirmed" className="flex flex-col gap-2">
        <h3 className="text-[15px] font-medium">Appointment booked</h3>
        <p className="text-[14px] text-neutral-600">
          {result.serviceName} —{" "}
          {new Date(result.startsAt).toLocaleString(undefined, {
            timeZone: timezone,
            dateStyle: "full",
            timeStyle: "short",
          })}
        </p>
        <p className="text-[13px] text-neutral-500">
          It is now listed with your upcoming appointments.
        </p>
      </div>
    );
  }

  return (
    <div data-testid="portal-rebook" className="flex flex-col gap-4">
      <div>
        <h3 className="text-[15px] font-medium">Book another appointment</h3>
        <p className="mt-1 text-[13px] text-neutral-500">
          You are signed in, so there is nothing to re-enter.
        </p>
      </div>

      <label className="flex flex-col gap-1 text-[13px]">
        <span className="text-neutral-600">Service</span>
        <select
          data-testid="portal-rebook-service"
          value={serviceId}
          onChange={(e) => setServiceId(e.target.value)}
          className="border border-neutral-300 px-3 py-2 text-[14px]"
        >
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-[13px]">
        <span className="text-neutral-600">Date</span>
        <input
          data-testid="portal-rebook-date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="border border-neutral-300 px-3 py-2 text-[14px]"
        />
      </label>

      {loadingSlots ? (
        <p className="text-[13px] text-neutral-500">Loading times…</p>
      ) : null}

      {slotsError ? (
        <p data-testid="portal-rebook-slots-error" className="text-[13px] text-neutral-700">
          {slotsError}
        </p>
      ) : null}

      {slots !== null && !loadingSlots ? (
        slots.length === 0 ? (
          <p data-testid="portal-rebook-no-slots" className="text-[13px] text-neutral-700">
            No times are available on that date. Please choose another date.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2" data-testid="portal-rebook-slots">
            {slots.map((iso) => (
              <button
                key={iso}
                type="button"
                disabled={booking}
                onClick={() =>
                  startBooking(async () => {
                    const fd = new FormData();
                    // CHOICES ONLY — no identity travels with this request.
                    fd.set("serviceId", serviceId);
                    fd.set("startsAt", iso);
                    setResult(await bookAnotherAppointmentAction(fd));
                  })
                }
                className="border border-neutral-300 px-4 py-2 text-[13px] disabled:opacity-50"
              >
                {new Date(iso).toLocaleTimeString(undefined, {
                  timeZone: timezone,
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </button>
            ))}
          </div>
        )
      ) : null}

      {result && !result.ok ? (
        <p data-testid="portal-rebook-error" className="text-[13px] text-neutral-700">
          {result.error}
        </p>
      ) : null}
    </div>
  );
}
