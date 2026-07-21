import "server-only";
import { getResendTransport, FROM_ADDRESS } from "@/lib/email/client";
import {
  buildWelcomeEmail,
  type WelcomeEmailParams,
} from "@/lib/email/templates/welcome";
import {
  claimWelcomeEmailAttempt,
  stampWelcomeEmailStatus,
} from "@/lib/onboarding/state";
import type { createAdminClient } from "@/lib/supabase/admin-server";
import type { WelcomeEmailStatus } from "@/lib/types/database";

// Bounded error marker: welcome_email_error:<stage>:<safe_code>. NEVER logs the
// provider error object, the recipient address, or any DB error text.
function markError(stage: string, code: string): void {
  console.error(`welcome_email_error:${stage}:${code}`);
}

// Sends the ONE truthful invitation email and records the outcome (Sent /
// Failed — never "delivered"; no provider delivery evidence exists). Never
// throws (studio create / resend must not depend on email). A single-attempt
// claim dedupes concurrent resends / rapid double-clicks. No account-variant is
// inferred — the copy is truthful for both new and existing accounts.
export async function deliverWelcomeEmail(
  admin: ReturnType<typeof createAdminClient>,
  params: { studioId: string } & WelcomeEmailParams,
): Promise<WelcomeEmailStatus> {
  const { studioId, ...emailParams } = params;

  // Single-attempt claim: concurrent resend / double-click -> exactly one send.
  let claimed = false;
  try {
    claimed = await claimWelcomeEmailAttempt(admin, studioId);
  } catch {
    markError("claim", "write_failed");
    claimed = true; // fail-open so a claim-write error never drops the first send
  }
  if (!claimed) {
    // Another attempt is in flight or just fired; do not send again.
    return "sent";
  }

  const transport = getResendTransport();
  let status: WelcomeEmailStatus = "not_sent";
  if (!transport) {
    // Not configured (dev/preview): nothing sends; recorded honestly.
  } else {
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
        status = "failed";
        markError("send", "provider_rejected");
      } else {
        status = "sent";
      }
    } catch {
      status = "failed";
      markError("send", "provider_exception");
    }
  }

  try {
    await stampWelcomeEmailStatus(admin, studioId, status);
  } catch {
    markError("stamp", "write_failed");
  }
  return status;
}
