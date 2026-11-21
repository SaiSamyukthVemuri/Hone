"use client";

import { useState, useTransition } from "react";
import { printWithAudit } from "@/lib/records/print/arm-print";
import { recordDayPacketPrintAction } from "./actions";

// HON-46. The ONLY thing that arms the packet for print, and only for ONE print:
// it records the print in the audit trail first (server action, fail closed),
// arms the document, opens the browser dialog, and disarms on afterprint (or a
// timeout, or any failure). A second Ctrl/Cmd+P therefore prints only the notice
// and the owner presses Print again, which audits again. See lib/records/print/
// arm-print.ts. Nothing here puts the client or day anywhere but the action's
// arguments.
function packetDocument(): Element | null {
  return document.querySelector("[data-packet-document]");
}

export function AuditedPrintButton({ clientId, day, previewAuditId }: { clientId: string; day: string; previewAuditId: string }) {
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState<null | "audit_failed" | "print_failed">(null);

  function onPrint() {
    setFailed(null);
    startTransition(async () => {
      const res = await printWithAudit({
        record: () => recordDayPacketPrintAction({ clientId, day, previewAuditId }),
        arm: () => packetDocument()?.setAttribute("data-print-armed", "true"),
        disarm: () => packetDocument()?.removeAttribute("data-print-armed"),
        print: () => window.print(),
        onAfterPrint: (cb) => {
          window.addEventListener("afterprint", cb);
          return () => window.removeEventListener("afterprint", cb);
        },
        setTimer: (cb, ms) => window.setTimeout(cb, ms),
        clearTimer: (h) => window.clearTimeout(h as number),
      });
      if (!res.ok) setFailed(res.reason);
    });
  }

  return (
    <div className="flex flex-col items-end gap-1 print:hidden">
      <button
        type="button"
        onClick={onPrint}
        disabled={pending}
        aria-busy={pending}
        className="rounded-md bg-neutral-900 px-5 py-3 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60"
      >
        {pending ? "Recording print…" : "Print"}
      </button>
      {failed === "audit_failed" && (
        <p role="alert" className="text-xs text-red-700">
          Could not record this print in the audit log, so nothing was printed. Reload the page and try again.
        </p>
      )}
      {failed === "print_failed" && (
        <p role="alert" className="text-xs text-red-700">
          This print was recorded in the audit log, but the browser could not open the print dialog. Press Print to try again; that is recorded again.
        </p>
      )}
    </div>
  );
}
