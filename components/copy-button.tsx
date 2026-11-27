"use client";

import { useEffect, useId, useRef, useState } from "react";
import { copyText, selectElementText, COPY_FAILED_MESSAGE } from "@/lib/clipboard/copy-text";

// HON-124 item 11. The shared copy control (extracted from the booking-link card, which stays the reference look).
//   * "Copied" is shown only AFTER the clipboard write succeeded.
//   * On failure it says so in a polite live region and SELECTS the visible text (selectTargetId) so the person can copy by hand; it never
//     claims success. The message clears after a few seconds, and a later press tries again.
type Props = {
  value: string;
  label?: string;
  copiedLabel?: string;
  /** id of the element that shows the same text; selected when the write fails. */
  selectTargetId?: string;
  className?: string;
  /** The value is not shown anywhere else: on failure, show it in a read-only field (already selected) to copy by hand. */
  revealOnFail?: boolean;
  /** Accessible name when the visible label is generic ("Copy"). */
  ariaLabel?: string;
};

export function CopyButton({ value, label = "Copy", copiedLabel = "Copied", selectTargetId, className, ariaLabel, revealOnFail }: Props) {
  const revealId = useId();
  const revealRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function onClick() {
    window.clearTimeout(timer.current);
    const ok = await copyText(value);
    setState(ok ? "copied" : "failed");
    if (!ok) {
      // wait one frame so the revealed field exists before it is selected
      requestAnimationFrame(() => selectElementText(selectTargetId ? document.getElementById(selectTargetId) : revealRef.current));
    }
    timer.current = window.setTimeout(() => setState("idle"), ok ? 1500 : 6000);
  }

  return (
    <>
      <button type="button" onClick={onClick} aria-label={ariaLabel} className={className}>
        {state === "copied" ? copiedLabel : label}
      </button>
      <span role="status" aria-live="polite" className={state === "failed" ? "basis-full text-xs text-neutral-600 dark:text-neutral-400" : "sr-only"}>
        {state === "failed" ? COPY_FAILED_MESSAGE : state === "copied" ? copiedLabel : ""}
      </span>
      {state === "failed" && revealOnFail && !selectTargetId ? (
        <input ref={revealRef} id={revealId} readOnly value={value} aria-label="Text to copy" onFocus={(e) => e.currentTarget.select()} className="min-w-0 basis-full rounded-md border border-neutral-300 bg-neutral-50 px-3 py-2 text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300" />
      ) : null}
    </>
  );
}
