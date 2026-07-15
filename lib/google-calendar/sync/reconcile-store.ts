import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin-server";
import type {
  ReconcileApptRow,
  ReconcileApptState,
  ReconcileLinkRow,
  ReconcileObservability,
  ReconcileStore,
  StudioReconcileResult,
} from "./reconcile";

// Google Calendar — Phase B2.3-b: the PRODUCTION ReconcileStore over the
// service-role Supabase (PostgREST) client. The admin client exposes NO raw SQL,
// so every read is a query-builder chain and every actuation is an .rpc() to the
// EXISTING repair functions. There is NO new DB function and NO migration.
//
// TENANT ISOLATION: every tenant read/write is scoped with .eq("studio_id", …)
// for a studio derived SERVER-SIDE by listEligibleStudioIds(); a browser-supplied
// id is never trusted. The two actuator RPCs are SECURITY DEFINER and derive
// authority from the row, not the caller.

type Admin = ReturnType<typeof createAdminClient>;

// PostgREST .in() lists are sent in the URL; keep each chunk small.
const IN_CHUNK = 100;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function createSupabaseReconcileStore(admin: Admin): ReconcileStore {
  return {
    async listEligibleStudioIds(): Promise<string[]> {
      // INTENT eligibility = studio outbound flag ON  ∩  an owner connection with a
      // chosen write calendar. Computed as two scoped reads intersected in app code
      // (no reliance on a PostgREST FK embed). In production the flag set is empty,
      // so the intersection — and the whole sweep — is empty.
      const [flagRes, connRes] = await Promise.all([
        admin.from("studios").select("id").eq("google_calendar_outbound_sync_enabled", true),
        admin
          .from("calendar_connections")
          .select("studio_id")
          .eq("is_studio_calendar_owner", true)
          .not("write_calendar_id", "is", null),
      ]);
      if (flagRes.error) throw flagRes.error;
      if (connRes.error) throw connRes.error;
      const flagged = new Set((flagRes.data ?? []).map((r) => r.id as string));
      const eligible = new Set<string>();
      for (const r of connRes.data ?? []) {
        const sid = r.studio_id as string;
        if (flagged.has(sid)) eligible.add(sid);
      }
      return [...eligible];
    },

    async pageConfirmedFutureAppointments(studioId, activationIso, snapshotIso, afterId, limit) {
      let q = admin
        .from("appointments")
        .select("id, sync_version")
        .eq("studio_id", studioId)
        .eq("status", "confirmed")
        .gte("ends_at", activationIso) // not-yet-ended (activation boundary)
        .lte("created_at", snapshotIso) // stable snapshot (enumeration boundary)
        .order("id", { ascending: true }) // IMMUTABLE key — never the mutable starts_at
        .limit(limit);
      if (afterId) q = q.gt("id", afterId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []).map((r): ReconcileApptRow => ({ id: r.id as string, syncVersion: Number(r.sync_version) }));
    },

    async pageActiveAppointmentLinks(studioId, afterId, limit) {
      let q = admin
        .from("calendar_event_links")
        .select("id, hone_entity_id, google_event_id, last_hone_version")
        .eq("studio_id", studioId)
        .eq("hone_entity_type", "appointment")
        .is("deleted_at", null)
        .order("id", { ascending: true }) // IMMUTABLE link id
        .limit(limit);
      if (afterId) q = q.gt("id", afterId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []).map(
        (r): ReconcileLinkRow => ({
          id: r.id as string,
          honeEntityId: r.hone_entity_id as string,
          googleEventId: (r.google_event_id as string | null) ?? null,
          lastHoneVersion: Number(r.last_hone_version),
        }),
      );
    },

    async getActiveLinksForEntities(studioId, appointmentIds) {
      const map = new Map<string, ReconcileLinkRow>();
      for (const ids of chunk(appointmentIds, IN_CHUNK)) {
        if (ids.length === 0) continue;
        const { data, error } = await admin
          .from("calendar_event_links")
          .select("id, hone_entity_id, google_event_id, last_hone_version")
          .eq("studio_id", studioId)
          .eq("hone_entity_type", "appointment")
          .is("deleted_at", null)
          .in("hone_entity_id", ids);
        if (error) throw error;
        for (const r of data ?? []) {
          map.set(r.hone_entity_id as string, {
            id: r.id as string,
            honeEntityId: r.hone_entity_id as string,
            googleEventId: (r.google_event_id as string | null) ?? null,
            lastHoneVersion: Number(r.last_hone_version),
          });
        }
      }
      return map;
    },

    async getAppointmentStates(studioId, appointmentIds) {
      const map = new Map<string, ReconcileApptState>();
      for (const ids of chunk(appointmentIds, IN_CHUNK)) {
        if (ids.length === 0) continue;
        const { data, error } = await admin
          .from("appointments")
          .select("id, status, sync_version, cancellation_kind")
          .eq("studio_id", studioId)
          .in("id", ids);
        if (error) throw error;
        for (const r of data ?? []) {
          map.set(r.id as string, {
            id: r.id as string,
            status: r.status as string,
            syncVersion: Number(r.sync_version),
            cancellationKind: (r.cancellation_kind as string | null) ?? null,
          });
        }
      }
      return map;
    },

    async getEntitiesWithOpenJobs(studioId, appointmentIds) {
      const set = new Set<string>();
      for (const ids of chunk(appointmentIds, IN_CHUNK)) {
        if (ids.length === 0) continue;
        const { data, error } = await admin
          .from("calendar_sync_outbox")
          .select("hone_entity_id")
          .eq("studio_id", studioId)
          .eq("hone_entity_type", "appointment")
          .in("hone_entity_id", ids)
          .in("status", ["pending", "processing"]);
        if (error) throw error;
        for (const r of data ?? []) if (r.hone_entity_id) set.add(r.hone_entity_id as string);
      }
      return set;
    },

    async bumpAppointmentSyncVersion(appointmentId) {
      const { data, error } = await admin.rpc("repair_bump_appointment_sync_version", {
        p_appointment_id: appointmentId,
      });
      if (error) throw error;
      return data === null || data === undefined ? null : Number(data);
    },

    async enqueueOrphanLinkDelete(linkId) {
      const { data, error } = await admin.rpc("repair_enqueue_orphan_link_delete", { p_link_id: linkId });
      if (error) throw error;
      return String(data);
    },
  };
}

// ---------------------------------------------------------------------------
// Metric-events retention (delete grant added by 0125 "= B2.3-b retention") +
// a PHI-free per-studio observability sink. Both are best-effort / fail-open.
// ---------------------------------------------------------------------------

// Bounded prune of append-only calendar_sync_metric_events older than the cutoff.
// PostgREST DELETE has no LIMIT, so we select a bounded id page then delete it.
export async function pruneMetricEvents(admin: Admin, cutoffIso: string, limit: number): Promise<number> {
  const { data, error } = await admin
    .from("calendar_sync_metric_events")
    .select("id")
    .lt("occurred_at", cutoffIso)
    .limit(Math.max(1, Math.floor(limit)));
  if (error) throw error;
  const ids = (data ?? []).map((r) => r.id as string);
  if (ids.length === 0) return 0;
  const { error: delErr } = await admin.from("calendar_sync_metric_events").delete().in("id", ids);
  if (delErr) throw delErr;
  return ids.length;
}

// Per-studio durable telemetry — records a PHI-free metric row ONLY for studios
// where the sweep did something operationally notable. safe_details carry aggregate
// counts only (never client identity, appointment content, Google id, or calendar id).
export function createReconcileObservability(admin: Admin): ReconcileObservability {
  return {
    async recordStudioResult(res: StudioReconcileResult): Promise<void> {
      try {
        if (res.enqueued > 0) {
          await admin.from("calendar_sync_metric_events").insert({
            studio_id: res.studioId,
            metric: "reconcile_enqueued",
            safe_details: {
              enqueued: res.enqueued,
              candidates: res.candidates,
              superseded: res.superseded,
              by_class: res.byClass,
              truncated: res.truncated,
            },
          });
        } else if (res.lockSkipReason === "unavailable") {
          await admin.from("calendar_sync_metric_events").insert({
            studio_id: res.studioId,
            metric: "reconcile_lock_unavailable",
            safe_details: { reason: "unavailable" },
          });
        }
      } catch {
        // Observability is fail-open; never abort the sweep.
      }
    },
  };
}
