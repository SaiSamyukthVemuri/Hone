"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  localLongDate,
  todayInTz,
  utcInstantFromLocal,
} from "@/lib/booking/tz";
import { maxPublicBookingHorizonDays } from "@/lib/booking/horizon";
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

// Studio-local long date for the conflict message ("Tuesday, June 4").
// Strips the trailing year so the message stays scannable; the year is
// noise for owner-facing diagnostics that always refer to a near-term
// appointment. Reuses the shared lib/booking/tz.ts helper so the
// format never drifts from the email / SMS day-string format.
function formatDateInTz(iso: string, tz: string): string {
  const long = localLongDate(new Date(iso), tz);
  return long.replace(/,\s*\d{4}$/, "");
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
  // Conflict messages now include the conflicting item's date so the
  // owner can tell which appointment in a multi-day blockout range
  // is blocking the save. Previously the message only showed time,
  // which read as "the app doesn't understand I'm blocking a range".
  // Date format reuses the shared lib/booking/tz.ts helper so the
  // wording matches the email/SMS day-string format.
  if (conflict.source_kind === "appointment") {
    const dateFmt = formatDateInTz(conflict.starts_at, studioTimezone);
    const startFmt = formatTimeInTz(conflict.starts_at, studioTimezone);
    const endFmt = formatTimeInTz(conflict.ends_at, studioTimezone);
    return `This block overlaps an appointment on ${dateFmt} from ${startFmt} to ${endFmt}. Choose a block that does not overlap that appointment, or reschedule or cancel the appointment first.`;
  }
  if (conflict.source_kind === "timed_block") {
    const dateFmt = formatDateInTz(conflict.starts_at, studioTimezone);
    const startFmt = formatTimeInTz(conflict.starts_at, studioTimezone);
    const endFmt = formatTimeInTz(conflict.ends_at, studioTimezone);
    return `This block overlaps an existing blocked period on ${dateFmt} from ${startFmt} to ${endFmt}. Edit or remove the existing block first.`;
  }
  if (conflict.source_kind === "full_day_blockout") {
    const dateFmt = formatDateInTz(conflict.starts_at, studioTimezone);
    return `This block overlaps an existing full-day blockout on ${dateFmt}. Edit or remove the existing blockout first.`;
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
        // Studio-wide scope. Migration 0135 keys uniqueness on
        // (studio_id, day_of_week, practitioner_id) via UNIQUE NULLS NOT
        // DISTINCT, so the studio-wide row must send an explicit NULL and the
        // conflict target must name all three columns (a column-only target
        // cannot infer the constraint). Per-practitioner writes (PR B owner UI)
        // send a validated practitioner_id instead.
        practitioner_id: null,
        is_open: isOpen,
        open_time: isOpen ? open : null,
        close_time: isOpen ? close : null,
      },
      { onConflict: "studio_id,day_of_week,practitioner_id" },
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
    practitioner_id: string | null;
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
      practitioner_id: null, // studio-wide scope (see upsertDayDefaultAction)
      is_open: isOpen,
      open_time: isOpen ? open : null,
      close_time: isOpen ? close : null,
    });
  }

  // Upsert each day individually so a partial failure doesn't leave a half-applied state.
  for (const row of rows) {
    const { error } = await supabase
      .from("studio_availability_default")
      .upsert(row, { onConflict: "studio_id,day_of_week,practitioner_id" });
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
        practitioner_id: null, // studio-wide scope (see upsertDayDefaultAction)
        is_open: isOpen,
        open_time: isOpen ? open : null,
        close_time: isOpen ? close : null,
        note,
      },
      { onConflict: "studio_id,effective_date,practitioner_id" },
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

// ===========================================================================
// PR B Part 2 — per-practitioner (scoped) availability actions. Every action:
// derives the studio from the authenticated OWNER (never a client-supplied
// studio id), requires role owner, validates any target practitioner as ACTIVE
// + same-studio, requires the capacity flag ON for practitioner-scoped writes
// (studio-wide writes remain allowed OFF), validates strict HH:MM + open<close,
// always sends an explicit practitioner_id + the 3-column conflict target, and
// scopes deletes by studio + practitioner + weekday/date. Returns a typed,
// user-safe result; the DB guard + owner-only RLS enforce the same rules.
// ===========================================================================

export type AvailabilityActionResult = { ok: true } | { ok: false; error: string };

// Resolves + validates a requested practitioner target. Empty => studio-wide.
// A non-empty target requires the flag ON, and must be an ACTIVE practitioner of
// the OWNER's studio; anything else fails closed WITHOUT revealing whether the
// id belongs to another studio.
async function resolveScopeTarget(
  supabase: SupabaseClient,
  studio: Studio,
  practitionerIdRaw: string,
): Promise<{ ok: true; practitionerId: string | null } | { ok: false; error: string }> {
  if (!practitionerIdRaw) return { ok: true, practitionerId: null };
  if (studio.practitioner_capacity_enabled !== true) {
    return {
      ok: false,
      error: "Per-practitioner schedules are not enabled for this studio.",
    };
  }
  const { data } = await supabase
    .from("practitioners")
    .select("id")
    .eq("id", practitionerIdRaw)
    .eq("studio_id", studio.id)
    .eq("active", true)
    .maybeSingle();
  if (!data) return { ok: false, error: "Practitioner not found." };
  return { ok: true, practitionerId: practitionerIdRaw };
}

function validateHours(
  isOpen: boolean,
  open: string | null,
  close: string | null,
): string | null {
  if (!isOpen) return null;
  if (!open || !close) return "Open and close times are required for open days.";
  if (!TIME_RE.test(open) || !TIME_RE.test(close))
    return "Times must be in HH:MM format.";
  if (open >= close) return "Close time must be after open time.";
  return null;
}

// Save ONE weekday for the studio-wide (empty practitioner_id) or a specific
// practitioner scope. Customizing a practitioner weekday persists a scoped row.
export async function upsertScopedDayDefaultAction(
  formData: FormData,
): Promise<AvailabilityActionResult> {
  const { studio } = await assertOwnerWithStudio();
  const supabase = await createClient();
  const scope = await resolveScopeTarget(
    supabase,
    studio,
    trimmed(formData.get("practitioner_id")),
  );
  if (!scope.ok) return scope;

  const dow = Number(trimmed(formData.get("day_of_week")));
  if (!Number.isInteger(dow) || dow < 0 || dow > 6)
    return { ok: false, error: "Day of week must be 0–6." };
  const isOpen = trimmed(formData.get("is_open")) === "true";
  const open = nullable(formData.get("open_time"));
  const close = nullable(formData.get("close_time"));
  const hoursError = validateHours(isOpen, open, close);
  if (hoursError) return { ok: false, error: hoursError };

  const { error } = await supabase.from("studio_availability_default").upsert(
    {
      studio_id: studio.id,
      day_of_week: dow,
      practitioner_id: scope.practitionerId,
      is_open: isOpen,
      open_time: isOpen ? open : null,
      close_time: isOpen ? close : null,
    },
    { onConflict: "studio_id,day_of_week,practitioner_id" },
  );
  if (error) return { ok: false, error: "Could not save these hours." };
  revalidatePath("/settings/availability");
  return { ok: true };
}

// Reset ONE practitioner weekday to the studio default — deletes ONLY that
// practitioner's scoped row for that weekday; never touches the studio-wide row.
export async function resetPractitionerDayAction(
  formData: FormData,
): Promise<AvailabilityActionResult> {
  const { studio } = await assertOwnerWithStudio();
  const supabase = await createClient();
  const scope = await resolveScopeTarget(
    supabase,
    studio,
    trimmed(formData.get("practitioner_id")),
  );
  if (!scope.ok) return scope;
  if (scope.practitionerId === null)
    return { ok: false, error: "Choose a practitioner to reset." };
  const dow = Number(trimmed(formData.get("day_of_week")));
  if (!Number.isInteger(dow) || dow < 0 || dow > 6)
    return { ok: false, error: "Day of week must be 0–6." };

  const { error } = await supabase
    .from("studio_availability_default")
    .delete()
    .eq("studio_id", studio.id)
    .eq("practitioner_id", scope.practitionerId)
    .eq("day_of_week", dow);
  if (error) return { ok: false, error: "Could not reset this day." };
  revalidatePath("/settings/availability");
  return { ok: true };
}

// Customize a practitioner's FULL week from the studio default — copies each
// studio-wide weekday into a scoped practitioner row (upsert; idempotent).
export async function customizePractitionerWeekAction(
  formData: FormData,
): Promise<AvailabilityActionResult> {
  const { studio } = await assertOwnerWithStudio();
  const supabase = await createClient();
  const scope = await resolveScopeTarget(
    supabase,
    studio,
    trimmed(formData.get("practitioner_id")),
  );
  if (!scope.ok) return scope;
  if (scope.practitionerId === null)
    return { ok: false, error: "Choose a practitioner to customize." };

  const { data: studioRows, error: readErr } = await supabase
    .from("studio_availability_default")
    .select("day_of_week, is_open, open_time, close_time")
    .eq("studio_id", studio.id)
    .is("practitioner_id", null);
  if (readErr) return { ok: false, error: "Could not read studio hours." };

  const byDow = new Map(
    (studioRows ?? []).map((r) => [r.day_of_week as number, r]),
  );
  const rows = Array.from({ length: 7 }, (_, dow) => {
    const s = byDow.get(dow);
    return {
      studio_id: studio.id,
      day_of_week: dow,
      practitioner_id: scope.practitionerId,
      is_open: s?.is_open ?? false,
      open_time: s?.is_open ? (s?.open_time ?? null) : null,
      close_time: s?.is_open ? (s?.close_time ?? null) : null,
    };
  });
  const { error } = await supabase
    .from("studio_availability_default")
    .upsert(rows, { onConflict: "studio_id,day_of_week,practitioner_id" });
  if (error) return { ok: false, error: "Could not customize the week." };
  revalidatePath("/settings/availability");
  return { ok: true };
}

// Reset a practitioner's FULL week — one atomic DELETE of all their weekly rows.
export async function resetPractitionerWeekAction(
  formData: FormData,
): Promise<AvailabilityActionResult> {
  const { studio } = await assertOwnerWithStudio();
  const supabase = await createClient();
  const scope = await resolveScopeTarget(
    supabase,
    studio,
    trimmed(formData.get("practitioner_id")),
  );
  if (!scope.ok) return scope;
  if (scope.practitionerId === null)
    return { ok: false, error: "Choose a practitioner to reset." };

  const { error } = await supabase
    .from("studio_availability_default")
    .delete()
    .eq("studio_id", studio.id)
    .eq("practitioner_id", scope.practitionerId);
  if (error) return { ok: false, error: "Could not reset the week." };
  revalidatePath("/settings/availability");
  return { ok: true };
}

// Save a date override for the studio-wide or a specific practitioner scope.
export async function upsertScopedOverrideAction(
  formData: FormData,
): Promise<AvailabilityActionResult> {
  const { studio } = await assertOwnerWithStudio();
  const supabase = await createClient();
  const scope = await resolveScopeTarget(
    supabase,
    studio,
    trimmed(formData.get("practitioner_id")),
  );
  if (!scope.ok) return scope;

  const effectiveDate = trimmed(formData.get("effective_date"));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate))
    return { ok: false, error: "A valid date is required." };
  const isOpen = trimmed(formData.get("is_open")) === "true";
  const open = nullable(formData.get("open_time"));
  const close = nullable(formData.get("close_time"));
  const note = nullable(formData.get("note"));
  const hoursError = validateHours(isOpen, open, close);
  if (hoursError) return { ok: false, error: hoursError };

  const { error } = await supabase.from("studio_availability_overrides").upsert(
    {
      studio_id: studio.id,
      effective_date: effectiveDate,
      practitioner_id: scope.practitionerId,
      is_open: isOpen,
      open_time: isOpen ? open : null,
      close_time: isOpen ? close : null,
      note,
    },
    { onConflict: "studio_id,effective_date,practitioner_id" },
  );
  if (error) return { ok: false, error: "Could not save this date override." };
  revalidatePath("/settings/availability");
  return { ok: true };
}

// Reset a practitioner date override — deletes ONLY the (studio, practitioner,
// date) row; the studio-wide date override for that date is untouched.
export async function resetPractitionerOverrideAction(
  formData: FormData,
): Promise<AvailabilityActionResult> {
  const { studio } = await assertOwnerWithStudio();
  const supabase = await createClient();
  const scope = await resolveScopeTarget(
    supabase,
    studio,
    trimmed(formData.get("practitioner_id")),
  );
  if (!scope.ok) return scope;
  if (scope.practitionerId === null)
    return { ok: false, error: "Choose a practitioner to reset." };
  const effectiveDate = trimmed(formData.get("effective_date"));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate))
    return { ok: false, error: "A valid date is required." };

  const { error } = await supabase
    .from("studio_availability_overrides")
    .delete()
    .eq("studio_id", studio.id)
    .eq("practitioner_id", scope.practitionerId)
    .eq("effective_date", effectiveDate);
  if (error) return { ok: false, error: "Could not reset this date override." };
  revalidatePath("/settings/availability");
  return { ok: true };
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

// PR #139. All-day block helper. Half-open range in studio-local
// time: [local 00:00 of dateStr, local 00:00 of dateStr + 1). DST-
// safe via utcInstantFromLocal which uses Intl.DateTimeFormat for
// the tz resolution rather than naive Date arithmetic. The
// matching pattern is the createBlockoutAction conflict-window
// computation already used elsewhere in this file.
function buildAllDayBlockUtcRange(
  dateStr: string,
  tz: string,
): { startsAt: string; endsAt: string } {
  const start = utcInstantFromLocal(dateStr, "00:00", tz);
  const nextDate = addDaysToIsoLocal(dateStr, 1);
  const end = utcInstantFromLocal(nextDate, "00:00", tz);
  return { startsAt: start.toISOString(), endsAt: end.toISOString() };
}

// Local mirror of addDaysToIso so this helper lives next to the
// build* family. Same UTC-noon trick: adds N days to a YYYY-MM-DD
// string and returns YYYY-MM-DD without DST drift.
function addDaysToIsoLocal(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export async function createTimedBlockAction(
  formData: FormData,
): Promise<BlockActionResult> {
  const { studio, practitioner } = await assertOwnerWithStudio();
  const dateStr = trimmed(formData.get("date"));
  // PR #139. All-day blocks. When 'all_day=true' is posted the
  // start_local / end_local time inputs are ignored and the action
  // synthesises a full studio-local-day UTC range:
  //   starts_at = utc(dateStr 00:00 in tz)
  //   ends_at   = utc((dateStr + 1) 00:00 in tz)
  // The existing slot-exclusion logic in lib/booking/slots.ts treats
  // any timed_block row as a slot-killer for its range, so a row
  // shaped this way kills the entire day for public booking and
  // internal quick-book without a schema change. Timezone-safe
  // because both endpoints flow through utcInstantFromLocal.
  const allDay = trimmed(formData.get("all_day")).toLowerCase() === "true";
  const startLocal = trimmed(formData.get("start_local"));
  const endLocal = trimmed(formData.get("end_local"));
  const category = trimmed(formData.get("category")).toLowerCase();
  const privateNote = nullable(formData.get("private_note"));

  if (!dateStr) {
    return { ok: false, error: "Date is required." };
  }
  if (!allDay && (!startLocal || !endLocal)) {
    return { ok: false, error: "Date and start/end times are required." };
  }
  const todayLocal = todayInTz(studio.timezone);
  if (dateStr < todayLocal) {
    return { ok: false, error: "Blocked time cannot be created in the past." };
  }
  if (!allDay) {
    if (!TIME_RE.test(startLocal) || !TIME_RE.test(endLocal)) {
      return { ok: false, error: "Times must be in HH:MM format." };
    }
    if (startLocal >= endLocal) {
      return { ok: false, error: "End time must be after start time." };
    }
  }
  if (
    !(TIMED_BLOCK_CATEGORIES as ReadonlyArray<string>).includes(category)
  ) {
    return { ok: false, error: "Invalid category." };
  }

  const { startsAt, endsAt } = allDay
    ? buildAllDayBlockUtcRange(dateStr, studio.timezone)
    : buildBlockUtcRange(dateStr, startLocal, endLocal, studio.timezone);
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

// Migration 0037 (Breaks & blocks cleanup): the previous enum
// whitelist (lunch/break/admin/other) was relaxed to a length-only
// check on the column. The action validates length here so the
// practitioner sees a friendly error rather than an opaque CHECK
// violation. Labels are private to the studio — clients only see the
// slot as unavailable on the booking page.
const RECURRING_BREAK_LABEL_MAX_LENGTH = 60;

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
  // When a recurring break rule is created/updated/toggled, materialize forward
  // to today + the SINGLE recurring-break horizon = maxPublicBookingHorizonDays()
  // (12 months × 31 = 372) + 14 days margin = 386. Derived from the max
  // configurable public horizon so a studio raising its horizon never sees a
  // coverage gap before the next cron run (3E-3; the stale 186/90 are removed).
  // The DB timezone-rebuild uses the matching public.recurring_break_horizon_days().
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  noon.setUTCDate(noon.getUTCDate() + maxPublicBookingHorizonDays() + 14);
  return `${noon.getUTCFullYear()}-${String(noon.getUTCMonth() + 1).padStart(2, "0")}-${String(noon.getUTCDate()).padStart(2, "0")}`;
}

// Generic conflict message used when a recurring-break RPC raises
// 23P01. The previous implementation queried the shadow for the
// soonest future non-recurring reservation, but that row is not
// guaranteed to be the one whose interval actually overlapped a
// projected occurrence. Returning a tailored time/date for an
// unrelated reservation would mislead the owner. A precise lookup
// (project the proposed pattern, check each occurrence, return the
// first colliding one) is a possible Phase 3 enhancement.
const RECURRING_BREAK_CONFLICT_MESSAGE =
  "This recurring break overlaps an existing appointment, blocked period, or full-day blockout. Edit or remove the conflicting item first, then try again.";

export async function createRecurringBreakRuleAction(
  formData: FormData,
): Promise<BlockActionResult> {
  // Session client + owner assertion for auth. The RPC EXECUTE grant
  // is service_role only, so the actual RPC call goes through the
  // admin client below.
  const { studio, practitioner } = await assertOwnerWithStudio();
  // Migration 0037: preserve practitioner-supplied capitalization
  // (e.g. "Dinner") instead of lowercasing — the label is private,
  // displayed verbatim on the practitioner calendar, and the DB
  // CHECK is now length-based, not enum-based.
  const label = trimmed(formData.get("label"));
  const days = parseDaysOfWeek(formData.get("days_of_week"));
  const startLocal = trimmed(formData.get("start_local"));
  const endLocal = trimmed(formData.get("end_local"));
  const active = trimmed(formData.get("active")) !== "false";

  if (label.length === 0) {
    return { ok: false, error: "Label is required." };
  }
  if (label.length > RECURRING_BREAK_LABEL_MAX_LENGTH) {
    return {
      ok: false,
      error: `Label must be ${RECURRING_BREAK_LABEL_MAX_LENGTH} characters or fewer.`,
    };
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
  const admin = createAdminClient();
  const { error } = await admin.rpc(
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
      return { ok: false, error: RECURRING_BREAK_CONFLICT_MESSAGE };
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
  // Migration 0037: preserve practitioner-supplied capitalization,
  // length-only validation; see createRecurringBreakRuleAction.
  const label = trimmed(formData.get("label"));
  const days = parseDaysOfWeek(formData.get("days_of_week"));
  const startLocal = trimmed(formData.get("start_local"));
  const endLocal = trimmed(formData.get("end_local"));
  const active = trimmed(formData.get("active")) !== "false";

  if (!id) return { ok: false, error: "Missing rule id." };
  if (label.length === 0) {
    return { ok: false, error: "Label is required." };
  }
  if (label.length > RECURRING_BREAK_LABEL_MAX_LENGTH) {
    return {
      ok: false,
      error: `Label must be ${RECURRING_BREAK_LABEL_MAX_LENGTH} characters or fewer.`,
    };
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
  const admin = createAdminClient();
  // p_studio_id is the asserted owner's studio so the RPC cannot
  // touch a rule outside their tenant even if a tampered request
  // sent another studio's rule id.
  const { error } = await admin.rpc(
    "update_recurring_break_rule_and_rematerialize",
    {
      p_rule_id: id,
      p_studio_id: studio.id,
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
      return { ok: false, error: RECURRING_BREAK_CONFLICT_MESSAGE };
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

  // Owner-visible read via the session client (RLS allows member
  // SELECT).
  const supabase = await createClient();
  const { data: rule, error: lookupErr } = await supabase
    .from("studio_recurring_break_rules")
    .select("label, days_of_week, start_local_time, end_local_time")
    .eq("id", id)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (lookupErr) return { ok: false, error: lookupErr.message };
  if (!rule) return { ok: false, error: "Rule not found." };

  const horizonEnd = horizonEndDateInStudioTz(studio.timezone);
  const admin = createAdminClient();
  const { error } = await admin.rpc(
    "update_recurring_break_rule_and_rematerialize",
    {
      p_rule_id: id,
      p_studio_id: studio.id,
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
      return { ok: false, error: RECURRING_BREAK_CONFLICT_MESSAGE };
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

  const admin = createAdminClient();
  const { error } = await admin.rpc("delete_recurring_break_rule", {
    p_rule_id: id,
    p_studio_id: studio.id,
  });
  if (error) {
    return { ok: false, error: `Failed to delete recurring break: ${error.message}` };
  }
  revalidatePath("/settings/availability");
  revalidatePath("/calendar");
  return { ok: true };
}
