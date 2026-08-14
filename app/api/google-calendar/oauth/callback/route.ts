import { type NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import {
  CALENDAR_DISCOVERY_SCOPE,
  DEFAULT_RETURN_PATH,
  OAUTH_NONCE_COOKIE,
} from "@/lib/google-calendar/config";
import {
  hasRequiredEventScopes,
  normalizeGrantedScopes,
  requiredEventScopeFor,
} from "@/lib/google-calendar/destination-scopes";
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

// Google OAuth 2.0 authorization-code CALLBACK: Phase A + B2.2 + B2.4.
//
// Browser-called WITH the practitioner's Supabase session (the httpOnly session
// cookie is SameSite=Lax, so it IS sent on Google's top-level redirect back).
// It never logs the code, tokens, or PKCE. It fails closed to a generic
// ?gcal=error, never leaking why.
//
// CREDENTIAL BOUNDARY (B2.4 §11). persistConnectedFromCallback is the ATOMIC
// replacement of the stored credentials + granted scopes. Every failure BEFORE it
// (code exchange, lost discovery scope, account mismatch, destination changed,
// missing/partial destination scope) preserves the PREVIOUS credentials and stores
// NOTHING. Only after the actual grant is validated do we replace credentials.
// Destination provisioning/selection happens LATER in a separate owner action, so a
// post-replacement provisioning/selection failure keeps the new grant and derives a
// pending state. It never rolls back the consented credentials.
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

  // Consume the single-use state (validates hash, expiry, nonce cookie, that this
  // is the SAME user who started the flow, and (atomically) that no concurrent
  // duplicate callback already consumed it). Also returns the B2.4 destination
  // binding (null for a plain Phase-A connect).
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

  // Exchange the code for tokens (server-side, with the PKCE verifier). A failure
  // here is PRE-replacement: nothing is stored, the previous credentials survive.
  const token = await exchangeAuthorizationCode({ code, codeVerifier: consumed.codeVerifier });
  if (!token.ok) return redirect(consumed.redirectPath, "error");

  // ACTUAL granted-scope truth. PRIMARY: the token-response `scope` field. FALLBACK
  // ONLY: tokeninfo, when the response omitted `scope`. Normalize to exact tokens
  // (no substring/prefix); we persist only these normalized scopes.
  let grantedScopes = normalizeGrantedScopes(token.grantedScopes);
  if (grantedScopes.length === 0) {
    const ti = await fetchTokenInfoScopes(token.accessToken);
    if (ti.ok) grantedScopes = normalizeGrantedScopes(ti.scopes);
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
  // identity MUST match it. On a mismatch we STOP (PRE-replacement), never
  // overwrite credentials or granted_scopes; the practitioner must disconnect first.
  const existing = await getOwnConnectionMetadata(consumed.studioId, consumed.practitionerId);
  const existingAccountId = await getConnectionAccountId(consumed.studioId, consumed.practitionerId);
  if (existingAccountId !== null && existingAccountId !== info.sub) {
    return redirect(consumed.redirectPath, "account_mismatch");
  }

  // B2.4 DESTINATION-BOUND upgrade validation. ALL of these are PRE-replacement
  // gates: on any failure the previous credentials + grant are preserved.
  const boundMode = consumed.destinationMode;
  if (boundMode !== null) {
    // The destination must not have changed between start and callback.
    if (!existing || existing.destinationMode !== boundMode) {
      return redirect(consumed.redirectPath, "destination_changed");
    }
    // Re-derive the required scope from the (current) mode and compare to the bound
    // value: a tampered single-column state value cannot pass.
    const expected = requiredEventScopeFor(boundMode);
    if (expected === null || expected !== consumed.requiredEventScope) {
      return redirect(consumed.redirectPath, "error");
    }
    // The ACTUAL grant must contain the EXACT destination scope. A partial grant
    // (discovery only / broad calendar.events / wrong destination scope) is a
    // PRE-replacement failure: preserve the previous credentials, store nothing.
    if (!hasRequiredEventScopes(boundMode, grantedScopes)) {
      return redirect(consumed.redirectPath, "event_scope_not_granted");
    }
  }

  // Write calendar. Preserve any existing selection. For a plain Phase-A connect
  // (no destination binding) discover a sensible default so selection has a value;
  // for a destination upgrade DO NOT auto-pick, the destination config step sets
  // the real write target (and setDestinationMode cleared the Phase-A default).
  let writeCalendarId = existing?.writeCalendarId ?? null;
  if (!writeCalendarId && boundMode === null) {
    const list = await fetchCalendarList(token.accessToken);
    writeCalendarId = list.ok
      ? (list.calendars.find((c) => c.primary)?.id ?? list.calendars[0]?.id ?? "primary")
      : "primary";
  }

  // Encrypt the (possibly rotated) refresh token before storage. If Google withheld
  // one (silent re-grant), persist PRESERVES the existing encrypted token; if
  // encryption fails we redirect error and never store plaintext: the existing
  // token stays intact (fail-closed).
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

  // ---- ATOMIC CREDENTIAL REPLACEMENT (the boundary). ----
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
    encryptionKeyVersion: keyVersion || 1,
  });
  if (!persisted.ok) {
    return redirect(
      consumed.redirectPath,
      persisted.reason === "no_refresh_token" ? "reconnect_required" : "error",
    );
  }

  // Non-destructive outcome banner (readiness itself is derived on the card):
  //   - destination scope granted -> the destination config step is next
  //   - plain connect / reconnect  -> connected
  const status = boundMode !== null ? "event_scope_granted" : "connected";
  return redirect(consumed.redirectPath, status);
}
