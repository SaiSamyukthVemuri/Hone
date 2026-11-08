import { createClient } from "@/lib/supabase/server";
import { serviceSelect, type ProfileReadOptions } from "@/lib/clients/profile-pricing";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { isMissingColumnError } from "@/lib/db/missing-column";
import type {
  Appointment,
  Service,
  Studio,
  StudioAvailabilityDefault,
  StudioAvailabilityOverride,
  StudioBlockout,
  StudioRecurringBreakOccurrence,
  StudioRecurringBreakRule,
  StudioTimedBlock,
} from "@/lib/types/database";
import { dbErrorCode, dbFailureCode } from "@/lib/logging/error-class";

// Active services for the studio, ordered by the practitioner-
// controlled sort_order ascending and then by name as a deterministic
// tiebreaker. sort_order is set via the Move up / Move down buttons
// in Settings -> Services (PR #109); keeping this query in sync with
// the public booking page means internal pickers (calendar quick-book,
// client profile, dashboard) all show services in the same order the
// practitioner arranged and the same order their clients see on the
// public booking menu. `{ includePrices: false }` selects no price column
// (the Client Profile for a non-owner).
export async function getActiveServices(
  studioId: string,
  o: ProfileReadOptions = {},
): Promise<Service[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("services")
    .select(serviceSelect(o))
    .eq("studio_id", studioId)
    .eq("active", true)
    .order("sort_order", { ascending: true })
    .order("name");
  if (error) throw new Error(`Failed to load services: ${dbErrorCode(error)}`);
  const rows = (data ?? []) as unknown as Service[];
  return o.includePrices === false ? rows.map((r) => ({ ...r, price_cents: null })) : rows;
}

// Explicit "does the services.calendar_color column exist yet?" probe for the
// settings UI. Before 0153 applies, returns false so the page hides the color
// selector; any non-missing-column error is re-thrown.
export async function servicesHaveCalendarColor(studioId: string): Promise<boolean> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("services")
    .select("calendar_color")
    .eq("studio_id", studioId)
    .limit(1);
  if (error) {
    if (isMissingColumnError(error, "calendar_color")) return false;
    throw new Error(`Failed to probe calendar color: ${dbErrorCode(error)}`);
  }
  return true;
}

export async function getAllServices(studioId: string): Promise<Service[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("services")
    .select("*")
    .eq("studio_id", studioId)
    // Canonical ordering columns. Callers still re-sort in JS through
    // lib/booking/service-order.ts (the client and Postgres collations can
    // disagree on `name`), but a services query that omits sort_order entirely
    // is a trap. It is what let the settings page and the reorder action
    // disagree about which row sat at which position.
    .order("active", { ascending: false })
    .order("sort_order", { ascending: true })
    .order("name")
    .order("id");
  if (error) throw new Error(`Failed to load services: ${dbErrorCode(error)}`);
  return (data ?? []) as Service[];
}

export async function getAvailabilityDefaults(
  studioId: string,
): Promise<StudioAvailabilityDefault[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("studio_availability_default")
    .select("*")
    .eq("studio_id", studioId)
    .order("day_of_week");
  if (error)
    throw new Error(`Failed to load weekly defaults: ${dbErrorCode(error)}`);
  return (data ?? []) as StudioAvailabilityDefault[];
}

export async function getOverridesForRange(
  studioId: string,
  startDate: string,
  endDate: string,
): Promise<StudioAvailabilityOverride[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("studio_availability_overrides")
    .select("*")
    .eq("studio_id", studioId)
    .gte("effective_date", startDate)
    .lte("effective_date", endDate)
    .order("effective_date");
  if (error) throw new Error(`Failed to load overrides: ${dbErrorCode(error)}`);
  return (data ?? []) as StudioAvailabilityOverride[];
}

export async function getBlockouts(studioId: string): Promise<StudioBlockout[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("studio_blockouts")
    .select("*")
    .eq("studio_id", studioId)
    .order("starts_on");
  if (error) throw new Error(`Failed to load blockouts: ${dbErrorCode(error)}`);
  return (data ?? []) as StudioBlockout[];
}

// Timed blocks within a UTC range. Used by the calendar grid where
// the view is bounded to the visible week. RLS allows studio members
// to SELECT.
export async function getTimedBlocksForRange(
  studioId: string,
  startIso: string,
  endIso: string,
): Promise<StudioTimedBlock[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("studio_timed_blocks")
    .select("*")
    .eq("studio_id", studioId)
    .lt("starts_at", endIso)
    .gt("ends_at", startIso)
    .order("starts_at");
  if (error)
    throw new Error(`Failed to load timed blocks: ${dbErrorCode(error)}`);
  return (data ?? []) as StudioTimedBlock[];
}

// All current-and-future timed blocks for a studio, ordered soonest
// first. Used by /settings/availability where the owner manages
// blocks across the full forward horizon (NOT limited to 90 days;
// the public booking horizon does not apply to owner-managed time).
// Pagination can be added later if a studio accumulates hundreds of
// future blocks; in v1 we load them all.
export async function getUpcomingTimedBlocks(
  studioId: string,
  nowIso: string,
): Promise<StudioTimedBlock[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("studio_timed_blocks")
    .select("*")
    .eq("studio_id", studioId)
    .gt("ends_at", nowIso)
    .order("starts_at");
  if (error)
    throw new Error(`Failed to load timed blocks: ${dbErrorCode(error)}`);
  return (data ?? []) as StudioTimedBlock[];
}

// All recurring-break rules for a studio (active + inactive), ordered
// by created_at. Used by /settings/availability to render the rule
// list and the edit form. Member SELECT allowed by RLS; owner-only
// writes flow through SECURITY DEFINER RPCs.
export async function getRecurringBreakRules(
  studioId: string,
): Promise<StudioRecurringBreakRule[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("studio_recurring_break_rules")
    .select("*")
    .eq("studio_id", studioId)
    .order("created_at");
  if (error)
    throw new Error(`Failed to load recurring breaks: ${dbErrorCode(error)}`);
  return (data ?? []) as StudioRecurringBreakRule[];
}

// Recurring-break occurrences whose interval overlaps a UTC window.
// Joins to the parent rule for the display label; orphan rows
// (rule_id NULL after a rule delete) come back with rule = null and
// the UI renders a generic "Break" label.
export type RecurringBreakOccurrenceWithRule =
  StudioRecurringBreakOccurrence & {
    rule: { label: string } | null;
  };

export async function getRecurringBreakOccurrencesForRange(
  studioId: string,
  startIso: string,
  endIso: string,
): Promise<RecurringBreakOccurrenceWithRule[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("studio_recurring_break_occurrences")
    .select("*, rule:studio_recurring_break_rules(label)")
    .eq("studio_id", studioId)
    .lt("starts_at", endIso)
    .gt("ends_at", startIso)
    .order("starts_at");
  if (error)
    throw new Error(`Failed to load recurring break occurrences: ${dbErrorCode(error)}`);
  type Raw = StudioRecurringBreakOccurrence & {
    rule: { label: string } | { label: string }[] | null;
  };
  return ((data ?? []) as Raw[]).map((row) => ({
    ...row,
    rule: Array.isArray(row.rule) ? (row.rule[0] ?? null) : row.rule,
  }));
}

// Appointment shape returned by getAppointmentsForRange. Includes small
// joins on practitioner (for color), client (for the calendar card
// headline), and service (for the secondary modality/name line) so the
// week view can render readable cards without an N+1 lookup. All three
// joins are existing FK relationships with no new RLS exposure: every
// row was already accessible to this studio's session via the
// underlying appointments query.
export type AppointmentWithPractitionerColor = Appointment & {
  practitioner: { id: string; color: string; display_name?: string | null } | null;
  client: { id: string; name: string } | null;
  service: {
    id: string;
    name: string;
    modality: string | null;
    calendar_color: string | null;
  } | null;
};

export async function getAppointmentsForRange(
  studioId: string,
  startIso: string,
  endIso: string,
): Promise<AppointmentWithPractitionerColor[]> {
  const supabase = await createClient();
  const BASE =
    "*, practitioner:practitioners!appointments_practitioner_same_studio_fk(id, color, display_name), client:clients(id, name), ";
  const runSelect = (serviceEmbed: string, afterId: string | null) => {
    let query = supabase
      .from("appointments")
      .select(`${BASE}${serviceEmbed}`)
      .eq("studio_id", studioId)
      .gte("starts_at", startIso)
      .lt("starts_at", endIso);
    if (afterId !== null) query = query.gt("id", afterId);
    return query.order("id").range(0, 999);
  };

  // Prefer the persisted calendar_color; if that column does not exist YET (app
  // deployed before 0153), retry the legacy embed and normalize calendar_color to
  // null. Any OTHER database error is re-thrown, never swallowed.
  // SCH-005: page by immutable id, not an offset into mutable times/membership.
  // A prior-page move must not shift an unread appointment behind the cursor.
  // Keep scope on every page and continue to empty even with a lower server cap;
  // read errors/repeated rows refuse the whole load. These are captured rows,
  // not a transaction-wide snapshot. Restore date/id display order below.
  const appointments: unknown[] = [];
  const seen = new Set<string>();
  let afterId: string | null = null;
  let serviceEmbed = "service:services(id, name, modality, calendar_color)";
  for (;;) {
    let { data, error } = await runSelect(serviceEmbed, afterId);
    if (error && isMissingColumnError(error, "calendar_color")) {
      serviceEmbed = "service:services(id, name, modality)";
      ({ data, error } = await runSelect(serviceEmbed, afterId));
    }
    if (error) throw new Error("Failed to load appointments");
    const rows = (data ?? []) as unknown as Array<{ id: string }>;
    if (rows.length === 0) break;
    for (const row of rows) {
      if (seen.has(row.id)) throw new Error("Failed to load appointments");
      seen.add(row.id);
      appointments.push(row);
    }
    afterId = rows[rows.length - 1].id;
  }

  // Supabase types joined relations as either a single row or an array.
  // Normalize so callers can use `a.practitioner?.color` without
  // branching (same idiom for client and service).
  type Raw = Appointment & {
    practitioner:
      | { id: string; color: string; display_name?: string | null }
      | { id: string; color: string; display_name?: string | null }[]
      | null;
    client:
      | { id: string; name: string }
      | { id: string; name: string }[]
      | null;
    service:
      | { id: string; name: string; modality: string | null; calendar_color?: string | null }
      | { id: string; name: string; modality: string | null; calendar_color?: string | null }[]
      | null;
  };
  return (appointments as Raw[]).sort((a, b) =>
    Date.parse(a.starts_at) - Date.parse(b.starts_at)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  ).map((row) => {
    const p = Array.isArray(row.practitioner)
      ? row.practitioner[0] ?? null
      : row.practitioner;
    const c = Array.isArray(row.client)
      ? row.client[0] ?? null
      : row.client;
    const rawS = Array.isArray(row.service)
      ? row.service[0] ?? null
      : row.service;
    // Normalize calendar_color to null when the legacy (pre-0153) embed omits it.
    const s = rawS
      ? { ...rawS, calendar_color: rawS.calendar_color ?? null }
      : null;
    return { ...row, practitioner: p, client: c, service: s };
  });
}

// Service-role lookup of a studio by public slug, for the pre-auth flows that
// identify a studio by its slug.
//
// TWO DIFFERENT ANSWERS, AND CALLERS MUST KEEP THEM APART:
//   * null   - the read completed and no studio has this slug.
//   * throws - the read did not complete (PostgREST error, or a transport
//              failure, which supabase-js reports as "TypeError: fetch failed").
//              Whether the studio exists is UNKNOWN, so this is never null.
export async function getStudioBySlug(slug: string): Promise<Studio | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("studios")
    .select("*")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw new Error(`Failed to load studio: ${dbFailureCode(error)}`);
  return (data ?? null) as Studio | null;
}
