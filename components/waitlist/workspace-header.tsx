"use client";

import { useId, useState, type ReactNode } from "react";

import { useInviteOutcomePending } from "@/components/waitlist/invite-pending-context";

export function WaitlistWorkspaceHeader({ settings, addPerson }: { settings: ReactNode; addPerson: ReactNode }) {
  const [panel, setPanel] = useState<"settings" | "add" | null>(null);
  const id = useId();
  const pending = useInviteOutcomePending();
  return (
    <header className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 tabIndex={-1} data-settings-heading className="text-3xl font-semibold tracking-tight outline-none">Waitlist</h1>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={pending}
            title={pending ? "Waiting for the invitation result" : undefined}
            aria-expanded={panel === "settings"}
            aria-controls={`${id}-settings`}
            onClick={() => setPanel(panel === "settings" ? null : "settings")}
            className="inline-flex min-h-11 items-center rounded-md disabled:cursor-default disabled:opacity-50 border border-line px-3 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-900"
          >Settings</button>
          <button
            type="button"
            disabled={pending}
            title={pending ? "Waiting for the invitation result" : undefined}
            aria-expanded={panel === "add"}
            aria-controls={`${id}-add`}
            onClick={() => setPanel(panel === "add" ? null : "add")}
            className="inline-flex min-h-11 items-center rounded-md disabled:cursor-default disabled:opacity-50 bg-neutral-900 px-4 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
          >+ Add person</button>
        </div>
      </div>
      <fieldset id={`${id}-settings`} aria-label="Waitlist settings" disabled={pending} hidden={panel !== "settings"} className="mt-3 min-w-0">{settings}</fieldset>
      <fieldset id={`${id}-add`} aria-label="Add a person" disabled={pending} hidden={panel !== "add"} className="mt-3 min-w-0">{addPerson}</fieldset>
    </header>
  );
}
