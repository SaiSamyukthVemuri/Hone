"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { DeskResult } from "@/lib/desk/booking";
import type { DeskScheduleRow } from "@/lib/desk/read";
import { formatStudioDateTime } from "@/lib/desk/time";
import { getDeskAppointmentContactAction } from "./contact-actions";

export function DeskVisitDetails({ visit, studioId, timezone, onClose }: {
  visit: DeskScheduleRow; studioId: string; timezone: string; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [contact, setContact] = useState<DeskResult<{ phone: string | null; email: string | null }> | null>(null);
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => { el?.close(); };
  }, []);
  useEffect(() => {
    let current = true;
    getDeskAppointmentContactAction({ studioId, appointmentId: visit.appointmentId })
      .then(result => { if (current) setContact(result); })
      .catch(() => { if (current) setContact({ ok: false, error: "Contact details are unavailable." }); });
    return () => { current = false; };
  }, [visit.appointmentId, studioId]);
  const fields = [
    ["Practitioner", visit.practitionerName], ["Service", visit.serviceName],
    ["Starts", formatStudioDateTime(visit.startsAt, timezone)], ["Ends", formatStudioDateTime(visit.endsAt, timezone)],
    ...(visit.durationMinutes ? [["Duration", `${visit.durationMinutes} min`]] : []),
    ["Status", visit.status.replace("_", " ")],
    ...(contact?.ok ? [["Phone", contact.phone ?? "No phone on file"], ["Email", contact.email ?? "No email on file"]] : []),
  ];
  return <dialog ref={dialog} aria-labelledby="desk-visit-title" onCancel={onClose}
    className="m-auto max-h-[90dvh] w-[min(92vw,28rem)] overflow-y-auto rounded-xl border border-line bg-surface p-5 text-fg backdrop:bg-black/40">
    <div className="flex items-center justify-between gap-2"><h2 id="desk-visit-title" className="text-lg font-semibold">Appointment details</h2>
      <Button type="button" size="sm" onClick={onClose}>Close</Button></div>
    <p className="my-4 text-xl font-semibold">{visit.clientName}</p>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 text-sm">
      {fields.map(([label, value]) => <div key={label} className="contents"><dt className="text-fg-muted">{label}</dt><dd className="break-words">{value}</dd></div>)}
    </dl>
    {!contact && <p role="status" className="mt-4 text-sm">Loading contact details…</p>}
    {contact && !contact.ok && <p role="alert" className="mt-4 text-sm">{contact.error}</p>}
  </dialog>;
}
