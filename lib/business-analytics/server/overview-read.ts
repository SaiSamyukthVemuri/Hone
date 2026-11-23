import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { localDateString, utcInstantFromLocal } from "@/lib/booking/tz";
import { readAppointmentsKeyset, readMoneyForAppointments } from "@/lib/finance/statement-money-read";
import { timed } from "@/lib/observability/perf-timing";
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

type ApptRead = Awaited<ReturnType<typeof readAppointmentsKeyset>>;

/** A window's figures from its appointment read: the money for those visits is read here. A failed or capped money read makes only the MONEY unavailable. */
async function windowFrom(supabase: SupabaseClient, studioId: string, appts: ApptRead): Promise<FigureRead<WindowData>> {
  if (!appts.ok) return { ok: false, reason: appts.reason === "too_many_appointments" ? "too_many_appointments" : "read_failed" };
  const money = await timed("analytics.money", () => readMoneyForAppointments(supabase, studioId, appts.rows.map((a) => a.id)));
  // A money read that failed or hit its row cap makes only the MONEY figures unavailable: the visit figures need none of it.
  return {
    ok: true,
    value: {
      appointments: appts.rows,
      money: money.ok ? { ok: true, value: { cardRows: money.cardRows, settlementRows: money.settlementRows, legacyFeeRows: money.legacyFeeRows } } : { ok: false, reason: "read_failed" },
    },
  };
}

/** Every appointment BEFORE the window began, any status. Over the 10,000 cap it says so; it never truncates. */
function historyFrom(r: ApptRead): FigureRead<HistoryData> {
  return r.ok ? { ok: true, value: { appointments: r.rows } } : readFailure(r.reason);
}

/** Everything up to now (any status; every client with a completed visit counts) and everything from now on, for "no next booking". As of now, so independent of the period chosen. */
function followThroughFrom(past: ApptRead, future: ApptRead): FigureRead<FollowThroughData> {
  if (!past.ok) return readFailure(past.reason);
  if (!future.ok) return readFailure(future.reason);
  return { ok: true, value: { past: past.rows, future: future.rows } };
}

/** The earlier appointments with their money, for the lifetime column. Over the money read's cap it says so; it never truncates. */
async function readLifetimeHistory(supabase: SupabaseClient, studioId: string, history: FigureRead<HistoryData>): Promise<FigureRead<WindowData>> {
  if (!history.ok) return { ok: false, reason: history.reason };
  const money = await timed("analytics.money", () => readMoneyForAppointments(supabase, studioId, history.value.appointments.map((a) => a.id)));
  if (!money.ok) return readFailure("read_failed");
  return { ok: true, value: { appointments: history.value.appointments, money: { ok: true, value: { cardRows: money.cardRows, settlementRows: money.settlementRows, legacyFeeRows: money.legacyFeeRows } } } };
}

const readFailure = (reason: "read_failed" | "too_many_appointments"): { ok: false; reason: "read_failed" | "too_many_appointments" } => ({ ok: false, reason });

// ---------------------------------------------------------------------------
// THE FIVE APPOINTMENT SETS. Each is "this studio's appointments in a half-open UTC range": the current window, the comparison window, everything before the
// current window (history), everything before now, everything from now. There are two ways to get them and they MUST return identical rows:
//   * "separate": one keyset read per set, one after another (the original loader, kept as the reference and as the fallback);
//   * "shared":   ONE keyset read of the studio's appointments, cut into the five ranges in memory. History, past and the windows overlap, so the separate
//                 reads scanned the table about three times.
// The shared read gives up (returns null) and the caller falls back to "separate" whenever it cannot be certain of the same answer: any failed or capped
// read (so a failure stays exactly as narrow as before, never wider), an unparseable instant, or a start with sub-millisecond digits (the cut compares
// milliseconds). A failed read stays "unavailable"; it is never turned into zero.
// ---------------------------------------------------------------------------

export type AppointmentReadStrategy = "shared" | "separate";
type ApptSets = { current: ApptRead; comparison: ApptRead; history: ApptRead; past: ApptRead; future: ApptRead };

/** Exported for the equivalence test only: the two ways of reading the five sets. */
export async function readSetsSeparately(supabase: SupabaseClient, studioId: string, timezone: string, period: ResolvedPeriod, now: Date): Promise<ApptSets> {
  const cw = windowInstants(period.current, timezone);
  const pw = windowInstants(period.comparison, timezone);
  const current = await readAppointmentsKeyset(supabase, studioId, { startUtc: cw.startUtc, endUtc: cw.endUtc });
  const comparison = await readAppointmentsKeyset(supabase, studioId, { startUtc: pw.startUtc, endUtc: pw.endUtc });
  const history = await readAppointmentsKeyset(supabase, studioId, { endUtc: cw.startUtc });
  const [past, future] = await Promise.all([
    readAppointmentsKeyset(supabase, studioId, { endUtc: now.toISOString() }),
    readAppointmentsKeyset(supabase, studioId, { startUtc: now.toISOString() }),
  ]);
  return { current, comparison, history, past, future };
}

const SUB_MILLISECOND = /\.\d{3}\d*[1-9]/;

export async function readSetsShared(supabase: SupabaseClient, studioId: string, timezone: string, period: ResolvedPeriod, now: Date): Promise<ApptSets | null> {
  const all = await readAppointmentsKeyset(supabase, studioId, {});
  if (!all.ok) return null;
  const at = new Map<string, number>();
  for (const a of all.rows) {
    const t = Date.parse(a.startsAt);
    if (!Number.isFinite(t) || SUB_MILLISECOND.test(a.startsAt)) return null;
    at.set(a.id, t);
  }
  const cw = windowInstants(period.current, timezone);
  const pw = windowInstants(period.comparison, timezone);
  const nowIso = now.toISOString();
  if ([cw.startUtc, cw.endUtc, pw.startUtc, pw.endUtc].some((i) => !Number.isFinite(Date.parse(i)))) return null;
  const cut = (startUtc?: string, endUtc?: string): ApptRead => {
    const lo = startUtc === undefined ? -Infinity : Date.parse(startUtc);
    const hi = endUtc === undefined ? Infinity : Date.parse(endUtc);
    return { ok: true, rows: all.rows.filter((a) => (at.get(a.id) as number) >= lo && (at.get(a.id) as number) < hi) };
  };
  return { current: cut(cw.startUtc, cw.endUtc), comparison: cut(pw.startUtc, pw.endUtc), history: cut(undefined, cw.startUtc), past: cut(undefined, nowIso), future: cut(nowIso, undefined) };
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
  opts: { strict: boolean; names?: boolean; clients?: { sort: ClientSort; chip: ClientChip; page: number }; appointmentReads?: AppointmentReadStrategy },
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

  const strategy = opts.appointmentReads ?? "shared";
  const sets = await timed("analytics.appointments", async () => (strategy === "shared" ? await readSetsShared(supabase, studio.id, studio.timezone, period, now) : null) ?? (await readSetsSeparately(supabase, studio.id, studio.timezone, period, now)));
  // Nothing below depends on another: the two windows' money, and (Clients tab only) the lifetime money, are read at once.
  const history = historyFrom(sets.history);
  const followThrough = followThroughFrom(sets.past, sets.future);
  const [current, comparison, lifetimeHistory] = await Promise.all([
    windowFrom(supabase, studio.id, sets.current),
    windowFrom(supabase, studio.id, sets.comparison),
    opts.clients ? readLifetimeHistory(supabase, studio.id, history) : Promise.resolve(undefined),
  ]);
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
  const clients = opts.clients && lifetimeHistory ? { ...opts.clients, lifetimeHistory } : undefined;
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
