import { createClient } from "@/lib/supabase/server";
import { getSessionBlockAreasByBlockIds } from "@/lib/supabase/queries";
import { blockAreasLabel } from "@/lib/sessions/block-areas";
import {
  normalizeProbeLabel,
  chartedLifecycleStatus,
  type ProbeLotSuggestion,
  type ProbeLotSuggestions,
} from "@/lib/record-keeping/probe-lot-suggestion";
import {
  buildProbeLotOptions,
  type ProbeLotInventoryRow,
  type ProbeLotOption,
} from "@/lib/record-keeping/probe-lot-inventory";
import { addDays, utcInstantFromLocal } from "@/lib/booking/tz";
import {
  SUPPLY_EXPIRING_WITHIN_DAYS,
  supplyExpiryHorizon,
} from "@/lib/record-keeping/expiry";
import type {
  RecordKeepingDisinfectant,
  RecordKeepingExposureIncident,
  RecordKeepingSterileItem,
} from "@/lib/types/database";

// PR #205 (migration 0085): health-inspection record keeping reads.
// All studio-scoped; RLS (is_studio_member) is the backstop and every
// query still filters by studio_id explicitly. Practitioner-facing
// only: nothing in this module may be imported by public/portal/
// email/cron surfaces.

export async function getSterileItemRecords(
  studioId: string,
): Promise<RecordKeepingSterileItem[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("record_keeping_sterile_items")
    .select("*")
    .eq("studio_id", studioId)
    .order("date_purchased", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(200);
  return (data ?? []) as RecordKeepingSterileItem[];
}

// PR #316: sterile items expired OR expiring within N days, for the dashboard
// "Supplies expiring" attention card. Studio-scoped (RLS + explicit .eq);
// `today` is passed in so callers stay deterministic. Returns only safe display
// fields (no lot_number, the card never needs it).
//
// MIGRATION 0182 — DISCARDED STOCK IS FILTERED OUT HERE, DELIBERATELY. This is
// a purely CURRENT surface: it exists only to prompt action on supplies still
// on the shelf, and it has exactly one caller (the dashboard). Stock the
// practitioner recorded as physically thrown away cannot need replacing, so the
// gate belongs in the query. This is the precise line that stops Hone telling
// Chloe to replace probes she has already binned.
//
// This is NOT the forbidden global filter. The foundational reads —
// getSterileItemRecords (the historical log), getProbeLotInventory (the
// inventory the charting form and every historical link resolve through) and
// getLotTraceability — are DIFFERENT functions and are deliberately left
// unfiltered. Current inventory is not historical record existence.
export async function getExpiringSterileItems(
  studioId: string,
  todayIso: string,
  options: { withinDays?: number; limit?: number } = {},
): Promise<
  Pick<
    RecordKeepingSterileItem,
    "id" | "item_description" | "manufacturer_name" | "expiry_date"
  >[]
> {
  const within = options.withinDays ?? SUPPLY_EXPIRING_WITHIN_DAYS;
  const supabase = await createClient();
  const horizon = supplyExpiryHorizon(todayIso, within);
  const { data } = await supabase
    .from("record_keeping_sterile_items")
    .select("id, item_description, manufacturer_name, expiry_date")
    .eq("studio_id", studioId)
    .is("date_discarded", null) // 0182: discarded stock is not current stock
    .not("expiry_date", "is", null)
    .lte("expiry_date", horizon)
    .order("expiry_date", { ascending: true })
    .limit(options.limit ?? 50);
  return (data ?? []) as Pick<
    RecordKeepingSterileItem,
    "id" | "item_description" | "manufacturer_name" | "expiry_date"
  >[];
}

// PR #279 (Chloe charting feedback): suggest the latest current probe lot/batch
// from the studio's sterile-item records so the practitioner can CONFIRM it
// while charting (it is never auto-confirmed). "Relevant" = a sterile item whose
// description mentions a probe; "current" = not past its expiry date. Returns the
// lot number to suggest, or null when there is nothing to suggest (manual entry
// stays available). Read-only; record-keeping forms are untouched (deferred to
// PR #280).
export async function getLatestProbeLotSuggestion(
  studioId: string,
): Promise<string | null> {
  const supabase = await createClient();
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supabase
    .from("record_keeping_sterile_items")
    .select("lot_number, item_description, expiry_date, date_purchased")
    .eq("studio_id", studioId)
    .not("lot_number", "is", null)
    .ilike("item_description", "%probe%")
    // Migration 0182: never suggest stock the practitioner recorded as
    // discarded. This function suggests the CURRENT lot to chart against, so
    // discarded rows are excluded here alongside the existing expiry gate.
    .is("date_discarded", null)
    .or(`expiry_date.is.null,expiry_date.gte.${today}`)
    .order("date_purchased", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const lot = (data?.lot_number as string | null | undefined)?.trim();
  return lot ? lot : null;
}

// Migration 0128 charting release: the full ACTIVE probe-lot inventory for the
// charting selector. Source = record_keeping_sterile_items (the studio's live
// sterilization log) filtered to probe rows with a lot number; the dormant
// legacy `probe_lots` table is deliberately NOT read. Studio-scoped (.eq +
// RLS). Expired lots ARE returned (a historical value must stay selectable) but
// are classified isExpired and sorted last by buildProbeLotOptions. Manual entry
// always remains available in the form; this only powers suggestions/search.
//
// MIGRATION 0182 — DISCARDED ROWS ARE RETURNED, NOT FILTERED. This is the
// FOUNDATIONAL inventory read, and filtering it on date_discarded would be a
// defect: a historical session's probe_inventory_item_id link, the edit chooser
// for that old record, and lot traceability all resolve through this list, so a
// row that vanishes here takes retrospective truth with it. date_discarded is
// SELECTED and carried onto each option as isDiscarded; the CURRENT-stock gate
// lives in activeProbeLotOptionsForProbe / resolveInventoryAutofill. Current
// inventory is not historical record existence.
export async function getProbeLotInventory(
  studioId: string,
): Promise<ProbeLotOption[]> {
  const supabase = await createClient();
  const today = new Date().toISOString().slice(0, 10);
  // Migration 0155: inventory is now probe-SPECIFIC via the structured probe_key,
  // not the free-text ILIKE '%probe%' heuristic. Only sterile items explicitly
  // classified with a probe_key are selectable inventory lots; each carries its
  // immutable inventory `id` so the chosen row can be durably linked. Legacy /
  // unclassified rows (probe_key null) never appear as an exact probe match.
  const { data } = await supabase
    .from("record_keeping_sterile_items")
    .select(
      "id, probe_key, lot_number, item_description, manufacturer_name, expiry_date, date_discarded",
    )
    .eq("studio_id", studioId)
    .not("probe_key", "is", null)
    .not("lot_number", "is", null)
    .order("expiry_date", { ascending: false, nullsFirst: true })
    .order("date_purchased", { ascending: false, nullsFirst: false })
    .limit(500);
  const rows: ProbeLotInventoryRow[] = ((data ?? []) as Array<{
    id: string;
    probe_key: string | null;
    lot_number: string | null;
    item_description: string | null;
    manufacturer_name: string | null;
    expiry_date: string | null;
    date_discarded: string | null;
  }>).map((r) => ({
    id: r.id,
    probeKey: r.probe_key,
    lotNumber: (r.lot_number ?? "").trim(),
    itemDescription: r.item_description ?? "",
    manufacturerName: r.manufacturer_name ?? null,
    expiryDate: r.expiry_date,
    dateDiscarded: r.date_discarded,
  }));
  return buildProbeLotOptions(rows, today);
}

// Feature A (Chloe charting feedback): while charting, suggest the most recent
// lot/batch used for the SAME probe (probe_key) in the SAME studio, so the
// practitioner can confirm/override it. Returns a probe_key -> lot map so the
// form can react to the probe the practitioner selects without a round-trip.
//
//   * Studio-scoped: .eq("studio_id") + RLS (session_blocks_member_all). A
//     studio never sees another studio's lots.
//   * Same probe only: keyed by probe_key; rows with a null probe_key never
//     contribute (a legacy free-text probe gets no suggestion → blank field).
//   * Excludes null/blank lots and soft-deleted blocks.
//   * Prefers a CONFIRMED lot where available, then the newest: the ordering
//     (probe_lot_confirmed desc, created_at desc) puts the preferred row first
//     per probe_key, and the first row per key wins.
//
// The suggestion is a hint only: the form auto-populates it UNCONFIRMED; the
// practitioner must confirm or override.
export async function getLatestProbeLotByProbeKey(
  studioId: string,
): Promise<Record<string, string>> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("session_blocks")
    .select("probe_key, probe_lot_number, probe_lot_confirmed, created_at")
    .eq("studio_id", studioId)
    .not("probe_key", "is", null)
    .not("probe_lot_number", "is", null)
    .is("deleted_at", null)
    .order("probe_key", { ascending: true })
    .order("probe_lot_confirmed", { ascending: false })
    .order("created_at", { ascending: false });

  const map: Record<string, string> = {};
  for (const row of data ?? []) {
    const key = (row.probe_key as string | null)?.trim();
    const lot = (row.probe_lot_number as string | null)?.trim();
    if (!key || !lot) continue;
    // First row per probe_key wins: confirmed-first, then newest.
    if (!(key in map)) map[key] = lot;
  }
  return map;
}

// Feature A (reliability): richer lot suggestions for the charting form.
//   * Studio-scoped (.eq("studio_id") + RLS), never cross-studio.
//   * Prefer CONFIRMED over unconfirmed, then newest, within EACH of byKey /
//     byLabel (ordering probe_lot_confirmed desc, created_at desc; first row
//     per key/label wins). The unconfirmed fallback is retained deliberately
//     (studios may have zero confirmed rows).
//   * Excludes null/blank lots and soft-deleted blocks.
//   * Carries the `confirmed` flag so the form can label the source
//     ("Auto-filled from last confirmed probe lot" vs "Suggested from last
//     probe lot").
export async function getProbeLotSuggestions(
  studioId: string,
): Promise<ProbeLotSuggestions> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("session_blocks")
    .select(
      "probe_key, probe_label, probe_lot_number, probe_lot_confirmed, probe_inventory_item_id, created_at",
    )
    .eq("studio_id", studioId)
    .not("probe_lot_number", "is", null)
    .is("deleted_at", null)
    .order("probe_lot_confirmed", { ascending: false })
    .order("created_at", { ascending: false });

  const byKey: Record<string, ProbeLotSuggestion> = {};
  const byLabel: Record<string, ProbeLotSuggestion> = {};
  // Two things are tracked per key/label, INDEPENDENTLY:
  //   * the DISPLAY winner: the first row (confirmed-first, then newest) of any
  //     source; its `inventoryItemId` may be null (a manual lot).
  //   * lastConfirmedInventoryItemId, the newest row satisfying BOTH
  //     probe_lot_confirmed = true AND probe_inventory_item_id IS NOT NULL. Since
  //     confirmed rows sort first (newest-first), the FIRST confirmed+linked row
  //     seen per key/label is the newest such row. This is what auto-fill uses,
  //     so a newer confirmed MANUAL row can never mask an older confirmed LINKED
  //     one, and an unconfirmed linked row never qualifies.
  const seedFirst = (
    map: Record<string, ProbeLotSuggestion>,
    slot: string,
    lot: string,
    confirmed: boolean,
    inventoryItemId: string | null,
  ) => {
    if (!(slot in map)) {
      map[slot] = {
        lot,
        confirmed,
        inventoryItemId,
        lastConfirmedInventoryItemId: null,
        lastCharted: "",
        lastChartedInventoryItemId: null,
        lastChartedLifecycle: null,
      };
    }
    if (
      confirmed &&
      inventoryItemId != null &&
      map[slot].lastConfirmedInventoryItemId == null
    ) {
      map[slot].lastConfirmedInventoryItemId = inventoryItemId;
    }
  };
  // lastCharted is recency-ONLY, so it cannot be seeded from the
  // confirmed-first ordering above. Resolved in a second pass over the same
  // rows, ordered by created_at desc within each confirmed group: the newest
  // row overall is whichever of the two group-leaders has the later created_at.
  const seedLastCharted = (
    map: Record<string, ProbeLotSuggestion>,
    seenAt: Record<string, string>,
    slot: string,
    lot: string,
    createdAt: string,
    // 0182: the inventory id of THIS row, kept in lockstep with lastCharted so
    // the auto-fill guard can check that exact item's lifecycle by identity.
    inventoryItemId: string | null,
  ) => {
    const previous = seenAt[slot];
    if (previous !== undefined && previous >= createdAt) return;
    seenAt[slot] = createdAt;
    map[slot].lastCharted = lot;
    map[slot].lastChartedInventoryItemId = inventoryItemId;
  };
  const lastChartedAtByKey: Record<string, string> = {};
  const lastChartedAtByLabel: Record<string, string> = {};
  for (const row of data ?? []) {
    const lot = (row.probe_lot_number as string | null)?.trim();
    if (!lot) continue;
    const confirmed = row.probe_lot_confirmed === true;
    const inventoryItemId =
      (row.probe_inventory_item_id as string | null) ?? null;
    const createdAt = (row.created_at as string | null) ?? "";
    const key = (row.probe_key as string | null)?.trim();
    if (key) {
      seedFirst(byKey, key, lot, confirmed, inventoryItemId);
      seedLastCharted(
        byKey,
        lastChartedAtByKey,
        key,
        lot,
        createdAt,
        inventoryItemId,
      );
    }
    const label = normalizeProbeLabel(row.probe_label as string | null);
    if (label) {
      seedFirst(byLabel, label, lot, confirmed, inventoryItemId);
      seedLastCharted(
        byLabel,
        lastChartedAtByLabel,
        label,
        lot,
        createdAt,
        inventoryItemId,
      );
    }
  }

  // Migration 0182: resolve the lifecycle of every EXACT item a last-charted
  // row pointed at, through the identity-complete authority read rather than
  // the picker projection. One bounded, studio-scoped query for the whole set.
  const chartedIds = [...Object.values(byKey), ...Object.values(byLabel)]
    .map((s) => s.lastChartedInventoryItemId)
    .filter((id): id is string => !!id);
  if (chartedIds.length > 0) {
    const today = new Date().toISOString().slice(0, 10);
    const lifecycle = await getInventoryLifecycleByIds(studioId, chartedIds);
    for (const s of [...Object.values(byKey), ...Object.values(byLabel)]) {
      const id = s.lastChartedInventoryItemId;
      if (!id) continue; // manual row: no item, so no lifecycle. Not "unknown".
      // A failed read yields "unknown" for every id, NOT "current": the
      // auto-fill guard must fail closed rather than treat an unanswered
      // question as permission.
      s.lastChartedLifecycle = lifecycle.ok
        ? chartedLifecycleStatus(lifecycle.byId.get(id), today)
        : "unknown";
    }
  }
  return { byKey, byLabel };
}

// Migration 0182 — THE IDENTITY-COMPLETE LIFECYCLE AUTHORITY.
//
// Resolves the lifecycle of EXACT sterile-item ids. It exists because
// getProbeLotInventory is deliberately a FILTERED, BOUNDED projection built for
// the charting picker — it requires a non-null probe_key, its option builder
// drops blank lot numbers, and it caps at 500 rows. A historically linked item
// can be legitimately absent from that list while still existing and still
// being discarded, so looking an id up in it made "absent" indistinguishable
// from "not inventory" and the auto-fill guard failed OPEN.
//
// This read applies NONE of those filters. It is keyed on id alone, so it is
// truthful for an unclassified row, a blank-lot row, or a row far outside any
// picker bound.
//
// AUTHORITY POSTURE:
//   * studio-scoped: explicit .eq("studio_id") on top of the 0085
//     is_studio_member RLS SELECT policy, so a cross-studio id resolves to
//     NOTHING and is reported as unresolved (never as another studio's data);
//   * bounded by the caller's id set, never a whole-table scan;
//   * user-scoped client — NO service role, no elevated read;
//   * returns ONLY the lifecycle columns the decision mechanically needs.
//
// FAIL-CLOSED CONTRACT: a read error returns { ok: false }. Callers must map
// that to "unknown" and refuse to auto-fill, never to "current". Silence is not
// evidence that stock still exists.
export type InventoryLifecycleFact = {
  id: string;
  expiryDate: string | null;
  dateDiscarded: string | null;
};

export async function getInventoryLifecycleByIds(
  studioId: string,
  ids: ReadonlyArray<string>,
): Promise<
  { ok: true; byId: Map<string, InventoryLifecycleFact> } | { ok: false }
> {
  const unique = [...new Set(ids.map((i) => (i ?? "").trim()).filter(Boolean))];
  if (unique.length === 0) return { ok: true, byId: new Map() };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("record_keeping_sterile_items")
    .select("id, expiry_date, date_discarded")
    .eq("studio_id", studioId)
    .in("id", unique);
  // Do NOT fall back to an empty map here: an empty map is indistinguishable
  // from "every id resolved as missing", which is a legitimate state. The
  // caller must be able to tell a failed read from a truthful absence.
  if (error) return { ok: false };
  const byId = new Map<string, InventoryLifecycleFact>();
  for (const r of (data ?? []) as Array<{
    id: string;
    expiry_date: string | null;
    date_discarded: string | null;
  }>) {
    byId.set(r.id, {
      id: r.id,
      expiryDate: r.expiry_date,
      dateDiscarded: r.date_discarded,
    });
  }
  return { ok: true, byId };
}

export async function getDisinfectantRecords(
  studioId: string,
): Promise<RecordKeepingDisinfectant[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("record_keeping_disinfectants")
    .select("*")
    .eq("studio_id", studioId)
    .order("date_prepared", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(200);
  return (data ?? []) as RecordKeepingDisinfectant[];
}

export async function getExposureIncidentRecords(
  studioId: string,
): Promise<RecordKeepingExposureIncident[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("record_keeping_exposure_incidents")
    .select("*")
    .eq("studio_id", studioId)
    .order("incident_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(200);
  return (data ?? []) as RecordKeepingExposureIncident[];
}

// "Client Record for Invasive Procedures": generated from EXISTING
// clients / sessions / session_blocks / practitioners data, never
// duplicated into a record table. Missing values render as "Not
// recorded" in the UI; nothing is invented here.
export type ClientProcedureRecord = {
  sessionId: string;
  clientId: string;
  startedAt: string;
  modality: string;
  clientName: string;
  dateOfBirth: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  operatorName: string | null;
  aftercareExplainedAt: string | null;
  areas: Array<{
    name: string;
    probeLabel: string | null;
    probeLotNumber: string | null;
    minutesPerformed: number | null;
    // PR #223: machine frequency where recorded (session_blocks
    // column from migration 0084-era charting; never invented).
    machineFrequency: string | null;
  }>;
};

// PR #223: optional per-client filter (+ studio-timezone date range)
// for the inspection/transfer workflow. The shape is sanitized by
// normalizeProcedureRecordFilter below; UTC instants are computed by
// the caller from the studio's IANA timezone. Unfiltered behavior is
// byte-identical to before (most recent `limit` sessions studio-wide).
export type ProcedureRecordFilter = {
  clientId?: string | null;
  // Inclusive lower / exclusive upper bound, ISO UTC instants.
  fromUtc?: string | null;
  toUtcExclusive?: string | null;
  limit?: number;
};

// Sanitize raw URL params for the procedure-record filter. Returns
// nulls for anything that is not a plausible UUID / YYYY-MM-DD date,
// and drops an inverted date range. Pure; unit-tested directly.
export function normalizeProcedureRecordFilter(raw: {
  clientId?: string;
  from?: string;
  to?: string;
}): { clientId: string | null; from: string | null; to: string | null } {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const clientId = raw.clientId && uuid.test(raw.clientId) ? raw.clientId : null;
  let from = raw.from && day.test(raw.from) ? raw.from : null;
  let to = raw.to && day.test(raw.to) ? raw.to : null;
  if (from && to && from > to) {
    from = null;
    to = null;
  }
  return { clientId, from, to };
}

// Convert a sanitized YYYY-MM-DD day range to UTC instants using the
// STUDIO's timezone: from 00:00 on `from` up to (but not including)
// 00:00 the day after `to`. Shared by the Records screen and the
// print view so the printed pull always matches the screen.
export function utcInstantsForLocalDayRange(
  from: string | null,
  to: string | null,
  timezone: string,
): { fromUtc: string | null; toUtcExclusive: string | null } {
  return {
    fromUtc: from
      ? utcInstantFromLocal(from, "00:00", timezone).toISOString()
      : null,
    toUtcExclusive: to
      ? utcInstantFromLocal(addDays(to, 1), "00:00", timezone).toISOString()
      : null,
  };
}

// Cap for a filtered (per-client) pull: high enough for a realistic
// inspection/transfer artifact, still bounded.
export const FILTERED_PROCEDURE_RECORD_LIMIT = 200;

// PR #318: cap for an UNFILTERED (studio-wide) pull, deliberately small since
// the unfiltered view is a browse, not a complete log. Named so the print view
// can show an honest "showing most recent N" notice when the cap is hit.
export const UNFILTERED_PROCEDURE_RECORD_LIMIT = 30;

export async function getClientProcedureRecords(
  studioId: string,
  filter: ProcedureRecordFilter = {},
): Promise<ClientProcedureRecord[]> {
  const limit =
    filter.limit ??
    (filter.clientId
      ? FILTERED_PROCEDURE_RECORD_LIMIT
      : UNFILTERED_PROCEDURE_RECORD_LIMIT);
  const supabase = await createClient();
  let query = supabase
    .from("sessions")
    .select(
      "id, started_at, modality, practitioner_id, performed_by_practitioner_id, aftercare_and_risks_explained_at, clients(id, name, date_of_birth, phone, email, address)",
    )
    .eq("studio_id", studioId)
    // PR #318: exclude soft-deleted sessions (migration 0013). A session deleted
    // as a correction must not appear in Procedure Records / the inspection
    // print/export. (session_blocks are already filtered below.)
    .is("deleted_at", null);
  if (filter.clientId) query = query.eq("client_id", filter.clientId);
  if (filter.fromUtc) query = query.gte("started_at", filter.fromUtc);
  if (filter.toUtcExclusive)
    query = query.lt("started_at", filter.toUtcExclusive);
  const { data: sessions } = await query
    .order("started_at", { ascending: false })
    .limit(limit);
  if (!sessions || sessions.length === 0) return [];

  const sessionIds = sessions.map((s) => s.id as string);
  const [{ data: blocks }, { data: practitioners }] = await Promise.all([
    supabase
      .from("session_blocks")
      .select(
        "id, session_id, sort_order, primary_area, side, block_name, probe_label, probe_lot_number, minutes_performed, machine_frequency",
      )
      .eq("studio_id", studioId)
      .in("session_id", sessionIds)
      .is("deleted_at", null)
      .order("sort_order", { ascending: true }),
    supabase
      .from("practitioners")
      .select("id, display_name, email")
      .eq("studio_id", studioId),
  ]);

  // Migration 0128: resolve EVERY treated area + laterality per block so a
  // procedure record never shows only the first of several areas.
  const procedureAreasByBlock = await getSessionBlockAreasByBlockIds(
    (blocks ?? []).map((b) => b.id as string),
    studioId,
  );

  const practitionerName = new Map<string, string>(
    (practitioners ?? []).map((p) => [
      p.id as string,
      ((p.display_name as string | null)?.trim() ||
        (p.email as string)) as string,
    ]),
  );
  const blocksBySession = new Map<
    string,
    ClientProcedureRecord["areas"]
  >();
  for (const b of blocks ?? []) {
    const sid = b.session_id as string;
    const list = blocksBySession.get(sid) ?? [];
    list.push({
      name:
        (blockAreasLabel(procedureAreasByBlock.get(b.id as string), {
          primary_area: b.primary_area as string | null,
          side: b.side as string | null,
        }) ||
          (b.block_name as string | null)?.trim() ||
          `Treatment area ${b.sort_order}`) as string,
      probeLabel: (b.probe_label as string | null) ?? null,
      probeLotNumber: (b.probe_lot_number as string | null) ?? null,
      minutesPerformed: (b.minutes_performed as number | null) ?? null,
      machineFrequency: (b.machine_frequency as string | null) ?? null,
    });
    blocksBySession.set(sid, list);
  }

  return sessions.map((s) => {
    const clientEmbed = (s as { clients: unknown }).clients;
    const client = (Array.isArray(clientEmbed) ? clientEmbed[0] : clientEmbed) as {
      id?: string;
      name?: string;
      date_of_birth?: string | null;
      phone?: string | null;
      email?: string | null;
      address?: string | null;
    } | null;
    const operatorId =
      (s.performed_by_practitioner_id as string | null) ??
      (s.practitioner_id as string | null);
    return {
      sessionId: s.id as string,
      clientId: (client?.id as string | undefined) ?? "",
      startedAt: s.started_at as string,
      modality: s.modality as string,
      clientName: client?.name ?? "",
      dateOfBirth: client?.date_of_birth ?? null,
      phone: client?.phone ?? null,
      email: client?.email ?? null,
      address: client?.address ?? null,
      operatorName: operatorId
        ? (practitionerName.get(operatorId) ?? null)
        : null,
      aftercareExplainedAt:
        (s.aftercare_and_risks_explained_at as string | null) ?? null,
      areas: blocksBySession.get(s.id as string) ?? [],
    };
  });
}

// PR #206 (migration 0086): audit-trail reads. Newest first, grouped
// by record so the UI can show a small History panel per row. Same
// studio scoping + RLS backstop as everything above.
import type { RecordKeepingAuditEvent } from "@/lib/types/database";

/**
 * How many audit events ONE read may return. Unchanged from PR #206: it bounds
 * the response, never the id list.
 */
export const AUDIT_EVENT_READ_LIMIT = 500;

/**
 * How many record ids may travel in ONE `.in(...)` filter.
 *
 * WHY A BOUND EXISTS AT ALL. PostgREST filters ride in the query string, so an
 * `.in()` over N uuids puts ~39 bytes per id on the GET request line, and the
 * gateway in front of PostgREST refuses a request line over ~8 KiB with
 * **HTTP 414**. Measured against the local stack on this exact query shape:
 * 205 ids (8,167 B) is the last that succeeds, 206 ids (8,206 B) is the first
 * 414. The sibling `.in()` shapes on this page wall at 202-206 ids too, which
 * is the tell that the wall is the byte budget, not the id count.
 *
 * WHY 50 AND NOT 200. Callers are already capped at 200 ids by the
 * `.limit(200)` on each record list, so the shipped code sits ~5 ids under a
 * hard failure with NOTHING holding it there: raise a list limit, lengthen a
 * select, or widen a filter and the margin is gone silently. 50 ids is a
 * ~2.1 KB request line — a ~4x margin — which makes the safe property
 * structural instead of coincidental.
 * `tests/lib/record-keeping/audit-history-uri-budget.test.ts` pins the chunk's
 * own budget AND the margin the shipped caps still rely on.
 */
export const AUDIT_HISTORY_ID_CHUNK = 50;

/**
 * Audit history for a set of records, and — separately — the records whose
 * history could NOT be read.
 *
 * The second field is the whole point. A `Map` alone cannot distinguish "this
 * record has no history" from "this record's history did not load", and the UI
 * renders the first as the sentence "No history recorded yet." on an
 * append-only clinical audit trail. Callers MUST consult
 * `unavailableRecordIds` before stating an absence.
 */
export type AuditHistoryByRecord = {
  byRecord: ReadonlyMap<string, RecordKeepingAuditEvent[]>;
  unavailableRecordIds: ReadonlySet<string>;
};

/** Nothing was asked for, so nothing is known to be missing. */
export const EMPTY_AUDIT_HISTORY: AuditHistoryByRecord = Object.freeze({
  byRecord: new Map<string, RecordKeepingAuditEvent[]>(),
  unavailableRecordIds: new Set<string>(),
});

/**
 * One structured line to stderr, the lib/ops/alerts.ts convention.
 *
 * No record ids, no studio id, no error message: a PostgREST error message
 * embeds the request URL, which carries the very record ids this module reads.
 * The count and the record type are enough to find it in a log.
 */
function warnAuditHistoryUnavailable(
  recordType: string,
  unavailable: number,
  reason: "error" | "truncated",
): void {
  try {
    console.error(
      JSON.stringify({
        event: "record_keeping_audit_history_unavailable",
        record_type: recordType,
        unavailable_record_count: unavailable,
        reason,
      }),
    );
  } catch {
    console.error("record_keeping_audit_history_unavailable");
  }
}

function chunkIds(ids: readonly string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

export async function getAuditEventsByRecord(
  studioId: string,
  recordType: RecordKeepingAuditEvent["record_type"],
  recordIds: string[],
): Promise<AuditHistoryByRecord> {
  const ids = [...new Set(recordIds)].filter(Boolean);
  if (ids.length === 0) return EMPTY_AUDIT_HISTORY;

  // Outside the per-chunk try/catch on purpose: a client that cannot be built
  // is not a failed history read, and its throw keeps reaching the route's
  // error boundary exactly as it did before this change.
  const supabase = await createClient();

  const byRecord = new Map<string, RecordKeepingAuditEvent[]>();
  const unavailableRecordIds = new Set<string>();
  let sawError = false;

  const results = await Promise.all(
    chunkIds(ids, AUDIT_HISTORY_ID_CHUNK).map(async (chunk) => {
      try {
        const { data, error } = await supabase
          .from("record_keeping_audit_events")
          .select("*")
          // Studio scoping is per REQUEST, not per call: every chunk carries
          // the same studio + record_type filters the single read carried, on
          // top of the RLS policy. Splitting the id list changes how many
          // requests are made, never what any one of them may see.
          .eq("studio_id", studioId)
          .eq("record_type", recordType)
          .in("record_id", chunk)
          .order("created_at", { ascending: false })
          .limit(AUDIT_EVENT_READ_LIMIT);
        if (error) return { chunk, rows: null };
        return { chunk, rows: (data ?? []) as RecordKeepingAuditEvent[] };
      } catch {
        // supabase-js turns a transport failure into `{ data: null, error }`,
        // so this is the narrow case where the builder itself throws. It is
        // contained rather than propagated: a collapsed History disclosure must
        // not be able to take down a clinical logbook page.
        return { chunk, rows: null };
      }
    }),
  );

  for (const { chunk, rows } of results) {
    if (rows === null) {
      sawError = true;
      for (const id of chunk) unavailableRecordIds.add(id);
      continue;
    }
    for (const row of rows) {
      const list = byRecord.get(row.record_id) ?? [];
      list.push(row);
      byRecord.set(row.record_id, list);
    }
    // A chunk that came back exactly at the ceiling may have been CUT, and what
    // it dropped is the oldest. A record that received rows still shows true
    // rows — the panel lists events, it never claims to list all of them. A
    // record that received NONE cannot be told apart from one whose events were
    // all beyond the ceiling, so it is UNKNOWN rather than empty.
    if (rows.length >= AUDIT_EVENT_READ_LIMIT) {
      for (const id of chunk) {
        if (!byRecord.has(id)) unavailableRecordIds.add(id);
      }
    }
  }

  if (unavailableRecordIds.size > 0) {
    warnAuditHistoryUnavailable(
      recordType,
      unavailableRecordIds.size,
      sawError ? "error" : "truncated",
    );
  }
  return { byRecord, unavailableRecordIds };
}

// Procedure-record history: aftercare events keyed by session id, and
// probe-lot events keyed by the session id carried in metadata.
export async function getProcedureAuditEvents(
  studioId: string,
  sessionIds: string[],
): Promise<AuditHistoryByRecord> {
  const ids = [...new Set(sessionIds)].filter(Boolean);
  if (ids.length === 0) return EMPTY_AUDIT_HISTORY;
  const supabase = await createClient();

  // NOT chunked, and it does not need to be: this read carries no id list at
  // all. Probe-lot events key off `metadata.session_id` rather than
  // `record_id`, so they cannot be selected by an `.in()` over session ids —
  // the read is studio-scoped by record_type and narrowed in memory below. Its
  // request line does not grow with the number of sessions, so the 414 wall
  // documented on AUDIT_HISTORY_ID_CHUNK is out of reach here by construction.
  const { data, error } = await supabase
    .from("record_keeping_audit_events")
    .select("*")
    .eq("studio_id", studioId)
    .in("record_type", ["session_aftercare", "session_block_probe_lot"])
    .order("created_at", { ascending: false })
    .limit(AUDIT_EVENT_READ_LIMIT);

  if (error) {
    // The read did not happen. Every session asked about is UNKNOWN, and none
    // of them may be rendered as "no history".
    warnAuditHistoryUnavailable("session_aftercare", ids.length, "error");
    return {
      byRecord: new Map<string, RecordKeepingAuditEvent[]>(),
      unavailableRecordIds: new Set(ids),
    };
  }

  const rows = (data ?? []) as RecordKeepingAuditEvent[];
  const byRecord = new Map<string, RecordKeepingAuditEvent[]>();
  const wanted = new Set(ids);
  for (const row of rows) {
    const sessionId =
      row.record_type === "session_aftercare"
        ? row.record_id
        : ((row.metadata?.session_id as string | undefined) ?? "");
    if (!wanted.has(sessionId)) continue;
    const list = byRecord.get(sessionId) ?? [];
    list.push(row);
    byRecord.set(sessionId, list);
  }

  // Same truncation rule as the chunked read, and it bites sooner here because
  // the ceiling is studio-wide rather than per chunk: a session that received
  // no rows from a response that came back AT the ceiling may simply have been
  // cut off, so it is UNKNOWN rather than empty.
  const unavailableRecordIds = new Set<string>();
  if (rows.length >= AUDIT_EVENT_READ_LIMIT) {
    for (const id of ids) if (!byRecord.has(id)) unavailableRecordIds.add(id);
    if (unavailableRecordIds.size > 0) {
      warnAuditHistoryUnavailable(
        "session_aftercare",
        unavailableRecordIds.size,
        "truncated",
      );
    }
  }
  return { byRecord, unavailableRecordIds };
}

// PR #213: probe lot traceability. "Where was this lot used?" --
// connects Sterile Items records to the treatment areas that recorded
// the same lot number. Matching is EXACT normalized matching (trim +
// case-insensitive via an escaped ILIKE; never fuzzy, never guessed):
// stored values are already trimmed at write time, the search input
// is trimmed here, and ILIKE special characters are escaped so the
// pattern can only match the literal lot. Traceability only; nothing
// here implies causation or any conclusion about a lot.

// Escape ILIKE wildcards so the pattern is a literal, case-insensitive
// equality match. Exported for tests.
export function escapeIlikeExact(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function normalizeLotSearch(raw: string | undefined | null): string | null {
  const t = raw?.trim();
  return t && t.length > 0 ? t : null;
}

export type LotUsage = {
  blockId: string;
  sessionId: string;
  clientId: string | null;
  clientName: string | null;
  startedAt: string | null;
  modality: string | null;
  areaName: string | null;
  probeLabel: string | null;
  machineFrequency: string | null;
  operatorName: string | null;
  aftercareExplainedAt: string | null;
};

export type LotTraceability = {
  lot: string;
  sterileItems: RecordKeepingSterileItem[];
  usages: LotUsage[];
};

export async function getLotTraceability(
  studioId: string,
  lotRaw: string,
): Promise<LotTraceability | null> {
  const lot = normalizeLotSearch(lotRaw);
  if (!lot) return null;
  const pattern = escapeIlikeExact(lot);

  const supabase = await createClient();
  const [{ data: items }, { data: blockRows }, { data: practitioners }] =
    await Promise.all([
      supabase
        .from("record_keeping_sterile_items")
        .select("*")
        .eq("studio_id", studioId)
        .ilike("lot_number", pattern)
        .order("date_purchased", { ascending: false })
        .limit(50),
      supabase
        .from("session_blocks")
        .select(
          "id, session_id, primary_area, side, block_name, sort_order, probe_label, machine_frequency, probe_lot_number, session:sessions(id, started_at, modality, client_id, aftercare_and_risks_explained_at, performed_by_practitioner_id, practitioner_id, client:clients(id, name))",
        )
        .eq("studio_id", studioId)
        .ilike("probe_lot_number", pattern)
        .is("deleted_at", null)
        .limit(200),
      supabase
        .from("practitioners")
        .select("id, display_name, email")
        .eq("studio_id", studioId),
    ]);

  const practitionerName = new Map<string, string>(
    ((practitioners ?? []) as Array<{
      id: string;
      display_name: string | null;
      email: string;
    }>).map((p) => [p.id, p.display_name?.trim() || p.email]),
  );

  // Migration 0128: resolve the full multi-area set for each block that used
  // this lot so the usage record shows every treated area + laterality.
  const lotAreasByBlock = await getSessionBlockAreasByBlockIds(
    ((blockRows ?? []) as Array<{ id: string }>).map((b) => b.id),
    studioId,
  );

  type RawUsage = {
    id: string;
    session_id: string;
    primary_area: string | null;
    side: string | null;
    block_name: string | null;
    sort_order: number;
    probe_label: string | null;
    machine_frequency: string | null;
    session:
      | {
          id: string;
          started_at: string;
          modality: string;
          client_id: string;
          aftercare_and_risks_explained_at: string | null;
          performed_by_practitioner_id: string | null;
          practitioner_id: string | null;
          client:
            | { id: string; name: string }
            | { id: string; name: string }[]
            | null;
        }
      | {
          id: string;
          started_at: string;
          modality: string;
          client_id: string;
          aftercare_and_risks_explained_at: string | null;
          performed_by_practitioner_id: string | null;
          practitioner_id: string | null;
          client:
            | { id: string; name: string }
            | { id: string; name: string }[]
            | null;
        }[]
      | null;
  };

  const usages: LotUsage[] = ((blockRows ?? []) as RawUsage[])
    .map((b) => {
      const sess = Array.isArray(b.session) ? (b.session[0] ?? null) : b.session;
      const client = sess
        ? Array.isArray(sess.client)
          ? (sess.client[0] ?? null)
          : sess.client
        : null;
      const operatorId =
        sess?.performed_by_practitioner_id ?? sess?.practitioner_id ?? null;
      return {
        blockId: b.id,
        sessionId: sess?.id ?? b.session_id,
        clientId: client?.id ?? null,
        clientName: client?.name ?? null,
        startedAt: sess?.started_at ?? null,
        modality: sess?.modality ?? null,
        areaName:
          blockAreasLabel(lotAreasByBlock.get(b.id), {
            primary_area: b.primary_area,
            side: b.side,
          }) ||
          b.block_name?.trim() ||
          `Treatment area ${b.sort_order}`,
        probeLabel: b.probe_label,
        machineFrequency: b.machine_frequency,
        operatorName: operatorId
          ? (practitionerName.get(operatorId) ?? null)
          : null,
        aftercareExplainedAt: sess?.aftercare_and_risks_explained_at ?? null,
      };
    })
    .sort((a, b) => ((a.startedAt ?? "") < (b.startedAt ?? "") ? 1 : -1));

  return {
    lot,
    sterileItems: (items ?? []) as RecordKeepingSterileItem[],
    usages,
  };
}
