"use client";

import { usePathname } from "next/navigation";
import { APP_MAIN_FULL, APP_MAIN_NORMAL, calendarUsesFullWidth } from "@/lib/calendar/page-width";

// The dashboard panels and the Records logbooks use a wider desktop layout.
export function AppMain({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const wide = calendarUsesFullWidth(pathname);
  const section = pathname?.replace(/\/$/, "");
  const contained = section === "/dashboard" || section === "/records"
    ? "mx-auto max-w-[86rem] px-4 py-6 md:px-8 md:py-8"
    : APP_MAIN_NORMAL;
  return (
    <main data-testid="app-main" data-width={wide ? "full" : "contained"} className={wide ? APP_MAIN_FULL : contained}>
      {children}
    </main>
  );
}
