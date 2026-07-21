"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { isAdmin } from "@/lib/admin";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import { deliverWelcomeEmail } from "@/lib/email/send-welcome";
// (welcome email is one truthful invitation; no account-variant)
import { logAdminAction } from "@/lib/audit/admin-actions";

import type { WelcomeEmailResult } from "@/lib/email/send-welcome";
import { auditOutcomeFor } from "./audit-outcome";

export type ResendWelcomeResult = {
  ok: boolean;
  status?: WelcomeEmailResult;
  error?: string;
};

// Operator-only "Resend welcome email" for a studio. Re-checks isAdmin (the
// real gate; defense-in-depth over the /admin layout), then reuses the same
// deliverWelcomeEmail path as studio creation — which also re-stamps the send
// outcome on studio_onboarding. Never mints an auth user or touches
// practitioners. Best-effort; surfaces the send outcome to the operator.
export async function resendWelcomeEmailAction(
  studioId: string,
): Promise<ResendWelcomeResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isAdmin(user.email)) {
    await logAdminAction({
      actorUserId: user?.id ?? null,
      actorEmail: user?.email ?? null,
      action: "welcome_email_resent",
      targetType: "studio",
      targetId: studioId,
      outcome: "blocked",
    });
    return { ok: false, error: "Not authorized." };
  }

  const admin = createAdminClient();
  const { data: studio, error } = await admin
    .from("studios")
    .select("id, name, slug, owner_email")
    .eq("id", studioId)
    .maybeSingle();
  if (error || !studio) {
    return { ok: false, error: "Studio not found." };
  }

  // One truthful invitation email (no account-variant inference).
  const status = await deliverWelcomeEmail(admin, {
    studioId: studio.id,
    ownerDisplayName: null,
    ownerEmail: studio.owner_email,
    studioName: studio.name,
    bookingUrl: studio.slug
      ? `${getRequiredAppOrigin()}/book/${studio.slug}`
      : "",
  });

  await logAdminAction({
    actorUserId: user.id,
    actorEmail: user.email ?? null,
    studioId: studio.id,
    targetType: "studio",
    targetId: studio.id,
    action: "welcome_email_resent",
    outcome: auditOutcomeFor(status),
    metadata: { slug: studio.slug ?? undefined, welcome_email_result: status },
  });

  revalidatePath(`/admin/studios/${studioId}`);
  return { ok: status !== "failed", status };
}
