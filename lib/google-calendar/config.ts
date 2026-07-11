import "server-only";
import { getRequiredAppOrigin } from "@/lib/app-origin";

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
export const GOOGLE_CALENDAR_LIST_ENDPOINT =
  "https://www.googleapis.com/calendar/v3/users/me/calendarList";

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

// PHASE B (future — DOCUMENTED here, NOT requested now): outbound event sync
// adds calendar.events (write Hone-owned events); inbound busy adds
// calendar.readonly (read busy/free). These will be requested via INCREMENTAL
// authorization (include_granted_scopes=true), so Sam's controlled connection
// will require exactly ONE additional consent/reconnect when Phase B ships.
export const PHASE_B_ADDITIONAL_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
] as const;

// The scopes actually requested in this phase.
export const REQUESTED_SCOPES = PHASE_A_SCOPES;

// Fixed, server-built redirect URI. NEVER derived from a request header (host-
// header injection guard). Must be registered EXACTLY in the Google Cloud
// console authorized-redirect list.
export const OAUTH_CALLBACK_PATH = "/api/google-calendar/oauth/callback";

export function getOAuthRedirectUri(): string {
  return `${getRequiredAppOrigin()}${OAUTH_CALLBACK_PATH}`;
}

// Allow-listed post-callback return paths (defense against open-redirect). A
// stored redirect_path is honored ONLY if it is an exact member of this set.
const ALLOWED_RETURN_PATHS = new Set<string>(["/settings/profile"]);
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

// The httpOnly nonce cookie name (double-submit binding for the callback).
export const OAUTH_NONCE_COOKIE = "gcal_oauth_nonce";
// Cookie + state TTL kept aligned (10 minutes).
export const OAUTH_STATE_TTL_SECONDS = 600;
