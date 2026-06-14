import Link from "next/link";
import { MARKETING_CTA, MARKETING_NAV, MARKETING_PALETTE } from "./marketingNav";
import { MobileNav } from "./MobileNav";

// The desktop nav carries the homepage story sections (Product,
// Records) plus Pricing and Sign in, with a Book walkthrough CTA
// button. PR #244 dropped the Agentic support item so the nav reads
// plainly. The full nav shows at lg+ so it never crowds the header at
// tablet widths; below lg the MobileNav menu carries the same links
// and the CTA (overflow-safe).
export function MarketingHeader() {
  return (
    <header
      className="px-6 py-5 md:px-12 lg:px-16"
      style={{ borderBottom: `1px solid ${MARKETING_PALETTE.rule}` }}
    >
      <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-4">
        <Link href="/" className="inline-flex items-baseline gap-2">
          <span
            className="font-[var(--font-fraunces)] text-[18px] font-bold"
            style={{ letterSpacing: "-0.02em" }}
          >
            Hone
          </span>
        </Link>

        <div className="hidden items-center gap-x-7 lg:flex">
          <nav className="flex items-center gap-x-7">
            {MARKETING_NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-[14px] font-medium hover:underline"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <Link
            href={MARKETING_CTA.href}
            className="inline-flex items-center justify-center px-5 py-2.5 text-[12px] font-medium uppercase transition-opacity hover:opacity-80"
            style={{
              backgroundColor: MARKETING_PALETTE.ink,
              color: MARKETING_PALETTE.bg,
              letterSpacing: "0.14em",
            }}
          >
            {MARKETING_CTA.label}
          </Link>
        </div>

        <div className="lg:hidden">
          <MobileNav />
        </div>
      </div>
    </header>
  );
}
