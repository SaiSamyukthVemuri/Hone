"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { acknowledgeTimesFeedback } from "@/lib/waitlist/times-feedback-owner";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = "/settings/waitlist/replies";

/**
 * Mark one reply as seen. Studio and actor come from the session, never the form.
 * A failure is SHOWN: it redirects back with ack=failed instead of returning
 * silently, so the owner is never left thinking a reply was cleared.
 */
export async function acknowledgeReplyAction(formData: FormData): Promise<void> {
  const invitationId = formData.get("invitationId");
  if (typeof invitationId !== "string" || !UUID.test(invitationId)) redirect(`${PAGE}?ack=failed`);
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") redirect(`${PAGE}?ack=failed`);
  const ok = await acknowledgeTimesFeedback(studio.id, invitationId, practitioner.user_id);
  revalidatePath(PAGE);
  revalidatePath("/settings/waitlist");
  redirect(ok ? PAGE : `${PAGE}?ack=failed`);
}
