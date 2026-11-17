"use client";

import { useState, useTransition } from "react";
import { reopenDayPacketAction } from "./reopen-action";

// "Open again" on the refusal page. It is shown to everyone who lands here, so the page itself reveals nothing about
// who could reopen. The server decides; a refusal here says one plain thing. On success the server action redirects to
// a fresh opaque ticket (no client id or day anywhere).
export function ReopenButton({ ticket }: { ticket: string }) {
  const [pending, startTransition] = useTransition();
  const [refused, setRefused] = useState(false);
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
        className="w-fit rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60"
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
