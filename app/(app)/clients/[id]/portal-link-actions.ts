"use server";

import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { limitPractitionerClientEmail } from "@/lib/rate-limit/public";
import { issuePortalMagicLink } from "@/lib/portal/magic-link";

export type SendPortalLinkResult = { ok: true } | { ok: false; error: string };

// Practitioner "Send portal link": emails a KNOWN client a secure magic link to
// THEIR studio's portal, reusing the shared hashed / single-use / 60-minute
// issuance. STUDIO-SCOPED — the client is loaded WHERE studio_id = the
// practitioner's studio, so a client in another studio is simply not found (no
// cross-studio send). RATE-LIMITED (3/hour per practitioner+client). No
// enumeration concern (the practitioner already sees this client). The email
// carries no clinical/intake/payment data; the raw token is never logged.
export async function sendPortalLinkAction(
  formData: FormData,
): Promise<SendPortalLinkResult> {
  const clientId = String(formData.get("client_id") ?? "").trim();
  if (!clientId) return { ok: false, error: "Missing client." };

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot send portal links." };
  }

  const rl = await limitPractitionerClientEmail({
    action: "portal_link",
    practitionerId: practitioner.id,
    clientId,
  });
  if (!rl.allowed) {
    return {
      ok: false,
      error: "Too many portal links sent to this client recently. Please try again later.",
    };
  }

  const admin = createAdminClient();
  // Studio-scoped lookup: a client in another studio is not found here.
  const { data: client, error } = await admin
    .from("clients")
    .select("id, email")
    .eq("id", clientId)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (error || !client) return { ok: false, error: "Client not found in your studio." };
  if (!client.email) {
    return {
      ok: false,
      error: "This client has no email on file. Add one to send a portal link.",
    };
  }

  const result = await issuePortalMagicLink(admin, {
    studioId: studio.id,
    clientId: client.id,
    email: client.email,
    studioName: studio.name,
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}
