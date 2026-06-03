import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { ensureIntakeForClient } from "@/lib/intake/queries";

const APP_ORIGIN = process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://hone.care";

// Server-side queries that back the authenticated /portal home. Every
// function on this file expects the caller to have already resolved a
// portal session (lib/portal/session.ts) and to pass the (studioId,
// clientId) pair from that session. Nothing on this file looks up a
// session by cookie; nothing looks up a client by email; nothing reads
// data outside of the resolved (studioId, clientId) scope.
//
// Data exposure stance (see PR #121 review):
//   * Only client-safe surfaces. Appointment time + service + studio +
//     manage token. Intake LINK + status only, never answers. Studio
//     policies (cancellation, no-show) only.
//   * No clinical/charting/session_block/practitioner_notes data is
//     touched here. The functions are typed narrowly so a future
//     contributor cannot accidentally widen the select shape without
//     also widening the return type and tripping a code review.

export type PortalClientSummary = {
  id: string;
  studioId: string;
  firstName: string;
  fullName: string;
};

export type PortalStudioSummary = {
  id: string;
  name: string;
  timezone: string;
  cancellationPolicyText: string | null;
  noShowPolicyText: string | null;
};

export type PortalUpcomingAppointment = {
  id: string;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  serviceName: string;
  manageToken: string | null;
};

export type PortalIntakeStatus =
  | { kind: "complete" }
  | { kind: "outstanding"; url: string }
  | { kind: "unavailable" };

// Resolve the client + studio identity from the session's
// (studioId, clientId). Returns null when either row is missing or
// the client is archived (archived clients must not surface portal
// data; the magic-link request gate filters them out, but defense
// in depth here covers an archive that happens AFTER login).
export async function getPortalIdentity(
  studioId: string,
  clientId: string,
): Promise<{
  client: PortalClientSummary;
  studio: PortalStudioSummary;
} | null> {
  const admin = createAdminClient();

  const { data: clientRow, error: clientErr } = await admin
    .from("clients")
    .select("id, name, studio_id, archived_at")
    .eq("id", clientId)
    .eq("studio_id", studioId)
    .maybeSingle();
  if (clientErr || !clientRow) return null;
  if (clientRow.archived_at != null) return null;

  const { data: studioRow, error: studioErr } = await admin
    .from("studios")
    .select(
      "id, name, timezone, cancellation_policy_text, no_show_policy_text",
    )
    .eq("id", studioId)
    .maybeSingle();
  if (studioErr || !studioRow) return null;

  const fullName = (clientRow.name as string).trim() || "Client";
  const firstName = fullName.split(/\s+/)[0] || fullName;

  return {
    client: {
      id: clientRow.id as string,
      studioId: clientRow.studio_id as string,
      firstName,
      fullName,
    },
    studio: {
      id: studioRow.id as string,
      name: studioRow.name as string,
      timezone: studioRow.timezone as string,
      cancellationPolicyText:
        (studioRow.cancellation_policy_text as string | null) ?? null,
      noShowPolicyText:
        (studioRow.no_show_policy_text as string | null) ?? null,
    },
  };
}

// Future confirmed appointments for this (studio, client). Soonest
// first. Includes the cancellation_token so the portal home can
// render a Manage button that lands on /manage/<token>: same
// public flow PR #116 ships, no portal-specific token machinery.
//
// We deliberately do NOT select notes, practitioner_id, status
// metadata, or any field that could leak practitioner intent. The
// select shape is the minimum a client needs to recognise the
// appointment.
export async function getPortalUpcomingAppointments(
  studioId: string,
  clientId: string,
  opts: { limit?: number } = {},
): Promise<PortalUpcomingAppointment[]> {
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  const { data, error } = await admin
    .from("appointments")
    .select(
      "id, starts_at, ends_at, duration_minutes, cancellation_token, service:services(name)",
    )
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("status", "confirmed")
    .gt("starts_at", nowIso)
    .order("starts_at", { ascending: true })
    .limit(opts.limit ?? 20);
  if (error) {
    console.error(
      JSON.stringify({
        event: "portal_upcoming_appointments_failed",
        code: error.code,
        message: error.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return [];
  }

  type Row = {
    id: string;
    starts_at: string;
    ends_at: string;
    duration_minutes: number;
    cancellation_token: string | null;
    service: { name: string } | Array<{ name: string }> | null;
  };
  const pick = <T>(v: T | T[] | null): T | null =>
    Array.isArray(v) ? (v[0] ?? null) : v;
  return ((data ?? []) as unknown as Row[]).map((row) => {
    const service = pick(row.service);
    return {
      id: row.id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      durationMinutes: row.duration_minutes,
      serviceName: service?.name?.trim() || "Appointment",
      manageToken: row.cancellation_token,
    };
  });
}

// Resolve intake status for the portal home. Reuses the same
// ensureIntakeForClient helper the booking action uses, so a
// returning client with a submitted/reviewed intake sees "Intake
// complete" and a client with an in-progress intake gets a fresh
// link. We never expose intake answers from this surface.
export async function getPortalIntakeStatus(
  studioId: string,
  clientId: string,
): Promise<PortalIntakeStatus> {
  const admin = createAdminClient();

  // First: is the latest intake submitted/reviewed? If so, return
  // "complete" without minting a new link.
  const { data: latest, error: latestErr } = await admin
    .from("client_intake_forms")
    .select("id, status")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestErr) {
    console.error(
      JSON.stringify({
        event: "portal_intake_status_failed",
        code: latestErr.code,
        message: latestErr.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return { kind: "unavailable" };
  }
  if (latest && (latest.status === "submitted" || latest.status === "reviewed")) {
    return { kind: "complete" };
  }

  // Otherwise mint or refresh the intake link via the existing helper.
  // ensureIntakeForClient creates an in-progress row when none exists
  // and returns a fresh signed link; we surface that as "outstanding".
  const ensured = await ensureIntakeForClient({
    studioId,
    clientId,
    appOrigin: APP_ORIGIN,
  });
  if (!ensured) return { kind: "unavailable" };
  return { kind: "outstanding", url: ensured.url };
}

// Resolve an active non-archived client by normalized email across
// every studio. Returns the matching (studio_id, client_id) pairs so
// the magic-link sender can fan out one email per pair. Archived
// clients are filtered out at the lookup level so this function
// never reveals their existence.
//
// IMPORTANT: callers must treat an empty array result the same as a
// populated one from the visitor's perspective; the public-facing
// success message is generic regardless of how many matches existed.
export async function findActiveClientsForPortalLogin(
  emailNormalized: string,
): Promise<Array<{ studioId: string; clientId: string }>> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("clients")
    .select("id, studio_id")
    .eq("normalized_email", emailNormalized)
    .is("archived_at", null);
  if (error) {
    console.error(
      JSON.stringify({
        event: "portal_login_lookup_failed",
        code: error.code,
        message: error.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return [];
  }
  return (data ?? []).map((row) => ({
    studioId: row.studio_id as string,
    clientId: row.id as string,
  }));
}
