"use client";

import { usePathname } from "next/navigation";
import { APP_MAIN_FULL, APP_MAIN_NORMAL, calendarUsesFullWidth } from "@/lib/calendar/page-width";

// The app shell's <main>. Identical to before for every page except the calendar grid, which takes
// the full viewport width (lib/calendar/page-width.ts).
export function AppMain({ children }: { children: React.ReactNode }) {
  const wide = calendarUsesFullWidth(usePathname());
  return (
    <main data-testid="app-main" data-width={wide ? "full" : "contained"} className={wide ? APP_MAIN_FULL : APP_MAIN_NORMAL}>
      {children}
    </main>
  );
}
