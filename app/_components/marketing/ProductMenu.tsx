"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { PRODUCT_MENU } from "@/lib/marketing/content";

// Desktop "Product" dropdown. Anchored directly beneath the trigger (relative
// wrapper), restrained width. Closes on: link select, route change, outside
// click, and Escape (returning focus to the trigger). While closed it is
// `hidden`, so it is removed from the tab order and the a11y tree and never left
// floating over content after navigation.
export function ProductMenu() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();

  // Close on route change (client navigation).
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Close on outside click + Escape while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-[0.9375rem] font-medium text-ink"
      >
        Product
        <svg
          aria-hidden="true"
          width="11"
          height="7"
          viewBox="0 0 11 7"
          fill="none"
          className={`text-muted transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path
            d="M1 1.5 5.5 5.5 10 1.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <div
        role="menu"
        hidden={!open}
        className="absolute left-0 top-[calc(100%+0.5rem)] z-50 w-56 rounded-[10px] border border-[color:var(--color-hairline)] bg-white p-2 shadow-[var(--mk-shadow-frame)]"
      >
        {PRODUCT_MENU.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block rounded-[6px] px-3 py-2 text-[0.9375rem] text-ink hover:bg-warm"
          >
            {item.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
