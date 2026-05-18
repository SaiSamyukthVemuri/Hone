import { redirect } from "next/navigation";
import { createClient } from "./server";
import type {
  ApilusModality,
  Client,
  ClientPricing,
  ElectrolysisEntry,
  ElectrolysisMode,
  LaserEntry,
  MachineFrequency,
  Modality,
  Practitioner,
  ProbeLot,
  ProbeType,
  Session,
  SessionBlock,
  Studio,
} from "@/lib/types/database";

export type PractitionerWithStudio = {
  practitioner: Practitioner;
  studio: Studio;
};

// Returns the signed-in user's active practitioner row + studio.
// Redirects to /login if no auth user, or throws if the user has no practitioner row.
export async function getCurrentPractitionerWithStudio(): Promise<PractitionerWithStudio> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data, error } = await supabase
    .from("practitioners")
    .select("*, studio:studios(*)")
    .eq("user_id", user.id)
    .eq("active", true)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load practitioner: ${error.message}`);
  }
  if (!data) {
    throw new Error("No active practitioner found for the signed-in user.");
  }

  const { studio, ...practitioner } = data as Practitioner & { studio: Studio };
  return { practitioner: practitioner as Practitioner, studio };
}

export async function getPractitionersForStudio(
  studioId: string,
): Promise<Practitioner[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("practitioners")
    .select("*")
    .eq("studio_id", studioId)
    .eq("active", true)
    .order("display_name", { ascending: true });
  if (error) throw new Error(`Failed to load practitioners: ${error.message}`);
  return (data ?? []) as Practitioner[];
}

export async function getClientsForStudio(studioId: string): Promise<Client[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clients")
    .select("*")
    .eq("studio_id", studioId)
    .order("name", { ascending: true });

  if (error) throw new Error(`Failed to load clients: ${error.message}`);
  return (data ?? []) as Client[];
}

export type SessionWithEntries = Session & {
  electrolysis_entries: ElectrolysisEntry[];
  laser_entries: LaserEntry[];
};

export type ClientCheatSheet = {
  client: Client;
  pricing: ClientPricing[];
  sessions: SessionWithEntries[];
  practitioners: Practitioner[];
};

// Resolves the human-readable name of who performed a session,
// preferring performed_by_practitioner_id but falling back to the creator.
export function sessionPerformerName(
  session: Pick<Session, "performed_by_practitioner_id" | "practitioner_id">,
  practitioners: Practitioner[],
): string | null {
  const id = session.performed_by_practitioner_id ?? session.practitioner_id;
  if (!id) return null;
  const match = practitioners.find((p) => p.id === id);
  if (!match) return null;
  return match.display_name?.trim() ? match.display_name : match.email;
}

export async function getClientById(
  studioId: string,
  clientId: string,
): Promise<ClientCheatSheet | null> {
  const supabase = await createClient();

  const { data: client, error: clientErr } = await supabase
    .from("clients")
    .select("*")
    .eq("studio_id", studioId)
    .eq("id", clientId)
    .maybeSingle();

  if (clientErr) throw new Error(`Failed to load client: ${clientErr.message}`);
  if (!client) return null;

  const [pricingRes, sessionsRes, practitioners] = await Promise.all([
    supabase
      .from("client_pricing")
      .select("*")
      .eq("studio_id", studioId)
      .eq("client_id", clientId)
      .order("effective_from", { ascending: false }),
    supabase
      .from("sessions")
      .select("*, electrolysis_entries(*), laser_entries(*)")
      .eq("studio_id", studioId)
      .eq("client_id", clientId)
      .is("deleted_at", null)
      .order("started_at", { ascending: false }),
    getPractitionersForStudio(studioId),
  ]);

  if (pricingRes.error)
    throw new Error(`Failed to load pricing: ${pricingRes.error.message}`);
  if (sessionsRes.error)
    throw new Error(`Failed to load sessions: ${sessionsRes.error.message}`);

  return {
    client: client as Client,
    pricing: (pricingRes.data ?? []) as ClientPricing[],
    sessions: (sessionsRes.data ?? []) as SessionWithEntries[],
    practitioners,
  };
}

export async function getSessionForClient(
  studioId: string,
  clientId: string,
  sessionId: string,
): Promise<SessionWithEntries | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sessions")
    .select("*, electrolysis_entries(*), laser_entries(*)")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("id", sessionId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) throw new Error(`Failed to load session: ${error.message}`);
  return (data ?? null) as SessionWithEntries | null;
}

export async function getRecentEntryForClient(
  studioId: string,
  clientId: string,
  modality: Modality,
): Promise<ElectrolysisEntry | LaserEntry | null> {
  const supabase = await createClient();
  const entryTable =
    modality === "electrolysis" ? "electrolysis_entries" : "laser_entries";

  // Find the most recent session for this client/modality and pull its latest entry.
  const { data: sessionRows, error: sessErr } = await supabase
    .from("sessions")
    .select(`id, ${entryTable}(*)`)
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("modality", modality)
    .is("deleted_at", null)
    .order("started_at", { ascending: false })
    .limit(10);

  if (sessErr) throw new Error(`Failed to load recent session: ${sessErr.message}`);

  for (const row of sessionRows ?? []) {
    const entries = (row as unknown as { [k: string]: (ElectrolysisEntry | LaserEntry)[] })[
      entryTable
    ];
    if (entries && entries.length > 0) {
      // Sessions return entries in insertion order; take the latest.
      const sorted = [...entries].sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
      return sorted[0];
    }
  }
  return null;
}

// Counts past laser entries for this client grouped by zone, across all sessions
// (including any in-progress one). Used to auto-suggest the next "Treatment #".
export async function getLaserTreatmentCountsForClient(
  studioId: string,
  clientId: string,
): Promise<Record<string, number>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sessions")
    .select("id, laser_entries(zone)")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("modality", "laser")
    .is("deleted_at", null);

  if (error)
    throw new Error(`Failed to load laser treatment counts: ${error.message}`);

  const counts: Record<string, number> = {};
  for (const row of data ?? []) {
    const entries = (row as unknown as { laser_entries: { zone: string }[] })
      .laser_entries;
    for (const e of entries ?? []) {
      counts[e.zone] = (counts[e.zone] ?? 0) + 1;
    }
  }
  return counts;
}

export async function getSessionAudit(
  sessionId: string,
): Promise<import("@/lib/types/database").SessionAudit[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("session_audit")
    .select("*")
    .eq("session_id", sessionId)
    .order("edited_at", { ascending: true });
  if (error) throw new Error(`Failed to load session audit: ${error.message}`);
  return (data ?? []) as import("@/lib/types/database").SessionAudit[];
}

export async function getActiveProbeLots(studioId: string): Promise<ProbeLot[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("probe_lots")
    .select("*")
    .eq("studio_id", studioId)
    .eq("active", true)
    .order("probe_size", { ascending: true });

  if (error) throw new Error(`Failed to load probe lots: ${error.message}`);
  return (data ?? []) as ProbeLot[];
}

// Returns clients with a session that started today (in the studio's timezone, naive: server time).
export async function getTodayRosterForStudio(studioId: string): Promise<
  Array<{ client: Client; sessions: Session[] }>
> {
  const supabase = await createClient();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);

  const { data, error } = await supabase
    .from("sessions")
    .select("*, client:clients(*)")
    .eq("studio_id", studioId)
    .is("deleted_at", null)
    .gte("started_at", start.toISOString())
    .lte("started_at", end.toISOString())
    .order("started_at", { ascending: true });

  if (error) throw new Error(`Failed to load today's roster: ${error.message}`);

  const grouped = new Map<string, { client: Client; sessions: Session[] }>();
  for (const row of data ?? []) {
    const { client, ...session } = row as Session & { client: Client };
    if (!client) continue;
    const existing = grouped.get(client.id);
    if (existing) {
      existing.sessions.push(session as Session);
    } else {
      grouped.set(client.id, { client, sessions: [session as Session] });
    }
  }
  return Array.from(grouped.values());
}

// Migration 0019: session block helpers.
// 17.5b.2 will use these to render blocks in the UI. They exist now so the
// query layer is complete and the new shape is reviewable in isolation.

export type SessionBlockWithEntries = SessionBlock & {
  electrolysis_entries: ElectrolysisEntry[];
};

export type SessionWithBlocks = {
  session: Session;
  blocks: SessionBlockWithEntries[];
  // Entries that somehow don't have a block_id, returned separately so the
  // UI can flag them. Expected to be empty after 0020 backfills and new
  // inserts go through ensureEntryHasBlock().
  orphan_entries: ElectrolysisEntry[];
};

// Returns all non-deleted blocks for a session, ordered by sort_order.
export async function getSessionBlocks(
  sessionId: string,
): Promise<SessionBlock[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("session_blocks")
    .select("*")
    .eq("session_id", sessionId)
    .is("deleted_at", null)
    .order("sort_order", { ascending: true });
  if (error) throw new Error(`Failed to load session blocks: ${error.message}`);
  return (data ?? []) as SessionBlock[];
}

export async function getSessionBlockById(
  blockId: string,
): Promise<SessionBlock | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("session_blocks")
    .select("*")
    .eq("id", blockId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(`Failed to load block: ${error.message}`);
  return (data ?? null) as SessionBlock | null;
}

// Fetches a session plus all its non-deleted blocks and the electrolysis
// entries grouped under each block. Laser entries are out of scope for the
// blocks restructure (blocks model electrolysis treatment-level params).
export async function getSessionWithBlocks(
  sessionId: string,
): Promise<SessionWithBlocks | null> {
  const supabase = await createClient();

  const [sessionRes, blocksRes, entriesRes] = await Promise.all([
    supabase
      .from("sessions")
      .select("*")
      .eq("id", sessionId)
      .is("deleted_at", null)
      .maybeSingle(),
    supabase
      .from("session_blocks")
      .select("*")
      .eq("session_id", sessionId)
      .is("deleted_at", null)
      .order("sort_order", { ascending: true }),
    supabase
      .from("electrolysis_entries")
      .select("*")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true }),
  ]);

  if (sessionRes.error)
    throw new Error(`Failed to load session: ${sessionRes.error.message}`);
  if (blocksRes.error)
    throw new Error(`Failed to load blocks: ${blocksRes.error.message}`);
  if (entriesRes.error)
    throw new Error(`Failed to load entries: ${entriesRes.error.message}`);
  if (!sessionRes.data) return null;

  const session = sessionRes.data as Session;
  const blocks = (blocksRes.data ?? []) as SessionBlock[];
  const entries = (entriesRes.data ?? []) as ElectrolysisEntry[];

  const byBlock = new Map<string, ElectrolysisEntry[]>();
  const orphan: ElectrolysisEntry[] = [];
  for (const e of entries) {
    if (e.block_id) {
      const bucket = byBlock.get(e.block_id) ?? [];
      bucket.push(e);
      byBlock.set(e.block_id, bucket);
    } else {
      orphan.push(e);
    }
  }

  const blocksWithEntries: SessionBlockWithEntries[] = blocks.map((b) => ({
    ...b,
    electrolysis_entries: byBlock.get(b.id) ?? [],
  }));

  return { session, blocks: blocksWithEntries, orphan_entries: orphan };
}

// Resolved treatment params for an entry: prefers block-level values and
// falls back to entry-level for backwards compatibility. During the
// 17.5b.1 -> 17.5b.2 transition, every entry has a block (via the 0020
// backfill or ensureEntryHasBlock for new rows). After the duplicate
// columns are dropped from electrolysis_entries in a future cleanup
// session, the fallback layer goes away.
export type TreatmentParams = {
  mode: ElectrolysisMode | null;
  apilus_modality: ApilusModality | null;
  energy_level: number | null;
  minutes_performed: number | null;
  probe_type: ProbeType | null;
  probe_size: string | null;
  machine_frequency: MachineFrequency | null;
};

export function resolveTreatmentParams(
  entry: ElectrolysisEntry,
  block: SessionBlock | null,
): TreatmentParams {
  return {
    mode: block?.mode ?? entry.mode,
    apilus_modality: block?.apilus_modality ?? entry.apilus_modality,
    energy_level: block?.energy_level ?? entry.energy_level,
    minutes_performed: block?.minutes_performed ?? entry.minutes_performed,
    probe_type: block?.probe_type ?? entry.probe_type,
    probe_size: block?.probe_size ?? entry.probe_size,
    machine_frequency: block?.machine_frequency ?? entry.machine_frequency,
  };
}
