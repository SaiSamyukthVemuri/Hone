import "server-only";
import { cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { generateRawToken, hashToken } from "./tokens";

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

// Read the cookie, hash its value, look the row up, and return the
// resolved session. Returns null when:
//   * no cookie is present (anonymous visitor)
//   * the hash doesn't match any row (forged or stale cookie)
//   * the row is expired or revoked
//
// Refreshes last_seen_at as a best-effort metric; failure to write it
// never blocks the session.
export async function getCurrentPortalSession(): Promise<PortalSession | null> {
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
    // Log sanitized; never include the raw cookie or its hash. A DB
    // outage should not 500 the page render; treat as anonymous.
    console.error(
      JSON.stringify({
        event: "portal_session_lookup_failed",
        code: error.code,
        message: error.message,
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
  // client PII; a failed touch never affects the returned session.
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
              sessionId: data.id,
              code: touchError.code,
              message: touchError.message,
              timestamp: new Date().toISOString(),
            }),
          );
        }
      },
      (err: unknown) => {
        console.error(
          JSON.stringify({
            event: "portal_session_last_seen_update_failed",
            sessionId: data.id,
            err: err instanceof Error ? err.message : String(err),
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
          message: error.message,
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
