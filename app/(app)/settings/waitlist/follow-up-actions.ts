"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  eraseAnswers,
  keepWithdrawal,
  linkFollowUpAppointment,
  markDeclineHandled,
  type CommandOutcome,
} from "@/lib/waitlist/followups-owner";

// 0325 — the owner's follow-up commands. STUDIO AND ACTOR COME FROM THE VERIFIED SESSION (getCurrentPractitionerWithStudio reads getUser),
// never the form; the form carries only ids, each checked as a UUID before it is used. The database re-derives the owner role regardless.
// Every outcome is redirected back to the anchor with a short closed code, so a failure is SHOWN and the owner is never left thinking a
// response was handled. No answer text, name or id is put in the redirect.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BACK = "/settings/waitlist";

export type FollowUpNotice = "done" | "already" | "refused" | "failed";

/** The closed code carried in `?fu=`. Exported for the page, which maps it to copy. */
export function noticeFor(outcome: CommandOutcome): FollowUpNotice {
  switch (outcome) {
    case "done":
      return "done";
    case "already":
      return "already";
    case "unavailable":
      return "failed";
    default:
      return "refused";
  }
}

function field(formData: FormData, name: string): string | null {
  const v = formData.get(name);
  return typeof v === "string" && UUID.test(v) ? v : null;
}

async function ownerSession() {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner" || !practitioner.user_id) return null;
  return { studioId: studio.id, actorUserId: practitioner.user_id };
}

function back(notice: FollowUpNotice): never {
  revalidatePath(BACK);
  redirect(`${BACK}?fu=${notice}#follow-up`);
}

export async function markHandledAction(formData: FormData): Promise<void> {
  const id = field(formData, "followupId");
  const s = await ownerSession();
  if (!id || !s) back("refused");
  back(noticeFor(await markDeclineHandled(s.studioId, s.actorUserId, id)));
}

export async function keepWithdrawalAction(formData: FormData): Promise<void> {
  const id = field(formData, "followupId");
  const s = await ownerSession();
  if (!id || !s) back("refused");
  back(noticeFor(await keepWithdrawal(s.studioId, s.actorUserId, id)));
}

export async function eraseAnswersAction(formData: FormData): Promise<void> {
  const id = field(formData, "followupId");
  const s = await ownerSession();
  if (!id || !s) back("refused");
  back(noticeFor(await eraseAnswers(s.studioId, s.actorUserId, id)));
}

/** Link an EXISTING appointment (booked by hand from here, or elsewhere). The database checks studio, client, status and uniqueness. */
export async function linkAppointmentAction(formData: FormData): Promise<void> {
  const id = field(formData, "followupId");
  const appointmentId = field(formData, "appointmentId");
  const s = await ownerSession();
  if (!id || !appointmentId || !s) back("refused");
  back(noticeFor(await linkFollowUpAppointment(s.studioId, s.actorUserId, id, appointmentId)));
}
