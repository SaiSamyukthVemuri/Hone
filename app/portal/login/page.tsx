import { redirect } from "next/navigation";
import { MarketingFooter } from "@/app/_components/MarketingFooter";
import { MARKETING_PALETTE as PALETTE } from "@/app/_components/marketingNav";
import { EyebrowCaption } from "@/app/_components/MarketingAtoms";
import { getCurrentPortalSession } from "@/lib/portal/session";
import { PortalLoginForm } from "./LoginForm";

// Public client portal login page. Renders the email form that
// requests a magic link. If the visitor already has a live portal
// session we send them straight to /portal so a stale login URL does
// not interrupt them.
export default async function PortalLoginPage() {
  const session = await getCurrentPortalSession();
  if (session) {
    redirect("/portal");
  }

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
              Sign in to your secure portal
            </h1>
            <p className="mt-4 text-[16px] leading-relaxed text-[#0A0A0A]">
              Enter the email your studio has on file. We will send you a
              secure one-time link to sign in.
            </p>
            <p className="mt-2 text-[13px]" style={{ color: "#6B6B6B" }}>
              The link expires in 30 minutes. After you sign in, your
              portal session may stay active on this device for a short
              time.
            </p>
          </div>

          <PortalLoginForm />
        </div>
      </section>
      <MarketingFooter />
    </main>
  );
}
