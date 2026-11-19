"use server";

import { redirect } from "next/navigation";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { reopenTicket } from "@/lib/records/print/ticket-reopen";

// "Open again" on the refusal page: a fresh one-use ticket for an owner of the SAME studio, from the ticket itself
// (nothing is stored server-side). Every failure returns the same { ok: false } (no reason). On success it redirects
// to /records/print/ticket/<new opaque ticket>: no client id and no day in the URL or the redirect.
export async function reopenDayPacketAction(ticket: string): Promise<{ ok: false }> {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  const result = reopenTicket({
    secret: process.env.PRINT_TICKET_SECRET,
    practitioner: { id: practitioner.id, role: practitioner.role, active: practitioner.active },
    studioId: studio.id,
    ticket,
  });
  if (result.ok) redirect(result.path);
  return { ok: false };
}
