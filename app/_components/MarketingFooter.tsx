import Link from "next/link";
import { MARKETING_PALETTE } from "./marketingNav";

export function MarketingFooter() {
  return (
    <footer
      className="px-6 py-16 md:px-12 lg:px-16"
      style={{ borderTop: `1px solid ${MARKETING_PALETTE.rule}` }}
    >
      <div className="mx-auto flex max-w-[1400px] flex-col gap-3">
        <p
          className="font-[var(--font-fraunces)] text-[14px] font-bold"
          style={{ letterSpacing: "-0.02em" }}
        >
          Hone
        </p>
        <p
          className="text-[10px] font-medium uppercase"
          style={{ letterSpacing: "0.2em", color: MARKETING_PALETTE.muted }}
        >
          Charting software for electrolysis and laser practitioners. A Saltkiln product.
        </p>
        <p
          className="text-[12px] font-medium uppercase"
          style={{ letterSpacing: "0.2em", color: MARKETING_PALETTE.muted }}
        >
          © 2026 Saltkiln.{" "}
          <Link href="/login" className="hover:underline">
            Sign in
          </Link>
          . Privacy.
        </p>
      </div>
    </footer>
  );
}
