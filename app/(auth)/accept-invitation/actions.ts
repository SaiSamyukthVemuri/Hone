"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { clearSelectedStudioId } from "@/lib/supabase/selected-studio";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import { sessionMailboxProof } from "@/lib/auth/session-email-proof";

export type AcceptState = { error: string; needsVerification?: boolean } | null;

export const MAILBOX_PROOF_REQUIRED =
  "Confirm that this email address is yours first: we will send a one-time link to it.";

// THE authoritative acceptance point. The browser cannot call the acceptance
// command directly (it is service-role only). This trusted server adapter:
//   1. validates the unchecked-by-default current-policy checkbox;
//   2. resolves the authenticated user from the session;
//   3. calls admin_accept_pending_invitation(p_user_id) via the service-role
//      client, passing ONLY the session user id: the command derives the
//      verified email + current policy versions internally and accepts no
//      email/studio/role/timestamps/versions from the browser.
export async function acceptInvitationAction(
  _prev: AcceptState,
  formData: FormData,
): Promise<AcceptState> {
  const consent = formData.get("consent");
  if (consent !== "on" && consent !== "true") {
    return {
      error:
        "Please confirm you agree to the current Terms of Service and Privacy Policy.",
    };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // PROOF OF MAILBOX CONTROL IN THIS SESSION. The invited address is the authority for the membership, and Supabase
  // auto-confirms accounts created while "Confirm email" was off, so a password session on such an account proves nothing.
  // Only a session created by a link/code sent to the address (or Google asserting it) may accept (lib/auth/email-proof.ts).
  const proof = await sessionMailboxProof(supabase, user);
  if (!proof.method) return { error: MAILBOX_PROOF_REQUIRED, needsVerification: true };

  // Service-role acceptance command; the browser cannot reach it.
  const admin = createAdminClient();
  const { data: rec, error } = await admin.rpc(
    "admin_accept_pending_invitation",
    { p_user_id: user.id },
  );
  if (error) {
    return { error: "Something went wrong. Please try again." };
  }

  const res = (rec && typeof rec === "object" ? rec : {}) as {
    status?: string;
    choose_studio?: boolean;
  };

  if (res.status === "conflict") redirect("/no-access?reason=invite-conflict");
  if (res.status === "ambiguous") redirect("/no-access?reason=invite-ambiguous");
  if (res.status === "no_invitation") redirect("/no-access");

  // Complete acceptance only when the governed command confirms success.
  // Missing or unknown responses must not clear selection or imply a join.
  if (res.status !== "linked" && res.status !== "already_linked") {
    return { error: "Something went wrong. Please try again." };
  }

  // linked / already_linked. Force the chooser for a newly multi-studio user.
  if (res.choose_studio === true) {
    await clearSelectedStudioId();
  }
  redirect("/dashboard");
}

export type ProofLinkState = { status: "idle" } | { status: "sent" } | { status: "error"; message: string };

// Sends the one-time link/code to the SESSION USER'S OWN address (never an address from the form), so redeeming it creates a
// session that proves the mailbox. shouldCreateUser is false: this can only sign an existing account in.
export async function sendMailboxProofLinkAction(
  _prev: ProofLinkState,
  _formData: FormData,
): Promise<ProofLinkState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (!user.email) return { status: "error", message: "This account has no email address." };
  const { error } = await supabase.auth.signInWithOtp({
    email: user.email,
    options: {
      shouldCreateUser: false,
      emailRedirectTo: `${getRequiredAppOrigin()}/auth/callback?next=/accept-invitation`,
    },
  });
  if (error) return { status: "error", message: "We could not send the link. Please try again in a minute." };
  return { status: "sent" };
}
