"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio, getPractitionersForStudio } from "@/lib/supabase/queries";
import { dbErrorCode } from "@/lib/logging/error-class";
import { isPractitionerColor } from "@/lib/practitioner-colors";
import { suggestDistinctColour } from "@/lib/calendar/colour-assignment";

// Settings > Calendar server actions (WS-C): the caller's OWN colour only. No studio-wide write lives here.

export type CalendarPreferencesResult = { ok: true } | { ok: false; error: string };

// Applies the suggested distinct colour to the CALLER'S OWN row through the governed 0178 command
// (no practitioner id crosses the boundary). It re-derives the suggestion on the server from the
// studio's current colours instead of trusting a submitted token, and refuses when the caller has
// already chosen a colour, so a stale page can never overwrite a deliberate choice.
export async function applySuggestedColourAction(): Promise<CalendarPreferencesResult> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (isPractitionerColor(practitioner.color) && practitioner.color !== "neutral") {
    return { ok: false, error: "You already have a calendar colour." };
  }
  const holders = await getPractitionersForStudio(studio.id);
  const token = suggestDistinctColour(holders, practitioner.id);
  if (!token) return { ok: false, error: "Every colour is already in use. Pick one yourself." };

  const supabase = await createClient();
  const { data: updatedId, error } = await supabase.rpc("update_own_practitioner_profile", {
    p_studio_id: studio.id,
    p_display_name: null,
    p_color: token,
  });
  if (error) return { ok: false, error: `Failed to save your colour: ${dbErrorCode(error)}` };
  if (!updatedId) return { ok: false, error: "Failed to save your colour: no active membership." };

  revalidatePath("/settings/calendar");
  revalidatePath("/calendar");
  return { ok: true };
}
