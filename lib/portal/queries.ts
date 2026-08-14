import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { ensureIntakeForClient } from "@/lib/intake/queries";
import type { ClientPortalMessage } from "@/lib/types/database";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import { generateCancellationToken } from "@/lib/booking/tokens";

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

// PR #260: appointment tokens are hashed at rest, so the raw column token
// is no longer readable here at render time. The portal mints the stateless
// HMAC token (expires at the appointment start) so the Manage button still
// lands on /manage/<token>; /manage, /cancel, and /reschedule all accept
// the HMAC fallback. Minting needs APPOINTMENT_SIGNING_SECRET; if it is
// unset we degrade to a null manageToken (the page hides the button)
// rather than throwing the whole portal home.
function safeManageToken(appointmentId: string, startsAt: string): string | null {
  try {
    return generateCancellationToken(appointmentId, new Date(startsAt));
  } catch {
    return null;
  }
}

// Future confirmed appointments for this (studio, client). Soonest
// first. The Manage token is minted (HMAC), never read from storage.
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
      "id, starts_at, ends_at, duration_minutes, service:services(name)",
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
      manageToken: safeManageToken(row.id, row.starts_at),
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
    appOrigin: getRequiredAppOrigin(),
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

// PR #129. Client-side reply row shape. Only the fields the portal UI
// actually renders are selected; the studio-facing notification_email_*
// audit columns and practitioner_seen_at are intentionally NOT
// surfaced to the portal because the client should not see whether
// the studio has read their reply yet, only that the reply was
// posted. Same scope rules as PortalMessageForClient: every read goes
// through the resolved (studioId, clientId) session pair.
export type PortalReplyForClient = {
  id: string;
  message_id: string;
  body: string;
  created_at: string;
};

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

// PR #129. Portal-side fetch of every reply the current client has
// posted across their visible messages. Returns a flat array sorted
// by created_at ascending so the portal page can render the oldest
// reply first under its parent message (the conversation reads
// top-down). Scoping is the same three-clause guard the
// markPortalMessageReviewedAction uses: studio_id + client_id +
// archived_at IS NULL. We do NOT filter by message_id here because
// the parent-list query already returned the set of visible
// messages; the portal page groups in memory.
export async function getPortalRepliesForClient(
  studioId: string,
  clientId: string,
): Promise<PortalReplyForClient[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("client_portal_message_replies")
    .select("id, message_id, body, created_at")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .is("archived_at", null)
    .order("created_at", { ascending: true });
  if (error) {
    console.error(
      JSON.stringify({
        event: "portal_replies_for_client_failed",
        code: error.code,
        message: error.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return [];
  }
  return (data ?? []) as PortalReplyForClient[];
}

// Resolve an active non-archived client by normalized email scoped
// to a single studio. Used by the studio-scoped /portal/login
// surface (?studio=<slug>). Returns 0..N matches; the caller
// (requestPortalMagicLinkAction) enforces the same single-match-
// per-studio gate the unscoped path uses on the global pool. A
// client who happens to belong to multiple studios is therefore
// reachable through whichever studio their visitor reached the
// login surface from, even when the same email exists on an
// active row in another studio. Archived clients are filtered at
// the lookup level so this function never reveals their existence.
//
// IMPORTANT: callers must treat an empty array the same as a
// populated one from the visitor's perspective; the public-facing
// success message is generic regardless of how many matches existed
// (including zero).
export async function findActiveClientsForStudioPortalLogin(
  emailNormalized: string,
  studioId: string,
): Promise<Array<{ studioId: string; clientId: string }>> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("clients")
    .select("id, studio_id")
    .eq("normalized_email", emailNormalized)
    .eq("studio_id", studioId)
    .is("archived_at", null);
  if (error) {
    console.error(
      JSON.stringify({
        event: "portal_login_studio_scoped_lookup_failed",
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

// Practitioner-side portal-access summary for a client (PR: Send portal link).
// Read-only, studio-scoped: the most recent magic link ISSUED to this client
// (client_portal_magic_links.created_at) and the last time they were seen in the
// portal (client_portal_sessions.last_seen_at). No new table: these already
// exist. Returns ISO strings or null. Never returns tokens.
export async function getPortalAccessSummary(
  studioId: string,
  clientId: string,
): Promise<{ lastLinkSentAt: string | null; lastSeenAt: string | null }> {
  const admin = createAdminClient();
  const { data: lastLink } = await admin
    .from("client_portal_magic_links")
    .select("created_at")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { data: lastSession } = await admin
    .from("client_portal_sessions")
    .select("last_seen_at")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .not("last_seen_at", "is", null)
    .order("last_seen_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return {
    lastLinkSentAt: (lastLink?.created_at as string | null) ?? null,
    lastSeenAt: (lastSession?.last_seen_at as string | null) ?? null,
  };
}

// Recent portal access/send events for a client (Portal Access PR 3).
// Studio-scoped, newest first. FAIL-SOFT: returns [] on any error, including
// the pre-migration case where client_portal_access_events does not exist yet,
// so the practitioner status card degrades gracefully. Never returns tokens.
export type PortalAccessEventRow = {
  id: string;
  eventType: string;
  channel: string | null;
  practitionerId: string | null;
  createdAt: string;
};
export async function getRecentPortalAccessEvents(
  studioId: string,
  clientId: string,
  limit = 5,
): Promise<PortalAccessEventRow[]> {
  const admin = createAdminClient();
  try {
    const { data, error } = await admin
      .from("client_portal_access_events")
      .select("id, event_type, channel, practitioner_id, created_at")
      .eq("studio_id", studioId)
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return data.map((r) => ({
      id: r.id as string,
      eventType: r.event_type as string,
      channel: (r.channel as string | null) ?? null,
      practitionerId: (r.practitioner_id as string | null) ?? null,
      createdAt: r.created_at as string,
    }));
  } catch {
    return [];
  }
}
