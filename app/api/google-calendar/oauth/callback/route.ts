import { type NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import {
  CALENDAR_DISCOVERY_SCOPE,
  DEFAULT_RETURN_PATH,
  EVENT_WRITE_SCOPE,
  OAUTH_NONCE_COOKIE,
} from "@/lib/google-calendar/config";
import {
  exchangeAuthorizationCode,
  fetchCalendarList,
  fetchTokenInfoScopes,
  fetchUserInfo,
} from "@/lib/google-calendar/oauth";
import { consumeOAuthState } from "@/lib/google-calendar/state";
import { encryptGoogleSecret } from "@/lib/google-calendar/token-crypto";
import {
  getConnectionAccountId,
  getOwnConnectionMetadata,
  persistConnectedFromCallback,
} from "@/lib/google-calendar/connection";

// Google OAuth 2.0 authorization-code CALLBACK — Phase A.
//
// Browser-called WITH the practitioner's Supabase session (the httpOnly session
// cookie is SameSite=Lax, so it IS sent on Google's top-level redirect back).
// It is therefore NOT allow-listed anonymous in middleware — it must resolve
// auth.getUser(). It never logs the code, tokens, or PKCE. It fails closed to a
// generic ?gcal=error, never leaking why.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function redirect(path: string, gcal: string): NextResponse {
  const origin = getRequiredAppOrigin();
  const url = new URL(path.startsWith("/") ? path : DEFAULT_RETURN_PATH, origin);
  url.searchParams.set("gcal", gcal);
  const res = NextResponse.redirect(url);
  // Always clear the single-use nonce cookie on the way out.
  res.cookies.set({ name: OAUTH_NONCE_COOKIE, value: "", path: "/", maxAge: 0 });
  return res;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;

  // User denied consent at Google, or Google returned an error.
  if (params.get("error")) return redirect(DEFAULT_RETURN_PATH, "denied");

  const state = params.get("state");
  const code = params.get("code");
  if (!state || !code) return redirect(DEFAULT_RETURN_PATH, "error");

  // The returning request must carry an authenticated session.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return redirect("/login", "error");

  // Consume the single-use state (validates hash, expiry, nonce cookie, and
  // that this is the SAME user who started the flow).
  const jar = await cookies();
  const nonce = jar.get(OAUTH_NONCE_COOKIE)?.value ?? null;
  const consumed = await consumeOAuthState({ state, nonce, userId: user.id });
  if (!consumed.ok) return redirect(DEFAULT_RETURN_PATH, "error");

  // Re-assert the practitioner is still active AND belongs to the bound studio.
  const admin = createAdminClient();
  const { data: prac } = await admin
    .from("practitioners")
    .select("id, active")
    .eq("id", consumed.practitionerId)
    .eq("studio_id", consumed.studioId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!prac || prac.active !== true) return redirect(consumed.redirectPath, "error");

  // Exchange the code for tokens (server-side, with the PKCE verifier).
  const token = await exchangeAuthorizationCode({ code, codeVerifier: consumed.codeVerifier });
  if (!token.ok) return redirect(consumed.redirectPath, "error");

  // Granted-scope verification. PRIMARY: the token-response `scope` field. It is
  // authoritative for what the grant contains and costs no extra call. FALLBACK
  // ONLY: tokeninfo, when the response omitted `scope`.
  let grantedScopes = token.grantedScopes;
  if (grantedScopes.length === 0) {
    const ti = await fetchTokenInfoScopes(token.accessToken);
    if (ti.ok) grantedScopes = ti.scopes;
  }

  // The connection must retain calendar-list discovery, or selection is
  // impossible. (An event-scope upgrade preserves it via include_granted_scopes.)
  if (!grantedScopes.includes(CALENDAR_DISCOVERY_SCOPE)) {
    return redirect(consumed.redirectPath, "insufficient_scope");
  }

  // Verify the connected Google account identity server-side (never trust the
  // redirect); this is what we store as google_account_id/email.
  const info = await fetchUserInfo(token.accessToken);
  if (!info.ok) return redirect(consumed.redirectPath, "error");

  // ACCOUNT-SWITCH PROTECTION. If a connection already exists, the returned Google
  // identity MUST match it. On a mismatch we STOP — never overwrite credentials or
  // granted_scopes; the practitioner must explicitly disconnect first.
  const existing = await getOwnConnectionMetadata(consumed.studioId, consumed.practitionerId);
  const existingAccountId = await getConnectionAccountId(consumed.studioId, consumed.practitionerId);
  const isReauth = existingAccountId !== null;
  if (existingAccountId !== null && existingAccountId !== info.sub) {
    return redirect(consumed.redirectPath, "account_mismatch");
  }

  // Preserve the existing write-calendar selection on a re-auth (a scope upgrade
  // must not reset the practitioner's chosen calendar). Discover a default only
  // for an initial connect / when none is set.
  let writeCalendarId = existing?.writeCalendarId ?? null;
  if (!writeCalendarId) {
    const list = await fetchCalendarList(token.accessToken);
    writeCalendarId = list.ok
      ? (list.calendars.find((c) => c.primary)?.id ?? list.calendars[0]?.id ?? "primary")
      : "primary";
  }

  // Encrypt the (possibly rotated) refresh token before storage. If Google
  // withheld one (silent re-grant), persist PRESERVES the existing encrypted
  // token; if encryption fails we redirect error and never store plaintext — the
  // existing token stays intact (the B2.1 fail-closed posture).
  let encryptedRefreshToken: string | null = null;
  let refreshTokenLast4: string | null = null;
  let keyVersion = 0;
  if (token.refreshToken) {
    const enc = encryptGoogleSecret(token.refreshToken);
    if (!enc.ok) return redirect(consumed.redirectPath, "error"); // never store plaintext
    encryptedRefreshToken = enc.ciphertext;
    refreshTokenLast4 = enc.last4;
    keyVersion = enc.keyVersion;
  }

  const persisted = await persistConnectedFromCallback({
    studioId: consumed.studioId,
    practitionerId: consumed.practitionerId,
    googleAccountId: info.sub,
    googleAccountEmail: info.email,
    grantedScopes,
    tokenExpiresAt: new Date(Date.now() + token.expiresInSeconds * 1000).toISOString(),
    writeCalendarId,
    encryptedRefreshToken,
    refreshTokenLast4,
    // If no token this run, keyVersion stays 0 but is unused (persist preserves
    // the existing secret row, which already carries its own version).
    encryptionKeyVersion: keyVersion || 1,
  });
  if (!persisted.ok) {
    return redirect(consumed.redirectPath, persisted.reason === "no_refresh_token" ? "reconnect_required" : "error");
  }

  // Non-destructive outcome banners (readiness itself is derived on the card):
  //   - event scope granted        -> affirm readiness for future sync
  //   - re-auth without the scope   -> the upgrade was denied/partial (Phase A intact)
  //   - initial connect            -> connected
  const hasEvents = grantedScopes.includes(EVENT_WRITE_SCOPE);
  const status = hasEvents ? "event_scope_granted" : isReauth ? "event_scope_not_granted" : "connected";
  return redirect(consumed.redirectPath, status);
}
