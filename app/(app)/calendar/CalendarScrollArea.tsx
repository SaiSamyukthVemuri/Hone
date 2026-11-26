"use client";

import { useLayoutEffect, useRef, type ComponentPropsWithoutRef } from "react";
import { HOUR_START, ROW_HEIGHT_PX, ROW_MINUTES } from "./calendar-constants";

type Props = ComponentPropsWithoutRef<"div"> & {
  period: string;
  firstHour: number;
};

export function CalendarScrollArea({ period, firstHour, children, ...props }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const positioned = useRef<string | null>(null);

  // Move only on entering a different period. A background refresh must
  // preserve where the viewer has scrolled, even if opening hours changed.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || positioned.current === period) return;
    positioned.current = period;
    el.scrollTop = (firstHour - HOUR_START) * 60 * ROW_HEIGHT_PX / ROW_MINUTES;
  }, [period, firstHour]);

  return <div {...props} data-calendar-scroll-area ref={scroller}>{children}</div>;
}
