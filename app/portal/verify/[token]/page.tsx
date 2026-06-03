import Link from "next/link";
import { MarketingFooter } from "@/app/_components/MarketingFooter";
import { MARKETING_PALETTE as PALETTE } from "@/app/_components/marketingNav";
import { EyebrowCaption } from "@/app/_components/MarketingAtoms";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { hashToken } from "@/lib/portal/tokens";
import { ContinueToPortalForm } from "./ContinueForm";

// Magic-link verify page. The GET request that lands here is now
// NON-CONSUMING: it validates the token shape, checks the row is
// known + unconsumed + unexpired + linked to an active client, and
// either renders the Continue form (POST consumes via the server
// action) or the generic unavailable surface. This split exists
// because email scanners, security gateways, and link-preview bots
// commonly fetch the magic-link URL before the human clicks; the
// previous one-step verify burned the visitor's single-use token
// against those bots.
//
// Single-use guarantee still holds: the POST action stamps
// consumed_at via a conditional UPDATE keyed on consumed_at IS NULL,
// so re-rendering this page (after a successful POST) sees the row
// as consumed and renders the unavailable surface.
//
// What this page deliberately does NOT do:
//   * No DB writes. No consumed_at stamp. No session creation. No
//     cookie set. All three live in the POST action only.
//   * No leaking of token state. Every failure branch renders the
//     same generic surface; an attacker probing the URL space cannot
//     distinguish "unknown token" from "expired" from "already
//     consumed" from "client archived".

const GENERIC_LINK_ERROR =
  "This secure link can't be used right now. Please request a new link.";

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
    return <Unavailable />;
  }

  const tokenHash = hashToken(token);
  const admin = createAdminClient();

  // Read-only lookup. The unique index on token_hash means at
  // most one row. NO conditional update; the consumed_at stamp
  // lives on the POST action below.
  const { data: link, error: lookupErr } = await admin
    .from("client_portal_magic_links")
    .select("id, studio_id, client_id, expires_at, consumed_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (lookupErr) {
    console.error(
      JSON.stringify({
        event: "portal_verify_get_lookup_failed",
        code: lookupErr.code,
        message: lookupErr.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return <Unavailable />;
  }
  if (!link) return <Unavailable />;
  if (link.consumed_at != null) return <Unavailable />;

  const nowIso = new Date().toISOString();
  if (link.expires_at <= nowIso) {
    return <Unavailable />;
  }

  // Defense in depth: confirm the client is still active and
  // belongs to the same studio the link was minted for. An archive
  // that happened between request and verify must not let the
  // Continue button appear.
  const { data: clientRow } = await admin
    .from("clients")
    .select("id, studio_id, archived_at")
    .eq("id", link.client_id)
    .eq("studio_id", link.studio_id)
    .maybeSingle();
  if (!clientRow || clientRow.archived_at != null) {
    return <Unavailable />;
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
            <p className="mt-4 text-[16px] leading-relaxed text-[#0A0A0A]">
              This secure link is ready. Continue to access your
              appointments, forms, and policies.
            </p>
            <p className="mt-2 text-[13px]" style={{ color: "#6B6B6B" }}>
              The link is single use; clicking Continue will sign you in
              and the link can no longer be used.
            </p>
          </div>
          <ContinueToPortalForm token={token} />
        </div>
      </section>
      <MarketingFooter />
    </main>
  );
}

function Unavailable() {
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
              {GENERIC_LINK_ERROR}
            </h1>
            <p className="mt-4 text-[16px] leading-relaxed text-[#0A0A0A]">
              Secure links expire after 30 minutes and can only be used
              once. Request a new link from the sign-in page and try
              again.
            </p>
          </div>
          <Link
            href="/portal/login"
            className="self-start px-8 py-4 text-[14px] font-medium uppercase"
            style={{
              backgroundColor: "#0A0A0A",
              color: "#FAFAF7",
              letterSpacing: "0.1em",
            }}
          >
            Request a new link
          </Link>
        </div>
      </section>
      <MarketingFooter />
    </main>
  );
}
