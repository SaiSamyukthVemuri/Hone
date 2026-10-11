import Link from "next/link";
import { FOOTER_GROUPS, FOOTER_LEGAL, POSITIONING } from "@/lib/marketing/content";
import { Container, Hairline } from "./primitives";
import { MK_FONT_DISPLAY } from "./tokens";

// Marketing footer, brand + the treatment-memory positioning line + grouped
// links to every shipped public page (§9). No dead Phase-2 links.
//
// TARGETS FOLLOW THE POINTER (DESIGN LAWS 3 and 5). Each link is a 44px row on
// touch, where the old 19px text lines were all a thumb had to aim at, and
// compacts to 32px only for a fine pointer — the explicit opt-in LAW 5 allows.
// Group titles are words in sentence case, not a tracked all-caps device.
const FOOTER_LINK =
  "inline-flex min-h-11 items-center text-[0.9375rem] text-ink transition-colors duration-[var(--hone-duration-ui)] hover:text-mineral pointer-fine:min-h-8 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-mineral)]";
// The legal line's links: the same targets, at the line's own size and tone.
const LEGAL_LINK =
  "inline-flex min-h-11 items-center text-[0.8125rem] text-muted underline decoration-[color:var(--color-hairline-strong)] underline-offset-4 transition-colors duration-[var(--hone-duration-ui)] hover:text-ink pointer-fine:min-h-8 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-mineral)]";

export function SiteFooter() {
  const year = 2026; // static; no build-time date fabrication.
  return (
    <footer className="bg-paper">
      <Hairline />
      <Container>
        {/* Two columns from the narrowest screen: single-column groups of 44px
            rows made the footer taller than a phone's screen. Three groups since
            MKT-03 revision 3 (see FOOTER_GROUPS): the product pages, the guides,
            and the two ways to reach a person. */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-8 py-12 lg:grid-cols-[1.4fr_repeat(3,1fr)] lg:gap-x-10">
          <div className="col-span-2 max-w-xs lg:col-span-1">
            <span
              className="text-[1.375rem] font-bold text-ink"
              style={{ fontFamily: MK_FONT_DISPLAY }}
            >
              Hone
            </span>
            <p className="mt-2 text-[0.9375rem] text-muted">{POSITIONING.keepPhrase}.</p>
          </div>

          {/* EACH GROUP IS ITS OWN LABELLED NAV. The titles rendered as plain
              text above an unassociated list, so assistive technology reached
              four anonymous link lists inside one contentinfo and the visible
              heading — "Product", "Company" — was decoration a screen reader
              never connected to the links under it. `aria-labelledby` pointing
              at the existing title is what makes the association real, rather
              than duplicating the word into an aria-label that can drift from
              what is on screen. */}
          {FOOTER_GROUPS.map((group) => (
            <nav
              key={group.title}
              aria-labelledby={`footer-group-${group.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
            >
              <p
                id={`footer-group-${group.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                className="text-[0.875rem] font-semibold text-ink"
              >
                {group.title}
              </p>
              <ul className="mt-2">
                {group.links.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href} className={FOOTER_LINK}>
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <Hairline />
        {/* The legal line: the copyright, where Hone is operated from, and the
            two policy pages beside them, with Sign in. */}
        <div className="flex flex-col gap-x-6 gap-y-2 py-5 text-[0.8125rem] text-muted sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <p>
            © {year} Hone. {POSITIONING.category}. Operated from Canada.
          </p>
          <nav aria-label="Legal">
            <ul className="flex flex-wrap gap-x-5">
              {FOOTER_LEGAL.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className={LEGAL_LINK}>
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </Container>
    </footer>
  );
}
