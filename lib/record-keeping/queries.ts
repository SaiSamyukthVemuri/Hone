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
