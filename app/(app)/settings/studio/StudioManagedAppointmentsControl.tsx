"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { setStudioManagedAppointmentsAction } from "./actions";

export function StudioManagedAppointmentsControl({ initial, available }: { initial: boolean; available: boolean }) {
  const [enabled, setEnabled] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const router = useRouter();

  function toggle() {
    const next = !enabled;
    setError(null);
    setSaved(false);
    const data = new FormData();
    data.set("studio_managed_appointments", String(next));
    startTransition(async () => {
      try {
        const result = await setStudioManagedAppointmentsAction(data);
        if (!result.ok) { setError(result.error); return; }
        setEnabled(next);
        setSaved(true);
        router.refresh();
      } catch {
        setError("Could not confirm appointment management. Reload this page to check the current setting before trying again.");
      }
    });
  }

  return <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
    <h2 className="text-base font-medium">Studio-managed appointments</h2>
    <p className="text-sm text-neutral-600 dark:text-neutral-400">When on, clients cannot use the portal, book online, reschedule or cancel themselves, including through existing invitation links. You and your staff manage appointments in Hone. Existing appointments and records stay unchanged.</p>
    <p className="text-sm text-neutral-600 dark:text-neutral-400">Confirmations, reminders, receipts and standalone intake links keep working. Portal messages are unavailable. Turning this off restores the saved self-service and new-client admission preferences.</p>
    {!available && <p role="status" className="text-sm text-neutral-600 dark:text-neutral-400">This control is not available yet. Your studio’s current booking settings remain in effect.</p>}
    <Button type="button" onClick={toggle} disabled={!available} pending={pending} aria-pressed={enabled} aria-label="Studio-managed appointments">{enabled ? "On" : "Off"}</Button>
    <div aria-live="polite" className="text-sm">
      {error && <p role="alert" className="text-red-700 dark:text-red-400">{error}</p>}
      {saved && <p>Saved. {enabled ? "Clients must contact your studio to book or change appointments." : "Your saved client self-service settings apply again."}</p>}
    </div>
  </section>;
}
