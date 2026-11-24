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

type BookingContext = {
  initialDate?: string;
  visiblePractitionerIds?: readonly string[];
  initialPractitionerId?: string;
  initialStartTime?: string;
  onBooked?: (date: string, practitionerId: string) => void;
};

type DeskBookingProps = BookingContext & {
  studioId: string;
  options?: DeskBookingOptions;
  initiallyOpen?: boolean;
};

export function DeskBooking({ studioId, options: suppliedOptions, initiallyOpen, ...context }: DeskBookingProps) {
  const scopedOptions = suppliedOptions?.studioId === studioId ? suppliedOptions : null;
  const [options, setOptions] = useState<DeskBookingOptions | null>(initiallyOpen ? scopedOptions : null);
  const [loading, startLoading] = useTransition();
  const [notice, setNotice] = useState("");
  const panel = useRef<HTMLElement>(null);

  function start() {
    setNotice("");
    if (scopedOptions) { setOptions(scopedOptions); return; }
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
      {!options && <Button type="button" variant="primary" pending={loading} disabled={context.visiblePractitionerIds?.length === 0}
        onClick={start}>Find an opening</Button>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {options && <DeskBookingForm {...context} options={options} onClose={close} />}
    </section>
  );
}

function DeskBookingForm({ options, onClose, initialDate, visiblePractitionerIds, initialPractitionerId, initialStartTime, onBooked }:
  BookingContext & { options: DeskBookingOptions; onClose: (message?: string) => void }) {
  const router = useRouter();
  const heading = useRef<HTMLHeadingElement>(null);
  const today = todayInTz(options.timezone);
  const selectedDate = initialDate && initialDate > today ? initialDate : today;
  const staff = options.practitioners.filter(p => !visiblePractitionerIds || visiblePractitionerIds.includes(p.id));
  const [serviceId, setServiceId] = useState(options.services[0]?.id ?? "");
  const [person, setPerson] = useState(staff.find(p => p.id === initialPractitionerId)?.id ?? (staff.length === 1 ? staff[0].id : ""));
  const [timeWindow, setTimeWindow] = useState("any");
  const [earliest, setEarliest] = useState(initialStartTime ?? "00:00");
  const [from, setFrom] = useState(selectedDate);
  const [through, setThrough] = useState(selectedDate);
  const [times, setTimes] = useState<DeskOpening[] | null>(null);
  const [limited, setLimited] = useState(false);
  const [shownCount, setShownCount] = useState(4);
  const [opening, setOpening] = useState<DeskOpening | null>(null);
  const [query, setQuery] = useState("");
  const [clients, setClients] = useState<DeskBookingClient[] | null>(null);
  const [client, setClient] = useState<DeskBookingClient | null>(null);
  const [error, setError] = useState("");
  const [pending, startRequest] = useTransition();
  const submitting = useRef(false);
  useEffect(() => { heading.current?.focus(); }, [opening]);
  const service = options.services.find(s => s.id === serviceId);
  const firstByPractitioner = new Map<string, DeskOpening>();
  const otherTimes: DeskOpening[] = [];
  for (const time of times ?? []) {
    if (firstByPractitioner.has(time.practitionerId)) otherTimes.push(time);
    else firstByPractitioner.set(time.practitionerId, time);
  }

  function openingButton(time: DeskOpening) {
    return <Button type="button" key={time.practitionerId + time.start} className="h-auto justify-start whitespace-normal text-left"
      onClick={() => { setError(""); setOpening(time); }}>
      {formatStudioDateTime(time.start, options.timezone)} · {time.practitionerName} · until {formatStudioTime(time.end, options.timezone)}
    </Button>;
  }

  function clearTimes() {
    setTimes(null);
    setShownCount(4);
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
          studioId: options.studioId, serviceId, practitionerIds: person ? [person] : staff.map(p => p.id),
          fromDate: from, toDate: through, earliest: timeWindow === "pm" && earliest < "12:00" ? "12:00" : earliest,
          latestEnd: timeWindow === "am" ? "12:00" : null,
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
          onBooked?.(opening.date, opening.practitionerId);
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
        <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold">{opening ? "Book appointment" : "Find an opening"}</h2>
        <Button type="button" size="sm" variant="quiet" onClick={() => onClose()}>Close</Button>
      </div>
      {!opening && <>
        {options.services.length === 0 ? <p className="text-sm">No services are available for booking.</p> :
          <form onSubmit={findTimes} className="grid gap-3 sm:grid-cols-2">
            <FieldLabel label="Service"><select required className={fieldControlClass()} value={serviceId} onChange={e => { clearTimes(); setServiceId(e.target.value); }}>
              {options.services.map(s => <option key={s.id} value={s.id}>{s.name} · {s.durationMinutes} min</option>)}
            </select></FieldLabel>
            <FieldLabel label="Practitioner"><select className={fieldControlClass()} value={person} onChange={e => { clearTimes(); setPerson(e.target.value); }}>
              {staff.length > 1 && <option value="">Any visible practitioner</option>}
              {staff.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></FieldLabel>
            <FieldLabel label="From"><input type="date" required min={today} value={from} className={fieldControlClass()} onChange={e => {
              const date = e.target.value;
              clearTimes(); setFrom(date);
              if (date && (from === through || through < date || through > addDays(date, 6))) setThrough(date);
            }} /></FieldLabel>
            <FieldLabel label="Through"><input type="date" required min={from} max={from ? addDays(from, 6) : undefined}
              value={through} className={fieldControlClass()} onChange={e => { clearTimes(); setThrough(e.target.value); }} /></FieldLabel>
            {from && <div className="flex flex-wrap gap-1 sm:col-span-2">
              <Button type="button" size="sm" variant="quiet" aria-pressed={through === from}
                onClick={() => { clearTimes(); setThrough(from); }}>Selected day</Button>
              <Button type="button" size="sm" variant="quiet" aria-pressed={through === addDays(from, 6)}
                onClick={() => { clearTimes(); setThrough(addDays(from, 6)); }}>Next 7 days</Button>
            </div>}
            <FieldLabel label="Time of day"><select value={timeWindow} className={fieldControlClass()} onChange={event => {
              clearTimes(); setTimeWindow(event.target.value);
              if (event.target.value === "am" && earliest >= "12:00") setEarliest("00:00");
            }}>
              <option value="any">Any time</option><option value="am">Before noon</option><option value="pm">Noon onward</option>
            </select></FieldLabel>
            <FieldLabel label="Earliest start"><input required type="time" className={fieldControlClass()}
              value={timeWindow === "pm" && earliest < "12:00" ? "12:00" : earliest}
              min={timeWindow === "pm" ? "12:00" : undefined} max={timeWindow === "am" ? "11:59" : undefined}
              onChange={event => { clearTimes(); setEarliest(event.target.value); }} /></FieldLabel>
            <Button type="submit" variant="primary" disabled={!staff.length} pending={pending} className="sm:justify-self-start">Search availability</Button>
          </form>}
        {times && <div className="space-y-2">
          <h3 className="text-sm font-semibold">First opening per practitioner</h3>
          <p className="text-xs text-fg-muted">{options.timezone}</p>
          {times.length === 0 && <p role="status" className="text-sm">No openings match. Try another service, practitioner, or time window.</p>}
          <div className="flex flex-wrap gap-2">{[...firstByPractitioner.values()].map(openingButton)}</div>
          {otherTimes.length > 0 && <details className="space-y-2">
            <summary className="cursor-pointer text-sm font-medium">Other available times</summary>
            <div className="flex flex-wrap gap-2">{otherTimes.slice(0, shownCount).map(openingButton)}</div>
            {otherTimes.length > shownCount && <Button type="button" size="sm" onClick={() => setShownCount(shownCount + 8)}>Show more times</Button>}
          </details>}
          {limited && <p className="text-sm text-fg-muted">More openings are available. Narrow the dates, time, or practitioner to see them.</p>}
        </div>}
      </>}
      {opening && <>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface-sunken p-3">
          <div><p className="font-medium">{formatStudioDateTime(opening.start, options.timezone)} · {opening.practitionerName}</p>
            <p className="text-sm text-fg-muted">{service?.name} · {service?.durationMinutes} min · {options.timezone}</p></div>
          <Button type="button" size="sm" onClick={() => { setOpening(null); setClient(null); setClients(null); setQuery(""); setError(""); }}>Change time</Button>
        </div>
        <form onSubmit={findClients} className="flex flex-wrap items-end gap-2">
          <FieldLabel label="Find an existing client" className="min-w-0 flex-1">
            <input className={fieldControlClass()} required minLength={2} maxLength={80} autoComplete="off"
              placeholder="Client name, email or phone" value={query}
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
