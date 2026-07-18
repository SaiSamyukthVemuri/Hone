# Fonts — Hone marketing site

**Scope:** the public marketing surface (pages wrapped in `.marketing-surface`).

## Decision: reuse the app's Fraunces + Inter

The marketing site uses the **same fonts as the product** — **Fraunces** for
display and **Inter** for text — via the shared CSS variables the root layout
already exposes (`--font-fraunces`, `--font-inter`), defined in `app/globals.css`:

| Role | CSS variable | Value |
|---|---|---|
| Display (headings, wordmark) | `--font-marketing-display` | `var(--font-fraunces), Georgia, "Times New Roman", ui-serif, serif` |
| Text / UI | `--font-marketing-text` | `var(--font-inter), ui-sans-serif, system-ui, -apple-system, …, sans-serif` |

### Why

- **Consistency + preference.** The product owner preferred the established
  Fraunces + Inter look over a system-serif stack. Reusing them makes the
  marketing site and the app feel like one product.
- **No extra cost.** Fraunces + Inter are already loaded once by the root layout
  (`app/layout.tsx`, `next/font/google`, self-hosted at build). The marketing
  site adds **no new font request** — it points at the already-loaded families
  through the CSS variables, with system-font fallbacks.

Note: an earlier iteration shipped a tuned system-serif stack to avoid any
Google-Fonts dependency; it was replaced with the app's Fraunces/Inter per the
product owner's direction. If a fully self-hosted, no-Google-Fonts pipeline is
required later, swap the two `--font-marketing-*` values to `next/font/local`
faces and record the files + SIL OFL licenses here — no component markup changes.
