import Link from "next/link";
import { FOOTER_GROUPS, POSITIONING } from "@/lib/marketing/content";
import { Container, Hairline } from "./primitives";
import { MK_FONT_DISPLAY } from "./tokens";

// Marketing footer, brand + the treatment-memory positioning line + grouped
// links to every shipped public page (§9). No dead Phase-2 links.
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
            <div key={group.title}>
              <p className="text-[0.75rem] font-semibold uppercase tracking-[0.14em] text-muted">
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
            </div>
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
