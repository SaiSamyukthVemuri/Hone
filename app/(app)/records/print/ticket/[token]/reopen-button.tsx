"use client";

import { useState, useTransition } from "react";
import { reopenDayPacketAction } from "./reopen-action";

// "Open again" on the refusal page. Owners get the button; anyone else is told only the viewer's own role requirement,
// which says nothing about the ticket or the client. The server decides either way, and a refusal says one plain thing.
// On success the server action redirects to a fresh opaque ticket (no client id or day anywhere).
export const NOT_OWNER_MESSAGE = "Only the studio owner can open this record again.";

export function ReopenButton({ ticket, isOwner }: { ticket: string; isOwner: boolean }) {
  const [pending, startTransition] = useTransition();
  const [refused, setRefused] = useState(false);
  if (!isOwner) return <p className="text-sm text-neutral-700 print:hidden">{NOT_OWNER_MESSAGE}</p>;
  return (
    <div className="flex flex-col gap-1 print:hidden">
      <button
        type="button"
        disabled={pending}
        aria-busy={pending}
        onClick={() => {
          setRefused(false);
          startTransition(async () => {
            const res = await reopenDayPacketAction(ticket);
            if (res && res.ok === false) setRefused(true);
          });
        }}
        className="min-h-[44px] w-fit rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60"
      >
        {pending ? "Opening…" : "Open again"}
      </button>
      {refused && (
        <p role="alert" className="text-xs text-red-700">
          This record can&rsquo;t be opened again from here. Open Print again from the client&rsquo;s session.
        </p>
      )}
    </div>
  );
}
