"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button, type ButtonSize, type ButtonVariant } from "@/components/ui/button";
import { copyText, selectElementText, COPY_FAILED_MESSAGE } from "@/lib/clipboard/copy-text";

// HON-124 item 11. The shared copy control (extracted from the booking-link card).
//   * Composes the Hone Button primitive, so it has the 44px touch floor, the focus ring and the press acknowledgement.
//   * "Copied" is shown only AFTER the clipboard write succeeded.
//   * On failure it says so in a polite live region and SELECTS the visible text (selectTargetId) so the person can copy by hand.
//     The ANNOUNCEMENT clears after a few seconds; a revealed fallback field (revealOnFail, for a value shown nowhere else) does NOT:
//     it stays until the person dismisses it or a retry succeeds, because someone still pressing and holding to copy must not lose it.
type Props = {
  value: string;
  label?: string;
  copiedLabel?: string;
  /** id of the element that shows the same text; selected when the write fails. */
  selectTargetId?: string;
  /** The value is not shown anywhere else: on failure, show it in a read-only field (already selected) to copy by hand. */
  revealOnFail?: boolean;
  /** Accessible name when the visible label is generic ("Copy"). */
  ariaLabel?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Layout only (width, margin). Colour, height and focus come from the primitive. */
  className?: string;
};

export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  selectTargetId,
  revealOnFail,
  ariaLabel,
  variant = "secondary",
  size = "md",
  className,
}: Props) {
  const revealId = useId();
  const buttonId = useId();
  const revealRef = useRef<HTMLInputElement>(null);
  const [announce, setAnnounce] = useState<"idle" | "copied" | "failed">("idle");
  const [revealed, setRevealed] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // The revealed field (and its Dismiss button) unmounts; a focused element that unmounts drops focus to <body>, which strands a keyboard user
  // (and escapes a modal's focus handling). Put focus back on the copy control, which is always mounted.
  function focusCopyButton() {
    requestAnimationFrame(() => document.getElementById(buttonId)?.focus());
  }

  async function onClick() {
    window.clearTimeout(timer.current);
    const ok = await copyText(value);
    setAnnounce(ok ? "copied" : "failed");
    if (ok) {
      setRevealed(false);
      focusCopyButton();
    }
    else {
      if (revealOnFail && !selectTargetId) setRevealed(true);
      // wait one frame so a revealed field exists before it is selected
      requestAnimationFrame(() => selectElementText(selectTargetId ? document.getElementById(selectTargetId) : revealRef.current));
    }
    timer.current = window.setTimeout(() => setAnnounce("idle"), ok ? 1500 : 6000);
  }

  return (
    <>
      <Button id={buttonId} variant={variant} size={size} onClick={onClick} aria-label={ariaLabel} className={className}>
        {announce === "copied" ? copiedLabel : label}
      </Button>
      <span role="status" aria-live="polite" className={announce === "failed" ? "basis-full text-xs text-neutral-600 dark:text-neutral-400" : "sr-only"}>
        {announce === "failed" ? COPY_FAILED_MESSAGE : announce === "copied" ? copiedLabel : ""}
      </span>
      {revealed ? (
        <span className="flex basis-full flex-wrap items-center gap-2" data-testid="copy-fallback">
          <input
            ref={revealRef}
            id={revealId}
            readOnly
            value={value}
            aria-label="Text to copy"
            onFocus={(e) => e.currentTarget.select()}
            className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-neutral-50 px-3 py-2 text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
          />
          <Button
            variant="quiet"
            size="sm"
            onClick={() => {
              setRevealed(false);
              focusCopyButton();
            }}
          >
            Dismiss
          </Button>
        </span>
      ) : null}
    </>
  );
}
