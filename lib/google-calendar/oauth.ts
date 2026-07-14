import "server-only";
import { createHash, randomBytes } from "node:crypto";
import {
  GOOGLE_AUTH_ENDPOINT,
  GOOGLE_CALENDAR_LIST_ENDPOINT,
  GOOGLE_CALENDARS_ENDPOINT,
  GOOGLE_REVOKE_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_TOKENINFO_ENDPOINT,
  GOOGLE_USERINFO_ENDPOINT,
  REQUESTED_SCOPES,
  getGoogleOAuthClient,
  getOAuthRedirectUri,
} from "./config";

// Thin, server-only Google OAuth 2.0 + Calendar REST client (Phase A).
// Direct `fetch`, no SDK. Never logs tokens, authorization codes, or PKCE
// values; all functions fail closed (return a typed error) instead of throwing
// secrets into a stack trace.

// --- PKCE + CSPRNG helpers ---
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function randomUrlToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export type Pkce = { verifier: string; challenge: string };
export function generatePkce(): Pkce {
  const verifier = base64url(randomBytes(64)); // 43..128 chars per RFC 7636
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

// --- Authorization URL ---
// prompt: 'consent' is forced only for a first connection / reconnect_required /
// when no usable refresh token is stored (Google withholds a refresh token on a
// silent re-grant). include_granted_scopes=true enables Phase B incremental
// authorization to add the event scopes without dropping the Phase A grant.
export function buildAuthorizationUrl(opts: {
  state: string;
  codeChallenge: string;
  loginHint?: string;
  forceConsent: boolean;
  // The scopes to request. Defaults to the Phase-A connect set. The B2.2 event-
  // scope upgrade passes ONLY [calendar.events]; include_granted_scopes=true
  // preserves the already-granted Phase-A scopes (incremental authorization).
  scopes?: readonly string[];
}): string | null {
  const client = getGoogleOAuthClient();
  if (!client) return null;
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: getOAuthRedirectUri(),
    response_type: "code",
    scope: (opts.scopes ?? REQUESTED_SCOPES).join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    state: opts.state,
  });
  if (opts.forceConsent) params.set("prompt", "consent");
  if (opts.loginHint) params.set("login_hint", opts.loginHint);
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

// --- Code exchange ---
export type TokenExchangeResult =
  | {
      ok: true;
      accessToken: string;
      refreshToken: string | null; // Google omits it on a silent re-grant
      expiresInSeconds: number;
      grantedScopes: string[];
    }
  | { ok: false; reason: string };

export async function exchangeAuthorizationCode(opts: {
  code: string;
  codeVerifier: string;
}): Promise<TokenExchangeResult> {
  const client = getGoogleOAuthClient();
  if (!client) return { ok: false, reason: "oauth_client_unavailable" };
  try {
    const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: opts.code,
        redirect_uri: getOAuthRedirectUri(),
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code_verifier: opts.codeVerifier,
      }),
    });
    if (!res.ok) return { ok: false, reason: `token_http_${res.status}` };
    const body = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    if (!body.access_token) return { ok: false, reason: "no_access_token" };
    return {
      ok: true,
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      expiresInSeconds: typeof body.expires_in === "number" ? body.expires_in : 3600,
      grantedScopes: (body.scope ?? "").split(" ").filter(Boolean),
    };
  } catch {
    return { ok: false, reason: "token_exchange_network_error" };
  }
}

// --- Access-token refresh (Phase A persists only the refresh token; an access
// token is re-minted on demand, e.g. to list calendars for selection). Google
// MAY rotate the refresh token; the caller must re-encrypt+store a rotated one. ---
export type RefreshResult =
  | {
      ok: true;
      accessToken: string;
      expiresInSeconds: number;
      rotatedRefreshToken: string | null;
    }
  | { ok: false; reason: string; invalidGrant: boolean };

export async function refreshAccessToken(refreshToken: string): Promise<RefreshResult> {
  const client = getGoogleOAuthClient();
  if (!client) return { ok: false, reason: "oauth_client_unavailable", invalidGrant: false };
  try {
    const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: client.clientId,
        client_secret: client.clientSecret,
      }),
    });
    if (!res.ok) {
      // 400 invalid_grant = the grant was revoked/expired -> reconnect_required.
      let invalidGrant = false;
      if (res.status === 400) {
        try {
          const err = (await res.json()) as { error?: string };
          invalidGrant = err.error === "invalid_grant";
        } catch {
          /* ignore parse error */
        }
      }
      return { ok: false, reason: `refresh_http_${res.status}`, invalidGrant };
    }
    const body = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
    };
    if (!body.access_token) return { ok: false, reason: "no_access_token", invalidGrant: false };
    return {
      ok: true,
      accessToken: body.access_token,
      expiresInSeconds: typeof body.expires_in === "number" ? body.expires_in : 3600,
      rotatedRefreshToken: body.refresh_token ?? null,
    };
  } catch {
    return { ok: false, reason: "refresh_network_error", invalidGrant: false };
  }
}

// --- Granted-scope fallback (B2.2) ---
// The token-response `scope` field is the PRIMARY, authoritative source of what a
// grant contains (parsed by the caller). This tokeninfo call is a FALLBACK used
// only when that field is missing/empty, so the callback can still verify the
// event scope was granted. Never a standard round-trip; never logs the token.
export type TokenInfoResult =
  | { ok: true; scopes: string[] }
  | { ok: false; reason: string };

export async function fetchTokenInfoScopes(accessToken: string): Promise<TokenInfoResult> {
  try {
    const res = await fetch(
      `${GOOGLE_TOKENINFO_ENDPOINT}?access_token=${encodeURIComponent(accessToken)}`,
    );
    if (!res.ok) return { ok: false, reason: `tokeninfo_http_${res.status}` };
    const body = (await res.json()) as { scope?: string };
    return { ok: true, scopes: (body.scope ?? "").split(" ").filter(Boolean) };
  } catch {
    return { ok: false, reason: "tokeninfo_network_error" };
  }
}

// --- Account identity (OIDC userinfo) ---
export type UserInfoResult =
  | { ok: true; sub: string; email: string | null }
  | { ok: false; reason: string };

export async function fetchUserInfo(accessToken: string): Promise<UserInfoResult> {
  try {
    const res = await fetch(GOOGLE_USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return { ok: false, reason: `userinfo_http_${res.status}` };
    const body = (await res.json()) as { sub?: string; email?: string };
    if (!body.sub) return { ok: false, reason: "no_sub" };
    return { ok: true, sub: body.sub, email: body.email ?? null };
  } catch {
    return { ok: false, reason: "userinfo_network_error" };
  }
}

// --- Calendar list (least-privilege discovery + selection validation) ---
export type GoogleCalendarListEntry = {
  id: string;
  summary: string;
  accessRole: string;
  primary: boolean;
};
export type CalendarListResult =
  | { ok: true; calendars: GoogleCalendarListEntry[] }
  | { ok: false; reason: string };

export async function fetchCalendarList(accessToken: string): Promise<CalendarListResult> {
  try {
    const res = await fetch(`${GOOGLE_CALENDAR_LIST_ENDPOINT}?minAccessRole=writer&maxResults=250`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return { ok: false, reason: `calendarlist_http_${res.status}` };
    const body = (await res.json()) as {
      items?: Array<{ id?: string; summary?: string; accessRole?: string; primary?: boolean }>;
    };
    const calendars = (body.items ?? [])
      .filter((c): c is { id: string; summary?: string; accessRole?: string; primary?: boolean } =>
        typeof c.id === "string" && c.id.length > 0,
      )
      // Never expose Google-supplied descriptions; only id + summary + role.
      .map((c) => ({
        id: c.id,
        summary: typeof c.summary === "string" ? c.summary : c.id,
        accessRole: typeof c.accessRole === "string" ? c.accessRole : "unknown",
        primary: c.primary === true,
      }));
    return { ok: true, calendars };
  } catch {
    return { ok: false, reason: "calendarlist_network_error" };
  }
}

// --- Secondary-calendar provisioning (B2.4 dedicated destination) ---
// Create a Hone-OWNED secondary calendar (requires the calendar.app.created
// grant). `description` carries the NON-SENSITIVE provisioning-attempt marker so
// an ambiguous provider response can be reconciled by EXACT token match. The
// returned id becomes app_created_calendar_id (idempotency anchor) + write target.
// Never logs the token; fails closed to a typed error. Creates NO event.
export type CreateCalendarResult =
  | { ok: true; id: string }
  | { ok: false; reason: string };

export async function createSecondaryCalendar(
  accessToken: string,
  input: { summary: string; description?: string },
): Promise<CreateCalendarResult> {
  try {
    const res = await fetch(GOOGLE_CALENDARS_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        input.description
          ? { summary: input.summary, description: input.description }
          : { summary: input.summary },
      ),
    });
    if (!res.ok) return { ok: false, reason: `calendar_create_http_${res.status}` };
    const body = (await res.json()) as { id?: string };
    if (typeof body.id !== "string" || body.id.length === 0) {
      return { ok: false, reason: "calendar_create_no_id" };
    }
    return { ok: true, id: body.id };
  } catch {
    return { ok: false, reason: "calendar_create_network_error" };
  }
}

// Reconciliation (B2.4 ambiguous-response handling). List the calendars visible to
// this connection and return the ids whose DESCRIPTION contains the EXACT
// provisioning-attempt token. Never matches on display name. Returns a typed error
// on any transport failure so the caller fails closed (never assumes zero matches).
export type ReconcileResult =
  | { ok: true; calendarIds: string[] }
  | { ok: false; reason: string };

export async function findCalendarsByDescriptionToken(
  accessToken: string,
  attemptToken: string,
): Promise<ReconcileResult> {
  // A blank/short token must never match everything — fail closed.
  if (!attemptToken || attemptToken.length < 16) {
    return { ok: false, reason: "reconcile_token_invalid" };
  }
  try {
    // Include showHidden so a freshly-created (not yet surfaced) calendar is found.
    const res = await fetch(
      `${GOOGLE_CALENDAR_LIST_ENDPOINT}?minAccessRole=owner&maxResults=250&showHidden=true`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) return { ok: false, reason: `reconcile_http_${res.status}` };
    const body = (await res.json()) as {
      items?: Array<{ id?: string; description?: string }>;
    };
    const calendarIds = (body.items ?? [])
      .filter(
        (c) =>
          typeof c.id === "string" &&
          c.id.length > 0 &&
          typeof c.description === "string" &&
          c.description.includes(attemptToken),
      )
      .map((c) => c.id as string);
    return { ok: true, calendarIds };
  } catch {
    return { ok: false, reason: "reconcile_network_error" };
  }
}

// Delete a secondary calendar. Used ONLY to roll back a just-created calendar
// whose local persist failed, so we never orphan a Hone-created calendar the DB
// doesn't reference. 200/204 = deleted; 404/410 = already gone (also success).
export async function deleteCalendar(
  accessToken: string,
  calendarId: string,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(
      `${GOOGLE_CALENDARS_ENDPOINT}/${encodeURIComponent(calendarId)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (res.ok || res.status === 404 || res.status === 410) return { ok: true };
    return { ok: false, reason: `calendar_delete_http_${res.status}` };
  } catch {
    return { ok: false, reason: "calendar_delete_network_error" };
  }
}

// --- Revocation (disconnect) ---
export async function revokeToken(token: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(GOOGLE_REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
    // Google returns 200 on success; 400 for an already-invalid token (which is
    // still an acceptable end state for disconnect).
    if (res.ok || res.status === 400) return { ok: true };
    return { ok: false, reason: `revoke_http_${res.status}` };
  } catch {
    return { ok: false, reason: "revoke_network_error" };
  }
}
