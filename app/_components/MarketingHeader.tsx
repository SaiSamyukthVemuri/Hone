import Link from "next/link";
import { MARKETING_NAV, MARKETING_PALETTE } from "./marketingNav";
import { MobileNav } from "./MobileNav";

export function MarketingHeader() {
  return (
    <header
      className="px-6 py-5 md:px-12 lg:px-16"
      style={{ borderBottom: `1px solid ${MARKETING_PALETTE.rule}` }}
    >
      <div className="mx-auto flex max-w-[1400px] items-baseline justify-between">
        <Link href="/" className="inline-flex items-baseline gap-2">
          <span
            className="font-[var(--font-fraunces)] text-[18px] font-bold"
            style={{ letterSpacing: "-0.02em" }}
          >
            Hone
          </span>
        </Link>

        <nav className="hidden items-baseline gap-x-8 md:flex">
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

        <div className="md:hidden">
          <MobileNav />
        </div>
      </div>
    </header>
  );
}
