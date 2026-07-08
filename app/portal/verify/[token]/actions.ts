"use server";

import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { hashToken } from "@/lib/portal/tokens";
import { createPortalSession } from "@/lib/portal/session";
import { logPortalAccessEvent } from "@/lib/portal/access-events";

// Server action that actually consumes a portal magic-link token and
// creates the portal session. Split out from the verify page so the
// GET request is non-consuming: email scanners, security gateways,
// and link-preview bots that fetch the magic-link URL no longer burn
// the visitor's single-use token before the human clicks the
// Continue button. The Continue button posts to this action.
//
// Same defense-in-depth shape as the previous one-step verify:
//   1. hash the submitted token
//   2. SELECT the magic-link row
//   3. reject unknown / expired / already-consumed tokens
//   4. reject when the linked client is missing or archived
//   5. atomically stamp consumed_at via a conditional UPDATE keyed
//      on consumed_at IS NULL (concurrent POST races resolve to one
//      winner)
//   6. create the portal session + set the httpOnly cookie
//   7. redirect to /portal
//
// Any failure path redirects back to /portal/verify/<token>; the
// page re-runs its GET-side validation, finds the token now
// missing / consumed / expired, and renders the same generic
// "This secure link can't be used right now" surface. No internal
// state is leaked.

export async function verifyPortalMagicLinkAction(
  formData: FormData,
): Promise<void> {
  const token = (formData.get("token") ?? "").toString();

  // Empty token shouldn't happen (the page's GET handler guards
  // against rendering the form without one) but a forged or
  // truncated POST could still hit this path. Bounce to the login
  // page rather than the verify page so the empty-token case can't
  // be used to bounce-loop.
  if (!token || token.length === 0) {
    redirect("/portal/login");
  }

  const tokenHash = hashToken(token);
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();

  const { data: link, error: lookupErr } = await admin
    .from("client_portal_magic_links")
    .select(
      "id, studio_id, client_id, expires_at, consumed_at",
    )
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (lookupErr) {
    console.error(
      JSON.stringify({
        event: "portal_verify_post_lookup_failed",
        code: lookupErr.code,
        message: lookupErr.message,
        timestamp: new Date().toISOString(),
      }),
    );
    redirect(`/portal/verify/${token}`);
  }
  if (!link || link.consumed_at != null || link.expires_at <= nowIso) {
    redirect(`/portal/verify/${token}`);
  }

  // Defense in depth: an archive that happened between the GET
  // validation and this POST must not let a session through.
  const { data: clientRow } = await admin
    .from("clients")
    .select("id, studio_id, archived_at")
    .eq("id", link.client_id)
    .eq("studio_id", link.studio_id)
    .maybeSingle();
  if (!clientRow || clientRow.archived_at != null) {
    redirect(`/portal/verify/${token}`);
  }

  // Atomic single-use stamp. The conditional .is("consumed_at",
  // null) means a concurrent POST of the same token races on this
  // UPDATE and only one side wins; the other observes a zero-row
  // result via .select() and is bounced back to the verify page,
  // which will then render the same generic unavailable surface.
  const { data: consumedRows, error: consumeErr } = await admin
    .from("client_portal_magic_links")
    .update({ consumed_at: nowIso })
    .eq("id", link.id)
    .is("consumed_at", null)
    .select("id");
  if (consumeErr) {
    console.error(
      JSON.stringify({
        event: "portal_verify_post_consume_failed",
        code: consumeErr.code,
        message: consumeErr.message,
        timestamp: new Date().toISOString(),
      }),
    );
    redirect(`/portal/verify/${token}`);
  }
  if (!consumedRows || consumedRows.length === 0) {
    // Lost the consume race; another POST already used this token.
    redirect(`/portal/verify/${token}`);
  }

  // Record the sign-in (magic link consumed) for the practitioner status view.
  // Client action → no practitioner_id; studio + client ids only, never the
  // token/URL. Fail-soft so it can never block the redirect.
  await logPortalAccessEvent(admin, {
    studioId: link.studio_id,
    clientId: link.client_id,
    eventType: "portal_magic_link_consumed",
  });

  try {
    await createPortalSession({
      studioId: link.studio_id,
      clientId: link.client_id,
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "portal_verify_post_session_create_failed",
        message: err instanceof Error ? err.message : "unknown",
        timestamp: new Date().toISOString(),
      }),
    );
    redirect(`/portal/verify/${token}`);
  }

  redirect("/portal");
}
