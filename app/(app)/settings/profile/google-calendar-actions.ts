"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  OAUTH_NONCE_COOKIE,
  OAUTH_STATE_TTL_SECONDS,
  getGoogleOAuthClient,
} from "@/lib/google-calendar/config";
import {
  decryptGoogleSecret,
  isGoogleTokenCryptoConfigured,
} from "@/lib/google-calendar/token-crypto";
import {
  buildAuthorizationUrl,
  fetchCalendarList,
  refreshAccessToken,
  revokeToken,
  type GoogleCalendarListEntry,
} from "@/lib/google-calendar/oauth";
import { createOAuthState } from "@/lib/google-calendar/state";
import {
  designateStudioCalendarOwner,
  disconnectConnection,
  getOwnConnectionMetadata,
  getRefreshTokenCiphertext,
  markReconnectRequired,
  setWriteCalendar,
} from "@/lib/google-calendar/connection";

// Google Calendar — Phase A server actions (connect / disconnect / calendar
// selection / owner designation). Every action:
//   * runs authenticated (getCurrentPractitionerWithStudio),
//   * enforces the studio flag SERVER-SIDE (UI gating alone is insufficient),
//   * never returns a token/secret to the client,
//   * fails closed when crypto/OAuth env is not configured.
// No event sync happens here — Phase A is connection foundation only.

type StartResult = { ok: true; url: string } | { ok: false; error: string };
type SimpleResult = { ok: true } | { ok: false; error: string };
type CalendarsResult =
  | { ok: true; calendars: GoogleCalendarListEntry[] }
  | { ok: false; error: string; reconnectRequired?: boolean };

// Shared gate: resolve the actor + require the connection flag. Returns the
// practitioner/studio context or a typed error (never throws to the client).
async function requireConnectionContext() {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (studio.google_calendar_connection_enabled !== true) {
    return { ok: false as const, error: "Google Calendar is not enabled for this studio." };
  }
  if (!practitioner.active) {
    return { ok: false as const, error: "Inactive practitioners cannot manage a connection." };
  }
  return { ok: true as const, practitioner, studio };
}

export async function startGoogleCalendarConnectAction(): Promise<StartResult> {
  const ctx = await requireConnectionContext();
  if (!ctx.ok) return { ok: false, error: ctx.error };
  const { practitioner, studio } = ctx;

  // Fail closed if the integration is not provisioned (missing key / client).
  if (!isGoogleTokenCryptoConfigured() || !getGoogleOAuthClient()) {
    return { ok: false, error: "Google Calendar sync is not configured yet. Contact support." };
  }

  const existing = await getOwnConnectionMetadata(studio.id, practitioner.id);
  // Force consent only when we need a fresh refresh token: first connect, or a
  // grant that is missing/reconnect-required/revoked. A healthy reconnect does
  // not force consent (Google will reuse the existing grant; we preserve the
  // stored refresh token if it withholds a new one).
  const forceConsent =
    !existing ||
    existing.connectionStatus === "reconnect_required" ||
    existing.connectionStatus === "revoked" ||
    existing.connectionStatus === "disconnected";

  const state = await createOAuthState({
    studioId: studio.id,
    practitionerId: practitioner.id,
    userId: practitioner.user_id ?? "",
    redirectPath: "/settings/profile",
  });
  if (!state.ok) {
    return { ok: false, error: "Could not start the Google connection. Please try again." };
  }

  const url = buildAuthorizationUrl({
    state: state.state,
    codeChallenge: state.codeChallenge,
    loginHint: existing?.googleAccountEmail ?? undefined,
    forceConsent,
  });
  if (!url) return { ok: false, error: "Google Calendar sync is not configured yet." };

  // httpOnly nonce cookie for the double-submit callback binding. SameSite=Lax
  // (NOT Strict) so it is sent on Google's top-level cross-site redirect back.
  const jar = await cookies();
  jar.set({
    name: OAUTH_NONCE_COOKIE,
    value: state.nonce,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: OAUTH_STATE_TTL_SECONDS,
  });

  return { ok: true, url };
}

export async function disconnectGoogleCalendarAction(): Promise<SimpleResult> {
  const ctx = await requireConnectionContext();
  if (!ctx.ok) return { ok: false, error: ctx.error };
  const { practitioner, studio } = ctx;

  // Best-effort revoke at Google BEFORE destroying local state, so we never
  // orphan a live grant. If revoke fails we still proceed to clear locally
  // (the token is destroyed regardless) — a failed revoke is logged, not fatal.
  const ciphertext = await getRefreshTokenCiphertext(studio.id, practitioner.id);
  if (ciphertext) {
    const dec = decryptGoogleSecret(ciphertext);
    if (dec.ok) {
      await revokeToken(dec.secret);
    }
  }
  await disconnectConnection(studio.id, practitioner.id);
  revalidatePath("/settings/profile");
  return { ok: true };
}

// List the connection's Google calendars (writer role) for selection. Re-mints
// an access token from the stored refresh token; never returns the token.
export async function listWritableCalendarsAction(): Promise<CalendarsResult> {
  const ctx = await requireConnectionContext();
  if (!ctx.ok) return { ok: false, error: ctx.error };
  const { practitioner, studio } = ctx;

  const ciphertext = await getRefreshTokenCiphertext(studio.id, practitioner.id);
  if (!ciphertext) {
    return { ok: false, error: "No connected Google account.", reconnectRequired: true };
  }
  const dec = decryptGoogleSecret(ciphertext);
  if (!dec.ok) {
    await markReconnectRequired(studio.id, practitioner.id, "decrypt_failed");
    return { ok: false, error: "Could not read the connection. Please reconnect.", reconnectRequired: true };
  }
  const refreshed = await refreshAccessToken(dec.secret);
  if (!refreshed.ok) {
    if (refreshed.invalidGrant) {
      await markReconnectRequired(studio.id, practitioner.id, "invalid_grant");
      return { ok: false, error: "Google access was revoked. Please reconnect.", reconnectRequired: true };
    }
    return { ok: false, error: "Couldn't reach Google. Please try again." };
  }
  const list = await fetchCalendarList(refreshed.accessToken);
  if (!list.ok) return { ok: false, error: "Couldn't load your Google calendars." };
  return { ok: true, calendars: list.calendars };
}

// Validate the chosen calendar id against Google's OWN list for this connection
// (never trust an arbitrary browser-supplied id), then store it.
export async function selectWriteCalendarAction(formData: FormData): Promise<SimpleResult> {
  const ctx = await requireConnectionContext();
  if (!ctx.ok) return { ok: false, error: ctx.error };
  const { practitioner, studio } = ctx;

  const calendarId = formData.get("calendar_id");
  if (typeof calendarId !== "string" || !calendarId) {
    return { ok: false, error: "Choose a calendar." };
  }

  const list = await listWritableCalendarsAction();
  if (!list.ok) return { ok: false, error: list.error };
  const allowed = list.calendars.some((c) => c.id === calendarId);
  if (!allowed) {
    return { ok: false, error: "That calendar isn't available on your connected account." };
  }

  await setWriteCalendar(studio.id, practitioner.id, calendarId);
  revalidatePath("/settings/profile");
  return { ok: true };
}

// Owner-only: designate the caller's own connection as the studio's calendar
// owner (Phase A single-practitioner reality; a later phase generalizes to
// selecting among multiple practitioners). Requires a connected account.
export async function designateSelfAsCalendarOwnerAction(): Promise<SimpleResult> {
  const ctx = await requireConnectionContext();
  if (!ctx.ok) return { ok: false, error: ctx.error };
  const { practitioner, studio } = ctx;
  if (practitioner.role !== "owner") {
    return { ok: false, error: "Only the studio owner can set the calendar owner." };
  }
  const existing = await getOwnConnectionMetadata(studio.id, practitioner.id);
  if (!existing || existing.connectionStatus !== "connected") {
    return { ok: false, error: "Connect your Google account first." };
  }
  await designateStudioCalendarOwner(studio.id, practitioner.id);
  revalidatePath("/settings/profile");
  return { ok: true };
}
