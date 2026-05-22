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
          className="font-[var(--font-fraunces)] text-[14px] italic"
          style={{ color: MARKETING_PALETTE.muted }}
        >
          Practice memory, made carefully.
        </p>
        <p
          className="text-[10px] font-medium uppercase"
          style={{ letterSpacing: "0.2em", color: MARKETING_PALETTE.muted }}
        >
          The practice memory system for permanent hair removal. A Saltkiln product.
        </p>
        <p
          className="text-[12px] font-medium uppercase"
          style={{ letterSpacing: "0.2em", color: MARKETING_PALETTE.muted }}
        >
          © 2026 Sam Vemuri (operating as Hone).{" "}
          <Link href="/privacy" className="hover:underline">
            Privacy
          </Link>
          {" · "}
          <Link href="/terms" className="hover:underline">
            Terms
          </Link>
          {" · "}
          <a href="mailto:privacy@hone.care" className="hover:underline">
            privacy@hone.care
          </a>
          {" · "}
          <Link href="/login" className="hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </footer>
  );
}
