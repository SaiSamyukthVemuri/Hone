"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  copyPreviousSessionAreasAction,
  type CopyPreviousAreasResult,
} from "./block-actions";

// PR #194 (Chloe retest). One-tap seed for a returning client's
// chart: copies the previous session's treatment areas + settings
// (never the client response) into this session as editable areas.
// Rendered only when this session has no treatment areas yet, so
// duplication is impossible. Feedback is explicit; the router refresh
// pulls the freshly-created areas into the blocks view.

export function CopyPreviousAreasButton({
  clientId,
  sessionId,
  previousSessionId,
}: {
  clientId: string;
  sessionId: string;
  previousSessionId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<CopyPreviousAreasResult | null>(null);

  function copy() {
    startTransition(async () => {
      const res = await copyPreviousSessionAreasAction({
        clientId,
        sessionId,
        previousSessionId,
      });
      setResult(res);
      if (res.ok) router.refresh();
    });
  }

  if (result?.ok) {
    return (
      <p className="text-sm text-green-700 dark:text-green-400" role="status">
        Copied {result.copiedCount} treatment{" "}
        {result.copiedCount === 1 ? "area" : "areas"} from last session.
        Review and adjust before saving today&apos;s details.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={copy}
        disabled={pending}
        className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
      >
        {pending ? "Copying…" : "Copy areas and settings from last session"}
      </button>
      <span className="text-xs text-neutral-500">
        Settings only; today&apos;s client response is recorded fresh.
      </span>
      {result && !result.ok && (
        <span className="text-sm text-red-600 dark:text-red-400" role="alert">
          {result.error}
        </span>
      )}
    </div>
  );
}
