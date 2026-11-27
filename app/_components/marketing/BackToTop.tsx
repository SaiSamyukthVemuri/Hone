"use client";

import { useEffect, useState } from "react";

// "Back to top" for the long public pages (HON-124 item 13). It appears only after the visitor has scrolled more than one and a half screens, so a short page
// never shows it, and it is a real <button>: Tab reaches it, Enter and Space press it.
//
// FOCUS. Pressing it moves focus to the top of the page (the marketing surface, a programmatic target, tabindex -1) BEFORE scrolling, so the next Tab lands
// on the skip link and the primary navigation rather than on whatever was last focused near the bottom. The control then unmounts as the page reaches the
// top, and focus is no longer parked on a removed element.
//
// MOTION. The scroll is smooth only when the visitor has not asked for reduced motion.
//
// It is mounted once, by MarketingSurface, which wraps every marketing and policy page. It lives in the bottom-right corner, clear of the footer text on a
// phone by the safe-area inset.
// A MODAL DIALOG HIDES IT. The mobile menu is a full-screen modal dialog inside the sticky header's own stacking context, so a z-index here could not reliably
// outrank it (a later sibling context paints above). Instead the control is not rendered at all while any modal dialog is open (aria-modal, not inert): it
// cannot paint over the dialog, cannot be clicked, and cannot take focus out of it.
const MODAL_OPEN = '[role="dialog"][aria-modal="true"]:not([inert])';
export const BACK_TO_TOP_TARGET_ID = "mk-top";
const SHOW_AFTER_SCREENS = 1.5;

export function BackToTop() {
  const [visible, setVisible] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    const check = () => setModalOpen(document.querySelector(MODAL_OPEN) !== null);
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["inert", "aria-modal"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const update = () => setVisible(window.scrollY > window.innerHeight * SHOW_AFTER_SCREENS);
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  if (!visible || modalOpen) return null;

  return (
    <button
      type="button"
      data-back-to-top=""
      onClick={() => {
        document.getElementById(BACK_TO_TOP_TARGET_ID)?.focus({ preventScroll: true });
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
      }}
      className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] z-40 inline-flex min-h-11 items-center justify-center rounded-[8px] bg-ink px-4 text-[0.9375rem] font-semibold text-paper shadow-[0_1px_3px_rgba(23,33,31,0.3)] hover:bg-[color:var(--color-mineral-deep)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-mineral)] print:hidden"
    >
      Back to top
    </button>
  );
}
