"use client";

import { useState, useTransition } from "react";
import { recordDayPacketPrintAction } from "./actions";

// HON-46. The ONLY thing that arms the packet for print. It records the print
// in the audit trail first (server action, fail closed) and only then marks the
// document printable and opens the browser dialog. If the audit fails nothing
// prints and the owner is told why. Nothing here puts the client or day anywhere
// but the action's arguments.
export function AuditedPrintButton({ clientId, day, previewAuditId }: { clientId: string; day: string; previewAuditId: string }) {
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);

  function onPrint() {
    setFailed(false);
    startTransition(async () => {
      const res = await recordDayPacketPrintAction({ clientId, day, previewAuditId }).catch(() => ({ ok: false }));
      if (!res.ok) {
        setFailed(true);
        return;
      }
      const doc = document.querySelector("[data-packet-document]");
      doc?.setAttribute("data-print-armed", "true");
      window.print();
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
      {failed && (
        <p role="alert" className="text-xs text-red-700">
          Could not record this print in the audit log, so nothing was printed. Reload the page and try again.
        </p>
      )}
    </div>
  );
}
