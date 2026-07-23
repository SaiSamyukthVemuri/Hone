import "server-only";
import { getResendTransport, FROM_ADDRESS } from "@/lib/email/client";
import { buildWelcomeEmail, type WelcomeEmailParams } from "@/lib/email/templates/welcome";
import {
  claimWelcomeEmailAttempt,
  recordWelcomeEmailResult,
} from "@/lib/onboarding/state";
import type { createAdminClient } from "@/lib/supabase/admin-server";

// Truthful application result — never claims success unless THIS invocation sent.
export type WelcomeEmailResult =
  | "sent"
  | "failed"
  | "not_configured"
  | "already_in_progress";

// Bounded error marker: welcome_email_error:<stage>:<safe_code>. NEVER logs the
// provider error object, the recipient address, or any DB error text.
function markError(stage: string, code: string): void {
  console.error(`welcome_email_error:${stage}:${code}`);
}

// Sends the ONE truthful invitation email and records the outcome via the
// attempt-id state machine (not_sent -> sending -> sent | failed; never
// "delivered"). Never throws (studio create / resend must not depend on email).
// Every Supabase error is inspected: a claim/stamp failure NEVER masquerades as
// success, and a caller that lost the single-flight race returns
// already_in_progress (it sends nothing) rather than a false "sent".
export async function deliverWelcomeEmail(
  admin: ReturnType<typeof createAdminClient>,
  params: { studioId: string } & WelcomeEmailParams,
): Promise<WelcomeEmailResult> {
  const { studioId, ...emailParams } = params;

  // Attempt-id single-flight claim.
  const claim = await claimWelcomeEmailAttempt(admin, studioId);
  if (claim.error) {
    // The claim RPC itself failed: do NOT send (dedup would be defeated) and do
    // NOT report success. Studio/invite creation stays successful.
    markError("claim", "write_failed");
    return "failed";
  }
  if (claim.attemptId === null) {
    // A live attempt already owns the send; this invocation sends nothing.
    return "already_in_progress";
  }
  const attemptId = claim.attemptId;

  const transport = getResendTransport();
  if (!transport) {
    // Not configured (dev/preview): nothing sent; revert 'sending' -> not_sent.
    const rec = await recordWelcomeEmailResult(admin, studioId, attemptId, "not_sent");
    if (rec.error) markError("stamp", "write_failed");
    return "not_configured";
  }

  let sendStatus: "sent" | "failed";
  const { subject, html, text } = buildWelcomeEmail(emailParams);
  try {
    const { error } = await transport.emails.send({
      from: FROM_ADDRESS,
      to: emailParams.ownerEmail,
      subject,
      html,
      text,
    });
    if (error) {
      sendStatus = "failed";
      markError("send", "provider_rejected");
    } else {
      sendStatus = "sent";
    }
  } catch {
    sendStatus = "failed";
    markError("send", "provider_exception");
  }

  // Compare-and-set on the attempt id: a newer retry (rec.applied === false with
  // no error) legitimately supersedes this attempt's result; a write error is
  // logged. Either way we report what THIS send actually did.
  const rec = await recordWelcomeEmailResult(admin, studioId, attemptId, sendStatus);
  if (rec.error) markError("stamp", "write_failed");
  return sendStatus;
}
