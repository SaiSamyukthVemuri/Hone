"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { FieldLabel, fieldControlClass } from "@/components/ui/field";
import { SectionLabel } from "@/components/ui/section-label";
import { addDays, formatClockLabel, type TimeFormat } from "@/lib/booking/tz";
import type { CalendarRebookSource } from "@/lib/calendar/rebook-source";
import type { Service } from "@/lib/types/database";
import { monthDayLabel, weekdayLabel } from "./calendar-format";
import { findCalendarOpeningsAction, type CalendarOpening } from "./find-time-actions";

export type FindTimeService = Pick<Service, "id" | "name" | "default_duration_minutes">;
export type { CalendarOpening };

export function CalendarFindTime({
  services, practitioners, isOwner, viewerId, today, anchorDate, timeFormat, rebook, selected,
  onSelect, onClear,
}: {
  services: ReadonlyArray<FindTimeService>;
  practitioners: ReadonlyArray<{ id: string; name: string }>;
  isOwner: boolean;
  viewerId: string;
  today: string;
  anchorDate: string;
  timeFormat: TimeFormat;
  rebook?: CalendarRebookSource | null;
  selected: CalendarOpening | null;
  onSelect: (opening: CalendarOpening) => void;
  onClear: () => void;
}) {
  const preferred = practitioners.find((p) => p.id === rebook?.practitionerId);
  const [serviceId, setServiceId] = useState(rebook?.serviceId ?? services[0]?.id ?? "");
  const [durationFilter, setDurationFilter] = useState<number | null>(
    rebook ? services.find((s) => s.id === rebook.serviceId)?.default_duration_minutes ?? null : null,
  );
  const [limited, setLimited] = useState(false);
  const [person, setPerson] = useState(isOwner ? preferred?.id ?? "" : viewerId);
  const [fromDate, setFromDate] = useState(anchorDate > today ? anchorDate : today);
  const [toDate, setToDate] = useState(() => addDays(fromDate, 2));
  const [openings, setOpenings] = useState<CalendarOpening[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [limit, setLimit] = useState(4);
  const request = useRef(0);
  useEffect(() => () => { request.current += 1; }, []);
  const service = services.find((s) => s.id === serviceId);
  const durations = [...new Set(services.map((s) => s.default_duration_minutes))].sort((a, b) => a - b);
  const matchingServices = services.filter((s) => !durationFilter || s.default_duration_minutes === durationFilter);

  function invalidate() {
    request.current += 1;
    setOpenings(null);
    setLimited(false);
    setLoading(false);
    setError("");
    setLimit(4);
    onClear();
  }
  async function search(event: FormEvent) {
    event.preventDefault();
    invalidate();
    if (!service || !fromDate || !toDate) return;
    const current = request.current;
    setLoading(true);
    try {
      const result = await findCalendarOpeningsAction({ serviceId, fromDate, toDate, practitionerId: person || null });
      if (request.current !== current) return;
      if (result.ok) {
        setOpenings(result.openings);
        setLimited(result.limited === true);
      } else setError(result.error);
    } catch {
      if (request.current === current) setError("Couldn’t load available times. Try again.");
    } finally {
      if (request.current === current) setLoading(false);
    }
  }
  const days = new Map<string, CalendarOpening[]>();
  for (const opening of openings ?? []) {
    const items = days.get(opening.date);
    if (items) items.push(opening);
    else days.set(opening.date, [opening]);
  }
  return (
    <section aria-label="Find time" className="space-y-4">
      {services.length === 0 ? <p className="text-sm text-fg-muted">No active services to book.</p> :
        <form onSubmit={search} className="grid gap-3">
          {durations.length > 1 && <fieldset>
            <legend className="mb-1"><SectionLabel size="caption">Duration</SectionLabel></legend>
            <div className="flex flex-wrap gap-1">
              {[null, ...durations].map((minutes) => <Button key={minutes ?? "all"} size="sm"
                aria-pressed={minutes === durationFilter} variant={minutes === durationFilter ? "primary" : "secondary"}
                onClick={() => {
                  invalidate();
                  setDurationFilter(minutes);
                  if (minutes && minutes !== service?.default_duration_minutes) setServiceId("");
                }}>{minutes ? minutes + " min" : "All"}</Button>)}
            </div>
          </fieldset>}
          <FieldLabel label="Service">
            <select required className={fieldControlClass()} value={serviceId} onChange={(e) => { invalidate(); setServiceId(e.target.value); }}>
              {!serviceId && <option value="">Choose a service</option>}
              {matchingServices.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.default_duration_minutes} min</option>)}
            </select>
          </FieldLabel>
          {rebook && service && rebook.durationMinutes !== service.default_duration_minutes && <p className="text-xs text-fg-muted">
            The previous appointment was {rebook.durationMinutes} minutes. This service books for {service.default_duration_minutes} minutes.
          </p>}
          <FieldLabel label="Practitioner">
            <select className={fieldControlClass()} value={person} disabled={!isOwner}
              onChange={(e) => { invalidate(); setPerson(e.target.value); }}>
              {isOwner && <option value="">Anyone available</option>}
              {practitioners.filter((p) => isOwner || p.id === viewerId).map((p) =>
                <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </FieldLabel>
          {rebook?.practitionerId && (!preferred || (!isOwner && rebook.practitionerId !== viewerId)) &&
            <p className="text-xs text-fg-muted">The previous practitioner is unavailable for this search.</p>}
          <FieldLabel label="From">
            <input type="date" required min={today} value={fromDate} className={fieldControlClass()} onChange={(e) => {
              const date = e.target.value;
              invalidate(); setFromDate(date);
              if (date && (toDate < date || toDate > addDays(date, 6))) setToDate(addDays(date, 2));
            }} />
          </FieldLabel>
          <FieldLabel label="Through">
            <input type="date" required min={fromDate} max={fromDate ? addDays(fromDate, 6) : undefined}
              value={toDate} className={fieldControlClass()} onChange={(e) => { invalidate(); setToDate(e.target.value); }} />
          </FieldLabel>
          <Button type="submit" size="sm" pending={loading} busyLabel="Searching…" disabled={!service}>Search availability</Button>
        </form>}
      {error && <p role="alert" className="text-sm text-danger-solid">{error}</p>}
      {openings && <section aria-label="Available times" className="space-y-3">
        <h3 className="text-sm font-semibold">Available times</h3>
        {days.size === 0 && <p role="status" className="text-sm text-fg-muted">No openings match. Try a different service, practitioner, or date.</p>}
        {[...days].map(([date, items]) => <div key={date}>
          <h4 className="mb-1 text-xs font-medium text-fg-muted">{weekdayLabel(new Date(date + "T00:00:00Z").getUTCDay())}, {monthDayLabel(date)}</h4>
          <div className="grid gap-1">
            {items.slice(0, limit).map((o) => <Button variant="quiet" size="sm" key={o.start + o.practitionerId}
              aria-pressed={selected?.start === o.start && selected.practitionerId === o.practitionerId}
              className="justify-start text-left aria-pressed:bg-sky-100 aria-pressed:text-sky-900" onClick={() => onSelect(o)}>
              {formatClockLabel(o.localTime, timeFormat)} · {o.practitionerName}
            </Button>)}
          </div>
        </div>)}
        {limited && <p className="text-xs text-fg-muted">Showing the earliest 48 openings per day. Choose a practitioner to narrow the results.</p>}
        {[...days.values()].some((items) => items.length > limit) &&
          <Button size="sm" onClick={() => setLimit(limit + 8)}>Show more times</Button>}
      </section>}
    </section>
  );
}
