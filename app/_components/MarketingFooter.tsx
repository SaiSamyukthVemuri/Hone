import Link from "next/link";
import { MARKETING_PALETTE } from "./marketingNav";
import { CONTACT_EMAIL } from "@/lib/marketing/content";

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
          Treatment memory, made carefully.
        </p>
        <p
          className="text-[10px] font-medium uppercase"
          style={{ letterSpacing: "0.2em", color: MARKETING_PALETTE.muted }}
        >
          Treatment memory for electrologists.
        </p>
        {/* HON-124 item 3. Two DIFFERENT contacts, kept apart: the studio answers about an appointment or treatment (Hone has no way to
            act on a studio's appointments), Hone support answers about this website. */}
        <div className="flex flex-col gap-1 text-[14px] leading-[1.6]" data-testid="contact-paths" style={{ color: MARKETING_PALETTE.muted }}>
          <p>
            <strong className="font-medium" style={{ color: MARKETING_PALETTE.ink }}>
              About your appointment or treatment:
            </strong>{" "}
            contact your studio directly.
          </p>
          <p>
            <strong className="font-medium" style={{ color: MARKETING_PALETTE.ink }}>
              Hone support, for problems with this website:
            </strong>{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className="underline underline-offset-4">
              {CONTACT_EMAIL}
            </a>
          </p>
        </div>
        <p
          className="text-[12px] font-medium uppercase"
          style={{ letterSpacing: "0.2em", color: MARKETING_PALETTE.muted }}
        >
          © 2026 Hone.{" "}
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
