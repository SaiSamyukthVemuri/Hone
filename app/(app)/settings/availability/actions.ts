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
  formatTimeForStudio,
  resolveTimeFormat,
  type TimeFormat,
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

// Conflict-message time honours the studio's 12h/24h preference via the shared
// TimeFormat contract (no hardcoded hour12). Always in the studio timezone.
function formatTimeInTz(iso: string, tz: string, format: TimeFormat): string {
  return formatTimeForStudio(new Date(iso), tz, format);
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

// PR B 3E-7 + §10: resource-aware, PII-safe conflict description. The two
// SECURITY DEFINER RPCs (find_scoped_calendar_conflict / find_recurring_break_
// conflict, migration 0139) filter to the resource set that actually reserves
// the proposed source — so an appointment for practitioner A never produces a
// conflict message for a B-only block — and return ONLY source kind + interval
// + resource_key. They are service_role-only, so these run on the admin client.
// The rendered message exposes only the conflicting item's KIND and studio-local
// date/time — never a client, service, note, practitioner name, or token.
type ConflictRow = {
  source_kind: string;
  starts_at: string;
  ends_at: string;
  resource_key: string;
};

function conflictMessageFromRow(
  row: ConflictRow | undefined,
  tz: string,
  format: TimeFormat,
  fallback: string,
): string {
  if (!row) return fallback;
  const dateFmt = formatDateInTz(row.starts_at, tz);
  const startFmt = formatTimeInTz(row.starts_at, tz, format);
  const endFmt = formatTimeInTz(row.ends_at, tz, format);
  switch (row.source_kind) {
    case "appointment":
      return `This overlaps an appointment on ${dateFmt} from ${startFmt} to ${endFmt}. Choose a time that does not overlap that appointment, or reschedule or cancel it first.`;
    case "timed_block":
      return `This overlaps an existing blocked period on ${dateFmt} from ${startFmt} to ${endFmt}. Edit or remove the existing block first.`;
    case "recurring_break_occurrence":
      return `This overlaps a repeating break on ${dateFmt} from ${startFmt} to ${endFmt}. Edit or remove that break first.`;
    case "full_day_blockout":
      return `This overlaps an existing full-day blockout on ${dateFmt}. Edit or remove the existing blockout first.`;
    default:
      return fallback;
  }
}

// One-off (timed-block / blockout) conflict lookup. `practitionerId` is the
// proposed source's scope (null = studio-wide); `exclude` removes the source
// being edited so it never self-conflicts.
async function describeTimedConflict(
  admin: SupabaseClient,
  args: {
    studioId: string;
    tz: string;
    format: TimeFormat;
    practitionerId: string | null;
    startsAt: string;
    endsAt: string;
    exclude?: { kind: string; id: string };
  },
): Promise<string> {
  const { data } = await admin.rpc("find_scoped_calendar_conflict", {
    p_studio_id: args.studioId,
    p_practitioner_id: args.practitionerId,
    p_starts_at: args.startsAt,
    p_ends_at: args.endsAt,
    p_exclude_kind: args.exclude?.kind ?? null,
    p_exclude_id: args.exclude?.id ?? null,
  });
  const row = (data as ConflictRow[] | null)?.[0];
  return conflictMessageFromRow(row, args.tz, args.format, FALLBACK_CONFLICT_MESSAGE);
}

// Recurring-break conflict projection: projects the proposed pattern across the
// horizon in the studio timezone (DST-correct) and returns the earliest actual
// collision, excluding the edited rule's own future occurrences.
async function describeRecurringConflict(
  admin: SupabaseClient,
  args: {
    studioId: string;
    tz: string;
    format: TimeFormat;
    practitionerId: string | null;
    days: number[];
    startLocal: string;
    endLocal: string;
    horizonEnd: string;
    excludeRuleId?: string | null;
  },
): Promise<string> {
  const { data } = await admin.rpc("find_recurring_break_conflict", {
    p_studio_id: args.studioId,
    p_practitioner_id: args.practitionerId,
    p_days_of_week: args.days,
    p_start_local: args.startLocal,
    p_end_local: args.endLocal,
    p_horizon_end: args.horizonEnd,
    p_exclude_rule_id: args.excludeRuleId ?? null,
  });
  const row = (data as ConflictRow[] | null)?.[0];
  return conflictMessageFromRow(row, args.tz, args.format, RECURRING_BREAK_CONFLICT_MESSAGE);
}

// Bounded operational marker for an unexpected DB error: action + stage +
// SQLSTATE only. NEVER the raw DB/PostgREST message, row data, private note,
// client, appointment, practitioner, or token. Owner-facing copy is always a
// fixed safe string chosen by the caller.
function logAvailabilityDbError(
  action: string,
  stage: string,
  code: string | undefined,
): void {
  console.error(`availability_action_db_error:${action}:${stage}:${code ?? "unknown"}`);
}

function trimmed(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullable(value: FormDataEntryValue | null): string | null {
  const t = trimmed(value);
  return t.length === 0 ? null : t;
}

// Resolve the per-practitioner scope a create/update should apply.
//
//   field ABSENT (a Legacy form that never renders a scope selector, or a
//     tampered request that drops the field)   -> preserve `existing`
//   field PRESENT but empty ("All practitioners") -> studio-wide (null)
//   field PRESENT with a UUID                    -> that practitioner
//
// The DB is the source of truth for validity: the composite FK
// (studio_id, practitioner_id) rejects a cross-tenant practitioner (23503),
// and guard_scoped_source_capacity rejects assigning a scope while capacity
// is OFF (42501) or to an inactive practitioner (23514). We never interpret
// a missing field as a reset to studio-wide — that would silently widen a
// scoped source. `existing` is undefined for CREATE (no prior row), so an
// absent field there resolves to studio-wide, the correct Legacy default.
function resolveSubmittedScope(
  formData: FormData,
  existing: string | null | undefined,
): string | null {
  if (!formData.has("practitioner_id")) return existing ?? null;
  const raw = trimmed(formData.get("practitioner_id"));
  return raw === "" ? null : raw;
}

// Maps the scope-guard sqlstates raised by the DB into owner-facing copy.
// Returns null when the code is not a scope-guard violation so the caller
// falls through to its generic error branch. No PII — codes only.
function scopeGuardMessage(code: string | undefined): string | null {
  switch (code) {
    case "42501":
      return "Per-practitioner scheduling is not enabled for this studio, so this item must apply to all practitioners.";
    case "23514":
      return "That practitioner is no longer active. Choose an active practitioner, or make this item apply to all practitioners.";
    case "23503":
      return "That practitioner does not belong to this studio.";
    default:
      return null;
  }
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
  if (error) {
    logAvailabilityDbError("upsert_day_default", "upsert", error.code);
    throw new Error("Could not save these hours. Please try again.");
  }
  revalidatePath("/settings/availability");
}

// Saves the weekly default in one round-trip. Form encodes seven rows.
export async function saveWeeklyDefaultsAction(formData: FormData): Promise<void> {
  const { studioId } = await assertOwner();

  const days: {
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
    days.push({
      day_of_week: dow,
      is_open: isOpen,
      open_time: isOpen ? open : null,
      close_time: isOpen ? close : null,
    });
  }

  // Part 4 Item 2: ONE atomic RPC writes all seven days in a single transaction
  // under the studios-row + capacity advisory lock. A bad day rolls the whole week
  // back (no more half-applied week), and the save serializes with booking /
  // retirement / the timezone rebuild. Studio-wide scope = NULL (unchanged rows);
  // the owner is resolved server-side above, so the admin (service_role) client is
  // safe here.
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("save_weekly_availability", {
    p_studio_id: studioId,
    p_scope_practitioner_id: null,
    p_days: days,
  });
  if (error) {
    logAvailabilityDbError("save_weekly_defaults", "rpc", error.code);
    throw new Error("Could not save these hours. Please try again.");
  }
  if (data !== "ok") {
    logAvailabilityDbError("save_weekly_defaults", "result", typeof data === "string" ? data : "unknown");
    throw new Error("Could not save these hours. Please try again.");
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
  if (error) {
    logAvailabilityDbError("upsert_override", "upsert", error.code);
    throw new Error("Could not save this date override. Please try again.");
  }
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
  if (error) {
    logAvailabilityDbError("delete_override", "delete", error.code);
    throw new Error("Could not delete this date override. Please try again.");
  }
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
  // Part 4 Item 2: route the full-week practitioner customize through the same
  // atomic, lock-taking RPC as the studio-wide save (one transaction, serialized
  // with booking / retirement). The scope practitioner is re-validated in-DB.
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("save_weekly_availability", {
    p_studio_id: studio.id,
    p_scope_practitioner_id: scope.practitionerId,
    p_days: rows.map((r) => ({
      day_of_week: r.day_of_week,
      is_open: r.is_open,
      open_time: r.open_time,
      close_time: r.close_time,
    })),
  });
  if (error || data !== "ok") return { ok: false, error: "Could not customize the week." };
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
      // midnight (ends + 1)) in the studio's tz. A full-day blockout is
      // studio-wide (practitionerId = null), so the resource-aware lookup
      // spans every practitioner.
      const startUtc = utcInstantFromLocal(starts, "00:00", studio.timezone);
      const endDateStr = addDaysToIso(ends, 1);
      const endUtc = utcInstantFromLocal(endDateStr, "00:00", studio.timezone);
      const message = await describeTimedConflict(createAdminClient(), {
        studioId: studio.id,
        tz: studio.timezone,
        format: resolveTimeFormat(studio),
        practitionerId: null,
        startsAt: startUtc.toISOString(),
        endsAt: endUtc.toISOString(),
      });
      return { ok: false, error: message };
    }
    logAvailabilityDbError("create_blockout", "insert", error.code);
    return { ok: false, error: "Could not add this full-day blockout. Please try again." };
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
  if (error) {
    logAvailabilityDbError("delete_blockout", "delete", error.code);
    throw new Error("Could not delete this full-day blockout. Please try again.");
  }
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

  // A timed block — including a whole-day one — may be studio-wide (NULL) or
  // scoped to one practitioner. A practitioner-scoped all-day block takes that
  // practitioner's entire day off without closing the studio for anyone else
  // (the synchronizer keys the reservation to the practitioner, not the
  // studio). This stays a studio_timed_blocks row with a local-midnight →
  // next-local-midnight interval; studio_blockouts remain studio-wide date
  // closures and are unaffected.
  const scope = resolveSubmittedScope(formData, undefined);

  const supabase = await createClient();
  const { error } = await supabase.from("studio_timed_blocks").insert({
    studio_id: studio.id,
    starts_at: startsAt,
    ends_at: endsAt,
    category,
    private_note: privateNote,
    created_by: practitioner.id,
    practitioner_id: scope,
  });
  if (error) {
    if (error.code === "23P01") {
      const message = await describeTimedConflict(createAdminClient(), {
        studioId: studio.id,
        tz: studio.timezone,
        format: resolveTimeFormat(studio),
        practitionerId: scope,
        startsAt,
        endsAt,
      });
      return { ok: false, error: message };
    }
    const scopeMsg = scopeGuardMessage(error.code);
    if (scopeMsg) return { ok: false, error: scopeMsg };
    logAvailabilityDbError("create_block", "insert", error.code);
    return { ok: false, error: "Could not add this block. Please try again." };
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
  // The edit form sends the block's CURRENT mode explicitly, so editing
  // category / note / date / scope preserves all-day (or timed) mode, and the
  // owner converts modes only by toggling the checkbox. All-day builds the
  // local-midnight → next-local-midnight range and ignores start/end.
  const allDay = trimmed(formData.get("all_day")).toLowerCase() === "true";
  const dateStr = trimmed(formData.get("date"));
  const startLocal = trimmed(formData.get("start_local"));
  const endLocal = trimmed(formData.get("end_local"));
  const category = trimmed(formData.get("category")).toLowerCase();
  const privateNote = nullable(formData.get("private_note"));

  if (!id) return { ok: false, error: "Missing block id." };
  if (!dateStr) return { ok: false, error: "Date is required." };
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
  // Load the existing row by id + authenticated studio BEFORE mutating. This
  // confirms tenant ownership and gives us the current scope to preserve when
  // the request omits practitioner_id (a Legacy form, or a tampered request).
  const { data: existing, error: loadErr } = await supabase
    .from("studio_timed_blocks")
    .select("practitioner_id")
    .eq("id", id)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (loadErr) {
    logAvailabilityDbError("update_block", "load", loadErr.code);
    return { ok: false, error: "Could not update this block. Please try again." };
  }
  if (!existing) return { ok: false, error: "Block not found." };
  const scope = resolveSubmittedScope(formData, existing.practitioner_id);

  const { error } = await supabase
    .from("studio_timed_blocks")
    .update({
      starts_at: startsAt,
      ends_at: endsAt,
      category,
      private_note: privateNote,
      practitioner_id: scope,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("studio_id", studio.id);
  if (error) {
    if (error.code === "23P01") {
      // Exclude the block we are editing from the conflict lookup
      // so we don't report a self-conflict. The shadow still holds
      // this row's pre-rollback values because the UPDATE was
      // aborted by the exclusion check. Scope-aware: only the resource(s)
      // this block actually reserves are considered.
      const message = await describeTimedConflict(createAdminClient(), {
        studioId: studio.id,
        tz: studio.timezone,
        format: resolveTimeFormat(studio),
        practitionerId: scope,
        startsAt,
        endsAt,
        exclude: { kind: "timed_block", id },
      });
      return { ok: false, error: message };
    }
    const scopeMsg = scopeGuardMessage(error.code);
    if (scopeMsg) return { ok: false, error: scopeMsg };
    logAvailabilityDbError("update_block", "update", error.code);
    return { ok: false, error: "Could not update this block. Please try again." };
  }
  revalidatePath("/settings/availability");
  revalidatePath("/calendar");
  return { ok: true };
}

export async function deleteTimedBlockAction(
  formData: FormData,
): Promise<BlockActionResult> {
  // Returns a BlockActionResult (not void) so a delete that fails the lock
  // trigger or RLS surfaces inline instead of a masked production throw.
  // Deleting a scoped block is always permitted — the lock/dormancy triggers
  // fire, but no scope guard blocks removal, so a block whose practitioner
  // later went inactive can still be cleaned up.
  const { studio } = await assertOwnerWithStudio();
  const id = trimmed(formData.get("id"));
  if (!id) return { ok: false, error: "Missing block id." };
  const supabase = await createClient();
  const { error } = await supabase
    .from("studio_timed_blocks")
    .delete()
    .eq("id", id)
    .eq("studio_id", studio.id);
  if (error) {
    logAvailabilityDbError("delete_block", "delete", error.code);
    return { ok: false, error: "Could not delete this block. Please try again." };
  }
  revalidatePath("/settings/availability");
  revalidatePath("/calendar");
  return { ok: true };
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
// projected occurrence. The precise lookup (project the proposed pattern in the
// studio timezone, check each occurrence against the relevant resource set,
// return the first colliding one) is now implemented in describeRecurringConflict
// (find_recurring_break_conflict, migration 0139). This static string is the
// safe fallback used only when the projection returns no row (e.g. the colliding
// reservation was resolved between the failed write and the lookup).
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

  const scope = resolveSubmittedScope(formData, undefined);
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
      p_practitioner_id: scope,
    },
  );
  if (error) {
    if (error.code === "23P01") {
      const message = await describeRecurringConflict(admin, {
        studioId: studio.id,
        tz: studio.timezone,
        format: resolveTimeFormat(studio),
        practitionerId: scope,
        days,
        startLocal,
        endLocal,
        horizonEnd,
      });
      return { ok: false, error: message };
    }
    const scopeMsg = scopeGuardMessage(error.code);
    if (scopeMsg) return { ok: false, error: scopeMsg };
    logAvailabilityDbError("create_recurring", "rpc", error.code);
    return { ok: false, error: "Could not add this recurring break. Please try again." };
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

  // Load the existing rule by id + authenticated studio first: confirms tenant
  // ownership and yields the current scope to preserve when the request omits
  // practitioner_id. Without this, the RPC's p_practitioner_id default (NULL)
  // would silently widen a scoped rule to studio-wide on every edit.
  const supabase = await createClient();
  const { data: existing, error: loadErr } = await supabase
    .from("studio_recurring_break_rules")
    .select("practitioner_id")
    .eq("id", id)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (loadErr) {
    logAvailabilityDbError("update_recurring", "load", loadErr.code);
    return { ok: false, error: "Could not update this recurring break. Please try again." };
  }
  if (!existing) return { ok: false, error: "Rule not found." };
  const scope = resolveSubmittedScope(formData, existing.practitioner_id);

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
      p_practitioner_id: scope,
    },
  );
  if (error) {
    if (error.code === "23P01") {
      const message = await describeRecurringConflict(admin, {
        studioId: studio.id,
        tz: studio.timezone,
        format: resolveTimeFormat(studio),
        practitionerId: scope,
        days,
        startLocal,
        endLocal,
        horizonEnd,
        excludeRuleId: id,
      });
      return { ok: false, error: message };
    }
    // 23514 = enabling / reassigning a scoped rule to an inactive practitioner
    // (guard_scoped_recurring_rule_capacity, migration 0139).
    if (error.code === "23514") {
      return {
        ok: false,
        error:
          "This break is assigned to a practitioner who is no longer active. Reassign it before enabling it.",
      };
    }
    const scopeMsg = scopeGuardMessage(error.code);
    if (scopeMsg) return { ok: false, error: scopeMsg };
    logAvailabilityDbError("update_recurring", "rpc", error.code);
    return { ok: false, error: "Could not update this recurring break. Please try again." };
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
    // 0137: MUST read practitioner_id and pass it back, or toggling active
    // would reset a practitioner-scoped rule to studio-wide (the RPC's
    // p_practitioner_id defaults to NULL).
    .select("label, days_of_week, start_local_time, end_local_time, practitioner_id")
    .eq("id", id)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (lookupErr) {
    logAvailabilityDbError("toggle_recurring", "load", lookupErr.code);
    return { ok: false, error: "Could not update this recurring break. Please try again." };
  }
  if (!rule) return { ok: false, error: "Rule not found." };

  const horizonEnd = horizonEndDateInStudioTz(studio.timezone);
  const admin = createAdminClient();
  const scope = rule.practitioner_id ?? null;
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
      p_practitioner_id: scope, // preserve scope
    },
  );
  if (error) {
    if (error.code === "23P01") {
      const message = await describeRecurringConflict(admin, {
        studioId: studio.id,
        tz: studio.timezone,
        format: resolveTimeFormat(studio),
        practitionerId: scope,
        days: rule.days_of_week,
        startLocal: String(rule.start_local_time).slice(0, 5),
        endLocal: String(rule.end_local_time).slice(0, 5),
        horizonEnd,
        excludeRuleId: id,
      });
      return { ok: false, error: message };
    }
    // 23514 = enabling / saving an active scoped rule whose practitioner is now
    // inactive (guard_scoped_recurring_rule_capacity, migration 0139).
    if (error.code === "23514") {
      return {
        ok: false,
        error:
          "This break is assigned to a practitioner who is no longer active. Reassign it before enabling it.",
      };
    }
    logAvailabilityDbError("toggle_recurring", "rpc", error.code);
    return { ok: false, error: "Could not update this recurring break. Please try again." };
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
    logAvailabilityDbError("delete_recurring", "rpc", error.code);
    return { ok: false, error: "Could not delete this recurring break. Please try again." };
  }
  revalidatePath("/settings/availability");
  revalidatePath("/calendar");
  return { ok: true };
}
