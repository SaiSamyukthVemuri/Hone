"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";

import { exportStudioDataAction } from "./actions";

function base64ToBlob(base64: string, mime: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

export function ExportButton() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [doneAt, setDoneAt] = useState<number | null>(null);

  function handleClick() {
    setError(null);
    startTransition(async () => {
      const result = await exportStudioDataAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const blob = base64ToBlob(result.base64, "application/zip");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoke after a tick so the browser has time to start the download.
      window.setTimeout(() => URL.revokeObjectURL(url), 500);
      setDoneAt(Date.now());
      window.setTimeout(() => setDoneAt(null), 2500);
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-4">
      {/* UI-R01 PROOF CONTROL — asynchronous action button.
          
          What this call site used to be, and why each part had to go:
            * a raw <button> with a hardcoded #0A0A0A background and an inline
              style, so it inherited none of the shared vocabulary;
            * `hover:opacity-90` and NOTHING else — no :active, so on a phone
              (where :hover never fires) the control was completely dead from
              first contact, and on a desktop it went silent the moment you
              pressed it;
            * no focus-visible ring at all;
            * `{pending ? "Preparing export…" : "Export data"}` — a 17-character
              label becoming 19, which RESIZES the button mid-press;
            * no aria-busy, so the state was invisible to a screen reader.

          The primitive supplies press, focus, the 44px floor, aria-busy, the
          disabled double-submit guard, and a spinner that sits INSIDE the
          resting footprint. `busyLabel` is deliberately NOT passed: omitting it
          is what selects the geometry-stable form. The announcement is carried
          by aria-busy plus the live region below, not by a shifting label. */}
      <Button
        variant="primary"
        onClick={handleClick}
        pending={pending}
      >
        Export data
      </Button>
      {/* Success is shown here and not as a toast because the outcome — a file
          arriving — is NOT self-evident inside the page (contract §E). The live
          region is mounted unconditionally and only its TEXT changes: a
          role="status" node inserted already containing its message is not
          reliably announced. Same rule pending-link.tsx documents. */}
      <span role="status" aria-live="polite" className="text-sm">
        {doneAt ? (
          <span className="text-green-700 dark:text-green-400">Download started</span>
        ) : null}
      </span>
      {error && (
        <span role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </span>
      )}
    </div>
  );
}
