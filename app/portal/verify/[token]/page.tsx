import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentPortalSessionState } from "@/lib/portal/session";
import { RequestNewLink } from "./RequestNewLink";
import { MarketingFooter } from "@/app/_components/MarketingFooter";
import { MARKETING_PALETTE as PALETTE } from "@/app/_components/marketingNav";
import { EyebrowCaption } from "@/app/_components/MarketingAtoms";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { hashToken } from "@/lib/portal/tokens";
import { ContinueToPortalForm } from "./ContinueForm";
import { dbErrorCode } from "@/lib/logging/error-class";
import { studioPortalAccess } from "@/lib/portal/portal-access-gate";
import { clientPortalDisabledMessage } from "@/lib/booking/client-self-service-policy";

// PR #142. Token-bearing route. Robots noindex/nofollow keeps the
// URL out of search indexes; the next.config.ts headers() block
// adds the X-Robots-Tag header for the same prefix as a redundant
// signal to non-rendering crawlers. Analytics is also OFF for this
// subtree (root layout no longer mounts it; this route does not opt
// in via SafeAnalytics).
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// GET never consumes a link, sends email, creates a session or touches last_seen_at.
// Both identifiers must match an existing session before an old link can take
// someone straight into the portal. Recovery only sends a new proof by POST.
export default async function PortalVerifyPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // Empty token: render the generic unavailable surface without
  // any DB lookup; matches the public-collapse stance we use on
  // cancel / reschedule / manage.
  if (!token || token.length === 0) {
    return <Recovery token={token} />;
  }

  const tokenHash = hashToken(token);
  const admin = createAdminClient();

  // Read-only lookup. The unique index on token_hash means at
  // most one row. NO conditional update; the consumed_at stamp
  // lives on the POST action below.
  const { data: link, error: lookupErr } = await admin
    .from("client_portal_magic_links")
    .select("id, studio_id, client_id, email_normalized, expires_at, consumed_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (lookupErr) {
    console.error(
      JSON.stringify({
        event: "portal_verify_get_lookup_failed",
        code: dbErrorCode(lookupErr),
        timestamp: new Date().toISOString(),
      }),
    );
    return <Recovery token={token} />;
  }
  if (!link) return <Recovery token={token} />;
  const state = await getCurrentPortalSessionState({ recordVisit: false });
  const sameSession =
    state.kind === "active" &&
    state.session.studioId === link.studio_id &&
    state.session.clientId === link.client_id;
  const canConsume = link.consumed_at == null && Date.parse(link.expires_at) > Date.now();
  if (!sameSession && !canConsume) return <Recovery token={token} />;

  // Defense in depth: confirm the client is still active and
  // belongs to the same studio the link was minted for. An archive
  // that happened between request and verify must not let the
  // Continue button appear.
  const { data: clientRow } = await admin
    .from("clients")
    .select("id, studio_id, archived_at, normalized_email")
    .eq("id", link.client_id)
    .eq("studio_id", link.studio_id)
    .maybeSingle();
  if (!clientRow || clientRow.archived_at != null) {
    return <Recovery token={token} />;
  }

  // The active-session resolver has already checked this studio's policy.
  if (sameSession) redirect("/portal");

  // A fresh sign-in must still target the email on file when it was issued.
  if (!clientRow.normalized_email || clientRow.normalized_email !== link.email_normalized) {
    return <Recovery token={token} />;
  }

  // HON-47. A studio with client portal access off gets the explanation, and no
  // Continue form. An unreadable policy fails closed to the generic surface.
  const portalAccess = await studioPortalAccess(admin, link.studio_id);
  if (!portalAccess.allowed) {
    return portalAccess.studioName ? (
      <PortalOff message={clientPortalDisabledMessage(portalAccess.studioName)} />
    ) : (
      <Recovery token={token} />
    );
  }

  // Valid token. Render the Continue form. The form submits to the
  // server action which re-runs every check above and atomically
  // consumes the token before creating the portal session.
  return (
    <main
      style={{
        backgroundColor: PALETTE.bg,
        color: PALETTE.ink,
        fontFeatureSettings: '"cv11"',
      }}
      className="min-h-screen font-[var(--font-inter)]"
    >
      <section className="px-6 py-20 md:px-12 lg:px-16">
        <div className="mx-auto max-w-[520px] flex flex-col gap-8">
          <div>
            <EyebrowCaption>Client portal</EyebrowCaption>
            <h1
              className="font-[var(--font-fraunces)] mt-8 text-[32px] font-bold leading-tight md:text-[40px]"
              style={{ letterSpacing: "-0.025em" }}
            >
              Continue to your portal
            </h1>
            <p className="mt-2 text-[13px]" style={{ color: "#6B6B6B" }}>
              Select Continue to sign in securely on this device.
            </p>
          </div>
          <ContinueToPortalForm token={token} />
        </div>
      </section>
      <MarketingFooter />
    </main>
  );
}

function Recovery({ token }: { token: string }) {
  return (
    <main className="min-h-screen font-[var(--font-inter)]" style={{ backgroundColor: PALETTE.bg, color: PALETTE.ink }}>
      <section className="mx-auto max-w-[568px] px-6 py-20">
        <EyebrowCaption>Client portal</EyebrowCaption>
        <h1 className="mt-8 font-[var(--font-fraunces)] text-[36px] font-bold leading-tight tracking-tight">
          Sign in to your portal
        </h1>
        <p className="mt-4 mb-6 text-base leading-relaxed">
          Get a fresh sign-in link at the email address your studio has on file.
        </p>
        <RequestNewLink token={token} />
      </section>
      <MarketingFooter />
    </main>
  );
}

function PortalOff({ message }: { message: string }) {
  return (
    <main
      style={{
        backgroundColor: PALETTE.bg,
        color: PALETTE.ink,
        fontFeatureSettings: '"cv11"',
      }}
      className="min-h-screen font-[var(--font-inter)]"
    >
      <section className="px-6 py-20 md:px-12 lg:px-16">
        <div className="mx-auto max-w-[520px] flex flex-col gap-8">
          <div>
            <EyebrowCaption>Client portal</EyebrowCaption>
            <h1
              className="font-[var(--font-fraunces)] mt-8 text-[28px] font-bold leading-tight md:text-[36px]"
              style={{ letterSpacing: "-0.02em" }}
            >
              Online access isn&apos;t available
            </h1>
            <p className="mt-4 text-[16px] leading-relaxed text-[#0A0A0A]">{message}</p>
          </div>
        </div>
      </section>
      <MarketingFooter />
    </main>
  );
}
