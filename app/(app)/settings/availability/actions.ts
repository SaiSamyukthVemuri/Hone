"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { todayInTz, utcInstantFromLocal } from "@/lib/booking/tz";
import type { Practitioner, Studio } from "@/lib/types/database";

function trimmed(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullable(value: FormDataEntryValue | null): string | null {
  const t = trimmed(value);
  return t.length === 0 ? null : t;
}

async function assertOwner(): Promise<{ studioId: string }> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    throw new Error("Only studio owners can change availability.");
  }
  return { studioId: studio.id };
}

async function assertOwnerWithStudio(): Promise<{
  studio: Studio;
  practitioner: Practitioner;
}> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    throw new Error("Only studio owners can change availability.");
  }
  return { studio, practitioner };
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Upserts one day-of-week row. Lets the inline editor save a single day
// without restating the other six. Returns nothing on success.
export async function upsertDayDefaultAction(formData: FormData): Promise<void> {
  const { studioId } = await assertOwner();
  const dowRaw = trimmed(formData.get("day_of_week"));
  const dow = Number(dowRaw);
  if (!Number.isFinite(dow) || dow < 0 || dow > 6) {
    throw new Error("Day of week must be 0–6.");
  }
  const isOpen = trimmed(formData.get("is_open")) === "true";
  const open = nullable(formData.get("open_time"));
  const close = nullable(formData.get("close_time"));

  if (isOpen) {
    if (!open || !close)
      throw new Error("Open and close times are required for open days.");
    if (!TIME_RE.test(open) || !TIME_RE.test(close))
      throw new Error("Times must be in HH:MM format.");
    if (open >= close)
      throw new Error("Close time must be after open time.");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("studio_availability_default")
    .upsert(
      {
        studio_id: studioId,
        day_of_week: dow,
        is_open: isOpen,
        open_time: isOpen ? open : null,
        close_time: isOpen ? close : null,
      },
      { onConflict: "studio_id,day_of_week" },
    );
  if (error) throw new Error(`Failed to save: ${error.message}`);
  revalidatePath("/settings/availability");
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
  if (error) {
    // 23P01: the AFTER trigger upsert into studio_calendar_reservations
    // collided with an existing appointment, timed block, or other
    // blockout. The blockout insert was rolled back.
    if (error.code === "23P01") {
      throw new Error(RESERVATION_CONFLICT_MESSAGE);
    }
    throw new Error(`Failed to add blockout: ${error.message}`);
  }
  revalidatePath("/settings/availability");
  revalidatePath("/calendar");
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

// -------------------------------------------------------------------------
// One-off timed blocks (migration 0030). Owner-only via RLS. The DB
// trigger mirrors writes into studio_calendar_reservations, where the
// unified gist exclusion enforces no overlap with appointments,
// other blocks, or full-day blockouts. A 23P01 from PostgREST means
// the block conflicts; we surface a clean message.
// -------------------------------------------------------------------------

const TIMED_BLOCK_CATEGORIES = [
  "lunch",
  "break",
  "meeting",
  "emergency",
  "personal",
  "training",
  "admin",
  "other",
] as const;

const RESERVATION_CONFLICT_MESSAGE =
  "This time overlaps an existing appointment or blocked period. Choose another time or resolve the existing calendar item first.";

function buildBlockUtcRange(
  dateStr: string,
  startLocal: string,
  endLocal: string,
  tz: string,
): { startsAt: string; endsAt: string } {
  const start = utcInstantFromLocal(dateStr, startLocal, tz);
  const end = utcInstantFromLocal(dateStr, endLocal, tz);
  return { startsAt: start.toISOString(), endsAt: end.toISOString() };
}

export async function createTimedBlockAction(
  formData: FormData,
): Promise<void> {
  const { studio, practitioner } = await assertOwnerWithStudio();
  const dateStr = trimmed(formData.get("date"));
  const startLocal = trimmed(formData.get("start_local"));
  const endLocal = trimmed(formData.get("end_local"));
  const category = trimmed(formData.get("category")).toLowerCase();
  const privateNote = nullable(formData.get("private_note"));

  if (!dateStr || !startLocal || !endLocal) {
    throw new Error("Date and start/end times are required.");
  }
  // Server-side guard: the date-input min attribute can be bypassed
  // by a tampered request. The /settings/availability list only
  // surfaces current-and-future blocks, so a backdated row would
  // disappear from view on save.
  const todayLocal = todayInTz(studio.timezone);
  if (dateStr < todayLocal) {
    throw new Error("Blocked time cannot be created in the past.");
  }
  if (!TIME_RE.test(startLocal) || !TIME_RE.test(endLocal)) {
    throw new Error("Times must be in HH:MM format.");
  }
  if (startLocal >= endLocal) {
    throw new Error("End time must be after start time.");
  }
  if (
    !(TIMED_BLOCK_CATEGORIES as ReadonlyArray<string>).includes(category)
  ) {
    throw new Error("Invalid category.");
  }

  const { startsAt, endsAt } = buildBlockUtcRange(
    dateStr,
    startLocal,
    endLocal,
    studio.timezone,
  );

  const supabase = await createClient();
  const { error } = await supabase.from("studio_timed_blocks").insert({
    studio_id: studio.id,
    starts_at: startsAt,
    ends_at: endsAt,
    category,
    private_note: privateNote,
    created_by: practitioner.id,
  });
  if (error) {
    if (error.code === "23P01") {
      throw new Error(RESERVATION_CONFLICT_MESSAGE);
    }
    throw new Error(`Failed to add block: ${error.message}`);
  }
  revalidatePath("/settings/availability");
  revalidatePath("/calendar");
}

export async function updateTimedBlockAction(
  formData: FormData,
): Promise<void> {
  const { studio } = await assertOwnerWithStudio();
  const id = trimmed(formData.get("id"));
  const dateStr = trimmed(formData.get("date"));
  const startLocal = trimmed(formData.get("start_local"));
  const endLocal = trimmed(formData.get("end_local"));
  const category = trimmed(formData.get("category")).toLowerCase();
  const privateNote = nullable(formData.get("private_note"));

  if (!id) throw new Error("Missing block id.");
  if (!dateStr || !startLocal || !endLocal) {
    throw new Error("Date and start/end times are required.");
  }
  // Server-side guard: the date-input min attribute can be bypassed
  // by a tampered request. The /settings/availability list only
  // surfaces current-and-future blocks, so a backdated row would
  // disappear from view on save.
  const todayLocal = todayInTz(studio.timezone);
  if (dateStr < todayLocal) {
    throw new Error("Blocked time cannot be created in the past.");
  }
  if (!TIME_RE.test(startLocal) || !TIME_RE.test(endLocal)) {
    throw new Error("Times must be in HH:MM format.");
  }
  if (startLocal >= endLocal) {
    throw new Error("End time must be after start time.");
  }
  if (
    !(TIMED_BLOCK_CATEGORIES as ReadonlyArray<string>).includes(category)
  ) {
    throw new Error("Invalid category.");
  }

  const { startsAt, endsAt } = buildBlockUtcRange(
    dateStr,
    startLocal,
    endLocal,
    studio.timezone,
  );

  const supabase = await createClient();
  const { error } = await supabase
    .from("studio_timed_blocks")
    .update({
      starts_at: startsAt,
      ends_at: endsAt,
      category,
      private_note: privateNote,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("studio_id", studio.id);
  if (error) {
    if (error.code === "23P01") {
      throw new Error(RESERVATION_CONFLICT_MESSAGE);
    }
    throw new Error(`Failed to update block: ${error.message}`);
  }
  revalidatePath("/settings/availability");
  revalidatePath("/calendar");
}

export async function deleteTimedBlockAction(
  formData: FormData,
): Promise<void> {
  const { studio } = await assertOwnerWithStudio();
  const id = trimmed(formData.get("id"));
  if (!id) throw new Error("Missing block id.");
  const supabase = await createClient();
  const { error } = await supabase
    .from("studio_timed_blocks")
    .delete()
    .eq("id", id)
    .eq("studio_id", studio.id);
  if (error) throw new Error(`Failed to delete block: ${error.message}`);
  revalidatePath("/settings/availability");
  revalidatePath("/calendar");
}
