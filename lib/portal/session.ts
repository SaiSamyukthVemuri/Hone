import "server-only";
import { cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { generateRawToken, hashToken } from "./tokens";
import { loadClientSelfServicePolicy } from "@/lib/booking/client-self-service-policy-store";
import { clientPortalDisabledMessage } from "@/lib/booking/client-self-service-policy";

// Server-side client portal session manager. Owns the
// hone_portal_session httpOnly cookie and the client_portal_sessions
// DB table (migration 0052). Never returns the raw cookie token to
// the caller; everything outside this file references sessions by
// the resolved { studio_id, client_id } pair.
//
// Threat model anchors:
//   * The cookie is httpOnly, secure in production, sameSite=lax, and
//     scoped to the entire site (path=/). It carries the raw session
//     token; the DB stores only the SHA-256 hex. A DB compromise
//     therefore does not yield usable session credentials.
//   * Every portal page that needs the session calls
//     getCurrentPortalSession() server-side. The page render is
//     suspended on a single DB lookup that filters by hashed token,
//     not-expired, and not-revoked.
//   * Practitioner auth (Supabase auth) lives entirely outside this
//     file. Portal sessions never grant practitioner access and
//     practitioner sessions never grant portal access.

const COOKIE_NAME = "hone_portal_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type PortalSession = {
  id: string;
  studioId: string;
  clientId: string;
  expiresAt: string;
};

// HON-47. The portal session resolver is the one place every portal page and
// action already passes through, so the studio's client-portal flag is enforced
// HERE: a session whose studio has turned client portal access off is never
// returned as usable. `disabled` carries the studio name so a caller can say
// why, instead of claiming the session expired.
export type PortalSessionState =
  | { kind: "none" }
  | { kind: "disabled"; studioName: string | null }
  | { kind: "active"; session: PortalSession };

export async function getCurrentPortalSessionState(): Promise<PortalSessionState> {
  const session = await readCurrentPortalSession();
  if (!session) return { kind: "none" };
  const policy = await loadClientSelfServicePolicy(
    createAdminClient(),
    session.studioId,
  );
  // FAIL CLOSED: an unreadable policy is treated as no session at all, never
  // as access.
  if (!policy.ok) return { kind: "none" };
  if (!policy.policy.portal) {
    return { kind: "disabled", studioName: policy.studioName };
  }
  return { kind: "active", session };
}

// Every existing caller keeps this signature. It returns the session only when
// the studio still allows client portal access (see above), so a caller that
// predates HON-47, or one added later, cannot reach a disabled studio's data.
export async function getCurrentPortalSession(): Promise<PortalSession | null> {
  const state = await getCurrentPortalSessionState();
  return state.kind === "active" ? state.session : null;
}

// For portal server actions: the session, or the refusal the action should
// return. A disabled studio gets the HON-47 explanation rather than "your
// session has expired", which would send the client round a sign-in loop that
// can never succeed.
export async function requirePortalSessionForAction(
  expiredMessage: string,
): Promise<
  | { ok: true; session: PortalSession }
  | { ok: false; code: "session_expired" | "portal_disabled"; error: string }
> {
  const state = await getCurrentPortalSessionState();
  if (state.kind === "active") return { ok: true, session: state.session };
  if (state.kind === "disabled") {
    return {
      ok: false,
      code: "portal_disabled",
      error: clientPortalDisabledMessage(state.studioName),
    };
  }
  return { ok: false, code: "session_expired", error: expiredMessage };
}

// Read the cookie, hash its value, look the row up, and return the
// resolved session. Returns null when:
//   * no cookie is present (anonymous visitor)
//   * the hash doesn't match any row (forged or stale cookie)
//   * the row is expired or revoked
//
// Refreshes last_seen_at as a best-effort metric; failure to write it
// never blocks the session.
async function readCurrentPortalSession(): Promise<PortalSession | null> {
  const jar = await cookies();
  const raw = jar.get(COOKIE_NAME)?.value;
  if (!raw || raw.length === 0) return null;

  const tokenHash = hashToken(raw);
  const admin = createAdminClient();

  const nowIso = new Date().toISOString();
  const { data, error } = await admin
    .from("client_portal_sessions")
    .select("id, studio_id, client_id, expires_at, revoked_at")
    .eq("session_token_hash", tokenHash)
    .maybeSingle();
  if (error) {
    // Omit provider text: it can quote identifiers, cookies or hashes. A DB
    // outage should not 500 the page render; treat as anonymous.
    console.error(
      JSON.stringify({
        event: "portal_session_lookup_failed",
        code: error.code,
        timestamp: new Date().toISOString(),
      }),
    );
    return null;
  }
  if (!data) return null;
  if (data.revoked_at) return null;
  if (data.expires_at <= nowIso) return null;

  // Fire-and-forget last_seen_at touch. We deliberately do NOT await
  // this so a slow update never blocks the render; an outdated
  // last_seen is acceptable. Supabase builders are lazy thenables:
  // no request is sent until the builder is awaited or .then()ed, so
  // the .then() below is what actually executes the update (PR #183;
  // a bare `void builder` here previously never fired). PostgREST
  // failures resolve with { error } rather than rejecting, so the
  // fulfilled arm inspects error; the rejected arm covers transport
  // throws. Neither arm logs the cookie token, its hash, or any
  // client PII: only an event marker, timestamp and database code leave.
  // A failed touch never affects the returned session.
  void admin
    .from("client_portal_sessions")
    .update({ last_seen_at: nowIso })
    .eq("id", data.id)
    .then(
      ({ error: touchError }) => {
        if (touchError) {
          console.error(
            JSON.stringify({
              event: "portal_session_last_seen_update_failed",
              code: touchError.code,
              timestamp: new Date().toISOString(),
            }),
          );
        }
      },
      () => {
        console.error(
          JSON.stringify({
            event: "portal_session_last_seen_update_failed",
            timestamp: new Date().toISOString(),
          }),
        );
      },
    );

  return {
    id: data.id as string,
    studioId: data.studio_id as string,
    clientId: data.client_id as string,
    expiresAt: data.expires_at as string,
  };
}

// Create a brand new portal session for the supplied (studio, client)
// pair and set the cookie. Returns nothing meaningful: callers redirect
// after this resolves. We do NOT return the raw token to anyone.
//
// expires_at is computed server-side from SESSION_TTL_MS, not from
// any client-supplied value.
export async function createPortalSession(params: {
  studioId: string;
  clientId: string;
}): Promise<void> {
  // HON-47. Defence in depth behind the verify action's own check: no session
  // is ever minted for a studio whose client portal access is off, or whose
  // policy cannot be read.
  const policy = await loadClientSelfServicePolicy(createAdminClient(), params.studioId);
  if (!policy.ok || !policy.policy.portal) {
    throw new Error("Portal session refused: client portal access is off");
  }
  const raw = generateRawToken();
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  const admin = createAdminClient();
  const { error } = await admin.from("client_portal_sessions").insert({
    studio_id: params.studioId,
    client_id: params.clientId,
    session_token_hash: tokenHash,
    expires_at: expiresAt.toISOString(),
  });
  if (error) {
    throw new Error(
      `Failed to create portal session: ${error.code ?? "unknown"}`,
    );
  }

  const jar = await cookies();
  jar.set({
    name: COOKIE_NAME,
    value: raw,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

// Revoke the current session (if any). Clears the cookie and stamps
// revoked_at on the matching DB row. Safe to call when no session
// exists; in that case the cookie clear is a no-op.
export async function destroyPortalSession(): Promise<void> {
  const jar = await cookies();
  const raw = jar.get(COOKIE_NAME)?.value;
  if (raw && raw.length > 0) {
    const tokenHash = hashToken(raw);
    const admin = createAdminClient();
    const { error } = await admin
      .from("client_portal_sessions")
      .update({ revoked_at: new Date().toISOString() })
      .eq("session_token_hash", tokenHash)
      .is("revoked_at", null);
    if (error) {
      console.error(
        JSON.stringify({
          event: "portal_session_revoke_failed",
          code: error.code,
          timestamp: new Date().toISOString(),
        }),
      );
      // Fall through and clear the cookie anyway; an orphaned DB row
      // is harmless and will expire on its own. The user expects
      // log-out to log them out.
    }
  }
  // Cookie clear: setting empty value with an expired Expires header
  // is the canonical Next.js cookies API pattern.
  jar.set({
    name: COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: new Date(0),
  });
}
