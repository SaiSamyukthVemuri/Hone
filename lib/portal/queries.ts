import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { ensureIntakeForClient } from "@/lib/intake/queries";
import type { ClientPortalMessage } from "@/lib/types/database";

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
  // Postcare fields the studio configured (same source the postcare
  // email renders from; we never invent a new postcare store). All
  // nullable: empty fields render nothing on the portal home.
  postcareAftercareText: string | null;
  postcareWarningSignsText: string | null;
  postcareProductRecommendationsText: string | null;
  postcareReviewUrl: string | null;
  postcareReviewPromptText: string | null;
  // Studio business contact email surfaced by the portal Contact
  // button. Reuses the same field that postcare emails fall back to
  // for "reply to" so we never hardcode a personal address. Null
  // means no contact button.
  postcareContactEmail: string | null;
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
      "id, name, timezone, cancellation_policy_text, no_show_policy_text, postcare_aftercare_text, postcare_warning_signs_text, postcare_product_recommendations_text, postcare_review_url, postcare_review_prompt_text, postcare_contact_email",
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
      postcareAftercareText:
        (studioRow.postcare_aftercare_text as string | null) ?? null,
      postcareWarningSignsText:
        (studioRow.postcare_warning_signs_text as string | null) ?? null,
      postcareProductRecommendationsText:
        (studioRow.postcare_product_recommendations_text as string | null) ??
        null,
      postcareReviewUrl:
        (studioRow.postcare_review_url as string | null) ?? null,
      postcareReviewPromptText:
        (studioRow.postcare_review_prompt_text as string | null) ?? null,
      postcareContactEmail:
        (studioRow.postcare_contact_email as string | null) ?? null,
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

// Pre-care instruction strings for the client's upcoming
// appointments. Service-level field (services.pre_care_instructions);
// the portal home groups by service name so a client with multiple
// upcoming appointments of the same service sees one entry. Empty /
// null pre-care strings are omitted at the source so an empty
// services row never produces a blank card.
//
// Scoped to (studioId, clientId) and to status=confirmed + future,
// matching the upcoming-appointments query. No clinical, charting,
// or treatment-plan fields are read.
export type PortalPreCareEntry = {
  serviceName: string;
  preCareText: string;
};

export async function getPortalUpcomingPreCare(
  studioId: string,
  clientId: string,
): Promise<PortalPreCareEntry[]> {
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  // Select only the columns we need to render pre-care; no notes,
  // practitioner_id, or treatment_plan_id are touched.
  const { data, error } = await admin
    .from("appointments")
    .select(
      "service:services(id, name, pre_care_instructions)",
    )
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("status", "confirmed")
    .gt("starts_at", nowIso)
    .order("starts_at", { ascending: true });
  if (error) {
    console.error(
      JSON.stringify({
        event: "portal_pre_care_failed",
        code: error.code,
        message: error.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return [];
  }

  type Row = {
    service:
      | { id: string; name: string; pre_care_instructions: string | null }
      | Array<{ id: string; name: string; pre_care_instructions: string | null }>
      | null;
  };
  const pick = <T>(v: T | T[] | null): T | null =>
    Array.isArray(v) ? (v[0] ?? null) : v;

  const byServiceId = new Map<string, PortalPreCareEntry>();
  for (const row of ((data ?? []) as unknown as Row[])) {
    const service = pick(row.service);
    if (!service) continue;
    const text = service.pre_care_instructions?.trim();
    if (!text) continue;
    if (byServiceId.has(service.id)) continue;
    byServiceId.set(service.id, {
      serviceName: service.name?.trim() || "Appointment",
      preCareText: text,
    });
  }
  return Array.from(byServiceId.values());
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

// Secure portal messages visible to this client on this studio.
// Filters published + non-archived; the partial index
// client_portal_messages_unreviewed_idx (migration 0053) keeps the
// common "any unreviewed?" lookup cheap. We deliberately do NOT
// pull notification_email_* fields; those are practitioner-side
// audit and never reach the client surface.
//
// Scoped strictly by (studioId, clientId). The portal page resolves
// both from getCurrentPortalSession() and passes them in; callers
// must never accept these from the URL or from form data.
export type PortalMessageForClient = Pick<
  ClientPortalMessage,
  | "id"
  | "subject"
  | "body"
  | "published_at"
  | "client_reviewed_at"
>;

export async function getPortalMessagesForClient(
  studioId: string,
  clientId: string,
): Promise<PortalMessageForClient[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("client_portal_messages")
    .select("id, subject, body, published_at, client_reviewed_at")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("status", "published")
    .is("archived_at", null)
    .order("published_at", { ascending: false });
  if (error) {
    console.error(
      JSON.stringify({
        event: "portal_messages_for_client_failed",
        code: error.code,
        message: error.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return [];
  }
  return (data ?? []) as PortalMessageForClient[];
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
