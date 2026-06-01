"use server";

import { randomBytes } from "crypto";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { isPractitionerColor } from "@/lib/practitioner-colors";

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
// Calendar feed token (migration 0046)
// ---------------------------------------------------------------------------
// Generates or rotates the per-practitioner secret used as the path
// segment for the private iCal subscription feed at
// /calendar-feed/<token>.ics. Acts as both "create" and "rotate":
// the
// row's previous token is overwritten by an UPDATE, so any subscribed
// Google Calendar polling the old URL immediately starts receiving 404.
//
// Token entropy: 32 random bytes -> base64url (~43 chars). Generated
// with Node's crypto.randomBytes (CSPRNG), not Math.random.
//
// The action returns the new token to the caller; the Settings page
// then derives the full URL on the client. The token is never written
// to the URL on the server-side render (only to the practitioner's
// own clipboard via the client component) so a leaked HTML cache
// cannot leak the feed URL.

export type CalendarFeedResult =
  | { ok: true; token: string }
  | { ok: false; error: string };

function newFeedToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function rotateCalendarFeedTokenAction(): Promise<CalendarFeedResult> {
  const { practitioner } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot manage feeds." };
  }
  const supabase = await createClient();
  const token = newFeedToken();
  const { error } = await supabase
    .from("practitioners")
    .update({ calendar_feed_token: token })
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
    .update({ calendar_feed_token: null })
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
