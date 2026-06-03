import { redirect } from "next/navigation";
import { MarketingFooter } from "@/app/_components/MarketingFooter";
import { MARKETING_PALETTE as PALETTE } from "@/app/_components/marketingNav";
import { EyebrowCaption } from "@/app/_components/MarketingAtoms";
import { getCurrentPortalSession } from "@/lib/portal/session";
import { getStudioBySlug } from "@/lib/booking/queries";
import { PortalLoginForm } from "./LoginForm";

// Public client portal login page. Renders the email form that
// requests a magic link. If the visitor already has a live portal
// session we send them straight to /portal so a stale login URL
// does not interrupt them.
//
// Studio scoping (PR #126). When the URL carries ?studio=<slug>:
//   * the page resolves the slug server-side via getStudioBySlug
//   * the heading + body copy name that studio
//   * a hidden `studio_slug` form field is included so the action
//     runs the scoped client-lookup, not the global one
// When the slug is missing or unknown, the page falls back to the
// generic copy and the unscoped action path. We deliberately do
// NOT render a different "this portal is not set up" surface for
// an unknown slug here; that would reveal whether a particular
// slug exists. The login action's invalid-slug branch returns the
// same generic success the no-match branch returns, preserving
// the no-enumeration stance.
export default async function PortalLoginPage({
  searchParams,
}: {
  searchParams?: Promise<{ studio?: string }>;
}) {
  const session = await getCurrentPortalSession();
  if (session) {
    redirect("/portal");
  }

  const params = (await searchParams) ?? {};
  const slug = (params.studio ?? "").trim();
  const studio = slug.length > 0 ? await getStudioBySlug(slug) : null;
  const studioName = studio?.name ?? null;
  // The hidden form value passes the slug through to the action even
  // when the studio lookup did not resolve (the action does its own
  // resolve + no-enumeration generic-success fallback). We only pass
  // a slug when one was actually in the URL so the unscoped login
  // path (no slug in URL) keeps using the global lookup.
  const studioSlugForForm = slug.length > 0 ? slug : null;

  const heading = studioName
    ? `Sign in to your ${studioName} portal`
    : "Sign in to your secure portal";
  const body = studioName
    ? `Enter the email ${studioName} has on file. We will send you a secure one-time link to sign in.`
    : "Enter the email your studio has on file. We will send you a secure one-time link to sign in.";

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
        <div className="mx-auto max-w-[520px] flex flex-col gap-10">
          <div>
            <EyebrowCaption>Client portal</EyebrowCaption>
            <h1
              className="font-[var(--font-fraunces)] mt-8 text-[36px] font-bold leading-tight md:text-[44px]"
              style={{ letterSpacing: "-0.025em" }}
            >
              {heading}
            </h1>
            <p className="mt-4 text-[16px] leading-relaxed text-[#0A0A0A]">
              {body}
            </p>
            <p className="mt-2 text-[13px]" style={{ color: "#6B6B6B" }}>
              The link expires in 30 minutes. After you sign in, your
              portal session may stay active on this device for a short
              time.
            </p>
          </div>

          <PortalLoginForm studioSlug={studioSlugForForm} />
        </div>
      </section>
      <MarketingFooter />
    </main>
  );
}
