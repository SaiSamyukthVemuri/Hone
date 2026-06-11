"use client";

// PR #207: browser-print trigger for the Record Keeping print view.
// window.print() works on iPad Safari; the surrounding app chrome is
// hidden via print:hidden so only the log content prints.
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-md bg-neutral-900 px-5 py-3 text-sm font-medium text-white hover:bg-neutral-800 print:hidden dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
    >
      Print
    </button>
  );
}
