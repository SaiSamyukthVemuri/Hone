import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";

// Google Calendar — Phase B2.3-c1: the store the event operations use to read
// link/appointment state and to invoke the transactional link-transition RPC
// (calendar_event_link_transition, migration 0132). It NEVER transitions the
// outbox row — the existing claim -> handle -> record_calendar_sync_result
// adapter remains the sole authority over outbox state. Injected so the
// operations are testable against a mock without the admin client.

export type LinkRow = {
  id: string;
  studioId: string;
  connectionId: string;
  honeEntityType: "appointment" | "timed_block";
  honeEntityId: string;
  googleCalendarId: string;
  googleEventId: string | null;
  googleIcalUid: string | null;
  googleEtag: string | null;
  lastHoneVersion: number;
  syncStatus: string;
  deletedAt: string | null;
};

export type AppointmentState = {
  id: string;
  studioId: string;
  status: "confirmed" | "cancelled" | "completed" | "no_show" | string;
  syncVersion: number;
  startsAt: string;
  endsAt: string;
  studioTimezone: string;
};

export type TransitionAction =
  | "bind_confirmed"
  | "update_confirmed"
  | "mark_deleted"
  | "rotate_for_recreate";

export type TransitionArgs = {
  action: TransitionAction;
  outboxId: string;
  claimToken: string;
  linkId: string;
  studioId: string;
  connectionId: string;
  honeEntityType: "appointment" | "timed_block";
  honeEntityId: string;
  expectedSourceVersion?: number | null;
  googleEventId?: string | null;
  googleIcalUid?: string | null;
  googleEtag?: string | null;
};

export type TransitionResult = { status: "ok" | "rejected"; code: string; linkId?: string };

export interface OpsLinkStore {
  loadActiveLinkByEntity(
    studioId: string,
    honeEntityType: "appointment" | "timed_block",
    honeEntityId: string,
  ): Promise<LinkRow | null>;
  loadLinkById(linkId: string): Promise<LinkRow | null>;
  loadAppointmentState(appointmentId: string, studioId: string): Promise<AppointmentState | null>;
  transition(args: TransitionArgs): Promise<TransitionResult>;
}

const LINK_COLUMNS =
  "id, studio_id, connection_id, hone_entity_type, hone_entity_id, google_calendar_id, google_event_id, google_ical_uid, google_etag, last_hone_version, sync_status, deleted_at";

function toLinkRow(row: Record<string, unknown>): LinkRow {
  return {
    id: row.id as string,
    studioId: row.studio_id as string,
    connectionId: row.connection_id as string,
    honeEntityType: row.hone_entity_type as LinkRow["honeEntityType"],
    honeEntityId: row.hone_entity_id as string,
    googleCalendarId: row.google_calendar_id as string,
    googleEventId: (row.google_event_id as string | null) ?? null,
    googleIcalUid: (row.google_ical_uid as string | null) ?? null,
    googleEtag: (row.google_etag as string | null) ?? null,
    lastHoneVersion: Number(row.last_hone_version ?? 0),
    syncStatus: row.sync_status as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
  };
}

export function createAdminOpsLinkStore(): OpsLinkStore {
  const admin = createAdminClient();
  return {
    async loadActiveLinkByEntity(studioId, honeEntityType, honeEntityId) {
      const { data, error } = await admin
        .from("calendar_event_links")
        .select(LINK_COLUMNS)
        .eq("studio_id", studioId)
        .eq("hone_entity_type", honeEntityType)
        .eq("hone_entity_id", honeEntityId)
        .is("deleted_at", null)
        .maybeSingle();
      if (error || !data) return null;
      return toLinkRow(data);
    },
    async loadLinkById(linkId) {
      const { data, error } = await admin
        .from("calendar_event_links")
        .select(LINK_COLUMNS)
        .eq("id", linkId)
        .maybeSingle();
      if (error || !data) return null;
      return toLinkRow(data);
    },
    async loadAppointmentState(appointmentId, studioId) {
      const { data, error } = await admin
        .from("appointments")
        .select("id, studio_id, status, sync_version, starts_at, ends_at, studios(timezone)")
        .eq("id", appointmentId)
        .eq("studio_id", studioId)
        .maybeSingle();
      if (error || !data) return null;
      const studios = (data as Record<string, unknown>).studios as { timezone?: string } | null;
      return {
        id: data.id as string,
        studioId: data.studio_id as string,
        status: data.status as string,
        syncVersion: Number((data as Record<string, unknown>).sync_version ?? 0),
        startsAt: data.starts_at as string,
        endsAt: data.ends_at as string,
        studioTimezone: (studios?.timezone as string | undefined) ?? "",
      };
    },
    async transition(args) {
      const { data, error } = await admin.rpc("calendar_event_link_transition", {
        p_action: args.action,
        p_outbox_id: args.outboxId,
        p_claim_token: args.claimToken,
        p_link_id: args.linkId,
        p_studio_id: args.studioId,
        p_connection_id: args.connectionId,
        p_hone_entity_type: args.honeEntityType,
        p_hone_entity_id: args.honeEntityId,
        p_expected_source_version: args.expectedSourceVersion ?? null,
        p_google_event_id: args.googleEventId ?? null,
        p_google_ical_uid: args.googleIcalUid ?? null,
        p_google_etag: args.googleEtag ?? null,
      });
      if (error || !data || typeof data !== "object") {
        return { status: "rejected", code: "rpc_error" };
      }
      const obj = data as { status?: string; code?: string; link_id?: string };
      return {
        status: obj.status === "ok" ? "ok" : "rejected",
        code: obj.code ?? "unknown",
        linkId: obj.link_id,
      };
    },
  };
}
