import "server-only";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import { isE2eFakeGoogleEnabled } from "./e2e/fake-google-guard";

// Google Calendar OAuth configuration — Phase A (connection foundation).
//
// DEPENDENCY DECISION: Option B — direct OAuth + Calendar REST via server-side
// `fetch`, NOT the `googleapis` npm package. Rationale (documented in
// docs/integrations/google-calendar-sync.md §Dependency):
//   * Bundle/security surface: Phase A needs exactly four HTTP calls (token
//     exchange, userinfo, calendarList.list, revoke). `googleapis` pulls the
//     entire Google API surface (tens of MB, hundreds of transitive types);
//     `fetch` is native to the Node runtime (no new dependency, no audit
//     surface, no bundle bloat).
//   * Token-refresh control: our design stores the refresh token ENCRYPTED at
//     rest and re-mints access tokens explicitly in a server worker. The
//     library's implicit auto-refresh hides the token state we must manage
//     ourselves; explicit fetch keeps that state visible and testable.
//   * Testability: mocking one thin typed client (fetch) is trivial in vitest;
//     mocking the library's client objects is heavier.
//   * Type safety: we declare narrow response types for the exact fields we
//     consume — safer than importing a huge, mostly-unused type surface.
// Trade-off accepted: we hand-write ~4 request builders. Revisit if Phase B+
// needs batch/watch ergonomics the library would materially simplify.

// --- OAuth + API endpoints (Google Calendar API v3 / OIDC) ---
export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
// Fallback-only (B2.2): used to read the granted scopes when the token response
// omits the `scope` field. NOT a standard round-trip.
export const GOOGLE_TOKENINFO_ENDPOINT = "https://oauth2.googleapis.com/tokeninfo";
export const GOOGLE_CALENDAR_LIST_ENDPOINT =
  "https://www.googleapis.com/calendar/v3/users/me/calendarList";
// Secondary-calendar collection (B2.4 dedicated destination): POST creates a
// Hone-owned calendar (calendar.app.created scope); DELETE `${endpoint}/{id}`
// removes one (used only to roll back a create whose local persist failed).
export const GOOGLE_CALENDARS_ENDPOINT =
  "https://www.googleapis.com/calendar/v3/calendars";

// --- Scopes ---
// PHASE A (this PR): the MINIMUM for account identity + calendar-list discovery
// + validating a selected calendar. Least privilege by design — NO event read
// or write scope is requested, because no event sync exists yet.
//   * openid + userinfo.email  -> the connected Google account id (sub) + email.
//   * calendar.calendarlist.readonly -> list the calendars the account is
//     subscribed to (name + access role) so the practitioner can pick a write
//     target. This is the narrowest official scope that makes calendar
//     selection possible; it grants NO access to event data.
export const PHASE_A_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
] as const;

// PHASE B (DOCUMENTED here, requested destination-specifically — NOT broad). B2.4
// makes the outbound event scope DERIVE from the connection's chosen destination
// (see lib/google-calendar/destination-scopes.ts): a Hone-created calendar needs
// calendar.app.created; an existing owned calendar needs calendar.events.owned.
// Broad `calendar.events` is DELIBERATELY EXCLUDED — B2.4 superseded it; it
// satisfies the outbound contract nowhere. Inbound busy (Phase C) will add
// calendar.readonly. All are requested via INCREMENTAL authorization
// (include_granted_scopes=true), so a connection takes exactly ONE additional
// consent/reconnect per new scope.
export const PHASE_B_ADDITIONAL_SCOPES = [
  "https://www.googleapis.com/auth/calendar.app.created",
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/calendar.readonly",
] as const;

// The scopes actually requested for the INITIAL Phase-A connect.
export const REQUESTED_SCOPES = PHASE_A_SCOPES;

// NOTE: broad `calendar.events` (the old EVENT_WRITE_SCOPE) was REMOVED in B2.4
// Stage 2. It is no longer part of the event-scope contract and is requested /
// accepted nowhere. The exact destination scopes live in
// lib/google-calendar/destination-scopes.ts (calendar.app.created /
// calendar.events.owned) and are the ONLY event scopes this integration requests.

// The calendar-list discovery scope (Phase A) the connection must retain.
export const CALENDAR_DISCOVERY_SCOPE = PHASE_A_SCOPES[2];

// Fixed, server-built redirect URI. NEVER derived from a request header (host-
// header injection guard). Must be registered EXACTLY in the Google Cloud
// console authorized-redirect list.
export const OAUTH_CALLBACK_PATH = "/api/google-calendar/oauth/callback";

export function getOAuthRedirectUri(): string {
  return `${getRequiredAppOrigin()}${OAUTH_CALLBACK_PATH}`;
}

// The guarded local fake-authorize route (E2E only). In production the guard is
// fail-closed, so getAuthorizeEndpoint() always returns the REAL Google endpoint.
export const OAUTH_FAKE_AUTHORIZE_PATH = "/api/google-calendar/e2e/authorize";

// The authorization endpoint the connect/upgrade URL points at. Real Google in
// production; the guarded local fake-authorize route ONLY in the E2E lane (so the
// browser never navigates to accounts.google.com under test).
export function getAuthorizeEndpoint(): string {
  if (isE2eFakeGoogleEnabled()) {
    return `${getRequiredAppOrigin()}${OAUTH_FAKE_AUTHORIZE_PATH}`;
  }
  return GOOGLE_AUTH_ENDPOINT;
}

// Allow-listed post-callback return paths (defense against open-redirect). A
// stored redirect_path is honored ONLY if it is an exact member of this set.
// /settings/integrations is the owner-facing connection surface; /settings/profile
// is the per-practitioner surface. Any other value falls back to DEFAULT_RETURN_PATH.
const ALLOWED_RETURN_PATHS = new Set<string>([
  "/settings/profile",
  "/settings/integrations",
]);
export const DEFAULT_RETURN_PATH = "/settings/profile";

export function safeReturnPath(candidate: string | null | undefined): string {
  if (candidate && ALLOWED_RETURN_PATHS.has(candidate)) return candidate;
  return DEFAULT_RETURN_PATH;
}

export type GoogleOAuthClient = { clientId: string; clientSecret: string };

// Reads the OAuth client credentials from env. Returns null (fail-closed) when
// either is missing, so the connect/callback paths refuse cleanly rather than
// starting a flow that cannot complete.
export function getGoogleOAuthClient(): GoogleOAuthClient | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

// The httpOnly nonce cookie's `secure` flag: tied to the actual app-origin scheme
// (https in production -> secure:true) rather than NODE_ENV, so the local E2E lane
// (next start / NODE_ENV=production over http://localhost) can still set + send it.
export function oauthCookieSecure(): boolean {
  return getRequiredAppOrigin().startsWith("https://");
}

// The httpOnly nonce cookie name (double-submit binding for the callback).
export const OAUTH_NONCE_COOKIE = "gcal_oauth_nonce";
// Cookie + state TTL kept aligned (10 minutes).
export const OAUTH_STATE_TTL_SECONDS = 600;
