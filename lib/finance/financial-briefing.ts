import type { SupabaseClient } from "@supabase/supabase-js";

import { addDays, todayInTz, utcInstantFromLocal } from "@/lib/booking/tz";
import {
  resolvePeriodRange,
  type ReportingPeriod,
} from "@/lib/booking/reporting-period";
import { createClient } from "@/lib/supabase/server";
import type { Studio } from "@/lib/types/database";

import {
  summarizeCalendar,
  unreadableCalendar,
  type CalendarCensus,
  type CensusRow,
} from "./financial-briefing-model";

// ===========================================================================
// FIN-01A — the read behind /financials
// ===========================================================================
//
// READ-ONLY. No INSERT, no UPDATE, no DELETE, no RPC, no Stripe call, no
// migration. It touches no email, SMS, Google or analytics path.
//
// WHAT THE OWNER GATE IS, STATED PLAINLY — and it is the same statement
// lib/dashboard/owner-capacity.ts makes, for the same reason. This is an
// APPLICATION-LAYER check on `practitioner.role`, performed BEFORE any read is
// issued and before a Supabase client is even constructed. It is NOT a database
// boundary. RLS on `appointments` is `is_studio_member`; so is the single
// SELECT policy on `payment_charge_attempts`, and so is
// `appointment_settlements_member_select` from migration 0187. Every
// practitioner of this studio can already SELECT those rows directly. This
// module decides who is SHOWN the aggregate, not who is permitted the
// underlying data.
//
// Making financial records owner-only IN THE DATABASE is a separate
// authorization project with its own blast radius — current operational payment
// workflows depend on the existing access model — and nothing here pretends to
// be one. Saying otherwise would describe a protection that does not exist.
//
// SCOPE — SLICE 1. One read: the studio's appointments inside one studio-local
// period. No money. See financial-briefing-model.ts for why the anchor is
// answered in visits rather than in service value.

/** One request returns at most this many rows; `supabase/config.toml` sets it. */
const API_PAGE_SIZE = 1_000;

export type FinancialBriefing = {
  readonly timezone: string;
  readonly period: ReportingPeriod;
  /** Studio-local calendar dates. The browser's timezone never participates. */
  readonly startLocal: string;
  /** What a human reads ("to 31 May"). */
  readonly endLocalInclusive: string;
  /** What the query used. */
  readonly endLocalExclusive: string;
  readonly label: string;
  readonly calendar: CalendarCensus;
};

/**
 * The whole outcome of asking for this screen, INCLUDING the refusal.
 *
 * A refusal is a value rather than a thrown error or a null briefing because
 * the page must be able to render the owner-only message without ever holding
 * an aggregate — and because a test can then prove that a non-owner produced no
 * read at all, which is the actual security-relevant claim.
 */
export type FinancialsView =
  | { readonly access: "refused" }
  | { readonly access: "granted"; readonly briefing: FinancialBriefing };

export async function loadFinancialsView(
  practitioner: { readonly role: string },
  studio: Studio,
  period: ReportingPeriod,
  supabaseClient: SupabaseClient | undefined = undefined,
): Promise<FinancialsView> {
  // FIRST STATEMENT, and it must stay first. Everything below this line — the
  // client, the window, the read — is skipped for a non-owner, so a
  // practitioner who types the URL causes no studio-wide query and receives no
  // aggregate payload, not merely an aggregate they are not shown.
  if (practitioner.role !== "owner") return { access: "refused" };

  const tz = studio.timezone;
  const todayLocal = todayInTz(tz);
  const range = resolvePeriodRange(todayLocal, period);

  // TWO SEPARATE LOCAL-MIDNIGHT INSTANTS, never "start + N x 24h". A DST day is
  // 23 or 25 hours long, and the arithmetic form silently moves an evening
  // appointment into the wrong period twice a year.
  const startUtc = utcInstantFromLocal(range.startLocal, "00:00", tz).toISOString();
  const endUtc = utcInstantFromLocal(range.endLocalExclusive, "00:00", tz).toISOString();

  const calendar = await readCalendar(
    supabaseClient ?? (await createClient()),
    studio.id,
    startUtc,
    endUtc,
  );

  return {
    access: "granted",
    briefing: {
      timezone: tz,
      period,
      startLocal: range.startLocal,
      endLocalInclusive: addDays(range.endLocalExclusive, -1),
      endLocalExclusive: range.endLocalExclusive,
      label: range.label,
      calendar,
    },
  };
}

/**
 * ONE statement, and it is one snapshot by construction.
 *
 * THREE WAYS THIS COULD OTHERWISE LIE WITH TOTAL CONFIDENCE, all closed here:
 *
 *   * A FAILED READ. supabase-js RESOLVES with `{ data: null, error }` rather
 *     than rejecting, so a discarded error becomes an empty row set — and an
 *     empty row set on this screen reads as a studio that saw nobody. The
 *     census fails CLOSED to `unavailable`, which renders as a sentence rather
 *     than as zeroes.
 *
 *   * THE ROW CEILING. `supabase/config.toml` sets `max_rows = 1000` and is
 *     tracked, so the Data API truncates a response before any app-side limit
 *     is reached; comparing the returned length against a LARGER app-side cap
 *     therefore proves nothing. The length is checked against the exact count
 *     PostgREST reports in Content-Range, which the ceiling does not bound.
 *
 *   * A COUNT THAT NEVER ARRIVED. No count is not the same as a matching count.
 *     A missing Content-Range means the completeness of the read is itself
 *     unknown, so it is treated exactly like a short read.
 *
 * Unlike the capacity loader this one RETURNS the failure instead of throwing:
 * /financials has to be able to render "Can't show this right now" as a
 * first-class state, and an exception would render the app error boundary
 * instead — which tells the owner nothing about which figure is missing.
 */
async function readCalendar(
  supabase: SupabaseClient,
  studioId: string,
  startUtc: string,
  endUtc: string,
): Promise<CalendarCensus> {
  const { data, error, count } = await supabase
    .from("appointments")
    .select("status", { count: "exact" })
    .eq("studio_id", studioId)
    // Windowed on starts_at: the calendar's value belongs to when the work was
    // scheduled. created_at is when the row was written, which straddles local
    // midnight and would place a late booking in the wrong period.
    .gte("starts_at", startUtc)
    .lt("starts_at", endUtc)
    .order("id")
    .range(0, API_PAGE_SIZE - 1);

  if (error) return unreadableCalendar("unavailable");

  const rows = (data ?? []) as unknown as CensusRow[];
  if (typeof count !== "number" || rows.length !== count) {
    return unreadableCalendar("not_enumerable");
  }

  return summarizeCalendar(rows);
}
