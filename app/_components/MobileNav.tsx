"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { MARKETING_CTA, MARKETING_NAV, MARKETING_PALETTE } from "./marketingNav";

// Mobile-only nav: a "Menu" text trigger + a full-viewport overlay
// holding the same four links stacked vertically. The overlay is always
// rendered (never display:none) so SSR markup is identical to the
// hydrated state; visibility is governed by opacity + pointer-events.
export function MobileNav() {
  const [open, setOpen] = useState(false);

  // Lock body scroll while the overlay is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[14px] font-medium hover:underline"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        Menu
      </button>

      <div
        role="dialog"
        aria-modal="true"
        aria-hidden={!open}
        style={{
          position: "fixed",
          inset: 0,
          backgroundColor: MARKETING_PALETTE.bg,
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: "opacity 200ms ease-out",
          zIndex: 50,
        }}
      >
        <div className="flex h-full flex-col">
          <div className="flex items-baseline justify-between px-6 py-5">
            <span
              className="font-[var(--font-fraunces)] text-[18px] font-bold"
              style={{ letterSpacing: "-0.02em" }}
            >
              Hone
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-[14px] font-medium hover:underline"
            >
              Close
            </button>
          </div>
          <nav className="flex flex-1 flex-col items-start justify-center gap-y-5 px-6">
            {MARKETING_NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="font-[var(--font-fraunces)] text-[32px] font-bold leading-none"
                style={{ letterSpacing: "-0.03em" }}
              >
                {item.label}
              </Link>
            ))}
            {/* PR #242: the Book walkthrough CTA stays reachable on
                phone and tablet, styled as a button at the bottom of
                the overlay. */}
            <Link
              href={MARKETING_CTA.href}
              onClick={() => setOpen(false)}
              className="mt-4 inline-flex items-center justify-center px-6 py-3.5 text-[13px] font-medium uppercase"
              style={{
                backgroundColor: MARKETING_PALETTE.ink,
                color: MARKETING_PALETTE.bg,
                letterSpacing: "0.16em",
              }}
            >
              {MARKETING_CTA.label}
            </Link>
          </nav>
        </div>
      </div>
    </>
  );
}
