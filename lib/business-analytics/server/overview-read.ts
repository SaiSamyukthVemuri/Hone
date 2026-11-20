import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { localDateString } from "@/lib/booking/tz";
import { readAppointmentsKeyset, readMoneyForAppointments } from "@/lib/finance/statement-money-read";
import { createClient } from "@/lib/supabase/server";
import type { Studio } from "@/lib/types/database";

import type { FigureRead } from "../figure";
import { buildOverview, type OverviewView, type PractitionerInfo, type WindowData } from "../overview-model";
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
  | { access: "granted"; ok: false; reason: "bad_request" | "read_failed" | "period_invalid"; notices: string[] }
  | { access: "granted"; ok: true; view: OverviewView; params: OverviewParams; notices: string[] };

async function readWindow(supabase: SupabaseClient, studioId: string, timezone: string, w: PeriodWindow): Promise<FigureRead<WindowData>> {
  const { startUtc, endUtc } = windowInstants(w, timezone);
  const appts = await readAppointmentsKeyset(supabase, studioId, { startUtc, endUtc });
  if (!appts.ok) return { ok: false, reason: appts.reason === "too_many_appointments" ? "too_many_appointments" : "read_failed" };
  const money = await readMoneyForAppointments(supabase, studioId, appts.rows.map((a) => a.id));
  if (!money.ok) return { ok: false, reason: "read_failed" };
  return { ok: true, value: { appointments: appts.rows, money: { cardRows: money.cardRows, settlementRows: money.settlementRows, legacyFeeRows: money.legacyFeeRows } } };
}

export async function loadOverview(
  practitioner: { readonly role: string },
  studio: Pick<Studio, "id" | "timezone">,
  studioCurrency: string | null,
  raw: RawParams,
  opts: { strict: boolean },
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
    return { access: "granted", ok: false, reason: "period_invalid", notices: [...parsed.notices, `The dates were not accepted (${resolved.error.replace(/_/g, " ")}).`] };
  }
  const period: ResolvedPeriod = resolved.period;

  const current = await readWindow(supabase, studio.id, studio.timezone, period.current);
  const comparison = await readWindow(supabase, studio.id, studio.timezone, period.comparison);
  const view = buildOverview({
    timezone: studio.timezone,
    currency: studioCurrency,
    nowIso: now.toISOString(),
    period,
    filter: parsed.params.practitioner,
    current,
    comparison,
    practitioners: people.rows,
    classesRead: CLASSES_READ,
  });
  return { access: "granted", ok: true, view, params: parsed.params, notices: parsed.notices };
}

async function readStudioPractitioners(supabase: SupabaseClient, studioId: string): Promise<{ ok: true; rows: PractitionerInfo[] } | { ok: false }> {
  const { data, error } = await supabase.from("practitioners").select("id, display_name, active").eq("studio_id", studioId).limit(1001);
  if (error || !data || data.length > 1000) return { ok: false };
  return { ok: true, rows: (data as { id: string; display_name: string | null; active: boolean }[]).map((r) => ({ id: r.id, displayName: r.display_name, active: r.active === true })) };
}
