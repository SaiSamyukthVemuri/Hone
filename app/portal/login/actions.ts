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

  // Hashed fingerprints recorded on every issued magic-link row for
  // audit. Hashing prevents the DB from ever holding raw IP/UA.
  const ipHash = hashFingerprint(clientIpFromHeaders(hdrs));
  const uaHash = hashFingerprint(hdrs.get("user-agent"));

  const matches = await findActiveClientsForPortalLogin(emailNormalized);

  if (matches.length === 0) {
    // No active client. Return the same generic message; we
    // deliberately do NOT log the email or signal that nothing
    // happened from the caller's perspective.
    logSanitized("portal_login_request_no_match", {
      emailHash: hashFingerprint(emailNormalized),
    });
    return { ok: true, message: GENERIC_SUCCESS };
  }

  const admin = createAdminClient();

  // One magic link per (studio, client). The same email matching
  // multiple active studios produces one email per pair so the
  // visitor lands in the correct portal for whichever link they
  // click. Each link binds to one pair via the magic-link row.
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
