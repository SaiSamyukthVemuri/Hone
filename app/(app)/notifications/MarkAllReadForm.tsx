"use client";

import { useState } from "react";
import { PendingButton } from "@/components/pending-button";
import { actionFailureMessage } from "@/lib/actions/action-result";

type MarkAllResult = { ok: true; updated: number } | { ok: false; error: string };

// HON-124 item 20. "Mark all read" used to fire and show nothing if it failed. The page keeps this component mounted, so the result stays
// visible after the unread count drops to zero (the button then goes away, the confirmation does not). Confirms only after ok.
export function MarkAllReadForm({ action, unreadCount }: { action: () => Promise<MarkAllResult>; unreadCount: number }) {
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  return (
    <>
      {unreadCount > 0 ? (
        <form
          action={async () => {
            setMessage(null);
            try {
              const result = await action();
              if (result.ok) {
                const n = result.updated;
                setMessage({ kind: "ok", text: typeof n === "number" ? `Marked ${n} ${n === 1 ? "notification" : "notifications"} read.` : "Marked all notifications read." });
              } else setMessage({ kind: "error", text: result.error });
            } catch (err) {
              setMessage({ kind: "error", text: actionFailureMessage(err, "Could not mark notifications read. Check your connection and try again.") });
            }
          }}
        >
          <PendingButton variant="secondary">Mark all read</PendingButton>
        </form>
      ) : null}
      <p role={message?.kind === "error" ? "alert" : "status"} className="text-xs text-neutral-600 empty:hidden dark:text-neutral-400">{message?.text ?? ""}</p>
    </>
  );
}
