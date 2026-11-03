import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  captureServerEvent,
  identifyServerUser,
} from "@/lib/analytics/server";
import { isAnalyticsUuid } from "@/lib/analytics/ids";
import type { EmailOtpType } from "@supabase/supabase-js";
import { claimsFromAccessToken, mailboxProofMethod } from "@/lib/auth/email-proof";
import { applyProofHardening, hardeningMode } from "@/lib/auth/proof-hardening";
import { createAdminClient } from "@/lib/supabase/admin-server";

const EMAIL_OTP_TYPES: readonly EmailOtpType[] = ["signup", "magiclink", "invite", "recovery", "email"];

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  const tokenHash = searchParams.get("token_hash");
  const otpType = searchParams.get("type") as EmailOtpType | null;

  if (code || (tokenHash && otpType && EMAIL_OTP_TYPES.includes(otpType))) {
    const supabase = await createClient();
    // PKCE code (magic link, Google) or a token_hash link (signup confirmation / invitation templates). Both create a session
    // whose access token records HOW it was proven; that, not email_confirmed_at, is what the checks below read.
    const { data, error } = code
      ? await supabase.auth.exchangeCodeForSession(code)
      : await supabase.auth.verifyOtp({ token_hash: tokenHash as string, type: otpType as EmailOtpType });
    if (!error && data.user) {
      // Post-response, bounded: sign-in must never fail or stall because
      // PostHog is unavailable (P1/P2-ANALYTICS-03). Identify by opaque UUID
      // only; the (app) layout re-identifies with the validated coarse role.
      if (isAnalyticsUuid(data.user.id)) {
        identifyServerUser({ id: data.user.id });
        captureServerEvent({
          actor: { kind: "user", id: data.user.id },
          event: "user_signed_in",
          properties: { provider: "magic_link" },
        });
      }

      // Existing-account invitation reconciliation. handle_new_user() only
      // provisions the membership when a NEW auth.users row is inserted, so an
      // email that already has a Hone account, invited to a new studio, would
      // otherwise sign in with the invite left 'pending' and land on /no-access.
      // The self-scoped RPC links the membership (copying valid current-version
      // acceptance evidence) or routes to explicit acceptance. It must NEVER
      // block sign-in, so any failure falls through to the default destination.
      let dest = next;
      let clearSelection = false;

      // MAILBOX PROOF (2 Nov). A session proves control of the account's email only when this very sign-in was a link/code sent
      // to it, or Google asserting that exact verified address. A password sign-in on an account auto-confirmed while "Confirm
      // email" was off proves nothing, so it must not link a membership. Not proven -> no reconcile; the person lands on the
      // accept page, which asks for a link to the address first.
      const accessToken = data.session?.access_token ?? null;
      const proven =
        mailboxProofMethod(claimsFromAccessToken(accessToken), {
          email: data.user.email,
          email_change_sent_at: data.user.email_change_sent_at,
          identities: data.user.identities,
        }) !== null;
      if (proven) {
        // Account-wide remediation is OFF unless the HONE_PROOF_HARDENING rollout flag says otherwise (lib/auth/proof-hardening.ts).
        // It rotates a password, which GoTrue answers by revoking every session, so it re-issues one for the person who just
        // proved the mailbox; if that cannot be done they sign in again. It never blocks sign-in otherwise.
        let outcome: string = "failed";
        try {
          outcome = await applyProofHardening({
            mode: hardeningMode(process.env.HONE_PROOF_HARDENING),
            user: data.user,
            makeAdmin: () => createAdminClient(),
            supabase,
          });
        } catch {
          // Never block sign-in on hardening.
        }
        if (outcome === "hardened_reissue_failed") return NextResponse.redirect(`${origin}/login?error=auth`);
      }
      try {
        if (!proven) throw new Error("mailbox not proven in this session");
        const { data: rec } = await supabase.rpc(
          "reconcile_my_pending_invitation",
        );
        const status =
          rec && typeof rec === "object"
            ? (rec as { status?: string; choose_studio?: boolean })
            : null;
        if (status?.status === "acceptance_required") {
          dest = "/accept-invitation";
        } else if (status?.status === "conflict") {
          dest = "/no-access?reason=invite-conflict";
        } else if (status?.status === "ambiguous") {
          dest = "/no-access?reason=invite-ambiguous";
        } else if (
          (status?.status === "linked" ||
            status?.status === "already_linked") &&
          status?.choose_studio === true
        ) {
          // Newly a multi-studio user: force a truthful chooser (clear any
          // selection; middleware routes 2+ memberships w/o selection there).
          dest = "/dashboard";
          clearSelection = true;
        }
      } catch {
        // Never block sign-in on reconciliation.
      }

      // Treat the caller's destination as a path, never an origin suffix.
      // URL parsing also normalizes backslashes/control characters; compare
      // origins after that normalization before emitting a redirect.
      let destination = new URL("/dashboard", origin);
      if (dest.startsWith("/")) {
        try {
          const candidate = new URL(dest, origin);
          if (candidate.origin === origin) destination = candidate;
        } catch {
          // Malformed destinations keep the ordinary signed-in landing page.
        }
      }
      const response = NextResponse.redirect(destination);
      if (clearSelection) {
        response.cookies.delete("hone_selected_studio");
      }
      return response;
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
