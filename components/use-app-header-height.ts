"use client";

import { useEffect, useState } from "react";

/**
 * The rendered height of the sticky app header, kept current as it changes.
 *
 * The header (`app/(app)/layout.tsx`, `sticky top-0 z-30`) has no fixed height:
 * it is ~69px at phone width and changes with wrapping and text size. A bar that
 * sticks UNDER it must stick at this measured height, or the header covers the
 * bar's top edge (HON-124 item 5: the phone calendar's day controls sat 13px
 * under it at `top-14`). Returns 0 before the first measurement, so callers keep
 * their class-based fallback until then.
 *
 * Extracted from components/profile-tab-bar.tsx, which did this first; both now
 * read it from here so there is one way to say "below the app header".
 */
export function useAppHeaderHeight(): number {
  const [headerHeight, setHeaderHeight] = useState(0);
  useEffect(() => {
    const header = document.querySelector("header");
    if (!header) return;
    const measure = () => setHeaderHeight(Math.round(header.getBoundingClientRect().height));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
  return headerHeight;
}
