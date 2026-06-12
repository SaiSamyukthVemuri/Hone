import { createClient } from "@/lib/supabase/server";
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
  }>;
};

export async function getClientProcedureRecords(
  studioId: string,
  limit = 30,
): Promise<ClientProcedureRecord[]> {
  const supabase = await createClient();
  const { data: sessions } = await supabase
    .from("sessions")
    .select(
      "id, started_at, modality, practitioner_id, performed_by_practitioner_id, aftercare_and_risks_explained_at, clients:client_id(id, name, date_of_birth, phone, email, address)",
    )
    .eq("studio_id", studioId)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (!sessions || sessions.length === 0) return [];

  const sessionIds = sessions.map((s) => s.id as string);
  const [{ data: blocks }, { data: practitioners }] = await Promise.all([
    supabase
      .from("session_blocks")
      .select(
        "session_id, sort_order, primary_area, block_name, probe_label, probe_lot_number, minutes_performed",
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
        ((b.primary_area as string | null)?.trim() ||
          (b.block_name as string | null)?.trim() ||
          `Treatment area ${b.sort_order}`) as string,
      probeLabel: (b.probe_label as string | null) ?? null,
      probeLotNumber: (b.probe_lot_number as string | null) ?? null,
      minutesPerformed: (b.minutes_performed as number | null) ?? null,
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
          "id, session_id, primary_area, block_name, sort_order, probe_label, machine_frequency, probe_lot_number, session:sessions(id, started_at, modality, client_id, aftercare_and_risks_explained_at, performed_by_practitioner_id, practitioner_id, client:clients(id, name))",
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

  type RawUsage = {
    id: string;
    session_id: string;
    primary_area: string | null;
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
          b.primary_area?.trim() ||
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
