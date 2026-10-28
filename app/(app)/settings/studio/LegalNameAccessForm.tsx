"use client";

import { useState, useTransition } from "react";
import { setReceptionistLegalNameAccessAction } from "./actions";

const LABEL = "Let front desk staff see clients' legal names";

export function LegalNameAccessForm({ initial }: { initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    const next = !on;
    setOn(next);
    setError(null);
    setHint(null);
    const fd = new FormData();
    fd.set("receptionist_legal_name_access", next ? "true" : "false");
    startTransition(async () => {
      const res = await setReceptionistLegalNameAccessAction(fd);
      if (!res.ok) {
        setError(res.error);
        setOn(!next);
        return;
      }
      setHint("Saved");
      window.setTimeout(() => setHint(null), 1500);
    });
  }

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 id="legal-name-access" className="scroll-mt-24 text-lg font-medium">
          Client legal names
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          Front desk staff always see each client&apos;s preferred name (or the name on file when no preferred name is set).
          Turn this on only if they also need the separate legal name. It is off by default, takes effect on their next page
          load, and every change is recorded. Owners and practitioners are not affected.
        </p>
      </div>
      <div className="flex items-start justify-between gap-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{LABEL}</p>
          <p className="mt-1 text-xs text-neutral-500">
            When off, legal names are not sent to front desk staff and cannot be searched by them.
          </p>
        </div>
        <button
          type="button"
          onClick={toggle}
          disabled={pending}
          aria-pressed={on}
          aria-label={LABEL}
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
