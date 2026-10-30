"use client";

import { useState, useTransition } from "react";

import { setWaitlistTextsAction } from "@/app/(app)/settings/waitlist/texts-actions";

// The studio's own switch for waitlist texts. Default OFF. It is a permission,
// not a send: a text still needs the person's recorded consent and an approved
// studio sender, so this card says what turning it on does and does not do.
export function WaitlistTextsSetting({ initial }: { initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    const next = !on;
    const previous = on;
    setOn(next);
    setError(null);
    setHint(null);
    const fd = new FormData();
    fd.set("send_waitlist_invitation_sms", next ? "true" : "false");
    startTransition(async () => {
      const res = await setWaitlistTextsAction(fd);
      if (!res.ok) {
        setError(res.error);
        setOn(previous);
        return;
      }
      setHint("Saved");
      window.setTimeout(() => setHint(null), 1500);
    });
  }

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h2 id="waitlist-texts" className="text-sm font-medium">
            Waitlist texts
          </h2>
          <p className="mt-1 text-xs text-neutral-500">
            Allow Hone to text people on your waitlist when you invite them, and to confirm they
            joined. Only people who agreed to texts are ever texted, and only from your approved
            studio number. Turning this on does not send anything by itself. Email invitations are
            separate and unchanged.
          </p>
        </div>
        <button
          type="button"
          onClick={toggle}
          disabled={pending}
          aria-pressed={on}
          aria-label="Waitlist texts"
          className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 ${
            on ? "bg-neutral-900 dark:bg-white" : "bg-neutral-300 dark:bg-neutral-700"
          }`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all dark:bg-neutral-950 ${
              on ? "left-[1.375rem]" : "left-0.5"
            }`}
          />
        </button>
      </div>
      <div className="flex items-center gap-3 text-xs">
        {hint && <span className="text-green-600 dark:text-green-400">{hint}</span>}
        {error && <span className="text-red-700">{error}</span>}
      </div>
    </section>
  );
}
