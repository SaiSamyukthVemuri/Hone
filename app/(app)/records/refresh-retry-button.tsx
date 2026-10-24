"use client";

import { useRouter } from "next/navigation";
import { startTransition } from "react";

// RECORDS-SECTION-RECOVERY (Codex P2 4367401278). The retry for a section that
// could not be read. A link to the URL already on screen is a client-side
// navigation that may reuse the Router Cache's failed payload, so the read
// would never run again. router.refresh() re-requests the server render, the
// same recovery app/(app)/error.tsx uses.
export function RefreshRetryButton({ className }: { className?: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => startTransition(() => router.refresh())}
      className={className}
    >
      Try again
    </button>
  );
}
