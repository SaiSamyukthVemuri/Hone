import Link from "next/link";
import { PRIMARY_NAV, WALKTHROUGH, ANALYTICS_EVENTS } from "@/lib/marketing/content";
import { Container, CTAButton } from "./primitives";
import { MobileNav } from "./MobileNav";
import { ProductMenu } from "./ProductMenu";
import { MK_FONT_DISPLAY } from "./tokens";

// Marketing site header. Opaque paper + hairline (no glass, no blur, and no
// translucency: at 95% the page's own headings showed through the bar as it
// scrolled). Desktop shows the Product dropdown (anchored to its trigger,
// closes on select/route/outside/Escape), the remaining nav links, and the
// walkthrough request. Below lg, the accessible MobileNav dialog takes over.
//
// THE HEADER'S REQUEST IS QUIET ON PURPOSE. It is an outline, not the filled
// button: every page opens with its own filled "Request a walkthrough", and two
// identical filled buttons stacked a few hundred pixels apart read as a stutter.
// The header's copy is the way back to the request from anywhere, so it stays
// visible, but it does not compete with the page's own call to action.
//
// THE HOMEPAGE TURNS IT OFF (`cta={false}`, MKT-03 revision 3). Its opening is
// one row, and the request sits in that row a few hundred pixels below the
// header, so the header's copy was the same words twice in one glance. The
// homepage still asks again at pricing and at its close; every other page keeps
// the header's request, because there it is the only way back to it.
//
// Every target meets the 44px floor (DESIGN LAW 5): the desktop nav also shows
// on a 1024px iPad in landscape, where the pointer is a finger.
const NAV_LINK =
  "inline-flex min-h-11 items-center text-[0.9375rem] font-medium text-ink transition-colors duration-[var(--hone-duration-ui)] hover:text-mineral focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-mineral)]";

export function SiteHeader({ cta = true }: { cta?: boolean } = {}) {
  const rest = PRIMARY_NAV.filter((i) => i.label !== "Product");

  return (
    <header className="sticky top-0 z-40 border-b border-[color:var(--color-hairline)] bg-paper">
      <Container>
        <div className="flex h-16 items-center justify-between">
          {/* inline-flex + min-h-11: the wordmark is the home control, so it
              meets the 44px touch floor (DESIGN LAW 5) inside the 64px bar. */}
          <Link
            href="/"
            className="inline-flex min-h-11 items-center text-[1.375rem] font-bold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-mineral)]"
            style={{ fontFamily: MK_FONT_DISPLAY }}
          >
            Hone
          </Link>

          <nav className="hidden items-center gap-7 lg:flex" aria-label="Primary">
            <ProductMenu />

            {rest.map((item) => (
              <Link key={item.href} href={item.href} className={NAV_LINK}>
                {item.label}
              </Link>
            ))}

            {cta ? (
              <CTAButton
                href={WALKTHROUGH.href}
                variant="outline"
                event={ANALYTICS_EVENTS.primaryCtaClick}
              >
                {WALKTHROUGH.primaryLabelShort}
              </CTAButton>
            ) : null}
          </nav>

          <MobileNav />
        </div>
      </Container>
    </header>
  );
}
