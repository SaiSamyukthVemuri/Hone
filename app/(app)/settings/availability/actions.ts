"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";

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
    throw new Error("Only studio owners can change availability.");
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
  if (buffer < 0 || buffer > 240) {
    throw new Error("Buffer must be between 0 and 240 minutes.");
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
  revalidatePath("/settings/availability");
  revalidatePath("/settings/studio");
}

// Saves the weekly default in one round-trip. Form encodes seven rows.
export async function saveWeeklyDefaultsAction(formData: FormData): Promise<void> {
  const { studioId } = await assertOwner();
  const supabase = await createClient();

  const rows: {
    studio_id: string;
    day_of_week: number;
    is_open: boolean;
    open_time: string | null;
    close_time: string | null;
  }[] = [];

  for (let dow = 0; dow < 7; dow++) {
    const isOpen = trimmed(formData.get(`is_open_${dow}`)) === "true";
    const open = nullable(formData.get(`open_time_${dow}`));
    const close = nullable(formData.get(`close_time_${dow}`));
    if (isOpen) {
      if (!open || !close)
        throw new Error("Open and close times are required for open days.");
      if (open >= close)
        throw new Error("Close time must be after open time.");
    }
    rows.push({
      studio_id: studioId,
      day_of_week: dow,
      is_open: isOpen,
      open_time: isOpen ? open : null,
      close_time: isOpen ? close : null,
    });
  }

  // Upsert each day individually so a partial failure doesn't leave a half-applied state.
  for (const row of rows) {
    const { error } = await supabase
      .from("studio_availability_default")
      .upsert(row, { onConflict: "studio_id,day_of_week" });
    if (error)
      throw new Error(`Failed to save weekly defaults: ${error.message}`);
  }
  revalidatePath("/settings/availability");
}

export async function upsertOverrideAction(formData: FormData): Promise<void> {
  const { studioId } = await assertOwner();
  const effectiveDate = trimmed(formData.get("effective_date"));
  if (!effectiveDate) throw new Error("Date is required.");
  const isOpen = trimmed(formData.get("is_open")) === "true";
  const open = nullable(formData.get("open_time"));
  const close = nullable(formData.get("close_time"));
  const note = nullable(formData.get("note"));

  if (isOpen) {
    if (!open || !close)
      throw new Error("Open and close times are required for open days.");
    if (open >= close)
      throw new Error("Close time must be after open time.");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("studio_availability_overrides")
    .upsert(
      {
        studio_id: studioId,
        effective_date: effectiveDate,
        is_open: isOpen,
        open_time: isOpen ? open : null,
        close_time: isOpen ? close : null,
        note,
      },
      { onConflict: "studio_id,effective_date" },
    );
  if (error)
    throw new Error(`Failed to save override: ${error.message}`);
  revalidatePath("/settings/availability");
}

export async function deleteOverrideAction(formData: FormData): Promise<void> {
  const { studioId } = await assertOwner();
  const id = trimmed(formData.get("id"));
  if (!id) throw new Error("Missing override id.");
  const supabase = await createClient();
  const { error } = await supabase
    .from("studio_availability_overrides")
    .delete()
    .eq("id", id)
    .eq("studio_id", studioId);
  if (error) throw new Error(`Failed to delete override: ${error.message}`);
  revalidatePath("/settings/availability");
}

export async function createBlockoutAction(formData: FormData): Promise<void> {
  const { studioId } = await assertOwner();
  const starts = trimmed(formData.get("starts_on"));
  const ends = trimmed(formData.get("ends_on"));
  const reason = nullable(formData.get("reason"));
  if (!starts || !ends) throw new Error("Both start and end dates required.");
  if (ends < starts)
    throw new Error("End date must be on or after start date.");

  const supabase = await createClient();
  const { error } = await supabase.from("studio_blockouts").insert({
    studio_id: studioId,
    starts_on: starts,
    ends_on: ends,
    reason,
  });
  if (error) throw new Error(`Failed to add blockout: ${error.message}`);
  revalidatePath("/settings/availability");
}

export async function deleteBlockoutAction(formData: FormData): Promise<void> {
  const { studioId } = await assertOwner();
  const id = trimmed(formData.get("id"));
  if (!id) throw new Error("Missing blockout id.");
  const supabase = await createClient();
  const { error } = await supabase
    .from("studio_blockouts")
    .delete()
    .eq("id", id)
    .eq("studio_id", studioId);
  if (error) throw new Error(`Failed to delete blockout: ${error.message}`);
  revalidatePath("/settings/availability");
}
