"use client";

import { createContext, useContext, useEffect, useRef, type ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { FOCUS_RING } from "@/components/ui/control-base";
import { formatClockLabel, type TimeFormat } from "@/lib/booking/tz";
import type { CalendarOpening } from "./CalendarFindTime";
import { monthDayLabel } from "./calendar-format";
import { HOUR_END, HOUR_START, ROW_HEIGHT_PX, ROW_MINUTES } from "./calendar-constants";
import { QuickBookDrawer } from "./QuickBookDrawer";

export const OpeningContext = createContext<{
  opening: CalendarOpening | null;
  booking: boolean;
  openBooking: () => void;
  dismiss: () => void;
  booked: () => void;
} | null>(null);

export function CalendarOpeningMarker({ date, practitionerId, timeFormat }: {
  date: string;
  /** Undefined for the combined week grid; null for the unassigned team column. */
  practitionerId?: string | null;
  timeFormat: TimeFormat;
}) {
  const context = useContext(OpeningContext);
  const opening = context?.opening;
  const ref = useRef<HTMLButtonElement>(null);
  const matches = opening?.date === date && (practitionerId === undefined || opening.practitionerId === practitionerId);
  useEffect(() => {
    const marker = ref.current;
    const viewport = marker?.closest<HTMLElement>("[data-calendar-scroll-area]");
    if (!matches || !marker || !viewport || !marker.getClientRects().length) return;
    const slot = marker.getBoundingClientRect();
    const grid = viewport.getBoundingClientRect();
    // Keep the page header and the sidebar visible. Only the schedule scrolls.
    viewport.scrollTop += slot.top - grid.top - (viewport.clientHeight - slot.height) / 2;
    if (slot.left < grid.left + 60 || slot.right > grid.right) {
      viewport.scrollLeft += slot.left - grid.left - (viewport.clientWidth - slot.width) / 2;
    }
  }, [matches, opening]);
  if (!context || !opening || !matches) return null;
  const [hour, minute] = opening.localTime.split(":").map(Number);
  if (hour < HOUR_START || hour >= HOUR_END) return null;
  const duration = (Date.parse(opening.end) - Date.parse(opening.start)) / 60000;
  const start = (hour - HOUR_START) * 60 + minute;
  const label = formatClockLabel(opening.localTime, timeFormat);
  return (
    <button type="button" ref={ref} onClick={context.openBooking} aria-label={`Book ${label} with ${opening.practitionerName}`}
      style={{ top: start * ROW_HEIGHT_PX / ROW_MINUTES, height: Math.min(duration, (HOUR_END - HOUR_START) * 60 - start) * ROW_HEIGHT_PX / ROW_MINUTES }}
      className={`absolute inset-x-1 z-[6] cursor-pointer overflow-hidden rounded-md border-2 border-dashed border-sky-600 bg-sky-50 px-1.5 text-left text-xs font-semibold text-sky-900 hover:bg-sky-100 ${FOCUS_RING}`}>
      + Book {label}
    </button>
  );
}

type BookingProps = Pick<ComponentProps<typeof QuickBookDrawer>, "clients" | "services" | "studioTimezone" | "timeFormat" | "isOwner"> & {
  date: string;
  clientId?: string;
  viewer: { id: string; name: string };
  capacityEnabled: boolean;
};
export function CalendarOpeningBooking({ date, clientId, viewer, capacityEnabled, ...props }: BookingProps) {
  const context = useContext(OpeningContext);
  const opening = context?.opening;
  if (!context || !opening || opening.date !== date) return null;
  const label = formatClockLabel(opening.localTime, props.timeFormat);
  const service = props.services.find((s) => s.id === opening.serviceId);
  if (clientId && !props.clients.some((client) => client.id === clientId)) {
    return <p role="status">This client is no longer available to rebook. Open their record to check their status.</p>;
  }
  if (!service) return <p role="status">This service is no longer available. Choose another service.</p>;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm">
        <span><strong>{opening.practitionerName}</strong> · {monthDayLabel(date)} · {label} · {service.name}</span>
        <Button size="sm" onClick={context.openBooking}>Book this time</Button>
      </div>
      {context.booking && (
        <QuickBookDrawer
          {...props}
          open
          practitionerCapacityEnabled={capacityEnabled}
          currentPractitionerId={viewer.id}
          currentPractitionerName={viewer.name}
          preferredPractitionerId={opening.practitionerId}
          draft={{ localDate: date, localTime: opening.localTime, opening: { start: opening.start, end: opening.end, serviceId: opening.serviceId, clientId } }}
          onClose={context.dismiss}
          onBooked={context.booked}
        />
      )}
    </>
  );
}
