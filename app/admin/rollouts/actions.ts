"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/admin";
import { addPilotStudio, ALL_CONFIRM_PHRASE, logBlockedAttempt, removePilotStudio, ROLLOUT_MODES, setRolloutMode, type RolloutMode } from "@/lib/rollouts/admin-commands";

// Operator-only controls for the xCell MultiPlex / New view rollout. EVERY action re-checks isAdmin (the layout is not the gate), takes the actor
// from the AUTHENTICATED SESSION and never from the form, and reads ONLY the named fields below. Enabling for ALL studios needs the typed phrase,
// enforced HERE (not only in the page). Turning it on creates nothing in any studio: it only changes what the existing code offers.

export type RolloutActionResult = { ok: boolean; message: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Actor = { userId: string; email: string };
async function authorize(
  blockedAction: "platform_rollout_mode_set" | "platform_rollout_studio_added" | "platform_rollout_studio_removed",
): Promise<{ actor: Actor } | { refusal: RolloutActionResult }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // No session: NOTHING is written (an unauthenticated loop cannot grow the log).
  if (!user) return { refusal: { ok: false, message: "Not authorized." } };
  if (!isAdmin(user.email) || !user.email) {
    await logBlockedAttempt(user.id, blockedAction); // user id only, one row per user per action per 10 minutes
    return { refusal: { ok: false, message: "Not authorized." } };
  }
  return { actor: { userId: user.id, email: user.email } };
}

export async function setRolloutModeAction(formData: FormData): Promise<RolloutActionResult> {
  const auth = await authorize("platform_rollout_mode_set");
  if ("refusal" in auth) return auth.refusal;
  const mode = formData.get("mode");
  if (typeof mode !== "string" || !(ROLLOUT_MODES as readonly string[]).includes(mode)) return { ok: false, message: "Choose Off, Pilot or All." };
  if (mode === "all" && formData.get("confirm") !== ALL_CONFIRM_PHRASE) {
    return { ok: false, message: `To turn this on for every studio, type ${ALL_CONFIRM_PHRASE} exactly.` };
  }
  const out = await setRolloutMode(mode as RolloutMode, auth.actor);
  if (out === null) return { ok: false, message: "That did not save. Nothing changed. Try again." };
  revalidatePath("/admin/rollouts");
  return { ok: true, message: out === "unchanged" ? "Already set." : "Saved." };
}

export async function addPilotStudioAction(formData: FormData): Promise<RolloutActionResult> {
  const auth = await authorize("platform_rollout_studio_added");
  if ("refusal" in auth) return auth.refusal;
  const studioId = formData.get("studioId");
  if (typeof studioId !== "string" || !UUID.test(studioId)) return { ok: false, message: "Choose a studio from the list." };
  const out = await addPilotStudio(studioId.toLowerCase(), auth.actor);
  if (out === null) return { ok: false, message: "That did not save. Nothing changed. Try again." };
  if (out === "not_found") return { ok: false, message: "That studio was not found." };
  revalidatePath("/admin/rollouts");
  return { ok: true, message: out === "exists" ? "Already in the pilot." : "Added to the pilot." };
}

export async function removePilotStudioAction(formData: FormData): Promise<RolloutActionResult> {
  const auth = await authorize("platform_rollout_studio_removed");
  if ("refusal" in auth) return auth.refusal;
  const studioId = formData.get("studioId");
  if (typeof studioId !== "string" || !UUID.test(studioId)) return { ok: false, message: "Choose a studio from the list." };
  const out = await removePilotStudio(studioId.toLowerCase(), auth.actor);
  if (out === null) return { ok: false, message: "That did not save. Nothing changed. Try again." };
  revalidatePath("/admin/rollouts");
  return { ok: true, message: out === "absent" ? "It was not in the pilot." : "Removed from the pilot." };
}
