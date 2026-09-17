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
//
// SKIP LINK (WCAG 2.4.1 Bypass Blocks). The header is sticky and repeats on
// every marketing page, so a keyboard or screen-reader user previously had to
// tab through the whole nav on each navigation to reach the content. The link
// is the first focusable element in the DOM, visually hidden until focused,
// and targets `#main-content`, which every marketing main landmark now
// carries. It deliberately uses a plain anchor, not next/link: the target is
// already on the page, so a router navigation is the wrong primitive and would
// not move focus.
export function SiteHeader() {
  const rest = PRIMARY_NAV.filter((i) => i.label !== "Product");

  return (
    <header className="sticky top-0 z-40 border-b border-[color:var(--color-hairline)] bg-paper/95">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded-[8px] focus:bg-ink focus:px-4 focus:py-2 focus:text-[0.9375rem] focus:font-semibold focus:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-mineral)] focus-visible:ring-offset-2"
      >
        Skip to main content
      </a>
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
