"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { dbErrorCode } from "@/lib/logging/error-class";
import {
  BookingSettingsError,
  bookingSettingsErrorUrl,
  parseBookingSettingsView,
  type BookingSettingsErrorCode,
} from "@/lib/booking/settings-error-codes";
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
    throw new BookingSettingsError("buffer_invalid");
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
    throw new BookingSettingsError("horizon_invalid");
  }
  return Number(raw);
}

async function assertOwner(): Promise<{
  studioId: string;
  currentSlug: string | null;
}> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    throw new BookingSettingsError("not_owner");
  }
  return {
    studioId: studio.id,
    currentSlug: typeof studio.slug === "string" ? studio.slug : null,
  };
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

// Reserved booking slugs. Block new submissions only: owners with an
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
//   ?error=<code>          on a failure (a code from
//                          lib/booking/settings-error-codes.ts, never text)
// The page reads these params and renders a calm green/red banner so
// the practitioner sees feedback after every tap. The redirect signal
// from next/navigation is itself thrown, so we collect the failure
// code in a local and only call redirect() once at the end.
export async function updateStudioBookingPrefsAction(
  formData: FormData,
): Promise<void> {
  let failureCode: BookingSettingsErrorCode | null = null;
  // Which focused view posted this (a hidden field); only the two known views
  // count, anything else falls back to the doorway.
  const view = parseBookingSettingsView(formData.get("view"));

  try {
    const { studioId, currentSlug } = await assertOwner();

    // R2: the booking link and the booking window are separate views, each
    // posting only its own fields. Write ONLY the fields present, so one view's
    // save can never reset the other's fields to a default. Every validation
    // below is unchanged; it just runs for the fields that were sent.
    const update: Record<string, string | number | null> = {};
    if (formData.has("timezone")) {
      update.timezone = trimmed(formData.get("timezone")) || "America/Toronto";
    }
    if (formData.has("default_appointment_duration_minutes")) {
      const defaultDuration = parseInteger(
        formData.get("default_appointment_duration_minutes"),
        60,
      );
      if (defaultDuration < 5 || defaultDuration > 480) {
        throw new BookingSettingsError("duration_invalid");
      }
      update.default_appointment_duration_minutes = defaultDuration;
    }
    if (formData.has("buffer_minutes")) {
      update.buffer_minutes = parseBufferPreset(formData.get("buffer_minutes"));
    }
    if (formData.has("public_booking_horizon_months")) {
      update.public_booking_horizon_months = parsePublicBookingHorizonMonths(
        formData.get("public_booking_horizon_months"),
      );
    }
    let slugRaw = currentSlug;
    if (formData.has("slug")) {
      slugRaw = trimmed(formData.get("slug")).toLowerCase();
      if (!SLUG_RE.test(slugRaw)) {
        throw new BookingSettingsError("slug_invalid");
      }
      if (slugRaw !== currentSlug && RESERVED_SLUGS.has(slugRaw)) {
        throw new BookingSettingsError("slug_reserved");
      }
      update.slug = slugRaw;
    }
    if (formData.has("address")) update.address = nullable(formData.get("address"));
    if (formData.has("booking_description")) {
      update.booking_description = nullable(formData.get("booking_description"));
    }
    if (Object.keys(update).length === 0) {
      throw new BookingSettingsError("save_failed");
    }

    const supabase = await createClient();
    const { error } = await supabase
      .from("studios")
      .update(update)
      .eq("id", studioId);
    if (error) {
      if (error.code === "23505") {
        throw new BookingSettingsError("slug_taken");
      }
      // 23P01: the timezone-change trigger rebuilt this studio's
      // full_day_blockout reservation rows into UTC instants under the
      // new timezone, and at least one recalculated interval collided
      // with another reservation. Buffer changes do NOT trigger
      // retroactive resync; existing appointments keep their migration
      // 0029 snapshot.
      if (error.code === "23P01") {
        throw new BookingSettingsError("timezone_conflict");
      }
      // The catch below shows this text to the person and puts it in the
      // redirect query, so it is a fixed sentence; the database's text stays
      // out of the banner and the URL, and the log carries the code only.
      console.error(
        JSON.stringify({
          event: "booking_settings_update_failed",
          code: dbErrorCode(error),
          timestamp: new Date().toISOString(),
        }),
      );
      throw new BookingSettingsError("save_failed");
    }
    revalidatePath("/settings/booking", "layout");
    revalidatePath("/settings/availability");
    revalidatePath("/settings/studio", "layout");
    revalidatePath("/calendar");
    if (slugRaw) revalidatePath(`/book/${slugRaw}`);
  } catch (err) {
    failureCode = err instanceof BookingSettingsError ? err.code : "save_failed";
  }

  if (failureCode) redirect(bookingSettingsErrorUrl(failureCode, view));
  redirect(`/settings/booking${view ? `/${view}` : ""}?saved=1`);
}

// ===========================================================================
// NEW-CLIENT-MODE-01 — THE OWNER'S OWN CONTROL
// ===========================================================================
//
// Its OWN action rather than a field on the preferences form above, because it
// is the only setting here whose authority is a database command rather than a
// column update: the browser sends an intent, and membership plus owner role
// are re-derived inside `set_new_client_admission_mode` from auth.uid(). Folding
// it into the general save would have meant a studio-wide write path that could
// change admission as a side effect of editing a buffer.
//
// The owner changes this without a deploy, an allowlist, or asking anyone.
export async function updateNewClientAdmissionModeAction(
  formData: FormData,
): Promise<void> {
  let failureCode: BookingSettingsErrorCode | null = null;
  try {
    const { studioId } = await assertOwner();
    // INTENT ONLY. Not validated into a mode here beyond being a string - the
    // database owns the closed set and answers `invalid_mode` for anything
    // outside it, so there is exactly one place that decides what is legal.
    const intent = trimmed(formData.get("new_client_admission_mode"));

    // NO CALLER-SUPPLIED FACT. An earlier version computed "is this studio still
    // email-only?" here and passed it in, which protected this screen and
    // nothing else: the command is granted to `authenticated` and only verifies
    // ownership, so an owner could call it straight through PostgREST and pass
    // `false`. The command now reads `new_client_admission_mode_set_at` from the
    // row itself, under its own lock, so there is nothing here to get wrong.
    const supabase = await createClient();
    const { data, error } = await supabase.rpc(
      "set_new_client_admission_mode",
      { p_studio_id: studioId, p_mode: intent },
    );
    if (error) {
      failureCode = "admission_save_failed";
    } else {
      const row = Array.isArray(data) ? data[0] : data;
      const outcome = (row as { outcome?: string } | null)?.outcome ?? "unknown";
      if (outcome === "not_authorized") {
        failureCode = "admission_not_owner";
      } else if (outcome === "invalid_mode") {
        failureCode = "admission_invalid_mode";
      } else if (outcome === "legacy_waitlist_cutover_required") {
        // TRUTHFUL, and it names the thing that has to happen first rather than
        // pretending the setting failed.
        // TRUTHFUL about what has to happen, and it names the one action that
        // does it. The rule is "not yet cut over", which is why the copy does
        // not promise this is only about email.
        failureCode = "admission_cutover_required";
      } else if (outcome !== "ok") {
        failureCode = "admission_save_failed";
      }
    }
  } catch {
    failureCode = "admission_save_failed";
  }

  revalidatePath("/settings/booking", "layout");
  redirect(failureCode ? bookingSettingsErrorUrl(failureCode, "link") : "/settings/booking/link?saved=1");
}
