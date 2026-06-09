"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { isPractitionerColor } from "@/lib/practitioner-colors";
import {
  generateCalendarFeedToken,
  hashCalendarFeedToken,
} from "@/lib/calendar-feed/token";

function trimmedOrThrow(
  value: FormDataEntryValue | null,
  label: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

export async function updateOwnProfileAction(formData: FormData): Promise<void> {
  const { practitioner } = await getCurrentPractitionerWithStudio();
  const displayName = trimmedOrThrow(
    formData.get("display_name"),
    "Your name",
  );

  const supabase = await createClient();
  const { error } = await supabase
    .from("practitioners")
    .update({ display_name: displayName })
    .eq("id", practitioner.id);
  if (error) {
    throw new Error(`Failed to save your name: ${error.message}`);
  }

  revalidatePath("/settings/profile");
  revalidatePath("/settings/studio");
  revalidatePath("/settings/team");
  revalidatePath("/dashboard");
}

export async function updatePractitionerColorAction(
  formData: FormData,
): Promise<void> {
  const { practitioner } = await getCurrentPractitionerWithStudio();
  const token = formData.get("color");
  if (!isPractitionerColor(token)) {
    throw new Error("Pick a color from the palette.");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("practitioners")
    .update({ color: token })
    .eq("id", practitioner.id);
  if (error) {
    throw new Error(`Failed to save your color: ${error.message}`);
  }

  revalidatePath("/settings/profile");
  revalidatePath("/calendar");
}

// ---------------------------------------------------------------------------
// Calendar feed token (migration 0046 + PR #182 / migration 0079)
// ---------------------------------------------------------------------------
// Generates or rotates the per-practitioner secret used as the path
// segment for the private iCal subscription feed at
// /calendar-feed/<token>.ics. Acts as both "create" and "rotate":
// the row's previous token is overwritten by an UPDATE, so any
// subscribed Google Calendar polling the old URL immediately starts
// receiving 404.
//
// Token entropy: 32 random bytes -> base64url (~43 chars). Generated
// with Node's crypto.randomBytes (CSPRNG) via the shared
// generateCalendarFeedToken helper.
//
// PR #182 phase 1 hashing model:
//   * The runtime feed route looks up by calendar_feed_token_hash
//     (SHA-256 hex) instead of the raw token (migration 0079).
//   * Rotation writes BOTH the raw column AND the hash column for
//     this phase. The raw column is what the existing settings UI
//     reads on page render to display the URL; nulling it here would
//     break the URL display on the deploy boundary. Phase 2 (a
//     separate PR) refactors the UI to display the URL only at
//     rotation time and then nulls the raw column.
//   * Clear nulls BOTH columns so the partial unique on either side
//     does not retain a stale value.
//
// The action returns the new raw token to the caller; the Settings
// page derives the full URL on the client. The hash is server-only
// and never returned to the browser.

export type CalendarFeedResult =
  | { ok: true; token: string }
  | { ok: false; error: string };

export async function rotateCalendarFeedTokenAction(): Promise<CalendarFeedResult> {
  const { practitioner } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot manage feeds." };
  }
  const supabase = await createClient();
  const token = generateCalendarFeedToken();
  const tokenHash = hashCalendarFeedToken(token);
  const { error } = await supabase
    .from("practitioners")
    .update({
      calendar_feed_token: token,
      calendar_feed_token_hash: tokenHash,
    })
    .eq("id", practitioner.id);
  if (error) {
    return {
      ok: false,
      error: "Could not generate a new calendar feed URL. Try again.",
    };
  }
  revalidatePath("/settings/profile");
  return { ok: true, token };
}

export async function clearCalendarFeedTokenAction(): Promise<CalendarFeedResult> {
  const { practitioner } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot manage feeds." };
  }
  const supabase = await createClient();
  const { error } = await supabase
    .from("practitioners")
    .update({
      calendar_feed_token: null,
      calendar_feed_token_hash: null,
    })
    .eq("id", practitioner.id);
  if (error) {
    return {
      ok: false,
      error: "Could not disable the calendar feed. Try again.",
    };
  }
  revalidatePath("/settings/profile");
  return { ok: true, token: "" };
}
