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

/** The longest search the finder runs, in days. find-time-actions.ts refuses a longer range with the same number. */
export const FIND_TIME_MAX_DAYS = 7;

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
  // Said politely (a live region) when moving From had to move Through with it, so the change is never silent.
  const [notice, setNotice] = useState("");
  const fromRef = useRef<HTMLInputElement>(null);
  const throughRef = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  useEffect(() => () => { request.current += 1; }, []);
  const service = services.find((s) => s.id === serviceId);
  const durations = [...new Set(services.map((s) => s.default_duration_minutes))].sort((a, b) => a - b);
  const matchingServices = services.filter((s) => !durationFilter || s.default_duration_minutes === durationFilter);
  // The search window is up to seven days (find-time-actions.ts enforces the same rule). The form checks it itself and says what to change beside the field:
  // the browser's own bubble named only a date and gave no way forward (HON-131).
  const lastAllowed = fromDate ? addDays(fromDate, FIND_TIME_MAX_DAYS - 1) : "";
  const fromError = !fromDate ? "Choose a From date." : fromDate < today ? `From can't be before today. Choose ${monthDayLabel(today)} or later.` : "";
  const throughError = !toDate ? "Choose a Through date."
    : !fromDate ? ""
    : toDate < fromDate ? `Through can't be before From. Choose ${monthDayLabel(fromDate)} to ${monthDayLabel(lastAllowed)}.`
    : toDate > lastAllowed ? `You can search up to ${FIND_TIME_MAX_DAYS} days at a time. The latest Through date for this From is ${monthDayLabel(lastAllowed)}. To search a later week, move From later.`
    : "";

  function invalidate() {
    request.current += 1;
    setOpenings(null);
    setLimited(false);
    setLoading(false);
    setError("");
    setLimit(4);
    setNotice("");
    onClear();
  }
  async function search(event: FormEvent) {
    event.preventDefault();
    // An invalid range sends nothing and keeps every selection; focus goes to the field the message sits beside.
    if (fromError || throughError) {
      (fromError ? fromRef : throughRef).current?.focus();
      return;
    }
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
        <form onSubmit={search} noValidate className="grid gap-3">
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
            <input ref={fromRef} type="date" required min={today} value={fromDate} className={fieldControlClass()}
              aria-invalid={fromError ? true : undefined} aria-describedby={fromError ? "find-time-from-error find-time-window-help" : "find-time-window-help"}
              onChange={(e) => {
                const date = e.target.value;
                invalidate(); setFromDate(date);
                // Moving From can leave Through outside the window. Move it, and SAY so: a date the person typed never changes without a word.
                if (date && (toDate < date || toDate > addDays(date, FIND_TIME_MAX_DAYS - 1))) {
                  const moved = addDays(date, 2);
                  setToDate(moved);
                  setNotice(`Through moved to ${monthDayLabel(moved)} so the search stays within ${FIND_TIME_MAX_DAYS} days of ${monthDayLabel(date)}.`);
                }
              }} />
          </FieldLabel>
          {fromError && <p id="find-time-from-error" role="alert" className="-mt-1 text-xs text-danger-solid">{fromError}</p>}
          <FieldLabel label="Through">
            <input ref={throughRef} type="date" required value={toDate} className={fieldControlClass()}
              aria-invalid={throughError ? true : undefined} aria-describedby={throughError ? "find-time-through-error find-time-window-help" : "find-time-window-help"}
              onChange={(e) => { invalidate(); setToDate(e.target.value); }} />
          </FieldLabel>
          {throughError && <p id="find-time-through-error" role="alert" className="-mt-1 text-xs text-danger-solid">{throughError}</p>}
          <p id="find-time-window-help" className="-mt-1 text-xs text-fg-muted">Search up to {FIND_TIME_MAX_DAYS} days at a time.</p>
          <p role="status" aria-live="polite" data-testid="find-time-notice" className={notice ? "-mt-1 text-xs text-fg-muted" : "sr-only"}>{notice}</p>
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
