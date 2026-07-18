# Fonts — Hone marketing site

**Scope:** the public marketing surface (pages wrapped in `.marketing-surface`).

## Decision: clean sans-serif (Inter) throughout

Per the product owner's direction, the marketing site uses **Inter for both
headings and body** — a clean, modern sans-serif with no serif letterforms.

- The face is loaded in `app/_components/marketing/fonts.ts` (`next/font/google`,
  Inter weights 400/500/600/700) and exposed as `--font-marketing-sans`, scoped
  to the marketing surface via `.variable` on `MarketingSurface` — so the
  authenticated app's own font loading is untouched.
- `--font-marketing-display` and `--font-marketing-text` (in `app/globals.css`)
  both resolve to `var(--font-marketing-sans)`, with a system sans fallback.
- Headings render at Inter **Semibold (600)** with tight tracking.

### History (why not a serif)

Earlier iterations tried a tuned system serif, then Fraunces, then Newsreader for
display. The serif options were rejected (Fraunces's lowercase "f" has an inherent
descending tail; the serif look wasn't wanted), so the site moved to a clean
sans-serif. Body was always Inter.
