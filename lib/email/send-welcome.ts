import "server-only";
import { resend, FROM_ADDRESS } from "@/lib/email/client";
import {
  buildWelcomeEmail,
  type WelcomeEmailParams,
} from "@/lib/email/templates/welcome";
import { stampWelcomeEmail } from "@/lib/onboarding/state";
import type { createAdminClient } from "@/lib/supabase/admin-server";
import type { WelcomeEmailStatus } from "@/lib/types/database";

// Sends the studio-owner welcome email through Resend and records the outcome
// on studio_onboarding (Sent / Failed — no delivered/opened tracking). Never
// throws: a studio must be created even if email/analytics fail. In dev the
// Resend client is null, so nothing sends and the status is recorded honestly.
//
// Reused by the admin studio-create action and the admin "Resend welcome email"
// action. Takes the caller's admin (service-role) client so no new service-role
// call site is introduced (the studio-create path already holds one, and the
// owner practitioner row does not exist yet at provisioning time).
export async function deliverWelcomeEmail(
  admin: ReturnType<typeof createAdminClient>,
  params: { studioId: string } & WelcomeEmailParams,
): Promise<WelcomeEmailStatus> {
  const { studioId, ...emailParams } = params;

  let status: WelcomeEmailStatus = "not_sent";
  if (!resend) {
    console.warn("Skipping welcome email: Resend client is not configured.");
  } else {
    const { subject, html, text } = buildWelcomeEmail(emailParams);
    try {
      const { error } = await resend.emails.send({
        from: FROM_ADDRESS,
        to: emailParams.ownerEmail,
        subject,
        html,
        text,
      });
      status = error ? "failed" : "sent";
      if (error) console.error("Failed to send welcome email:", error);
    } catch (error) {
      status = "failed";
      console.error("Failed to send welcome email:", error);
    }
  }

  // Seed/stamp the studio_onboarding row so the admin status view can show the
  // true send outcome. Best-effort; a stamp failure never fails the flow.
  try {
    await stampWelcomeEmail(admin, studioId, {
      status,
      variant: emailParams.variant,
    });
  } catch (error) {
    console.error("Failed to stamp welcome-email status:", error);
  }

  return status;
}
