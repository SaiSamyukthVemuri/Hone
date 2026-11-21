"use client";

import { CONTROL_MIN_TOUCH, FOCUS_RING, cx } from "@/components/ui/control-base";

/** A plain browser print: the person chooses "Save as PDF" in the print dialog. No PDF library, no request, nothing is sent anywhere. */
export function PrintButton() {
  return (
    <button type="button" onClick={() => window.print()} className={cx("inline-flex items-center rounded-md border border-line px-4 text-sm font-medium text-fg", CONTROL_MIN_TOUCH, FOCUS_RING)}>
      Print / Save as PDF
    </button>
  );
}
