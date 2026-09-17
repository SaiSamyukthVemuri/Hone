import type { ReactNode } from "react";
import { MarketingHeader } from "@/app/_components/MarketingHeader";
import { MarketingFooter } from "@/app/_components/MarketingFooter";
import { SkipLink } from "@/app/_components/marketing/SkipLink";
import { SafeAnalytics } from "@/app/_components/SafeAnalytics";
import { MARKETING_PALETTE as PALETTE } from "@/app/_components/marketingNav";

// Shared shell for /privacy and /terms. Same header + footer as the
// marketing surfaces; content area uses Fraunces for headings, Inter for
// body, max-width about 65ch for readability.
//
// LANDMARKS (MARKETING-01b). The outer element used to be <main>, which put
// the header's <nav> and the footer's <contentinfo> INSIDE the main landmark
// and made "skip to main content" meaningless here - the whole page was main.
// The shell is now a plain <div>; only the policy <article> is wrapped in
// <main id="main-content">, matching every other marketing page.
export function PolicyLayout({
  title,
  effectiveDate,
  lastUpdated,
  children,
}: {
  title: string;
  effectiveDate: string;
  lastUpdated: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        backgroundColor: PALETTE.bg,
        color: PALETTE.ink,
        fontFeatureSettings: '"cv11"',
      }}
      className="min-h-screen font-[var(--font-inter)]"
    >
      <SkipLink />
      <MarketingHeader />
      <main id="main-content">
      <article className="px-6 py-16 md:px-12 md:py-24 lg:px-16">
        <div className="mx-auto max-w-[65ch] flex flex-col gap-6">
          <header className="flex flex-col gap-2">
            <h1
              className="font-[var(--font-fraunces)] text-[40px] font-bold leading-tight md:text-[56px]"
              style={{ letterSpacing: "-0.025em" }}
            >
              {title}
            </h1>
            <p className="text-sm text-[#6B6B6B]">
              <strong className="font-medium text-[#0A0A0A]">
                Effective date:
              </strong>{" "}
              {effectiveDate}
              <span className="mx-2 text-[#C9C4B6]">·</span>
              <strong className="font-medium text-[#0A0A0A]">
                Last updated:
              </strong>{" "}
              {lastUpdated}
            </p>
          </header>
          <div className="policy-body flex flex-col gap-6 text-[16px] leading-[1.7]">
            {children}
          </div>
        </div>
      </article>
      </main>
      <MarketingFooter />
      {/* PR #142. PolicyLayout wraps the privacy + terms pages.
          Both are safe marketing routes (no bearer token in URL),
          so SafeAnalytics mounts here. Token routes never use
          PolicyLayout. */}
      <SafeAnalytics />
    </div>
  );
}

export function H2({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2
      id={id}
      className="font-[var(--font-fraunces)] mt-8 text-[24px] font-bold leading-tight md:text-[28px]"
      style={{ letterSpacing: "-0.02em" }}
    >
      <a href={`#${id}`} className="no-underline hover:underline">
        {children}
      </a>
    </h2>
  );
}

export function H3({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h3
      id={id}
      className="mt-4 text-[18px] font-semibold leading-tight"
    >
      <a href={`#${id}`} className="no-underline hover:underline">
        {children}
      </a>
    </h3>
  );
}

export function P({ children }: { children: ReactNode }) {
  return <p className="whitespace-pre-line">{children}</p>;
}

export function UL({ children }: { children: ReactNode }) {
  return <ul className="ml-6 flex list-disc flex-col gap-1.5">{children}</ul>;
}
