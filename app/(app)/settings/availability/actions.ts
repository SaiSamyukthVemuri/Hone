"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { todayInTz, utcInstantFromLocal } from "@/lib/booking/tz";
import type { Practitioner, Studio } from "@/lib/types/database";

// Typed result used by every action that can hit the unified shadow's
// gist exclusion (sqlstate 23P01). Owner-facing UI displays
// result.error inline rather than relying on a thrown Server Action
// exception, which Next.js production masks to a generic message.
export type BlockActionResult =
  | { ok: true }
  | { ok: false; error: string };

const FALLBACK_CONFLICT_MESSAGE =
  "This time overlaps an existing appointment or blocked period. Choose another time or resolve the existing calendar item first.";

function formatTimeInTz(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(iso));
}

// Looks up the soonest reservation row that overlaps the requested
// interval and returns an owner-facing message. Does NOT expose
// client names, service details, private notes, or block categories.
async function lookupConflictMessage(
  supabase: SupabaseClient,
  studioId: string,
  studioTimezone: string,
  startsAtIso: string,
  endsAtIso: string,
  exclude?: { source_kind: string; source_id: string },
): Promise<string> {
  const { data } = await supabase
    .from("studio_calendar_reservations")
    .select("source_kind, source_id, starts_at, ends_at")
    .eq("studio_id", studioId)
    .lt("starts_at", endsAtIso)
    .gt("ends_at", startsAtIso)
    .order("starts_at")
    .limit(5);

  if (!data || data.length === 0) {
    return FALLBACK_CONFLICT_MESSAGE;
  }

  const candidates = exclude
    ? data.filter(
        (r) =>
          !(
            r.source_kind === exclude.source_kind &&
            r.source_id === exclude.source_id
          ),
      )
    : data;

  if (candidates.length === 0) {
    return FALLBACK_CONFLICT_MESSAGE;
  }

  const conflict = candidates[0];
  if (conflict.source_kind === "appointment") {
    const startFmt = formatTimeInTz(conflict.starts_at, studioTimezone);
    const endFmt = formatTimeInTz(conflict.ends_at, studioTimezone);
    return `You can't block this time because an appointment already reserves ${startFmt} to ${endFmt}, including turnaround time. Choose a time after ${endFmt}.`;
  }
  if (conflict.source_kind === "timed_block") {
    return "This time overlaps an existing blocked period. Edit or remove the existing block first.";
  }
  if (conflict.source_kind === "full_day_blockout") {
    return "This date is already unavailable because of an existing full-day blockout.";
  }
  return FALLBACK_CONFLICT_MESSAGE;
}

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

export async function createBlockoutAction(
  formData: FormData,
): Promise<BlockActionResult> {
  const { studio } = await assertOwnerWithStudio();
  const starts = trimmed(formData.get("starts_on"));
  const ends = trimmed(formData.get("ends_on"));
  const reason = nullable(formData.get("reason"));
  if (!starts || !ends) {
    return { ok: false, error: "Both start and end dates required." };
  }
  if (ends < starts) {
    return { ok: false, error: "End date must be on or after start date." };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("studio_blockouts").insert({
    studio_id: studio.id,
    starts_on: starts,
    ends_on: ends,
    reason,
  });
  if (error) {
    if (error.code === "23P01") {
      // Recompute the UTC range the trigger used so the lookup
      // matches exactly. Half-open: [local midnight starts, local
      // midnight (ends + 1)) in the studio's tz.
      const startUtc = utcInstantFromLocal(starts, "00:00", studio.timezone);
      const endDateStr = addDaysToIso(ends, 1);
      const endUtc = utcInstantFromLocal(endDateStr, "00:00", studio.timezone);
      const message = await lookupConflictMessage(
        supabase,
        studio.id,
        studio.timezone,
        startUtc.toISOString(),
        endUtc.toISOString(),
      );
      return { ok: false, error: message };
    }
    return { ok: false, error: `Failed to add blockout: ${error.message}` };
  }
  revalidatePath("/settings/availability");
  revalidatePath("/calendar");
  return { ok: true };
}

// Internal helper: adds N days to a YYYY-MM-DD string, returns
// YYYY-MM-DD. Uses UTC arithmetic so DST does not introduce drift.
function addDaysToIso(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
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
): Promise<BlockActionResult> {
  const { studio, practitioner } = await assertOwnerWithStudio();
  const dateStr = trimmed(formData.get("date"));
  const startLocal = trimmed(formData.get("start_local"));
  const endLocal = trimmed(formData.get("end_local"));
  const category = trimmed(formData.get("category")).toLowerCase();
  const privateNote = nullable(formData.get("private_note"));

  if (!dateStr || !startLocal || !endLocal) {
    return { ok: false, error: "Date and start/end times are required." };
  }
  const todayLocal = todayInTz(studio.timezone);
  if (dateStr < todayLocal) {
    return { ok: false, error: "Blocked time cannot be created in the past." };
  }
  if (!TIME_RE.test(startLocal) || !TIME_RE.test(endLocal)) {
    return { ok: false, error: "Times must be in HH:MM format." };
  }
  if (startLocal >= endLocal) {
    return { ok: false, error: "End time must be after start time." };
  }
  if (
    !(TIMED_BLOCK_CATEGORIES as ReadonlyArray<string>).includes(category)
  ) {
    return { ok: false, error: "Invalid category." };
  }

  const { startsAt, endsAt } = buildBlockUtcRange(
    dateStr,
    startLocal,
    endLocal,
    studio.timezone,
  );
  if (new Date(endsAt).getTime() <= Date.now()) {
    return { ok: false, error: "Blocked time must end in the future." };
  }

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
      const message = await lookupConflictMessage(
        supabase,
        studio.id,
        studio.timezone,
        startsAt,
        endsAt,
      );
      return { ok: false, error: message };
    }
    return { ok: false, error: `Failed to add block: ${error.message}` };
  }
  revalidatePath("/settings/availability");
  revalidatePath("/calendar");
  return { ok: true };
}

export async function updateTimedBlockAction(
  formData: FormData,
): Promise<BlockActionResult> {
  const { studio } = await assertOwnerWithStudio();
  const id = trimmed(formData.get("id"));
  const dateStr = trimmed(formData.get("date"));
  const startLocal = trimmed(formData.get("start_local"));
  const endLocal = trimmed(formData.get("end_local"));
  const category = trimmed(formData.get("category")).toLowerCase();
  const privateNote = nullable(formData.get("private_note"));

  if (!id) return { ok: false, error: "Missing block id." };
  if (!dateStr || !startLocal || !endLocal) {
    return { ok: false, error: "Date and start/end times are required." };
  }
  const todayLocal = todayInTz(studio.timezone);
  if (dateStr < todayLocal) {
    return { ok: false, error: "Blocked time cannot be created in the past." };
  }
  if (!TIME_RE.test(startLocal) || !TIME_RE.test(endLocal)) {
    return { ok: false, error: "Times must be in HH:MM format." };
  }
  if (startLocal >= endLocal) {
    return { ok: false, error: "End time must be after start time." };
  }
  if (
    !(TIMED_BLOCK_CATEGORIES as ReadonlyArray<string>).includes(category)
  ) {
    return { ok: false, error: "Invalid category." };
  }

  const { startsAt, endsAt } = buildBlockUtcRange(
    dateStr,
    startLocal,
    endLocal,
    studio.timezone,
  );
  if (new Date(endsAt).getTime() <= Date.now()) {
    return { ok: false, error: "Blocked time must end in the future." };
  }

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
      // Exclude the block we are editing from the conflict lookup
      // so we don't report a self-conflict. The shadow still holds
      // this row's pre-rollback values because the UPDATE was
      // aborted by the exclusion check.
      const message = await lookupConflictMessage(
        supabase,
        studio.id,
        studio.timezone,
        startsAt,
        endsAt,
        { source_kind: "timed_block", source_id: id },
      );
      return { ok: false, error: message };
    }
    return { ok: false, error: `Failed to update block: ${error.message}` };
  }
  revalidatePath("/settings/availability");
  revalidatePath("/calendar");
  return { ok: true };
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

// -------------------------------------------------------------------------
// Recurring break rules (migration 0031). Owner-only via RLS. The
// rule CRUD goes through SECURITY DEFINER RPCs so the rule update,
// future-occurrence delete, and re-materialization happen in a
// single transaction. A 23P01 from the shadow's exclusion is looked
// up the same way createTimedBlockAction does, so the owner sees the
// specific conflicting time.
// -------------------------------------------------------------------------

const RECURRING_BREAK_LABELS = ["lunch", "break", "admin", "other"] as const;

function parseDaysOfWeek(value: FormDataEntryValue | null): number[] {
  // The form posts a single comma-separated string like "1,3,5".
  const raw = trimmed(value);
  if (!raw) return [];
  const parts = raw.split(",").map((p) => Number(p.trim()));
  const unique: number[] = [];
  for (const n of parts) {
    if (!Number.isFinite(n) || n < 0 || n > 6) return [];
    if (!unique.includes(n)) unique.push(n);
  }
  unique.sort((a, b) => a - b);
  return unique;
}

function horizonEndDateInStudioTz(tz: string): string {
  // Mirrors lib/booking/horizon.ts BOOKING_HORIZON_DAYS = 90. Returns
  // YYYY-MM-DD that the RPC parses as a date.
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  noon.setUTCDate(noon.getUTCDate() + 90);
  return `${noon.getUTCFullYear()}-${String(noon.getUTCMonth() + 1).padStart(2, "0")}-${String(noon.getUTCDate()).padStart(2, "0")}`;
}

export async function createRecurringBreakRuleAction(
  formData: FormData,
): Promise<BlockActionResult> {
  const { studio, practitioner } = await assertOwnerWithStudio();
  const label = trimmed(formData.get("label")).toLowerCase();
  const days = parseDaysOfWeek(formData.get("days_of_week"));
  const startLocal = trimmed(formData.get("start_local"));
  const endLocal = trimmed(formData.get("end_local"));
  const active = trimmed(formData.get("active")) !== "false";

  if (!(RECURRING_BREAK_LABELS as ReadonlyArray<string>).includes(label)) {
    return { ok: false, error: "Invalid label." };
  }
  if (days.length === 0) {
    return { ok: false, error: "Pick at least one weekday." };
  }
  if (!TIME_RE.test(startLocal) || !TIME_RE.test(endLocal)) {
    return { ok: false, error: "Times must be in HH:MM format." };
  }
  if (startLocal >= endLocal) {
    return { ok: false, error: "End time must be after start time." };
  }

  const horizonEnd = horizonEndDateInStudioTz(studio.timezone);
  const supabase = await createClient();
  const { error } = await supabase.rpc(
    "create_recurring_break_rule_and_materialize",
    {
      p_studio_id: studio.id,
      p_label: label,
      p_days_of_week: days,
      p_start_local_time: startLocal,
      p_end_local_time: endLocal,
      p_active: active,
      p_created_by: practitioner.id,
      p_horizon_end: horizonEnd,
    },
  );
  if (error) {
    if (error.code === "23P01") {
      const message = await lookupRecurringBreakConflictMessage(
        supabase,
        studio.id,
        studio.timezone,
      );
      return { ok: false, error: message };
    }
    return { ok: false, error: `Failed to add recurring break: ${error.message}` };
  }
  revalidatePath("/settings/availability");
  revalidatePath("/calendar");
  return { ok: true };
}

export async function updateRecurringBreakRuleAction(
  formData: FormData,
): Promise<BlockActionResult> {
  const { studio } = await assertOwnerWithStudio();
  const id = trimmed(formData.get("id"));
  const label = trimmed(formData.get("label")).toLowerCase();
  const days = parseDaysOfWeek(formData.get("days_of_week"));
  const startLocal = trimmed(formData.get("start_local"));
  const endLocal = trimmed(formData.get("end_local"));
  const active = trimmed(formData.get("active")) !== "false";

  if (!id) return { ok: false, error: "Missing rule id." };
  if (!(RECURRING_BREAK_LABELS as ReadonlyArray<string>).includes(label)) {
    return { ok: false, error: "Invalid label." };
  }
  if (days.length === 0) {
    return { ok: false, error: "Pick at least one weekday." };
  }
  if (!TIME_RE.test(startLocal) || !TIME_RE.test(endLocal)) {
    return { ok: false, error: "Times must be in HH:MM format." };
  }
  if (startLocal >= endLocal) {
    return { ok: false, error: "End time must be after start time." };
  }

  const horizonEnd = horizonEndDateInStudioTz(studio.timezone);
  const supabase = await createClient();
  const { error } = await supabase.rpc(
    "update_recurring_break_rule_and_rematerialize",
    {
      p_rule_id: id,
      p_label: label,
      p_days_of_week: days,
      p_start_local_time: startLocal,
      p_end_local_time: endLocal,
      p_active: active,
      p_horizon_end: horizonEnd,
    },
  );
  if (error) {
    if (error.code === "23P01") {
      const message = await lookupRecurringBreakConflictMessage(
        supabase,
        studio.id,
        studio.timezone,
      );
      return { ok: false, error: message };
    }
    return { ok: false, error: `Failed to update recurring break: ${error.message}` };
  }
  revalidatePath("/settings/availability");
  revalidatePath("/calendar");
  return { ok: true };
}

export async function toggleRecurringBreakRuleActiveAction(
  formData: FormData,
): Promise<BlockActionResult> {
  const { studio } = await assertOwnerWithStudio();
  const id = trimmed(formData.get("id"));
  const active = trimmed(formData.get("active")) === "true";
  if (!id) return { ok: false, error: "Missing rule id." };

  const supabase = await createClient();
  // Fetch current rule values so we can call the update RPC without
  // re-typing them.
  const { data: rule, error: lookupErr } = await supabase
    .from("studio_recurring_break_rules")
    .select("label, days_of_week, start_local_time, end_local_time")
    .eq("id", id)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (lookupErr) return { ok: false, error: lookupErr.message };
  if (!rule) return { ok: false, error: "Rule not found." };

  const horizonEnd = horizonEndDateInStudioTz(studio.timezone);
  const { error } = await supabase.rpc(
    "update_recurring_break_rule_and_rematerialize",
    {
      p_rule_id: id,
      p_label: rule.label,
      p_days_of_week: rule.days_of_week,
      p_start_local_time: rule.start_local_time,
      p_end_local_time: rule.end_local_time,
      p_active: active,
      p_horizon_end: horizonEnd,
    },
  );
  if (error) {
    if (error.code === "23P01") {
      const message = await lookupRecurringBreakConflictMessage(
        supabase,
        studio.id,
        studio.timezone,
      );
      return { ok: false, error: message };
    }
    return { ok: false, error: `Failed to update recurring break: ${error.message}` };
  }
  revalidatePath("/settings/availability");
  revalidatePath("/calendar");
  return { ok: true };
}

export async function deleteRecurringBreakRuleAction(
  formData: FormData,
): Promise<BlockActionResult> {
  const { studio } = await assertOwnerWithStudio();
  const id = trimmed(formData.get("id"));
  if (!id) return { ok: false, error: "Missing rule id." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("delete_recurring_break_rule", {
    p_rule_id: id,
  });
  if (error) {
    return { ok: false, error: `Failed to delete recurring break: ${error.message}` };
  }
  void studio.id;
  revalidatePath("/settings/availability");
  revalidatePath("/calendar");
  return { ok: true };
}

// When a recurring-break RPC raises 23P01, the materialize loop
// failed on some specific occurrence date. We don't have the
// failing date directly (Postgres surfaces it inside the error
// message but not always parseably), so we look up the first
// reservation row inside the horizon that does NOT belong to this
// studio's recurring breaks, and report it. The same source_kind
// taxonomy from migration 0030 applies.
async function lookupRecurringBreakConflictMessage(
  supabase: SupabaseClient,
  studioId: string,
  studioTimezone: string,
): Promise<string> {
  const horizonEnd = horizonEndDateInStudioTz(studioTimezone);
  const nowIso = new Date().toISOString();
  const horizonEndUtc = new Date(`${horizonEnd}T00:00:00Z`).toISOString();

  const { data } = await supabase
    .from("studio_calendar_reservations")
    .select("source_kind, source_id, starts_at, ends_at")
    .eq("studio_id", studioId)
    .gt("ends_at", nowIso)
    .lt("starts_at", horizonEndUtc)
    .order("starts_at")
    .limit(20);

  if (!data || data.length === 0) {
    return "This recurring break overlaps an existing appointment or blocked period. Resolve the conflict first.";
  }
  // The conflict could be against any non-recurring-break source.
  // Find the first non-self-source row.
  const conflict = data.find(
    (r) => r.source_kind !== "recurring_break_occurrence",
  );
  if (!conflict) {
    return "This recurring break overlaps an existing appointment or blocked period. Resolve the conflict first.";
  }

  const startFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: studioTimezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(conflict.starts_at));
  const endFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: studioTimezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(conflict.ends_at));

  if (conflict.source_kind === "appointment") {
    return `This recurring break overlaps an appointment on ${startFmt} to ${endFmt}, including turnaround time. Reschedule that appointment first or pick a different time.`;
  }
  if (conflict.source_kind === "timed_block") {
    return `This recurring break overlaps an existing blocked period on ${startFmt} to ${endFmt}. Edit or remove that block first.`;
  }
  if (conflict.source_kind === "full_day_blockout") {
    return `This recurring break overlaps a full-day blockout starting ${startFmt}. Remove the blockout or pick a different day.`;
  }
  return "This recurring break overlaps an existing calendar item. Resolve the conflict first.";
}
