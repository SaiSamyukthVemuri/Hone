import Link from "next/link";
import { FOOTER_GROUPS, POSITIONING } from "@/lib/marketing/content";
import { Container, Hairline } from "./primitives";
import { MK_FONT_DISPLAY } from "./tokens";

// Marketing footer, brand + the treatment-memory positioning line + grouped
// links to every shipped public page (§9). No dead Phase-2 links.
/** Stable id fragment for a footer group's heading, so <nav aria-labelledby>
 *  points at a real element. Group titles are authored constants (Product,
 *  Features, Resources, Company), so this only has to handle spaces and case. */
function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function SiteFooter() {
  const year = 2026; // static; no build-time date fabrication.
  return (
    <footer className="bg-paper">
      <Hairline />
      <Container>
        <div className="grid gap-10 py-14 sm:grid-cols-2 lg:grid-cols-[1.4fr_repeat(4,1fr)]">
          <div className="max-w-xs">
            <span
              className="text-[1.375rem] font-bold text-ink"
              style={{ fontFamily: MK_FONT_DISPLAY }}
            >
              Hone
            </span>
            <p
              className="mt-3 text-[0.9375rem] italic text-muted"
              style={{ fontFamily: MK_FONT_DISPLAY }}
            >
              {POSITIONING.keepPhrase}.
            </p>
          </div>

          {FOOTER_GROUPS.map((group) => (
            // Each group is its own navigation landmark, named by its own
            // heading (WCAG 1.3.1 / 2.4.1). Before this the four link lists sat
            // loose in <footer> with the group name in a plain <p>, so nothing
            // associated "Product" with the links under it: a screen reader
            // navigating by landmark found no footer navigation at all, and
            // navigating by list found four unlabelled lists.
            <nav
              key={group.title}
              aria-labelledby={`footer-group-${slugify(group.title)}`}
            >
              {/* Stays a <p>, not a heading. `aria-labelledby` names the
                  landmark from any element, and promoting "Product" to an <h2>
                  would place a footer group at the same level as the page's
                  own sections in the heading outline, which is the wrong
                  hierarchy for a subordinate link list. */}
              <p
                id={`footer-group-${slugify(group.title)}`}
                className="text-[0.75rem] font-semibold uppercase tracking-[0.14em] text-muted"
              >
                {group.title}
              </p>
              <ul className="mt-4 space-y-2.5">
                {group.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-[0.9375rem] text-ink hover:text-mineral"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <Hairline />
        <div className="flex flex-col gap-2 py-6 text-[0.8125rem] text-muted sm:flex-row sm:items-center sm:justify-between">
          <p>© {year} Hone. {POSITIONING.category}.</p>
          <p>Operated from Canada.</p>
        </div>
      </Container>
    </footer>
  );
}
