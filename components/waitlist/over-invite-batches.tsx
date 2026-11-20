"use client";

import { useState, useTransition } from "react";
import type { OverInviteResult } from "@/lib/waitlist/over-invite-result";

// Confirmed batches that still have people to send. Shown from the DATABASE on every page load, so a batch left unfinished stays visible with its
// age and the estimate the owner saw when confirming. NOTHING sends unless the owner presses the button: no page load, timer or background job runs
// the worker. Pressing it continues this studio's queue only.

export type OpenBatch = { id: string; confirmedAt: string; quantity: number; fitShown: number; liveShown: number; remaining: number };

function age(iso: string, now: number): string {
  const mins = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} days ago`;
}

export function OverInviteBatches({
  batches,
  continueAction,
  renderedAt,
}: {
  batches: readonly OpenBatch[];
  continueAction: (prev: OverInviteResult) => Promise<OverInviteResult>;
  renderedAt: number;
}) {
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  if (batches.length === 0) return null;
  const total = batches.reduce((n, b) => n + b.remaining, 0);
  return (
    <section data-testid="over-invite-open-batches" className="flex flex-col gap-2 text-sm" aria-label="Batches still sending">
      <h2 className="font-medium">Confirmed, still to send</h2>
      <ul className="flex flex-col gap-1">
        {batches.map((b) => (
          <li key={b.id} data-testid="open-batch">
            Confirmed {age(b.confirmedAt, renderedAt)} · {b.remaining} of {b.quantity} still to send · estimate then: {b.fitShown} available, {b.liveShown} active
          </li>
        ))}
      </ul>
      <p>These were confirmed earlier. Availability may have changed since. They send only when you press the button.</p>
      <button
        type="button"
        disabled={pending}
        className="min-h-11 self-start rounded-md border px-3"
        onClick={() =>
          start(async () => {
            const r = await continueAction({ state: "idle" });
            setNote(r.state === "progress" ? `${r.sent} sent, ${r.skipped} not sent, ${r.failed} could not be delivered.` : r.state === "notice" ? r.notice : null);
          })
        }
      >
        Keep sending the remaining {total}
      </button>
      {note ? <p role="status">{note}</p> : null}
    </section>
  );
}
