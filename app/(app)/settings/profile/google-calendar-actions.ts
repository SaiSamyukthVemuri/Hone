"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  OAUTH_NONCE_COOKIE,
  OAUTH_STATE_TTL_SECONDS,
  getGoogleOAuthClient,
  safeReturnPath,
} from "@/lib/google-calendar/config";
import {
  hasRequiredEventScopes,
  isCalendarDestinationMode,
  requiredEventScopeFor,
  requiredEventScopesForDestination,
} from "@/lib/google-calendar/destination-scopes";
import {
  decryptGoogleSecret,
  isGoogleTokenCryptoConfigured,
} from "@/lib/google-calendar/token-crypto";
import {
  buildAuthorizationUrl,
  createSecondaryCalendar,
  fetchCalendarList,
  findCalendarsByDescriptionToken,
  randomUrlToken,
  refreshAccessToken,
  revokeToken,
  type GoogleCalendarListEntry,
} from "@/lib/google-calendar/oauth";
import { createOAuthState } from "@/lib/google-calendar/state";
import {
  beginDedicatedProvisioningAttempt,
  designateStudioCalendarOwner,
  disconnectConnection,
  getOwnConnectionMetadata,
  getRefreshTokenCiphertext,
  markDedicatedProvisioningAmbiguous,
  markReconnectRequired,
  setDedicatedCalendarDestination,
  setDestinationMode,
  setOwnedCalendarDestination,
  setWriteCalendar,
} from "@/lib/google-calendar/connection";

// Google Calendar — Phase A + B2.2 + B2.4 server actions. Every action:
//   * runs authenticated (getCurrentPractitionerWithStudio),
//   * enforces the studio connection flag SERVER-SIDE (UI gating alone is
//     insufficient),
//   * DESTINATION actions additionally require the studio OWNER role,
//   * never returns a token/secret to the client,
//   * fails closed when crypto/OAuth env is not configured.
// NO event sync happens here — B2.4 is destination SETUP only. Nothing enqueues,
// syncs, or turns on the outbound flag / worker.

type StartResult = { ok: true; url: string } | { ok: false; error: string };
type SimpleResult = { ok: true } | { ok: false; error: string };
type CalendarsResult =
  | { ok: true; calendars: GoogleCalendarListEntry[] }
  | { ok: false; error: string; reconnectRequired?: boolean };

// The fixed display name of the secondary calendar Hone creates for the dedicated
// destination. Human-readable only; never contains PHI / account data.
const DEDICATED_CALENDAR_NAME = "Hone Appointments";
// A machine-readable, NON-SENSITIVE marker embedded in a created calendar's
// description so an ambiguous provider response can be reconciled by EXACT token.
const PROVISIONING_MARKER_PREFIX = "hone-provisioning-attempt:";
function provisioningDescription(attemptToken: string): string {
  return `Created by Hone for appointment scheduling. Do not delete. [${PROVISIONING_MARKER_PREFIX}${attemptToken}]`;
}

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

// Owner-only gate for DESTINATION management (choose / upgrade / provision / list /
// select). Defense-in-depth: the page hides these for non-owners, the nav is
// owner-only, AND every destination action re-authorizes here. Hidden UI is never
// authorization.
async function requireOwnerConnectionContext() {
  const ctx = await requireConnectionContext();
  if (!ctx.ok) return ctx;
  if (ctx.practitioner.role !== "owner") {
    return { ok: false as const, error: "Only the studio owner can manage the calendar destination." };
  }
  return ctx;
}

// Re-mint an access token from the stored (encrypted) refresh token. Marks the
// connection reconnect_required on a dead/undecryptable grant. Never returns the
// refresh token; the access token stays server-side.
type TokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; error: string; reconnectRequired?: boolean };

async function mintAccessToken(studioId: string, practitionerId: string): Promise<TokenResult> {
  const ciphertext = await getRefreshTokenCiphertext(studioId, practitionerId);
  if (!ciphertext) return { ok: false, error: "No connected Google account.", reconnectRequired: true };
  const dec = decryptGoogleSecret(ciphertext);
  if (!dec.ok) {
    await markReconnectRequired(studioId, practitionerId, "decrypt_failed");
    return { ok: false, error: "Could not read the connection. Please reconnect.", reconnectRequired: true };
  }
  const refreshed = await refreshAccessToken(dec.secret);
  if (!refreshed.ok) {
    if (refreshed.invalidGrant) {
      await markReconnectRequired(studioId, practitionerId, "invalid_grant");
      return { ok: false, error: "Google access was revoked. Please reconnect.", reconnectRequired: true };
    }
    return { ok: false, error: "Couldn't reach Google. Please try again." };
  }
  return { ok: true, accessToken: refreshed.accessToken };
}

// returnPath: the in-app page to return to after the callback. Validated against
// the open-redirect allowlist (safeReturnPath) — a browser-supplied value can only
// ever resolve to an allow-listed settings path, never an arbitrary URL.
export async function startGoogleCalendarConnectAction(
  returnPath?: string,
): Promise<StartResult> {
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
    redirectPath: safeReturnPath(returnPath),
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

// B2.4 — OWNER-only: choose the appointment DESTINATION mode. NO-SWITCH: once a
// mode is chosen it cannot be changed to the other (setDestinationMode enforces
// this; switching is a future product/data-lifecycle decision). Records the mode
// only; the scope-upgrade + target config are separate steps.
export async function chooseDestinationModeAction(
  mode: string,
  returnPath?: string,
): Promise<SimpleResult> {
  const ctx = await requireOwnerConnectionContext();
  if (!ctx.ok) return { ok: false, error: ctx.error };
  const { practitioner, studio } = ctx;

  if (!isCalendarDestinationMode(mode)) {
    return { ok: false, error: "Choose a valid destination." };
  }
  const existing = await getOwnConnectionMetadata(studio.id, practitioner.id);
  if (!existing || existing.connectionStatus !== "connected") {
    return { ok: false, error: "Connect your Google account first." };
  }
  const r = await setDestinationMode(studio.id, practitioner.id, mode);
  if (!r.ok) {
    if (r.reason === "destination_switching_unsupported") {
      return {
        ok: false,
        error:
          "This connection already has a destination. Changing destinations isn't supported yet — disconnect to start over.",
      };
    }
    return { ok: false, error: "Couldn't save the destination. Please try again." };
  }
  revalidatePath(safeReturnPath(returnPath));
  return { ok: true };
}

// B2.2/B2.4 — OWNER-only: start the incremental-authorization EVENT-SCOPE UPGRADE.
// The requested scope DERIVES from the connection's chosen destination
// (calendar.app.created for dedicated, calendar.events.owned for existing-owned) —
// broad calendar.events is never requested. include_granted_scopes=true preserves
// the Phase-A grant; prompt=consent re-issues a refresh token (doubles as
// reconnect). The chosen mode + its EXACT required scope are BOUND onto the OAuth
// state so the callback rejects a destination/scope that changed. Enqueues nothing.
export async function startGoogleCalendarEventScopeUpgradeAction(
  returnPath?: string,
): Promise<StartResult> {
  const ctx = await requireOwnerConnectionContext();
  if (!ctx.ok) return { ok: false, error: ctx.error };
  const { practitioner, studio } = ctx;

  // Hard guard: the outbound sync flag must remain OFF. Requesting the write
  // scope must never be entangled with enabling synchronization.
  if (studio.google_calendar_outbound_sync_enabled === true) {
    return { ok: false, error: "Outbound sync is enabled; the scope upgrade is managed separately." };
  }
  if (!isGoogleTokenCryptoConfigured() || !getGoogleOAuthClient()) {
    return { ok: false, error: "Google Calendar sync is not configured yet. Contact support." };
  }

  const existing = await getOwnConnectionMetadata(studio.id, practitioner.id);
  if (!existing || existing.connectionStatus === "disconnected") {
    return { ok: false, error: "Connect your Google account first." };
  }

  // The destination MUST be chosen first — the required scope derives from it.
  const mode = existing.destinationMode;
  const requiredScopes = requiredEventScopesForDestination(mode);
  const requiredScope = requiredEventScopeFor(mode);
  if (!isCalendarDestinationMode(mode) || !requiredScopes || requiredScope === null) {
    return { ok: false, error: "Choose a calendar destination first." };
  }

  const state = await createOAuthState({
    studioId: studio.id,
    practitionerId: practitioner.id,
    userId: practitioner.user_id ?? "",
    redirectPath: safeReturnPath(returnPath),
    destination: { mode, requiredScope },
  });
  if (!state.ok) {
    return { ok: false, error: "Could not start the permission upgrade. Please try again." };
  }

  const url = buildAuthorizationUrl({
    state: state.state,
    codeChallenge: state.codeChallenge,
    loginHint: existing.googleAccountEmail ?? undefined,
    forceConsent: true, // prompt=consent (reliable refresh-token re-issue + doubles as reconnect)
    scopes: requiredScopes, // ONLY the destination scope; include_granted_scopes preserves Phase A
  });
  if (!url) return { ok: false, error: "Google Calendar sync is not configured yet." };

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

// B2.4 dedicated — OWNER-only: provision (or reconcile+adopt) the Hone Appointments
// calendar. IDEMPOTENT + concurrency-safe via a STABLE attempt token embedded in
// the created calendar description and reconciled by EXACT match (never by name):
//   * already provisioned (app_created_calendar_id set) -> converge + succeed.
//   * ambiguous flagged -> needs attention, never auto-create.
//   * a stable attempt token is minted ONCE (CAS); every retry reconciles under it.
//   * reconcile 1 match -> adopt; >1 -> fail closed (ambiguous); 0 -> create one.
// Creates only an EMPTY secondary calendar — NO event, NO sync, NO worker.
export async function provisionDedicatedCalendarAction(
  returnPath?: string,
): Promise<SimpleResult> {
  const ctx = await requireOwnerConnectionContext();
  if (!ctx.ok) return { ok: false, error: ctx.error };
  const { practitioner, studio } = ctx;

  if (!isGoogleTokenCryptoConfigured() || !getGoogleOAuthClient()) {
    return { ok: false, error: "Google Calendar sync is not configured yet. Contact support." };
  }

  const existing = await getOwnConnectionMetadata(studio.id, practitioner.id);
  if (!existing || existing.connectionStatus !== "connected") {
    return { ok: false, error: "Connect your Google account first." };
  }
  if (existing.destinationMode !== "dedicated_app_created") {
    return { ok: false, error: "Choose the dedicated-calendar destination first." };
  }
  if (existing.provisioningAmbiguousAt) {
    return {
      ok: false,
      error: "Multiple Hone calendars were found for this connection. It needs attention — contact support.",
    };
  }
  // Idempotency: already provisioned -> re-affirm + succeed (never re-create).
  if (existing.appCreatedCalendarId) {
    const conv = await setDedicatedCalendarDestination(studio.id, practitioner.id, {
      calendarId: existing.appCreatedCalendarId,
      displayName: existing.selectedCalendarDisplayName ?? DEDICATED_CALENDAR_NAME,
    });
    if (!conv.ok) return { ok: false, error: "Couldn't confirm the calendar. Please try again." };
    await designateStudioCalendarOwner(studio.id, practitioner.id);
    revalidatePath(safeReturnPath(returnPath));
    return { ok: true };
  }
  // Must hold the EXACT app.created scope (granted via the upgrade) before creating.
  if (!hasRequiredEventScopes("dedicated_app_created", existing.grantedScopes)) {
    return { ok: false, error: "Grant calendar permission before creating the calendar." };
  }

  const token = await mintAccessToken(studio.id, practitioner.id);
  if (!token.ok) return { ok: false, error: token.error };

  // Establish a STABLE attempt token (mint once via CAS). A retry / concurrent call
  // re-reads the already-claimed token so every attempt reconciles under ONE token.
  let attemptToken = existing.provisioningAttemptToken;
  if (!attemptToken) {
    const fresh = randomUrlToken(24);
    const claim = await beginDedicatedProvisioningAttempt(studio.id, practitioner.id, fresh);
    if (claim.ok) {
      attemptToken = fresh;
    } else {
      const reread = await getOwnConnectionMetadata(studio.id, practitioner.id);
      attemptToken = reread?.provisioningAttemptToken ?? null;
      if (!attemptToken) {
        return { ok: false, error: "Couldn't start calendar creation. Please try again." };
      }
    }
  }

  // Reconcile FIRST: a prior/concurrent attempt may have created a calendar we
  // never persisted. Match by EXACT token in the description (never by name).
  const rec = await findCalendarsByDescriptionToken(token.accessToken, attemptToken);
  if (!rec.ok) {
    return { ok: false, error: "Couldn't verify calendar creation. Please try again." }; // fail closed
  }
  if (rec.calendarIds.length > 1) {
    await markDedicatedProvisioningAmbiguous(studio.id, practitioner.id);
    return { ok: false, error: "Multiple Hone calendars were found. This connection needs attention." };
  }
  if (rec.calendarIds.length === 1) {
    const saved = await setDedicatedCalendarDestination(studio.id, practitioner.id, {
      calendarId: rec.calendarIds[0],
      displayName: DEDICATED_CALENDAR_NAME,
    });
    if (!saved.ok) return { ok: false, error: "Couldn't save the calendar. Please try again." };
    await designateStudioCalendarOwner(studio.id, practitioner.id);
    revalidatePath(safeReturnPath(returnPath));
    return { ok: true };
  }

  // Zero matches -> create ONE calendar under the SAME stable token.
  const created = await createSecondaryCalendar(token.accessToken, {
    summary: DEDICATED_CALENDAR_NAME,
    description: provisioningDescription(attemptToken),
  });
  if (!created.ok) {
    // Ambiguous vs definite failure: the token stays persisted so the NEXT retry
    // reconciles by it (adopting an orphan if Google actually created one). We do
    // NOT create another calendar now.
    return { ok: false, error: "Couldn't create the calendar on Google. Please try again." };
  }
  // Re-reconcile to detect a concurrent double-create before adopting.
  const post = await findCalendarsByDescriptionToken(token.accessToken, attemptToken);
  if (post.ok && post.calendarIds.length > 1) {
    await markDedicatedProvisioningAmbiguous(studio.id, practitioner.id);
    return { ok: false, error: "Multiple Hone calendars were found. This connection needs attention." };
  }
  const adoptId = post.ok && post.calendarIds.length === 1 ? post.calendarIds[0] : created.id;
  const saved = await setDedicatedCalendarDestination(studio.id, practitioner.id, {
    calendarId: adoptId,
    displayName: DEDICATED_CALENDAR_NAME,
  });
  if (!saved.ok) {
    // Do NOT delete — the token lets a retry reconcile + adopt this exact calendar.
    return { ok: false, error: "Created the calendar but couldn't save it. Please try again." };
  }
  await designateStudioCalendarOwner(studio.id, practitioner.id);
  revalidatePath(safeReturnPath(returnPath));
  return { ok: true };
}

// B2.4 existing-owned — OWNER-only: list the calendars the connected account OWNS
// (exact accessRole === "owner"), for selection. Re-mints an access token; never
// returns the token. Writer/reader/freeBusy/unknown roles are excluded.
export async function listOwnedCalendarsAction(): Promise<CalendarsResult> {
  const ctx = await requireOwnerConnectionContext();
  if (!ctx.ok) return { ok: false, error: ctx.error };
  const { practitioner, studio } = ctx;

  const token = await mintAccessToken(studio.id, practitioner.id);
  if (!token.ok) return { ok: false, error: token.error, reconnectRequired: token.reconnectRequired };
  const list = await fetchCalendarList(token.accessToken);
  if (!list.ok) return { ok: false, error: "Couldn't load your Google calendars." };
  const owned = list.calendars.filter((c) => c.accessRole === "owner");
  return { ok: true, calendars: owned };
}

// B2.4 existing-owned — OWNER-only: select an OWNED calendar as the destination.
// The browser submits only a candidate id; the server re-fetches Google's own list
// and confirms the candidate has exact accessRole === "owner" (ignores any browser
// role). Stores nothing on validation failure. Reads/creates NO event.
export async function selectOwnedCalendarAction(
  calendarId: string,
  returnPath?: string,
): Promise<SimpleResult> {
  const ctx = await requireOwnerConnectionContext();
  if (!ctx.ok) return { ok: false, error: ctx.error };
  const { practitioner, studio } = ctx;

  if (typeof calendarId !== "string" || !calendarId) {
    return { ok: false, error: "Choose a calendar." };
  }
  const existing = await getOwnConnectionMetadata(studio.id, practitioner.id);
  if (!existing || existing.connectionStatus !== "connected") {
    return { ok: false, error: "Connect your Google account first." };
  }
  if (existing.destinationMode !== "existing_owned") {
    return { ok: false, error: "Choose the existing-calendar destination first." };
  }
  if (!hasRequiredEventScopes("existing_owned", existing.grantedScopes)) {
    return { ok: false, error: "Grant calendar permission before selecting a calendar." };
  }

  const token = await mintAccessToken(studio.id, practitioner.id);
  if (!token.ok) return { ok: false, error: token.error };
  const list = await fetchCalendarList(token.accessToken);
  if (!list.ok) return { ok: false, error: "Couldn't load your Google calendars." };
  // Server-side ownership revalidation — EXACT owner role, ignore browser claims.
  const entry = list.calendars.find((c) => c.id === calendarId && c.accessRole === "owner");
  if (!entry) {
    return { ok: false, error: "Choose a calendar you own." };
  }

  const saved = await setOwnedCalendarDestination(studio.id, practitioner.id, {
    calendarId,
    displayName: entry.summary,
  });
  if (!saved.ok) return { ok: false, error: "Couldn't save the calendar. Please try again." };
  await designateStudioCalendarOwner(studio.id, practitioner.id);
  revalidatePath(safeReturnPath(returnPath));
  return { ok: true };
}

export async function disconnectGoogleCalendarAction(
  returnPath?: string,
): Promise<SimpleResult> {
  const ctx = await requireConnectionContext();
  if (!ctx.ok) return { ok: false, error: ctx.error };
  const { practitioner, studio } = ctx;

  // Best-effort revoke at Google BEFORE destroying local state, so we never
  // orphan a live grant. If revoke fails we still proceed to clear locally
  // (the token is destroyed regardless) — a failed revoke is logged, not fatal.
  // NOTE (B2.4 §17): disconnect NEVER deletes a Hone-created Google calendar; it
  // only revokes credentials + clears local connection state. Calendar deletion is
  // a separate future product decision.
  const ciphertext = await getRefreshTokenCiphertext(studio.id, practitioner.id);
  if (ciphertext) {
    const dec = decryptGoogleSecret(ciphertext);
    if (dec.ok) {
      await revokeToken(dec.secret);
    }
  }
  await disconnectConnection(studio.id, practitioner.id);
  revalidatePath(safeReturnPath(returnPath));
  return { ok: true };
}

// List the connection's Google calendars (writer role) for the generic Phase-A
// selection. Re-mints an access token from the stored refresh token; never returns
// the token. (Superseded by the destination flow for B2.4 write targets.)
export async function listWritableCalendarsAction(): Promise<CalendarsResult> {
  const ctx = await requireConnectionContext();
  if (!ctx.ok) return { ok: false, error: ctx.error };
  const { practitioner, studio } = ctx;

  const token = await mintAccessToken(studio.id, practitioner.id);
  if (!token.ok) return { ok: false, error: token.error, reconnectRequired: token.reconnectRequired };
  const list = await fetchCalendarList(token.accessToken);
  if (!list.ok) return { ok: false, error: "Couldn't load your Google calendars." };
  return { ok: true, calendars: list.calendars };
}

// Validate the chosen calendar id against Google's OWN list for this connection
// (never trust an arbitrary browser-supplied id), then store it. Generic Phase-A
// write-calendar selection (does not set destination provenance).
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
// owner. Requires a connected account. (The destination-config actions also
// designate the owner automatically on completion.)
export async function designateSelfAsCalendarOwnerAction(): Promise<SimpleResult> {
  const ctx = await requireOwnerConnectionContext();
  if (!ctx.ok) return { ok: false, error: ctx.error };
  const { practitioner, studio } = ctx;
  const existing = await getOwnConnectionMetadata(studio.id, practitioner.id);
  if (!existing || existing.connectionStatus !== "connected") {
    return { ok: false, error: "Connect your Google account first." };
  }
  await designateStudioCalendarOwner(studio.id, practitioner.id);
  revalidatePath("/settings/profile");
  return { ok: true };
}
