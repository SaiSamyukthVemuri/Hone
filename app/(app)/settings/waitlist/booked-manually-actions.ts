"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { markEntryBookedManually } from "@/lib/waitlist/booked-manually";
import { waitlistBookedManuallyEnabled, type BookedManuallyResult } from "@/lib/waitlist/booked-manually-notice";

// The owner's "Booked manually" command. STUDIO AND ACTOR COME FROM THE VERIFIED SESSION; the form carries only the entry and appointment ids (each
// checked as a UUID) and an explicit confirmation for an email mismatch. The database re-derives the owner role regardless. Every outcome is redirected
// back with a short closed code, so a failure is SHOWN and the owner is never left thinking an entry was booked. Nothing is sent.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BACK = "/settings/waitlist";

function field(formData: FormData, name: string): string | null {
  const v = formData.get(name);
  return typeof v === "string" && UUID.test(v) ? v : null;
}

function back(code: BookedManuallyResult): never {
  revalidatePath(BACK);
  redirect(`${BACK}?bm=${code}`);
}

export async function bookedManuallyAction(formData: FormData): Promise<void> {
  const entryId = field(formData, "entryId");
  const appointmentId = field(formData, "appointmentId");
  // Explicit only: the confirmation is a checkbox the owner ticks, never inferred and never defaulted on.
  const confirm = formData.get("confirmEmailMismatch") === "on";
  if (!waitlistBookedManuallyEnabled()) back("unavailable");
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  // The role is checked HERE, before any command, and again inside the database. A bad id is a neutral refusal, not a claim about roles.
  if (practitioner.role !== "owner" || !practitioner.user_id) back("not_owner");
  if (!entryId || !appointmentId) back("invalid_request");
  back(await markEntryBookedManually(studio.id, practitioner.user_id!, entryId!, appointmentId!, confirm));
}
