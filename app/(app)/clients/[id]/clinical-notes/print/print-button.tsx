"use client";

// Small print trigger for the clinical-notes export page. Practitioner-only,
// authenticated route; no data: it just invokes the browser print dialog.
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="min-h-[44px] rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200 print:hidden"
    >
      Print
    </button>
  );
}
