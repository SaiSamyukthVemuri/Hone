import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { localDateString, utcInstantFromLocal } from "@/lib/booking/tz";
import { readAppointmentsKeyset, readMoneyForAppointments } from "@/lib/finance/statement-money-read";
import { createClient } from "@/lib/supabase/server";
import type { Studio } from "@/lib/types/database";

import { FORMER_TEAM_MEMBER_LABEL, UNNAMED_TEAM_MEMBER_LABEL } from "../copy";
import type { FigureRead } from "../figure";
import { readClientNames } from "./client-names-read";
import type { ClientChip, ClientSort } from "../clients-table";
import type { NameLookup } from "../named-clients";
import { buildOverview, candidateClientIds, type FollowThroughData, type HistoryData, type OverviewView, type PractitionerInfo, type WindowData } from "../overview-model";
import { parseOverviewParams, type OverviewParams, type RawParams } from "../overview-params";
import { resolvePeriod, windowInstants, type PeriodWindow, type ResolvedPeriod } from "../period";
import type { PriceEvidenceClass } from "../service-value";

// ===========================================================================
// Business → Analytics: THE OVERVIEW'S READS. READ-ONLY, owner-only, fail-closed.
// ===========================================================================
// The OWNER GATE is the first statement: no query is made for anyone else. Invoker client only (row-level security), no service role, no write.
// The studio is the signed-in practitioner's studio, never a request value. Each window is read whole by keyset paging or fails; a partial window is
// never shown as a whole one. Only settlement quotes are read as price evidence: the online-booking snapshot's table has no read policy, so that class
// is reported as NOT READ, never as zero.

export const CLASSES_READ: readonly PriceEvidenceClass[] = ["recorded_at_visit"];

export type OverviewRead =
  | { access: "refused" }
  | { access: "granted"; ok: false; reason: "bad_request" | "read_failed"; notices: string[] }
  // The dates were not accepted: the controls are still drawn with what was submitted (parsed to safe values), so the owner can correct the range.
  | { access: "granted"; ok: false; reason: "period_invalid"; notices: string[]; params: OverviewParams; practitionerOptions: PractitionerOption[] }
  | { access: "granted"; ok: true; view: OverviewView; params: OverviewParams; notices: string[]; practitionerOptions: PractitionerOption[] };

/** What the filter control lists: the current team, by display name. Needed by the filter's own form only; never put in a chart, table or export. */
export type PractitionerOption = { id: string; label: string };

async function readWindow(supabase: SupabaseClient, studioId: string, timezone: string, w: PeriodWindow): Promise<FigureRead<WindowData>> {
  const { startUtc, endUtc } = windowInstants(w, timezone);
  const appts = await readAppointmentsKeyset(supabase, studioId, { startUtc, endUtc });
  if (!appts.ok) return { ok: false, reason: appts.reason === "too_many_appointments" ? "too_many_appointments" : "read_failed" };
  const money = await readMoneyForAppointments(supabase, studioId, appts.rows.map((a) => a.id));
  // A money read that failed or hit its row cap makes only the MONEY figures unavailable: the visit figures need none of it.
  return {
    ok: true,
    value: {
      appointments: appts.rows,
      money: money.ok ? { ok: true, value: { cardRows: money.cardRows, settlementRows: money.settlementRows, legacyFeeRows: money.legacyFeeRows } } : { ok: false, reason: "read_failed" },
    },
  };
}

/** The earlier appointments with their money, for the lifetime column. Over the money read's cap it says so; it never truncates. */
async function readLifetimeHistory(supabase: SupabaseClient, studioId: string, history: FigureRead<HistoryData>): Promise<FigureRead<WindowData>> {
  if (!history.ok) return { ok: false, reason: history.reason };
  const money = await readMoneyForAppointments(supabase, studioId, history.value.appointments.map((a) => a.id));
  if (!money.ok) return readFailure("read_failed");
  return { ok: true, value: { appointments: history.value.appointments, money: { ok: true, value: { cardRows: money.cardRows, settlementRows: money.settlementRows, legacyFeeRows: money.legacyFeeRows } } } };
}

const readFailure = (reason: "read_failed" | "too_many_appointments"): { ok: false; reason: "read_failed" | "too_many_appointments" } => ({ ok: false, reason });

/** Every appointment BEFORE the window began, any status. Over the 10,000 cap it says so; it never truncates. */
async function readHistory(supabase: SupabaseClient, studioId: string, timezone: string, w: PeriodWindow): Promise<FigureRead<HistoryData>> {
  const { startUtc } = windowInstants(w, timezone);
  const r = await readAppointmentsKeyset(supabase, studioId, { endUtc: startUtc });
  return r.ok ? { ok: true, value: { appointments: r.rows } } : readFailure(r.reason);
}

/** Everything up to now (any status; every client with a completed visit counts) and everything from now on, for "no next booking". As of now, so independent of the period chosen. */
async function readFollowThrough(supabase: SupabaseClient, studioId: string, now: Date): Promise<FigureRead<FollowThroughData>> {
  const [past, future] = await Promise.all([
    readAppointmentsKeyset(supabase, studioId, { endUtc: now.toISOString() }),
    readAppointmentsKeyset(supabase, studioId, { startUtc: now.toISOString() }),
  ]);
  if (!past.ok) return readFailure(past.reason);
  if (!future.ok) return readFailure(future.reason);
  return { ok: true, value: { past: past.rows, future: future.rows } };
}

/**
 * The filter's list: the active team by display name, sorted. A SELECTED team member who is no longer active still has visits to show; the form lists
 * active members only, so without this the browser would show "Everyone" while the data is filtered. List the selected one as a former team member,
 * never by name.
 */
function optionsFor(rows: ReadonlyArray<{ id: string; displayName: string | null; active: boolean }>, params: OverviewParams): PractitionerOption[] {
  const options = rows
    .filter((p) => p.active)
    .map((p) => ({ id: p.id, label: p.displayName && p.displayName.trim() ? p.displayName.trim() : UNNAMED_TEAM_MEMBER_LABEL }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  const chosen = params.practitioner.kind === "one" ? params.practitioner.practitionerId : null;
  if (chosen !== null && !options.some((o) => o.id === chosen)) options.push({ id: chosen, label: FORMER_TEAM_MEMBER_LABEL });
  return options;
}

export async function loadOverview(
  practitioner: { readonly role: string },
  studio: Pick<Studio, "id" | "timezone">,
  studioCurrency: string | null,
  raw: RawParams,
  /** `names: false` skips the client-name read entirely: the printed page never shows names, so it never reads them. */
  opts: { strict: boolean; names?: boolean; clients?: { sort: ClientSort; chip: ClientChip; page: number } },
  now: Date,
  supabaseClient: SupabaseClient | undefined = undefined,
): Promise<OverviewRead> {
  if (practitioner.role !== "owner") return { access: "refused" };
  const supabase = supabaseClient ?? (await createClient());

  // Names are labels, but a missing one would put a figure under the wrong heading, so a failed read fails the whole page.
  const people = await readStudioPractitioners(supabase, studio.id);
  if (!people.ok) return { access: "granted", ok: false, reason: "read_failed", notices: [] };

  const parsed = parseOverviewParams(raw, { strict: opts.strict, practitionerIds: new Set(people.rows.map((p) => p.id)) });
  if (!parsed.ok) return { access: "granted", ok: false, reason: "bad_request", notices: [] };

  const resolved = resolvePeriod({
    kind: parsed.params.periodKind,
    today: localDateString(now, studio.timezone),
    from: parsed.params.from,
    to: parsed.params.to,
    customComparison: parsed.params.compare,
  });
  if (!resolved.ok) {
    if (opts.strict) return { access: "granted", ok: false, reason: "bad_request", notices: [] };
    return { access: "granted", ok: false, reason: "period_invalid", notices: [...parsed.notices, `The dates were not accepted (${resolved.error.replace(/_/g, " ")}).`], params: parsed.params, practitionerOptions: optionsFor(people.rows, parsed.params) };
  }
  const period: ResolvedPeriod = resolved.period;

  const current = await readWindow(supabase, studio.id, studio.timezone, period.current);
  const comparison = await readWindow(supabase, studio.id, studio.timezone, period.comparison);
  const history = await readHistory(supabase, studio.id, studio.timezone, period.current);
  const followThrough = await readFollowThrough(supabase, studio.id, now);
  const input = {
    timezone: studio.timezone,
    currency: studioCurrency,
    nowIso: now.toISOString(),
    period,
    filter: parsed.params.practitioner,
    current,
    comparison,
    history,
    followThrough,
    practitioners: people.rows,
    classesRead: CLASSES_READ,
  };
  // Names for the clients this period's visits name, read after the owner check and for no one else.
  const names: NameLookup = opts.names === false ? { ok: false } : await readClientNames(supabase, studio.id, candidateClientIds(input));
  // The Clients tab also needs the money on the earlier visits, for its lifetime column. A failure there affects only that column.
  const clients = opts.clients ? { ...opts.clients, lifetimeHistory: await readLifetimeHistory(supabase, studio.id, history) } : undefined;
  const view = buildOverview({ ...input, names, clients });
  const practitionerOptions = optionsFor(people.rows, parsed.params);
  return { access: "granted", ok: true, view, params: parsed.params, notices: parsed.notices, practitionerOptions };
}

/** The API returns at most 1000 rows whatever limit is asked for, so truncation can only be seen as a FULL page: a page of exactly the cap may be cut off, and a roster that may be incomplete would mislabel people. It fails the page closed. */
export const PRACTITIONER_PAGE_CAP = 1000;

async function readStudioPractitioners(supabase: SupabaseClient, studioId: string): Promise<{ ok: true; rows: PractitionerInfo[] } | { ok: false }> {
  const { data, error } = await supabase.from("practitioners").select("id, display_name, active").eq("studio_id", studioId).limit(PRACTITIONER_PAGE_CAP);
  if (error || !data || data.length >= PRACTITIONER_PAGE_CAP) return { ok: false };
  return { ok: true, rows: (data as { id: string; display_name: string | null; active: boolean }[]).map((r) => ({ id: r.id, displayName: r.display_name, active: r.active === true })) };
}
