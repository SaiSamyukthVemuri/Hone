import Link from "next/link";
import { PRIMARY_NAV, WALKTHROUGH, ANALYTICS_EVENTS } from "@/lib/marketing/content";
import { Container } from "./primitives";
import { MobileNav } from "./MobileNav";
import { ProductMenu } from "./ProductMenu";
import { MK_FONT_DISPLAY } from "./tokens";

// Marketing site header. Solid paper background + hairline (no glass/blur).
// Desktop shows the Product dropdown (anchored to its trigger, closes on
// select/route/outside/Escape), the remaining nav links, and the walkthrough
// CTA. Below lg, the accessible MobileNav dialog takes over.
export function SiteHeader() {
  const rest = PRIMARY_NAV.filter((i) => i.label !== "Product");

  return (
    <header className="sticky top-0 z-40 border-b border-[color:var(--color-hairline)] bg-paper/95">
      <Container>
        <div className="flex h-16 items-center justify-between">
          <Link
            href="/"
            className="text-[1.375rem] font-bold text-ink"
            style={{ fontFamily: MK_FONT_DISPLAY }}
          >
            Hone
          </Link>

          <nav className="hidden items-center gap-7 lg:flex" aria-label="Primary">
            <ProductMenu />

            {rest.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-[0.9375rem] font-medium text-ink hover:text-mineral"
              >
                {item.label}
              </Link>
            ))}

            <Link
              href={WALKTHROUGH.href}
              data-event={ANALYTICS_EVENTS.primaryCtaClick}
              className="inline-flex min-h-[40px] items-center justify-center rounded-[8px] bg-mineral px-4 text-[0.875rem] font-semibold text-paper transition-colors hover:bg-[color:var(--color-mineral-deep)]"
            >
              {WALKTHROUGH.primaryLabelShort}
            </Link>
          </nav>

          <MobileNav />
        </div>
      </Container>
    </header>
  );
}
