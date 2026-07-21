import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { listActiveStudioMemberships } from "@/lib/supabase/queries";
import { signOutFromGate, switchStudioAction } from "./actions";

// Invite-only "no studio access yet" gate (PR #253). Hone is invite-only
// for supervised studios. A signed-in user with NO active practitioner
// row (e.g. an uninvited Google sign-in — auth.users exists but
// handle_new_user created no studio/practitioner) is sent here by the app
// shell guard (requirePractitionerWithStudio) instead of seeing a raw
// error or any studio data.
//
// This page does its OWN lightweight check (never calls
// requirePractitionerWithStudio, which would loop): no auth user ->
// /login; an active practitioner DOES exist -> /dashboard (they have
// access and should not be here); otherwise show the safe gate. It
// renders NO app navigation and reads NO studio data.

export const metadata = {
  title: "No studio access yet",
  robots: { index: false, follow: false },
};

const PALETTE = {
  bg: "#FAFAF7",
  ink: "#0A0A0A",
  muted: "#6B6B6B",
  rule: "#E5E2DA",
} as const;

export default async function NoAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  // Load active memberships (RLS-scoped, no .maybeSingle()). Exactly one active
  // studio -> they have access, send to /dashboard. Zero -> invite-only gate.
  // Two or more -> the studio chooser below.
  const memberships = await listActiveStudioMemberships();
  if (memberships.length === 1) {
    // They have studio access; the gate is not for them.
    redirect("/dashboard");
  }
  const multiple = memberships.length > 1;
  // Safe, self-scoped copy for the reconciliation edge cases (no DB/Auth text,
  // no cross-tenant information). These only apply to a 0-membership user.
  const inviteIssue =
    !multiple &&
    (reason === "invite-conflict" || reason === "invite-ambiguous");

  const heading = multiple
    ? "Choose a studio"
    : inviteIssue
      ? "We couldn't finish setting up your access"
      : "No studio access yet";
  const body = multiple
    ? "Your account is an active member of more than one studio. Choose which studio you want to work in — you can switch anytime from the account menu."
    : reason === "invite-conflict"
      ? "This invitation couldn't be completed automatically. Please contact the studio or Hone support so it can be sorted out."
      : reason === "invite-ambiguous"
        ? "There is more than one pending invitation for your account. Please contact the studio or Hone support so it can be resolved."
        : "Hone is currently invite-only for supervised studios. Use the email address your studio invitation was sent to, or contact Hone if you believe you should have access.";

  return (
    <main
      style={{
        backgroundColor: PALETTE.bg,
        color: PALETTE.ink,
        fontFeatureSettings: '"cv11"',
      }}
      className="flex min-h-screen items-center justify-center px-6 font-[var(--font-inter)]"
    >
      <div className="mx-auto w-full max-w-[440px] py-12 text-center">
        <span
          className="font-[var(--font-fraunces)] mb-10 inline-block text-[28px] font-bold leading-none"
          style={{ letterSpacing: "-0.02em", color: PALETTE.ink }}
        >
          Hone
        </span>

        <h1
          className="font-[var(--font-fraunces)] mb-6 text-[32px] font-bold leading-[1.05]"
          style={{ letterSpacing: "-0.02em", color: PALETTE.ink }}
        >
          {heading}
        </h1>

        <p
          className="mb-10 text-[16px] leading-[1.6]"
          style={{ color: PALETTE.muted }}
        >
          {body}
        </p>

        {multiple && (
          <div className="mb-10 flex flex-col items-stretch gap-3">
            {memberships.map((m) => (
              <form key={m.studioId} action={switchStudioAction}>
                <input type="hidden" name="studio_id" value={m.studioId} />
                <button
                  type="submit"
                  className="flex w-full flex-col items-start gap-0.5 px-5 py-3 text-left transition-opacity hover:opacity-80"
                  style={{ border: `1px solid ${PALETTE.ink}` }}
                >
                  <span
                    className="text-[16px] font-medium"
                    style={{ color: PALETTE.ink }}
                  >
                    {m.studioName}
                  </span>
                  <span className="text-[13px]" style={{ color: PALETTE.muted }}>
                    {m.role === "owner" ? "Owner" : "Practitioner"}
                  </span>
                </button>
              </form>
            ))}
          </div>
        )}

        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:justify-center">
          <form action={signOutFromGate}>
            <button
              type="submit"
              className="w-full px-7 py-3 text-[14px] font-medium uppercase transition-opacity hover:opacity-90 sm:w-auto"
              style={{
                backgroundColor: PALETTE.ink,
                color: PALETTE.bg,
                letterSpacing: "0.12em",
              }}
            >
              Sign out
            </button>
          </form>
          <a
            href="mailto:hello@hone.care?subject=Hone%20access%20request"
            className="inline-flex w-full items-center justify-center px-7 py-3 text-[14px] font-medium uppercase transition-colors hover:opacity-70 sm:w-auto"
            style={{
              border: `1px solid ${PALETTE.ink}`,
              color: PALETTE.ink,
              letterSpacing: "0.12em",
            }}
          >
            Contact Hone
          </a>
        </div>
      </div>
    </main>
  );
}
