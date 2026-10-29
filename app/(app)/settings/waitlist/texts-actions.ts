"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { dbErrorCode } from "@/lib/logging/error-class";

// ===========================================================================
// WAITLIST TEXTS — the studio switch (0206 send_waitlist_invitation_sms)
// ===========================================================================
//
// Owner-only. Writes the one boolean on the CALLER'S studio; the studio id is
// resolved from the session, never from the form. The value must be the literal
// "true" or "false". RLS "studios: owners update" is the second wall.
//
// WHAT THE SWITCH DOES NOT DO. Turning it on sends nothing by itself (0210).
// The database claim still refuses unless the person recorded SMS consent, the
// studio has an active approved sender, and the per-invitation / per-number-
// per-day rules hold. Turning it off makes the claim answer studio_disabled and
// write nothing. This action never touches reminders, postcare or consent.

export type WaitlistTextsResult = { ok: true } | { ok: false; error: string };

export async function setWaitlistTextsAction(formData: FormData): Promise<WaitlistTextsResult> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return { ok: false, error: "Only studio owners can change waitlist texts." };
  }
  const raw = formData.get("send_waitlist_invitation_sms");
  if (raw !== "true" && raw !== "false") {
    return { ok: false, error: "Could not save settings. Please try again." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("studios")
    .update({ send_waitlist_invitation_sms: raw === "true" })
    .eq("id", studio.id);
  if (error) {
    console.error(
      JSON.stringify({
        event: "studio_waitlist_texts_update_failed",
        code: dbErrorCode(error),
        studioId: studio.id,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: "Could not save settings. Please try again." };
  }

  revalidatePath("/settings/waitlist");
  return { ok: true };
}
