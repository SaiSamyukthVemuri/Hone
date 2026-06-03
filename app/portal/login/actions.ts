"use server";

import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { sendEmailSafely } from "@/lib/email/send-appointment";
import {
  limitPortalMagicLink,
  RATE_LIMIT_MESSAGE,
} from "@/lib/rate-limit/public";
import {
  generateRawToken,
  hashFingerprint,
  hashToken,
} from "@/lib/portal/tokens";
import { findActiveClientsForPortalLogin } from "@/lib/portal/queries";
import { buildPortalMagicLinkEmail } from "@/lib/email/templates/portal-magic-link";

const APP_ORIGIN = process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://hone.care";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAGIC_LINK_TTL_MS = 30 * 60 * 1000;

// Generic success message returned for every valid login request,
// regardless of whether an active client matched. This is the no-
// enumeration guarantee: a visitor who tries an email cannot learn
// whether that email belongs to an active client, an archived
// client, or no client at all.
const GENERIC_SUCCESS =
  "If that email is on file, we sent a secure link.";

const INVALID_EMAIL = "Please enter a valid email address.";

// Timing-oracle floor for well-formed portal login requests. The
// match branch does at least one DB insert, one DB select, and one
// outbound HTTP send (the Resend call); the no-match branch returns
// straight after the lookup. Without a floor, the wall-clock delta
// is large enough to be measurable from a network client and is a
// soft enumeration channel. We pad every post-rate-limit branch
// (match, no-match, insert failure, email failure, multiple
// matches) to the same floor so the visible response time is
// uniform.
//
// 900 ms comfortably covers the slowest match path (DB insert +
// studio lookup + Resend POST with default timeout headroom) on
// production while still feeling responsive. The floor is applied
// AFTER the email-syntax check and AFTER the rate-limit check;
// those two paths return immediately on rejection because rejecting
// them quickly is itself useful signal to the visitor (typo / over
// the limit) and revealing nothing about client-record state.
const MIN_PORTAL_LOGIN_RESPONSE_MS = 900;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilMinimumElapsed(startedAt: number): Promise<void> {
  const elapsed = Date.now() - startedAt;
  const remaining = MIN_PORTAL_LOGIN_RESPONSE_MS - elapsed;
  if (remaining > 0) await sleep(remaining);
}

export type RequestPortalLinkResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

// Public action invoked by the /portal/login form. Always returns
// ok:true with the same generic message on the happy path; the
// caller never learns whether an email actually triggered a send.
// Returns ok:false only for visitor-input errors (malformed email)
// and rate-limit refusals; neither leaks client-record state.
export async function requestPortalMagicLinkAction(
  formData: FormData,
): Promise<RequestPortalLinkResult> {
  const rawEmail = (formData.get("email") ?? "").toString();
  const trimmed = rawEmail.trim();
  if (!trimmed || !EMAIL_RE.test(trimmed)) {
    return { ok: false, error: INVALID_EMAIL };
  }
  const emailNormalized = trimmed.toLowerCase();

  const hdrs = await headers();

  // Rate limit by IP and email. Sliding windows; fails open. Runs
  // BEFORE any DB read so the limiter result is independent of
  // whether a client matched.
  const gate = await limitPortalMagicLink({
    headers: hdrs,
    email: emailNormalized,
  });
  if (!gate.allowed) {
    return { ok: false, error: RATE_LIMIT_MESSAGE };
  }

  // Timing-oracle floor anchor. Captured AFTER the email-syntax
  // check and AFTER the rate-limit check so those two rejection
  // paths return immediately. Every well-formed branch below
  // awaits waitUntilMinimumElapsed(startedAt) right before
  // returning the generic success so the visible response time is
  // uniform across no-match, single-match, multi-match, insert
  // failure, and email-send failure.
  const startedAt = Date.now();

  // Hashed fingerprints recorded on every issued magic-link row for
  // audit. Hashing prevents the DB from ever holding raw IP/UA.
  const ipHash = hashFingerprint(clientIpFromHeaders(hdrs));
  const uaHash = hashFingerprint(hdrs.get("user-agent"));

  const matches = await findActiveClientsForPortalLogin(emailNormalized);

  if (matches.length === 0) {
    // No active client. Return the same generic message; we
    // deliberately do NOT log the email or signal that nothing
    // happened from the caller's perspective. The hashed email is
    // safe to log (salted SHA-256 via hashFingerprint) and helps an
    // operator triage a brute-force attempt without storing the
    // raw address.
    logSanitized("portal_login_request_no_match", {
      emailHash: hashFingerprint(emailNormalized),
    });
    await waitUntilMinimumElapsed(startedAt);
    return { ok: true, message: GENERIC_SUCCESS };
  }

  // Pilot safety: when the same normalized email matches multiple
  // active clients (e.g. test data collisions, or a real client who
  // exists in more than one studio's roster) we must NOT fan out a
  // magic link per match. Sending several emails to one address is
  // confusing and the visitor cannot tell which link belongs to
  // which (studio, client) pair from the email body, which is
  // intentionally generic for no-enumeration reasons. For the
  // pilot we refuse the send, log a sanitized review signal, and
  // return the same generic success so a visitor cannot probe the
  // multi-match condition by timing or by observing inbox state.
  // A future multi-studio claim flow can replace this branch with
  // a chooser surface; that is out of scope here.
  if (matches.length > 1) {
    logSanitized("portal_login_multiple_matches_needs_review", {
      emailHash: hashFingerprint(emailNormalized),
      matchCount: matches.length,
    });
    await waitUntilMinimumElapsed(startedAt);
    return { ok: true, message: GENERIC_SUCCESS };
  }

  const admin = createAdminClient();

  // Single-match branch. The matches.length === 1 invariant is
  // guaranteed by the early returns above; the for-loop shape is
  // retained for diff cleanliness but executes exactly once.
  let successfulSends = 0;
  for (const match of matches) {
    const rawToken = generateRawToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS);

    const { error: insertErr } = await admin
      .from("client_portal_magic_links")
      .insert({
        studio_id: match.studioId,
        client_id: match.clientId,
        token_hash: tokenHash,
        email_normalized: emailNormalized,
        expires_at: expiresAt.toISOString(),
        created_ip_hash: ipHash,
        user_agent_hash: uaHash,
      });
    if (insertErr) {
      logSanitized("portal_login_magic_insert_failed", {
        code: insertErr.code,
        message: insertErr.message,
      });
      continue;
    }

    // Resolve the studio name for the email subject + body. Cheap
    // single-row select; never selects sensitive columns.
    const { data: studioRow } = await admin
      .from("studios")
      .select("name")
      .eq("id", match.studioId)
      .maybeSingle();
    const studioName = studioRow?.name?.trim() || "your studio";

    const magicLink = `${APP_ORIGIN}/portal/verify/${rawToken}`;
    const email = buildPortalMagicLinkEmail({
      studioName,
      magicLink,
    });

    const sendResult = await sendEmailSafely({
      to: trimmed,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
    if (sendResult.ok) {
      successfulSends += 1;
    } else {
      logSanitized("portal_login_email_send_failed", {
        retryable: sendResult.retryable,
        error: sendResult.error,
      });
    }
  }

  logSanitized("portal_login_request_match", {
    matchCount: matches.length,
    successfulSends,
  });
  // Same timing floor as the no-match branch. The match branch
  // already does at least one DB insert + studio select + Resend
  // POST, so the floor is usually a no-op here; we still call it
  // unconditionally so a fast-path (e.g. cache hit, env-disabled
  // Resend) cannot collapse the wall-clock delta. Insert-failure
  // and email-failure cases hit this same return via the loop
  // above, so they get the floor as well.
  await waitUntilMinimumElapsed(startedAt);
  return { ok: true, message: GENERIC_SUCCESS };
}

// Pull a best-effort client IP from the proxy headers in the same
// way lib/rate-limit/public.ts does. We re-implement the small
// helper rather than import it because that file's helper is
// non-exported and we want one stable owner of the IP-shape.
function clientIpFromHeaders(h: Headers): string {
  const forwarded = h.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = h.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "0.0.0.0";
}

function logSanitized(event: string, detail: Record<string, unknown>) {
  try {
    console.log(
      JSON.stringify({
        event,
        ...detail,
        timestamp: new Date().toISOString(),
      }),
    );
  } catch {
    console.log(event);
  }
}
