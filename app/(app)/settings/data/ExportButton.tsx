"use client";

import { useState, useTransition } from "react";
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
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        className="px-6 py-3 text-[13px] font-medium uppercase tracking-[0.15em] text-[#FAFAF7] transition-opacity hover:opacity-90 disabled:opacity-50"
        style={{ backgroundColor: "#0A0A0A" }}
      >
        {pending ? "Preparing export…" : "Export data"}
      </button>
      {doneAt && (
        <span className="text-sm text-green-700 dark:text-green-400">
          Download started
        </span>
      )}
      {error && (
        <span className="text-sm text-red-600 dark:text-red-400">{error}</span>
      )}
    </div>
  );
}
