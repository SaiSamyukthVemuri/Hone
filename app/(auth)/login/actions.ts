"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getRequiredAppOrigin } from "@/lib/app-origin";

// PR #189 (pilot safety): Hone is invite-only during the pilot.
//
// Previously the login page called supabase.auth.signInWithOtp from
// the browser with the default shouldCreateUser=true, so ANY visitor
// who typed an email got an auth user created on link consumption,
// and the handle_new_user() trigger's no-invite fallback then created
// a brand-new studio for them. This action moves the magic-link
// request server-side and only allows auth-user creation when a
// pending invitation exists for the address:
//
//   * pending invite          -> shouldCreateUser=true. First login
//     creates the auth user; handle_new_user() matches the invite and
//     places the practitioner in the inviting studio (0007 path).
//   * no pending invite       -> shouldCreateUser=false. Existing
//     practitioners still receive their sign-in link; unknown emails
//     get nothing and no user/studio is created.
//
// The response is the same generic success either way so the login
// form is not an account-enumeration oracle. The Google OAuth button
// cannot pass shouldCreateUser and may still create an auth user on
// first OAuth login, but migration 0081 removed handle_new_user()'s
// no-invite fallback, so an uninvited OAuth user gets no studio, no
// practitioner row, and no app access (documented in docs/03).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type MagicLinkResult = { ok: true } | { ok: false; error: string };

export async function requestPractitionerMagicLinkAction(
  email: string,
): Promise<MagicLinkResult> {
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalized)) {
    return { ok: false, error: "Enter a valid email address." };
  }

  // Invite lookup runs through the admin client: the requester is
  // anonymous and pending_invitations is RLS-gated to studio members.
  // ilike with no wildcards = case-insensitive equality, matching the
  // lower(email) semantics of the handle_new_user() trigger. A lookup
  // error fails CLOSED for signup (no user creation) while still
  // letting existing practitioners get their link.
  const admin = createAdminClient();
  const { data: invite, error: inviteError } = await admin
    .from("pending_invitations")
    .select("id")
    .ilike("email", normalized)
    .eq("status", "pending")
    .maybeSingle();
  const allowSignup = !inviteError && Boolean(invite);

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: normalized,
    options: {
      emailRedirectTo: `${getRequiredAppOrigin()}/auth/callback`,
      shouldCreateUser: allowSignup,
    },
  });

  if (error) {
    // "Signups not allowed for otp" is Supabase telling us the email
    // has no account and creation was disabled: exactly the uninvited
    // case. Collapse it into the generic success so the form does not
    // reveal which emails have accounts. Other errors (rate limit,
    // config) return a generic retry message without error details.
    if (/signups not allowed/i.test(error.message)) {
      return { ok: true };
    }
    return {
      ok: false,
      error: "Could not send the sign-in link. Try again in a moment.",
    };
  }
  return { ok: true };
}
