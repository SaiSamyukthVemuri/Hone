"use client";

import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { DeskBookingClient, DeskBookingOptions, DeskOpening } from "@/lib/desk/booking";
import { Button } from "@/components/ui/button";
import { FieldLabel, fieldControlClass } from "@/components/ui/field";
import { addDays, todayInTz } from "@/lib/booking/tz";
import { formatStudioDateTime, formatStudioTime } from "@/lib/desk/time";
import {
  bookDeskOpeningAction,
  findDeskOpeningsAction,
  getDeskBookingOptionsAction,
  searchDeskBookingClientsAction,
} from "./booking-actions";

export function DeskBooking({ studioId }: { studioId: string }) {
  const [options, setOptions] = useState<DeskBookingOptions | null>(null);
  const [loading, startLoading] = useTransition();
  const [notice, setNotice] = useState("");
  const panel = useRef<HTMLElement>(null);

  function start() {
    setNotice("");
    startLoading(async () => {
      try {
        const result = await getDeskBookingOptionsAction();
        if (!result.ok) setNotice(result.error);
        else if (result.studioId !== studioId) setNotice("Your selected studio changed. Refresh this desk to book.");
        else setOptions(result);
      } catch {
        setNotice("Could not load booking options. Try again.");
      }
    });
  }

  function close(message = "") {
    setOptions(null);
    setNotice(message);
    requestAnimationFrame(() => panel.current?.querySelector("button")?.focus());
  }

  return (
    <section ref={panel} aria-label="Desk booking" className="space-y-3">
      {!options && <Button type="button" variant="primary" pending={loading} onClick={start}>Find time</Button>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {options && <DeskBookingForm options={options} onClose={close} />}
    </section>
  );
}

function DeskBookingForm({ options, onClose }: { options: DeskBookingOptions; onClose: (message?: string) => void }) {
  const router = useRouter();
  const heading = useRef<HTMLHeadingElement>(null);
  const today = todayInTz(options.timezone);
  const [serviceId, setServiceId] = useState(options.services[0]?.id ?? "");
  const [person, setPerson] = useState("");
  const [from, setFrom] = useState(today);
  const [through, setThrough] = useState(addDays(today, 2));
  const [times, setTimes] = useState<DeskOpening[] | null>(null);
  const [limited, setLimited] = useState(false);
  const [shownPerDay, setShownPerDay] = useState(4);
  const [opening, setOpening] = useState<DeskOpening | null>(null);
  const [query, setQuery] = useState("");
  const [clients, setClients] = useState<DeskBookingClient[] | null>(null);
  const [client, setClient] = useState<DeskBookingClient | null>(null);
  const [error, setError] = useState("");
  const [pending, startRequest] = useTransition();
  const submitting = useRef(false);
  useEffect(() => { heading.current?.focus(); }, [opening]);
  const service = options.services.find(s => s.id === serviceId);
  const byDate = new Map<string, DeskOpening[]>();
  for (const time of times ?? []) {
    const group = byDate.get(time.date);
    if (group) group.push(time);
    else byDate.set(time.date, [time]);
  }

  function clearTimes() {
    setTimes(null);
    setShownPerDay(4);
    setOpening(null);
    setClient(null);
    setClients(null);
    setQuery("");
    setError("");
  }

  function findTimes(event: FormEvent) {
    event.preventDefault();
    clearTimes();
    startRequest(async () => {
      try {
        const result = await findDeskOpeningsAction({
          studioId: options.studioId, serviceId, practitionerId: person || null, fromDate: from, toDate: through,
        });
        if (!result.ok) setError(result.error);
        else {
          setTimes(result.openings);
          setLimited(Boolean(result.limited));
        }
      } catch {
        setError("Could not load available times. Try again.");
      }
    });
  }

  function findClients(event: FormEvent) {
    event.preventDefault();
    setError("");
    setClients(null);
    setClient(null);
    startRequest(async () => {
      try {
        const result = await searchDeskBookingClientsAction({ studioId: options.studioId, query: query.trim() });
        if (result.ok) setClients(result.clients);
        else setError(result.error);
      } catch {
        setError("Could not find clients. Try again.");
      }
    });
  }

  function confirm() {
    if (!opening || !client || submitting.current) return;
    submitting.current = true;
    setError("");
    startRequest(async () => {
      try {
        const result = await bookDeskOpeningAction({
          studioId: options.studioId, serviceId: opening.serviceId, practitionerId: opening.practitionerId,
          clientId: client.id, start: opening.start, end: opening.end,
        });
        if (result.ok) {
          router.refresh();
          onClose(`Booked ${formatStudioDateTime(opening.start, options.timezone)} with ${opening.practitionerName}. No booking confirmation was sent.`);
        } else {
          clearTimes();
          setError(result.error);
        }
      } catch {
        onClose("We couldn’t confirm whether the appointment was saved. Check the schedule before trying again.");
      } finally {
        submitting.current = false;
      }
    });
  }

  return (
    <fieldset disabled={pending} aria-busy={pending} className="min-w-0 space-y-4 rounded-xl border border-line bg-surface p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold">{opening ? "Book appointment" : "Find time"}</h2>
        <Button type="button" size="sm" variant="quiet" onClick={() => onClose()}>Close</Button>
      </div>
      {!opening && <>
        {options.services.length === 0 ? <p className="text-sm">No services are available for booking.</p> :
          <form onSubmit={findTimes} className="grid gap-3 sm:grid-cols-2">
            <FieldLabel label="Service"><select required className={fieldControlClass()} value={serviceId} onChange={e => { clearTimes(); setServiceId(e.target.value); }}>
              {options.services.map(s => <option key={s.id} value={s.id}>{s.name} · {s.durationMinutes} min</option>)}
            </select></FieldLabel>
            <FieldLabel label="Practitioner"><select className={fieldControlClass()} value={person} onChange={e => { clearTimes(); setPerson(e.target.value); }}>
              <option value="">Anyone available</option>
              {options.practitioners.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></FieldLabel>
            <FieldLabel label="From"><input type="date" required min={today} value={from} className={fieldControlClass()} onChange={e => {
              const date = e.target.value;
              clearTimes(); setFrom(date);
              if (date && (through < date || through > addDays(date, 6))) setThrough(addDays(date, 2));
            }} /></FieldLabel>
            <FieldLabel label="Through"><input type="date" required min={from} max={from ? addDays(from, 6) : undefined}
              value={through} className={fieldControlClass()} onChange={e => { clearTimes(); setThrough(e.target.value); }} /></FieldLabel>
            <Button type="submit" variant="primary" pending={pending} className="sm:justify-self-start">Search availability</Button>
          </form>}
        {times && <div className="space-y-2">
          <h3 className="text-sm font-semibold">Available times · {options.timezone}</h3>
          {times.length === 0 && <p role="status" className="text-sm">No openings match. Try another date or practitioner.</p>}
          {[...byDate].map(([date, matches]) => <div key={date} className="space-y-1">
            <h4 className="text-sm font-medium">{new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: options.timezone }).format(new Date(matches[0].start))}</h4>
            <div className="flex flex-wrap gap-2">
              {matches.slice(0, shownPerDay).map(time => <Button type="button" key={time.practitionerId + time.start}
                onClick={() => setOpening(time)}>{formatStudioTime(time.start, options.timezone)} · {time.practitionerName}</Button>)}
            </div>
          </div>)}
          {[...byDate.values()].some(matches => matches.length > shownPerDay) &&
            <Button type="button" size="sm" onClick={() => setShownPerDay(shownPerDay + 8)}>Show more times</Button>}
          {limited && <p className="text-sm text-fg-muted">Showing the earliest matches. Narrow the dates or choose a practitioner for more times.</p>}
        </div>}
      </>}
      {opening && <>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface-sunken p-3">
          <div><p className="font-medium">{formatStudioDateTime(opening.start, options.timezone)} · {opening.practitionerName}</p>
            <p className="text-sm text-fg-muted">{service?.name} · {service?.durationMinutes} min · {options.timezone}</p></div>
          <Button type="button" size="sm" onClick={() => { clearTimes(); }}>Change time</Button>
        </div>
        <form onSubmit={findClients} className="flex flex-wrap items-end gap-2">
          <FieldLabel label="Find an existing client" className="min-w-0 flex-1">
            <input className={fieldControlClass()} required minLength={2} maxLength={80} autoComplete="off"
              placeholder="Preferred name, email or phone" value={query}
              onChange={e => { setQuery(e.target.value); setClient(null); setClients(null); setError(""); }} />
          </FieldLabel>
          <Button type="submit" disabled={query.trim().length < 2}>Find client</Button>
        </form>
        {clients && <div className="space-y-1">
          {clients.length === 0 && <p role="status" className="text-sm">No matching clients.</p>}
          {clients.map(match => {
            const ambiguous = clients.some(other => other.id !== match.id && other.displayName === match.displayName && other.contactHint === match.contactHint);
            return <Button key={match.id} type="button" disabled={ambiguous} aria-pressed={client?.id === match.id}
              className="mr-1 aria-pressed:bg-sky-100 aria-pressed:text-sky-900" onClick={() => setClient(match)}>
              {match.displayName}{match.contactHint && ` · ${match.contactHint}`}{ambiguous && " · Refine search"}
            </Button>;
          })}
        </div>}
        {client && <Button type="button" variant="primary" pending={pending} busyLabel="Booking…" onClick={confirm}>
          Book appointment for {client.displayName}
        </Button>}
      </>}
      {pending && !submitting.current && <p role="status" className="text-sm text-fg-muted">Loading…</p>}
      {error && <p role="alert" className="text-sm text-danger-solid">{error}</p>}
    </fieldset>
  );
}
