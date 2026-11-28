"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  PRIMARY_NAV,
  PRODUCT_MENU,
  WALKTHROUGH,
  ANALYTICS_EVENTS,
} from "@/lib/marketing/content";
import { MK_FONT_DISPLAY } from "./tokens";

// Accessible mobile navigation: a "Menu" trigger opening a full-viewport dialog
// with the same routes as desktop (Product group + the rest) and the walkthrough
// CTA. While CLOSED the dialog is `inert`, removed from the tab order and the
// accessibility tree (so its links are not tabbable and no aria-modal is exposed)
// while still keeping the opacity fade. On open, focus moves into the dialog and
// Tab is trapped; Escape or a link click closes it and restores focus to the
// trigger. Body scroll-locks while open; 44px targets; no horizontal overflow.
export function MobileNav({ selfServe = false }: { selfServe?: boolean } = {}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Scroll-lock + Escape while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Move focus into the dialog when it opens.
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  // Keep Tab focus within the dialog while open.
  function onDialogKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "Tab" || !dialogRef.current) return;
    const items = dialogRef.current.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled])',
    );
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const rest = PRIMARY_NAV.filter((i) => i.label !== "Product");
  // HON-124 item 10. The page the visitor is on is announced (aria-current)
  // and shown (mineral ink + underline, the marketing accent), so the menu
  // says where they are and not only where they could go.
  const pathname = usePathname();
  const isCurrent = (href: string) => pathname === href;
  const CURRENT = "text-mineral underline underline-offset-4";

  return (
    <div className="lg:hidden">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="site-navigation-dialog"
        className="inline-flex min-h-[44px] items-center px-2 text-[0.9375rem] font-semibold text-ink"
      >
        Menu
      </button>

      <div
        ref={dialogRef}
        id="site-navigation-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Site navigation"
        inert={!open}
        onKeyDown={onDialogKeyDown}
        // OPENS ON THE FIRST FRAME, fades only on close (HON-124 / HON-109).
        // The 200ms fade-in made the tapped menu take ~215ms to be fully
        // visible and selectable at 390px (measured, 10 warm runs); the
        // transition now exists only while CLOSED, so opening is instant and
        // closing keeps its fade. Reduced motion drops the fade entirely.
        className={`fixed inset-0 z-50 flex flex-col bg-paper ${open ? "" : "transition-opacity duration-200 motion-reduce:transition-none"}`}
        style={{ opacity: open ? 1 : 0, pointerEvents: open ? "auto" : "none" }}
      >
        <div className="flex items-center justify-between border-b border-[color:var(--color-hairline)] px-5 py-4">
          <span
            className="text-[1.25rem] font-bold text-ink"
            style={{ fontFamily: MK_FONT_DISPLAY }}
          >
            Hone
          </span>
          <button
            ref={closeRef}
            type="button"
            onClick={close}
            className="inline-flex min-h-[44px] items-center px-2 text-[0.9375rem] font-semibold text-ink"
          >
            Close
          </button>
        </div>

        <nav aria-label="Site" className="flex flex-1 flex-col gap-1 overflow-y-auto px-5 py-6">
          <p className="pb-1 text-[0.875rem] font-medium text-muted">Product</p>
          {PRODUCT_MENU.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={close}
              aria-current={isCurrent(item.href) ? "page" : undefined}
              className={`min-h-[44px] py-2 text-[1.125rem] ${isCurrent(item.href) ? CURRENT : "text-ink"}`}
            >
              {item.label}
            </Link>
          ))}
          <div className="my-3 h-px bg-[color:var(--color-hairline)]" />
          {rest.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={close}
              aria-current={isCurrent(item.href) ? "page" : undefined}
              className={`min-h-[44px] py-2 text-[1.125rem] font-medium ${isCurrent(item.href) ? CURRENT : "text-ink"}`}
            >
              {item.label}
            </Link>
          ))}
          <Link
            href={selfServe ? "/pricing" : WALKTHROUGH.href}
            onClick={close}
            data-event={ANALYTICS_EVENTS.primaryCtaClick}
            className="mt-4 inline-flex min-h-[48px] items-center justify-center rounded-[8px] bg-mineral px-5 text-[1rem] font-semibold text-paper"
          >
            {selfServe ? "Sign up" : WALKTHROUGH.primaryLabelShort}
          </Link>
        </nav>
      </div>
    </div>
  );
}
