import { generateRawToken, hashToken } from "@/lib/portal/tokens";
import { buildPortalMagicLinkEmail } from "@/lib/email/templates/portal-magic-link";
import { sendEmailSafely } from "@/lib/email/send-appointment";
import { getRequiredAppOrigin } from "@/lib/app-origin";

// Shared client-portal magic-link issuance. Used by the new practitioner
// "Send portal link" action; mirrors the public self-request issuance
// (app/portal/login/actions.ts) so security is identical. The public action's
// MAGIC_LINK_TTL_MS is kept equal to this value (drift-guarded by a test).
export const PORTAL_MAGIC_LINK_TTL_MS = 60 * 60 * 1000; // 60 minutes

// Minimal structural admin type so callers pass their service-role client.
type PortalAdmin = { from: (table: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

export type IssuePortalMagicLinkResult = { ok: true } | { ok: false; error: string };

// Issue a secure portal magic link and email it. Security guarantees:
//   * 256-bit random token, SHA-256 HASHED at rest — only the hash is stored;
//   * single-use (the verify route stamps consumed_at atomically);
//   * 60-minute TTL (expires_at);
//   * STUDIO-SCOPED — studio_id + client_id are written on the row, so a link
//     is bound to one studio's one client;
//   * the RAW token appears ONLY in the emailed URL — never logged, never
//     returned;
//   * reuses the existing SAFE portal email (studio name + link only — no client
//     name, no clinical/intake/payment data).
export async function issuePortalMagicLink(
  admin: PortalAdmin,
  input: {
    studioId: string;
    clientId: string;
    email: string;
    studioName: string;
    createdIpHash?: string | null;
    userAgentHash?: string | null;
    ttlMs?: number;
  },
): Promise<IssuePortalMagicLinkResult> {
  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(
    Date.now() + (input.ttlMs ?? PORTAL_MAGIC_LINK_TTL_MS),
  );

  const { error: insertErr } = await admin
    .from("client_portal_magic_links")
    .insert({
      studio_id: input.studioId,
      client_id: input.clientId,
      token_hash: tokenHash,
      email_normalized: input.email.trim().toLowerCase(),
      expires_at: expiresAt.toISOString(),
      created_ip_hash: input.createdIpHash ?? null,
      user_agent_hash: input.userAgentHash ?? null,
    });
  if (insertErr) {
    // Safe log only — never the raw token.
    console.error(
      JSON.stringify({
        event: "portal_magic_link_insert_failed",
        code: insertErr.code,
        message: insertErr.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: "Could not create the portal link. Please try again." };
  }

  const studioName = input.studioName.trim() || "your studio";
  // The raw token is embedded in the URL that is emailed to the client. It is
  // NEVER logged and NEVER returned from this function.
  const magicLink = `${getRequiredAppOrigin()}/portal/verify/${rawToken}`;
  const email = buildPortalMagicLinkEmail({ studioName, magicLink });

  const sendResult = await sendEmailSafely({
    to: input.email,
    subject: email.subject,
    html: email.html,
    text: email.text,
  });
  if (!sendResult.ok) {
    console.error(
      JSON.stringify({
        event: "portal_magic_link_email_failed",
        retryable: sendResult.retryable,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: "The portal link email could not be sent. Please try again." };
  }

  console.log(
    JSON.stringify({
      event: "portal_magic_link_sent",
      studioId: input.studioId,
      clientId: input.clientId,
      timestamp: new Date().toISOString(),
    }),
  );
  return { ok: true };
}
