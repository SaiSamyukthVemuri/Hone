"use server";

import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { verifyCancellationToken } from "@/lib/booking/tokens";
import { hashAppointmentToken } from "@/lib/booking/appointment-token";
import { limitTokenRoute, RATE_LIMIT_MESSAGE } from "@/lib/rate-limit/public";
// EMERG-01. /manage mutates nothing, so this is not an authority boundary —
// the four reschedule actions own that. It is however the button a client
// actually taps from a confirmation or reminder message, and offering
// "Reschedule appointment" to someone /reschedule will then refuse is the same
// dead end, one screen earlier. Same decision, same server-resolved inputs.
import { isFreeConsultWaitlistOnlyReschedule } from "@/lib/booking/free-consult-reschedule-policy";

// Generic public-facing message for the /manage surface. Returned for
// any non-success outcome so the existence of a real appointment row
// cannot be probed by comparing error shapes. Matches the same
// collapse stance used by /cancel and /reschedule; the wording is
// scoped to "manage link" so the user sees a coherent message.
const PUBLIC_MANAGE_GENERIC_ERROR =
  "This manage link can't be used right now.";

function logInternal(event: string, detail: unknown) {
  try {
    console.error(
      JSON.stringify({
        event,
        detail,
        timestamp: new Date().toISOString(),
      }),
    );
  } catch {
    console.error(event, detail);
  }
}

// Same hash-or-HMAC resolver pattern used by the cancel surface so the
// manage link works for both the hashed at-rest token (PR #260; the raw
// URL token is hashed and matched against cancellation_token_hash) and
// any HMAC-based links a client may hold in an email. As of PR #260 the
// reschedule surface ALSO accepts the HMAC fallback, so the Reschedule
// button on a manage page reached via an HMAC link (portal / reminder /
// internal confirmation) now resolves too: the previous column-only
// asymmetry is gone. We intentionally do not export this resolver; the
// manage surface is the only caller and a shared helper would broaden
// the import graph without a need.
async function resolveAppointmentIdFromToken(
  token: string,
): Promise<
  | { ok: true; appointment_id: string }
  | { ok: false; error: "expired" | "invalid" }
> {
  if (!token) return { ok: false, error: "invalid" };

  const admin = createAdminClient();
  // PR #260: hash the incoming raw URL token and match the at-rest hash.
  const { data: byColumn } = await admin
    .from("appointments")
    .select("id")
    .eq("cancellation_token_hash", hashAppointmentToken(token))
    .maybeSingle();
  if (byColumn) {
    return { ok: true, appointment_id: byColumn.id };
  }

  const v = verifyCancellationToken(token);
  if (v.ok) return { ok: true, appointment_id: v.appointment_id };
  return { ok: false, error: v.error === "expired" ? "expired" : "invalid" };
}

// Public-facing summary for the manage page. Only fields the visitor
// already needs to recognise the appointment plus the two policy
// strings used by the reminder card. Deliberately omits address,
// client name, practitioner identifying details, and appointment id
// to match the same minimal-leak stance as the cancel and reschedule
// fetchers.
export type ManageSummary = {
  studioName: string;
  studioTimezone: string;
  serviceName: string;
  startsAt: string;
  cancellationPolicyText: string | null;
  noShowPolicyText: string | null;
  // EMERG-01. SERVER-DERIVED, presentation only: true when /reschedule will
  // refuse this appointment. The page withdraws the reschedule CTA rather than
  // linking into a refusal. Cancellation is unaffected and still offered.
  freeConsultationWaitlistOnly: boolean;
};

export type FetchManageResult =
  | { ok: true; summary: ManageSummary }
  | { ok: false; error: string };

export async function fetchAppointmentForManageAction(
  token: string,
): Promise<FetchManageResult> {
  // Rate limit at the view tier (looser than submit). The token is
  // never consumed by /manage; this surface is read-only.
  const gate = await limitTokenRoute({
    routeClass: "cancel_view",
    token,
    headers: await headers(),
  });
  if (!gate.allowed) return { ok: false, error: RATE_LIMIT_MESSAGE };

  const resolved = await resolveAppointmentIdFromToken(token);
  if (!resolved.ok) {
    // Collapse rule: malformed / unknown / expired all return the
    // same generic public message. No distinct "expired" string is
    // exposed.
    return { ok: false, error: PUBLIC_MANAGE_GENERIC_ERROR };
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("appointments")
    .select(
      // EMERG-01 adds the studio slug and the service's modality + price so
      // the policy is derived from the same row this page renders.
      "id, status, starts_at, studio:studios(name, slug, timezone, cancellation_policy_text, no_show_policy_text), service:services(name, modality, price_cents)",
    )
    .eq("id", resolved.appointment_id)
    .maybeSingle();
  if (error) {
    logInternal("public_manage_fetch_error", {
      code: error.code,
      message: error.message,
    });
    return { ok: false, error: PUBLIC_MANAGE_GENERIC_ERROR };
  }
  if (!data) return { ok: false, error: PUBLIC_MANAGE_GENERIC_ERROR };

  type JoinedStudio = {
    name: string;
    slug: string | null;
    timezone: string;
    cancellation_policy_text: string | null;
    no_show_policy_text: string | null;
  };
  type JoinedService = {
    name: string;
    modality: string | null;
    price_cents: number | null;
  };
  type Joined = {
    id: string;
    status: string;
    starts_at: string;
    studio: JoinedStudio | JoinedStudio[] | null;
    service: JoinedService | JoinedService[] | null;
  };
  const row = data as unknown as Joined;

  // Collapse rule (same as cancel/reschedule): only a future
  // confirmed appointment can flow through. Any other status
  // (cancelled / completed / no_show / unknown) and any past start
  // time collapses to the same generic payload, so a probing visitor
  // cannot tell whether the token is valid-but-now-ineligible vs.
  // unknown.
  const startsAtMs = new Date(row.starts_at).getTime();
  const isManageable =
    row.status === "confirmed" &&
    Number.isFinite(startsAtMs) &&
    startsAtMs > Date.now();
  if (!isManageable) {
    return { ok: false, error: PUBLIC_MANAGE_GENERIC_ERROR };
  }

  const pick = <T,>(v: T | T[] | null): T | null =>
    Array.isArray(v) ? (v[0] ?? null) : v;
  const studio = pick(row.studio);
  const service = pick(row.service);

  return {
    ok: true,
    summary: {
      studioName: studio?.name ?? "studio",
      studioTimezone: studio?.timezone ?? "UTC",
      serviceName: service?.name ?? "Appointment",
      startsAt: row.starts_at,
      cancellationPolicyText: studio?.cancellation_policy_text ?? null,
      noShowPolicyText: studio?.no_show_policy_text ?? null,
      // EMERG-01. Derived AFTER the collapse rule above, so a token that did
      // not resolve to a future confirmed appointment never reaches it and the
      // policy stays invisible to a probing caller. The slug is consumed here
      // and never returned: this surface has no waitlist CTA to build.
      freeConsultationWaitlistOnly: isFreeConsultWaitlistOnlyReschedule({
        studioSlug: studio?.slug ?? null,
        service,
      }),
    },
  };
}
