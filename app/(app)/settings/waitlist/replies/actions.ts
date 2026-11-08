"use server";

import { revalidatePath } from "next/cache";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { acknowledgeTimesFeedback } from "@/lib/waitlist/times-feedback-owner";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mark one reply as seen. Studio and actor come from the session, never the form. */
export async function acknowledgeReplyAction(formData: FormData): Promise<void> {
  const invitationId = formData.get("invitationId");
  if (typeof invitationId !== "string" || !UUID.test(invitationId)) return;
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") return;
  await acknowledgeTimesFeedback(studio.id, invitationId, practitioner.user_id);
  revalidatePath("/settings/waitlist/replies");
  revalidatePath("/settings/waitlist");
}
