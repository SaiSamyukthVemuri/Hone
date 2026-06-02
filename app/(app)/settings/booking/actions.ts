"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { BUFFER_PRESET_MINUTES } from "@/lib/booking/buffer-presets";
import { PUBLIC_BOOKING_HORIZON_MONTHS_VALUES } from "@/lib/booking/horizon";

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

// Strict preset validation. parseInt() would happily parse "15garbage"
// as 15 and pass our membership check; require the raw string to be
// one of the exact preset literals before converting.
const BUFFER_PRESET_STRINGS = BUFFER_PRESET_MINUTES.map(String);
function parseBufferPreset(value: FormDataEntryValue | null): number {
  const raw = trimmed(value);
  if (!BUFFER_PRESET_STRINGS.includes(raw)) {
    throw new Error(
      `Buffer must be one of: ${BUFFER_PRESET_MINUTES.join(", ")} minutes.`,
    );
  }
  return Number(raw);
}

// Strict membership check for the booking-horizon select. Same idiom as
// parseBufferPreset above: never coerce to a number until we've
// confirmed the raw string matches one of the allowed literals.
const HORIZON_MONTH_STRINGS = PUBLIC_BOOKING_HORIZON_MONTHS_VALUES.map(String);
function parsePublicBookingHorizonMonths(
  value: FormDataEntryValue | null,
): number {
  const raw = trimmed(value);
  if (!HORIZON_MONTH_STRINGS.includes(raw)) {
    throw new Error(
      `Booking horizon must be one of: ${PUBLIC_BOOKING_HORIZON_MONTHS_VALUES.join(", ")} months.`,
    );
  }
  return Number(raw);
}

async function assertOwner(): Promise<{
  studioId: string;
  currentSlug: string | null;
}> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    throw new Error("Only studio owners can change booking preferences.");
  }
  return {
    studioId: studio.id,
    currentSlug: typeof studio.slug === "string" ? studio.slug : null,
  };
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

// Reserved booking slugs. Block new submissions only — owners with an
// existing slug that happens to match (unlikely; the list is the routes
// the marketing/app surface uses) keep working because the check is
// skipped when the submitted slug is byte-identical to the studio's
// current slug. No slug redirect/history is added in this PR.
const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "admin",
  "api",
  "auth",
  "book",
  "calendar",
  "clients",
  "dashboard",
  "data",
  "intake",
  "login",
  "pricing",
  "privacy",
  "reschedule",
  "settings",
  "terms",
]);

// Save the studio booking preferences and surface the outcome inline
// rather than via Next's error.tsx boundary. The action redirects back
// to /settings/booking with one of two query params:
//   ?saved=1               on success
//   ?error=<urlencoded>    on a validated failure
// The page reads these params and renders a calm green/red banner so
// the practitioner sees feedback after every tap. The redirect signal
// from next/navigation is itself thrown, so we collect the failure
// message in a local string and only call redirect() once at the end.
export async function updateStudioBookingPrefsAction(
  formData: FormData,
): Promise<void> {
  let failureMessage: string | null = null;

  try {
    const { studioId, currentSlug } = await assertOwner();

    const tz = trimmed(formData.get("timezone")) || "America/Toronto";
    const defaultDuration = parseInteger(
      formData.get("default_appointment_duration_minutes"),
      60,
    );
    const buffer = parseBufferPreset(formData.get("buffer_minutes"));
    const publicBookingHorizonMonths = parsePublicBookingHorizonMonths(
      formData.get("public_booking_horizon_months"),
    );
    const slugRaw = trimmed(formData.get("slug")).toLowerCase();
    const address = nullable(formData.get("address"));
    const bookingDescription = nullable(formData.get("booking_description"));

    if (!SLUG_RE.test(slugRaw)) {
      throw new Error(
        "Slug must be lowercase letters, numbers, and dashes (1-64 chars).",
      );
    }
    if (slugRaw !== currentSlug && RESERVED_SLUGS.has(slugRaw)) {
      throw new Error("That booking link is reserved. Please choose another.");
    }
    if (defaultDuration < 5 || defaultDuration > 480) {
      throw new Error("Default duration must be between 5 and 480 minutes.");
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
        public_booking_horizon_months: publicBookingHorizonMonths,
      })
      .eq("id", studioId);
    if (error) {
      if (error.code === "23505") {
        throw new Error("That slug is already taken. Pick another.");
      }
      // 23P01: the timezone-change trigger rebuilt this studio's
      // full_day_blockout reservation rows into UTC instants under the
      // new timezone, and at least one recalculated interval collided
      // with another reservation. Buffer changes do NOT trigger
      // retroactive resync; existing appointments keep their migration
      // 0029 snapshot.
      if (error.code === "23P01") {
        throw new Error(
          "Changing the timezone would push a blockout into a conflict with an existing calendar item. Reschedule or remove the affected appointment or block first.",
        );
      }
      throw new Error(`Failed to update booking settings: ${error.message}`);
    }
    revalidatePath("/settings/booking");
    revalidatePath("/settings/availability");
    revalidatePath("/settings/studio");
    revalidatePath("/calendar");
    if (slugRaw) revalidatePath(`/book/${slugRaw}`);
  } catch (err) {
    failureMessage =
      err instanceof Error && err.message ? err.message : "Save failed.";
  }

  if (failureMessage) {
    redirect(
      `/settings/booking?error=${encodeURIComponent(failureMessage)}`,
    );
  }
  redirect("/settings/booking?saved=1");
}
