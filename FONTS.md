# Fonts — Hone marketing site

**Scope:** the public marketing surface (pages wrapped in `.marketing-surface`:
homepage, pillar, feature, resource, pricing, demo). The authenticated app's
typography is separate and unchanged (see the note at the bottom).

## Decision: tuned system font stack (no web-font files shipped)

The marketing site ships **no font files** and makes **no runtime or build-time
Google Fonts network request** (prompt §11). Display and text are rendered from
a tuned system stack defined in `app/globals.css`:

| Role | CSS variable | Stack |
|---|---|---|
| Display (headings) | `--font-marketing-display` | `"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, ui-serif, serif` |
| Text / UI | `--font-marketing-text` | `ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` |

- **Display** resolves to a warm, high-optical-contrast old-style serif where
  available (Iowan Old Style / Palatino on Apple platforms), falling back to
  Georgia, then the platform `ui-serif`. This gives the "quiet precision"
  editorial feel without shipping bytes.
- **Text** resolves to the native platform grotesk (San Francisco / Segoe UI /
  Roboto), which is highly legible at ≥16px and renders instantly.

### Why a system stack (and not vendored web fonts)

§11's preferred pairing is **Newsreader (display) + Geist (text)** — both
open-licensed (SIL OFL). We chose the tuned system stack instead because:

1. **Licensing integrity.** Verified, correctly-subset WOFF2 files for those
   families could not be obtained and license-verified within this build
   environment, and §11 forbids shipping unlicensed files. A system stack has
   no licensing exposure.
2. **No network dependency.** Zero runtime and zero build-time font requests,
   satisfying §11 directly.
3. **Performance & CLS.** No font download, no swap/FOUT, no layout shift from
   late-loading webfonts — fonts paint on first frame. Distinctiveness is
   carried by layout, color, and the signature product visual, per the design
   plan, rather than by an exotic typeface.

This is the explicitly-permitted §11 fallback ("If licensing or quality cannot
be verified, use a tuned system stack.").

### If web fonts are adopted later

To move to Newsreader + Geist without a Google Fonts network dependency:
- Add self-hosted **WOFF2 subsets** under `app/fonts/` (or the licensed `geist`
  npm package for the text face), wire them with **`next/font/local`**, and
  record the exact files + SIL OFL license text and source URLs here.
- Keep `--font-marketing-display` / `--font-marketing-text` as the swap points
  so no component markup changes.

## Note: the authenticated app's fonts are unchanged

The root layout (`app/layout.tsx`) loads **Fraunces + Inter via
`next/font/google`** for the authenticated product. That is a pre-existing
dependency and is intentionally **not** modified by this marketing work
(delivery rule §30: no authenticated-product change). Migrating the app off
Google Fonts, if desired, is a separate, separately-authorized change.
