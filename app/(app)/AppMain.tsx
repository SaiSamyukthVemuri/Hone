"use client";

import { useEffect } from "react";
import { WAITLIST_PATH } from "@/lib/waitlist/paths";
import { usePathname } from "next/navigation";
import { APP_MAIN_FULL, APP_MAIN_NORMAL, calendarUsesFullWidth } from "@/lib/calendar/page-width";
import { useAppHeaderHeight } from "@/components/use-app-header-height";

// The dashboard, the client directory, the Records logbooks and the waitlist workspace use wider columns than detail pages.
export function AppMain({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const path = pathname?.replace(/\/$/, "");
  const wide = calendarUsesFullWidth(pathname);
  const contained = path === "/dashboard" || path === "/clients" || path === "/records" || path === WAITLIST_PATH
    ? "mx-auto max-w-[86rem] px-4 py-6 md:px-8 md:py-8"
    : APP_MAIN_NORMAL;

  return (
    // `id="main-content"` is the SkipLink target (HON-124 item 17), the same id
    // the marketing shells use; the pair is pinned by
    // tests/app/marketing-skip-link-and-landmarks.test.ts.
    <>
      <ScrollPaddingBelowHeader />
      <main id="main-content" data-testid="app-main" data-width={wide ? "full" : "contained"} className={wide ? APP_MAIN_FULL : contained}>
        {children}
      </main>
    </>
  );
}

// Its own component, rendering nothing, so AppMain itself stays a plain
// function of the pathname (tests/app/app-main-contained-width.test.ts calls it
// directly).
function ScrollPaddingBelowHeader() {
  // HON-124 item 5. The app header is sticky, so anything the browser scrolls
  // into view at the top edge (a field reached by Shift+Tab, an anchor jump)
  // landed UNDER it: measured at 390px, focused controls sat at y=0 behind the
  // 69px header. `scroll-padding-top` on the root scroller reserves the
  // header's MEASURED height (plus a small gap) for every such scroll. Set
  // here, not in globals.css, because the marketing shells have their own
  // header and their own `scroll-margin-top` rule, and the two would stack.
  const headerHeight = useAppHeaderHeight();
  useEffect(() => {
    if (headerHeight <= 0) return;
    const root = document.documentElement;
    const previous = root.style.scrollPaddingTop;
    root.style.scrollPaddingTop = `${headerHeight + 8}px`;
    return () => {
      root.style.scrollPaddingTop = previous;
    };
  }, [headerHeight]);
  return null;
}
