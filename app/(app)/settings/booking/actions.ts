"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { BUFFER_PRESET_MINUTES } from "@/lib/booking/buffer-presets";

function trimmed(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullable(value: FormDataEntryValue | null): string | null {
  const t = trimmed(value);
  return t.length === 0 ? null : t;
}

function parseInteger(
  value: FormDataEntryValue | null,
  fallback: number,
): number {
  const t = trimmed(value);
  if (!t) return fallback;
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : fallback;
}

async function assertOwner(): Promise<{ studioId: string }> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    throw new Error("Only studio owners can change booking preferences.");
  }
  return { studioId: studio.id };
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export async function updateStudioBookingPrefsAction(
  formData: FormData,
): Promise<void> {
  const { studioId } = await assertOwner();

  const tz = trimmed(formData.get("timezone")) || "America/Toronto";
  const defaultDuration = parseInteger(
    formData.get("default_appointment_duration_minutes"),
    60,
  );
  const buffer = parseInteger(formData.get("buffer_minutes"), 15);
  const slugRaw = trimmed(formData.get("slug")).toLowerCase();
  const address = nullable(formData.get("address"));
  const bookingDescription = nullable(formData.get("booking_description"));

  if (!SLUG_RE.test(slugRaw)) {
    throw new Error(
      "Slug must be lowercase letters, numbers, and dashes (1–64 chars).",
    );
  }
  if (defaultDuration < 5 || defaultDuration > 480) {
    throw new Error("Default duration must be between 5 and 480 minutes.");
  }
  if (!BUFFER_PRESET_MINUTES.includes(buffer)) {
    throw new Error(
      `Buffer must be one of: ${BUFFER_PRESET_MINUTES.join(", ")} minutes.`,
    );
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("studios")
    .update({
      timezone: tz,
      default_appointment_duration_minutes: defaultDuration,
      buffer_minutes: buffer,
      slug: slugRaw,
      address,
      booking_description: bookingDescription,
    })
    .eq("id", studioId);
  if (error) {
    if (error.code === "23505") {
      throw new Error("That slug is already taken. Pick another.");
    }
    throw new Error(`Failed to update booking settings: ${error.message}`);
  }
  revalidatePath("/settings/booking");
  revalidatePath("/settings/availability");
  revalidatePath("/settings/studio");
}
