import { createClient } from "@/lib/supabase/server";
import { getSessionBlockAreasByBlockIds } from "@/lib/supabase/queries";
import { blockAreasLabel } from "@/lib/sessions/block-areas";
import {
  normalizeProbeLabel,
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
    .select("id, probe_key, lot_number, item_description, manufacturer_name, expiry_date")
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
  }>).map((r) => ({
    id: r.id,
    probeKey: r.probe_key,
    lotNumber: (r.lot_number ?? "").trim(),
    itemDescription: r.item_description ?? "",
    manufacturerName: r.manufacturer_name ?? null,
    expiryDate: r.expiry_date,
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
  ) => {
    const previous = seenAt[slot];
    if (previous !== undefined && previous >= createdAt) return;
    seenAt[slot] = createdAt;
    map[slot].lastCharted = lot;
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
      seedLastCharted(byKey, lastChartedAtByKey, key, lot, createdAt);
    }
    const label = normalizeProbeLabel(row.probe_label as string | null);
    if (label) {
      seedFirst(byLabel, label, lot, confirmed, inventoryItemId);
      seedLastCharted(byLabel, lastChartedAtByLabel, label, lot, createdAt);
    }
  }
  return { byKey, byLabel };
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

export async function getAuditEventsByRecord(
  studioId: string,
  recordType: RecordKeepingAuditEvent["record_type"],
  recordIds: string[],
): Promise<Map<string, RecordKeepingAuditEvent[]>> {
  const grouped = new Map<string, RecordKeepingAuditEvent[]>();
  if (recordIds.length === 0) return grouped;
  const supabase = await createClient();
  const { data } = await supabase
    .from("record_keeping_audit_events")
    .select("*")
    .eq("studio_id", studioId)
    .eq("record_type", recordType)
    .in("record_id", recordIds)
    .order("created_at", { ascending: false })
    .limit(500);
  for (const row of (data ?? []) as RecordKeepingAuditEvent[]) {
    const list = grouped.get(row.record_id) ?? [];
    list.push(row);
    grouped.set(row.record_id, list);
  }
  return grouped;
}

// Procedure-record history: aftercare events keyed by session id, and
// probe-lot events keyed by the session id carried in metadata.
export async function getProcedureAuditEvents(
  studioId: string,
  sessionIds: string[],
): Promise<Map<string, RecordKeepingAuditEvent[]>> {
  const grouped = new Map<string, RecordKeepingAuditEvent[]>();
  if (sessionIds.length === 0) return grouped;
  const supabase = await createClient();
  const { data } = await supabase
    .from("record_keeping_audit_events")
    .select("*")
    .eq("studio_id", studioId)
    .in("record_type", ["session_aftercare", "session_block_probe_lot"])
    .order("created_at", { ascending: false })
    .limit(500);
  const wanted = new Set(sessionIds);
  for (const row of (data ?? []) as RecordKeepingAuditEvent[]) {
    const sessionId =
      row.record_type === "session_aftercare"
        ? row.record_id
        : ((row.metadata?.session_id as string | undefined) ?? "");
    if (!wanted.has(sessionId)) continue;
    const list = grouped.get(sessionId) ?? [];
    list.push(row);
    grouped.set(sessionId, list);
  }
  return grouped;
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
