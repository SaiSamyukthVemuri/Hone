import { redirect } from "next/navigation";
import Link from "next/link";
import { MarketingFooter } from "@/app/_components/MarketingFooter";
import { MARKETING_PALETTE as PALETTE } from "@/app/_components/marketingNav";
import { EyebrowCaption } from "@/app/_components/MarketingAtoms";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { hashToken } from "@/lib/portal/tokens";
import { createPortalSession } from "@/lib/portal/session";

// Magic-link exchange. The visitor lands on /portal/verify/<token>;
// we hash the URL token, look up the matching client_portal_magic_links
// row, verify it is unused and not expired, stamp consumed_at to
// guarantee single-use, and create the portal session. On success we
// redirect to /portal. On any failure the page renders a generic
// "link unavailable" surface; the same string is shown whether the
// token is unknown, expired, or already consumed so a probing
// visitor cannot distinguish those states.
//
// Single-use guarantee: the consumed_at stamp uses a conditional
// UPDATE keyed on consumed_at IS NULL. Postgres reports the affected
// row count; if zero rows were updated, the token was already
// consumed by a concurrent request and this verify must fail.

const GENERIC_LINK_ERROR =
  "This secure link can't be used right now. Please request a new link.";

export default async function PortalVerifyPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // Empty token: render the generic unavailable surface without any
  // DB lookup; matches the public-collapse stance we use on cancel /
  // reschedule / manage.
  if (!token || token.length === 0) {
    return <Unavailable />;
  }

  const tokenHash = hashToken(token);
  const admin = createAdminClient();

  // Lookup. The unique index on token_hash means at most one row.
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
        event: "portal_verify_lookup_failed",
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

  // Defense in depth: make sure the client is still active and
  // belongs to the same studio the link was minted for. A token
  // minted for an active client whose row was archived between
  // request and verify must not establish a session.
  const { data: clientRow } = await admin
    .from("clients")
    .select("id, studio_id, archived_at")
    .eq("id", link.client_id)
    .eq("studio_id", link.studio_id)
    .maybeSingle();
  if (!clientRow || clientRow.archived_at != null) {
    return <Unavailable />;
  }

  // Atomic single-use stamp. The conditional .is("consumed_at", null)
  // means a concurrent verify of the same token races on this UPDATE
  // and only one side wins; the other observes a zero-row result via
  // .select() and surfaces the generic unavailable surface.
  const { data: consumedRows, error: consumeErr } = await admin
    .from("client_portal_magic_links")
    .update({ consumed_at: nowIso })
    .eq("id", link.id)
    .is("consumed_at", null)
    .select("id");
  if (consumeErr) {
    console.error(
      JSON.stringify({
        event: "portal_verify_consume_failed",
        code: consumeErr.code,
        message: consumeErr.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return <Unavailable />;
  }
  if (!consumedRows || consumedRows.length === 0) {
    // Lost the consume race; another verify already used this token.
    return <Unavailable />;
  }

  try {
    await createPortalSession({
      studioId: link.studio_id,
      clientId: link.client_id,
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "portal_verify_session_create_failed",
        message: err instanceof Error ? err.message : "unknown",
        timestamp: new Date().toISOString(),
      }),
    );
    return <Unavailable />;
  }

  redirect("/portal");
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
