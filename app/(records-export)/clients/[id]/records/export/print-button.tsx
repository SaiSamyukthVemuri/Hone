"use client";

import { useState, useTransition } from "react";
import { recordClinicalRecordsPrintAction } from "./actions";
import { EXPORT_DOCUMENT_ID, PRINT_ARMED_ATTRIBUTE } from "@/lib/clinical-records/print-gate";

/**
 * Arm the print gate for exactly one print, then disarm it after the dialog
 * closes, so a later native Ctrl/Cmd+P (unaudited) is gated again.
 */
function printArmed(): void {
  const doc = document.getElementById(EXPORT_DOCUMENT_ID);
  if (!doc) return;
  doc.setAttribute(PRINT_ARMED_ATTRIBUTE, "");
  const disarm = () => doc.removeAttribute(PRINT_ARMED_ATTRIBUTE);
  window.addEventListener("afterprint", disarm, { once: true });
  window.print();
}

// HON-46. Prints only after the print has been audited. If the audit cannot be
// recorded, the dialog does not open and the owner is told why.
export function AuditedPrintButton({
  clientId,
  rawScope,
}: {
  clientId: string;
  rawScope: { scope?: string; session?: string; day?: string; from?: string; to?: string };
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-end gap-1 print:hidden">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const r = await recordClinicalRecordsPrintAction(clientId, rawScope).catch(() => ({ ok: false }));
            if (r.ok) printArmed();
            else setError("Could not record this print in the audit log, so it was not printed. Try again.");
          });
        }}
        className="min-h-[44px] rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        {pending ? "Recording…" : "Print"}
      </button>
      {error && (
        <p role="alert" className="text-xs text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
