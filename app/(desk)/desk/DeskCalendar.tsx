"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { localDateString } from "@/lib/booking/tz";
import { monthYearLabel } from "@/lib/booking/month-grid";
import { practitionerInitials } from "@/lib/calendar/practitioner-identity";
import { resolvePractitionerColor } from "@/lib/practitioner-colors";
import type { DeskBookingOptions } from "@/lib/desk/booking";
import type { DeskScheduleRow } from "@/lib/desk/read";
import { formatStudioTime } from "@/lib/desk/time";
import { DeskBooking } from "./DeskBooking";
import { DeskTimeGrid } from "./DeskTimeGrid";
import { DeskVisitDetails } from "./DeskVisitDetails";
import { deskDays, deskDateLabel, deskHref, deskRoster, shiftDeskDate, UNASSIGNED, type DeskView, type DeskPerson } from "./desk-period";

const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const fullDate = (date: string) => deskDateLabel(date, { dateStyle: "full" });
const shortDate = (date: string) => deskDateLabel(date, { month: "short", day: "numeric" });
const visitCount = (n: number) => `${n} ${n === 1 ? "visit" : "visits"}`;
const navStyle = "inline-flex min-h-11 items-center justify-center rounded-md border border-line px-3 text-sm hover:bg-surface-sunken aria-[current=page]:bg-fg aria-[current=page]:text-surface";

function Swatch({ person }: { person: DeskPerson }) {
  return <span aria-hidden="true" className={`inline-block h-2 w-2 shrink-0 rounded-full ${resolvePractitionerColor(person.color).bg}`} />;
}

type CalendarProps = {
  studioId: string; today: string; date: string; view: DeskView; timezone: string;
  rows: DeskScheduleRow[]; booking: DeskBookingOptions | null;
};
export function DeskCalendar(props: CalendarProps) {
  // Hidden IDs persist across date and view navigation within this studio. A newly added practitioner starts visible.
  const [hidden, setHidden] = useState<string[]>([]);
  return <CalendarPeriod key={props.date + props.view} {...props} hidden={hidden} setHidden={setHidden} />;
}

function CalendarPeriod({ studioId, today, date, view, timezone, rows, booking, hidden, setHidden }: CalendarProps & {
  hidden: string[]; setHidden: (ids: string[]) => void;
}) {
  const router = useRouter();
  const [selectedDate, setDate] = useState(date);
  const [visitId, setVisit] = useState<string | null>(null);
  const [bookingStart, setBookingStart] = useState<{ p: string; time: string; sequence: number } | null>(null);
  const [bookedDate, setBookedDate] = useState("");
  const agenda = useRef<HTMLElement>(null);
  const selectedCell = useRef<HTMLButtonElement>(null);
  const finder = useRef<HTMLDivElement>(null);
  const days = deskDays(date, view);
  const roster = deskRoster(booking?.practitioners ?? [], rows);
  const people = roster.filter(p => !hidden.includes(p.id));
  const personById = new Map(people.map(person => [person.id, person]));
  const bookableIds = (booking?.practitioners ?? []).filter(p => !hidden.includes(p.id)).map(p => p.id);
  const visible = rows.filter(r => r.status !== "cancelled" && !hidden.includes(r.practitionerId ?? UNASSIGNED));
  const byDate = new Map<string, DeskScheduleRow[]>();
  for (const row of visible) {
    // Include a visit that runs through local midnight in each day it occupies.
    const from = localDateString(new Date(row.startsAt), timezone);
    const through = localDateString(new Date(Date.parse(row.endsAt) - 1), timezone);
    for (const d of days) if (d >= from && d <= through) {
      const entries = byDate.get(d);
      if (entries) entries.push(row); else byDate.set(d, [row]);
    }
  }
  const picked = byDate.get(selectedDate) ?? [];
  const selectedVisit = visible.find(r => r.appointmentId === visitId);
  const label = view === "month" ? monthYearLabel(date) : view === "week" ? `${shortDate(days[0])} – ${shortDate(days[6])}, ${days[6].slice(0, 4)}` : fullDate(date);
  function chooseDate(day: string) {
    setDate(day); setBookingStart(null);
    if (view === "month" && window.matchMedia("(max-width: 1023px)").matches) {
      requestAnimationFrame(() => { agenda.current?.focus({ preventScroll: true }); agenda.current?.scrollIntoView({ block: "start" }); });
    }
  }
  function beginBooking(p = "", time = "") {
    setBookingStart(old => ({ p, time, sequence: (old?.sequence ?? 0) + 1 }));
    finder.current?.scrollIntoView({ block: "nearest" });
  }
  function onBooked(day: string) {
    if (days.includes(day) && selectedDate !== day) {
      setBookingStart(null);
      setBookedDate(day);
      setDate(day);
    }
    if (!days.includes(day) || (view === "month" && day.slice(0, 7) !== date.slice(0, 7))) router.push(deskHref(day, view));
  }
  function visitButton(row: DeskScheduleRow, compact = false) {
    const person = personById.get(row.practitionerId ?? UNASSIGNED);
    const description = `${formatStudioTime(row.startsAt, timezone)}–${formatStudioTime(row.endsAt, timezone)} · ${row.clientName} · ${row.serviceName} · ${row.practitionerName}`;
    return <button key={row.appointmentId} type="button" aria-label={description} title={description} onClick={() => setVisit(row.appointmentId)}
      className={compact ? "block w-full rounded-md border border-line bg-surface p-1 text-left text-xs hover:bg-surface-sunken" : "grid min-h-11 w-full grid-cols-[5rem_minmax(0,1fr)] gap-2 border-b border-line p-3 text-left text-sm last:border-0 hover:bg-surface-sunken"}>
      <span className="flex items-center gap-1 tabular-nums">{person && <Swatch person={person} />}{formatStudioTime(row.startsAt, timezone)}</span>
      <span className="block min-w-0"><strong className="block break-words">{row.clientName}</strong>
        <small className="block text-fg-muted">{row.serviceName}{!compact && ` · ${row.practitionerName}`}</small></span>
    </button>;
  }
  function bookFromGrid(day: string, person: string, time: string) {
    setDate(day);
    beginBooking(person, time);
  }
  const agendaList = <section ref={agenda} tabIndex={-1} aria-label="Selected day appointments" className="min-w-0 rounded-xl border border-line focus-visible:outline-2">
    <header className="space-y-2 border-b border-line bg-surface-sunken p-3">
      <h2 className="text-lg font-semibold">{fullDate(selectedDate)}</h2><p className="text-sm text-fg-muted">{visitCount(picked.length)}</p>
      {view === "month" && <div className="flex flex-wrap gap-2"><Link prefetch={false} href={deskHref(selectedDate,"day")} className={navStyle}>Open day calendar</Link>
        <Button type="button" size="sm" variant="quiet" className="lg:hidden" onClick={() => selectedCell.current?.focus()}>Back to month</Button>
        {selectedDate >= today && bookableIds.length > 0 && <Button type="button" size="sm" onClick={() => beginBooking()}>Find an opening</Button>}</div>}
    </header>
    <div className="max-h-[32rem] overflow-auto">{picked.map(row => visitButton(row))}
      {!picked.length && <p className="p-3 text-sm text-fg-muted">No appointments on this day.</p>}</div>
  </section>;

  return <div className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="text-2xl font-semibold tracking-tight">{label}</h1><p className="mt-1 text-sm text-fg-muted">{people.length} of {roster.length} practitioners · {timezone}</p></div>
      <nav aria-label="Calendar view" className="flex gap-1">{(["day","week","month"] as const).map(v => <Link key={v} prefetch={false}
        href={deskHref(selectedDate, v)} aria-current={view === v ? "page" : undefined} className={navStyle}>{v[0].toUpperCase()+v.slice(1)}</Link>)}</nav>
    </div>
    <nav aria-label="Calendar dates" className="flex flex-wrap items-center gap-2">
      <Link prefetch={false} className={navStyle} aria-label={`Previous ${view}`} href={deskHref(shiftDeskDate(date, view, -1), view)}>‹</Link>
      <Link prefetch={false} className={navStyle} href={deskHref(today, view)}>Today</Link>
      <Link prefetch={false} className={navStyle} aria-label={`Next ${view}`} href={deskHref(shiftDeskDate(date, view, 1), view)}>›</Link>
      <input type="date" aria-label="Jump to date" value={selectedDate} className="min-h-11 rounded-md border border-line bg-surface px-2 text-sm"
        onChange={e => { if (e.target.value && e.target.validity.valid) router.push(deskHref(e.target.value, view)); }} />
    </nav>
    <fieldset className="flex flex-wrap items-center gap-2"><legend className="mb-1 text-sm font-medium">Visible practitioners</legend>
      {roster.map(p => <label key={p.id} className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-line px-3 text-sm">
        <input type="checkbox" checked={!hidden.includes(p.id)} onChange={e => setHidden(e.target.checked ? hidden.filter(id => id !== p.id) : [...hidden, p.id])} />
        <Swatch person={p} />{p.name}</label>)}
      {roster.length > 0 && <Button type="button" size="sm" variant="quiet" onClick={() => setHidden(people.length === roster.length ? roster.map(p => p.id) : [])}>
        {people.length === roster.length ? "Clear" : "Select all"}</Button>}
    </fieldset>
    {bookedDate && <p role="status" className="text-sm">Booked for {fullDate(bookedDate)}.</p>}
    <div ref={finder}>
      {(bookableIds.length > 0 || !booking) && <DeskBooking key={[selectedDate, ...bookableIds, bookingStart?.sequence].join(",")} studioId={studioId}
        initialDate={selectedDate} visiblePractitionerIds={booking ? bookableIds : undefined}
        initialPractitionerId={bookingStart?.p || undefined} initialStartTime={bookingStart?.time || undefined} initiallyOpen={Boolean(bookingStart)}
        options={booking ?? undefined} onBooked={onBooked} />}
    </div>
    {!people.length ? <p role="status" className="rounded-xl border border-line p-4">{roster.length ? "Select a practitioner to see their calendar." : "No practitioners or appointments in this window."}</p> : <>
      {view === "month" && <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,27%)]">
        <div className="overflow-hidden rounded-xl border border-line"><div className="grid grid-cols-7 bg-surface-sunken">
          {weekdayNames.map(day => <span key={day} className="py-2 text-center text-xs font-semibold">{day}</span>)}</div>
          <div className="grid grid-cols-7">{days.map(d => {
            const list = byDate.get(d) ?? [];
            const counts = people.map(p => ({ person:p, count:list.filter(r => (r.practitionerId ?? UNASSIGNED) === p.id).length }));
            const summary = counts.map(({person,count}) => `${person.name} ${count}`).join(", ");
            return <button key={d} type="button" ref={d === selectedDate ? selectedCell : undefined} aria-pressed={d === selectedDate} aria-label={`${fullDate(d)}, ${visitCount(list.length)}, ${summary}`}
              onClick={() => chooseDate(d)} className={`min-w-0 border-r border-t border-line p-1 text-left align-top hover:bg-surface-sunken aria-pressed:bg-surface-sunken aria-pressed:ring-1 aria-pressed:ring-inset aria-pressed:ring-fg sm:p-2 ${d.slice(0,7)!==date.slice(0,7) ? "text-fg-muted" : ""}`}>
              <span className="flex flex-wrap items-baseline justify-between gap-x-1"><b className="text-sm">{Number(d.slice(-2))}</b><small className="text-[10px] text-fg-muted">{list.length}<span className="sr-only sm:not-sr-only"> visits</span></small></span>
              {counts.map(({ person, count }) => <span key={person.id} className="mt-0.5 flex min-w-0 items-center gap-0.5 text-[10px] sm:gap-1 sm:text-xs"><Swatch person={person} />
                <span className="truncate sm:hidden" aria-hidden="true">{practitionerInitials(person.name)}</span><span className="hidden truncate sm:inline">{person.name}</span>
                <b className="ml-auto">{count}</b></span>)}
            </button>;
          })}</div>
        </div>{agendaList}
      </div>}
      {view === "day" && <DeskTimeGrid today={today} timezone={timezone} bookableIds={bookableIds}
        columns={people.map(person => ({ date, person, heading: person.name, visits: picked.filter(row => (row.practitionerId ?? UNASSIGNED) === person.id) }))}
        onBook={bookFromGrid} onVisit={row => setVisit(row.appointmentId)} />}
      {view==="week" && <>
        {people.length === 1 ? <div className="hidden md:block"><DeskTimeGrid today={today} timezone={timezone} bookableIds={bookableIds}
          columns={days.map(day => ({ date: day, person: people[0], heading: deskDateLabel(day, { weekday: "short", day: "numeric" }), visits: byDate.get(day) ?? [] }))}
          onBook={bookFromGrid} onVisit={row => setVisit(row.appointmentId)} /></div> :
        <div className="hidden overflow-x-auto rounded-xl border border-line md:block"><table className="w-full table-fixed border-collapse text-left text-sm">
          <thead className="bg-surface-sunken"><tr><th className="w-28 p-2">Practitioner</th>
            {days.map(d => <th key={d} className="border-l border-line p-1"><Link prefetch={false} href={deskHref(d,"day")} className="underline">
              {deskDateLabel(d,{weekday:"short",day:"numeric"})}</Link><small className="block font-normal">{visitCount(byDate.get(d)?.length ?? 0)}</small></th>)}</tr></thead>
          <tbody>{people.map(p => <tr key={p.id}><th className="border-t border-line p-2 align-top"><Swatch person={p} /> {p.name}</th>
            {days.map(d => <td key={d} className="space-y-1 border-l border-t border-line p-1 align-top">
              {(byDate.get(d) ?? []).filter(r => (r.practitionerId ?? UNASSIGNED) === p.id).map(row => visitButton(row,true))}</td>)}</tr>)}</tbody>
        </table></div>}
        <div className="space-y-3 md:hidden"><div className="grid grid-cols-7">{days.map(d => <button type="button" key={d} aria-pressed={selectedDate===d}
          aria-label={fullDate(d)} className="rounded-md p-1 text-xs aria-pressed:bg-surface-sunken" onClick={() => chooseDate(d)}>{deskDateLabel(d,{weekday:"short"})}
          <b className="block text-sm">{Number(d.slice(-2))}</b></button>)}</div>{agendaList}</div>
      </>}
    </>}
    {selectedVisit && <DeskVisitDetails key={selectedVisit.appointmentId} visit={selectedVisit} studioId={studioId} timezone={timezone} onClose={() => setVisit(null)} />}
  </div>;
}
