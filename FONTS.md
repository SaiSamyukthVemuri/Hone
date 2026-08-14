# Fonts — Hone marketing site

**Scope:** the public marketing surface (pages wrapped in `.marketing-surface`).

## Decision: clean sans-serif (Inter) throughout

Per the product owner's direction, the marketing site uses **Inter for both
headings and body** — a clean, modern sans-serif with no serif letterforms.

- The face is loaded in `app/_fonts/marketing-fonts.ts` (self-hosted via
  `next/font/local`, Inter weights 400/500/600/700), re-exported by
  `app/_components/marketing/fonts.ts` and exposed as `--font-marketing-sans`,
  scoped to the marketing surface via `.variable` on `MarketingSurface` — so the
  authenticated app's own font loading is untouched.
- `--font-marketing-display` and `--font-marketing-text` (in `app/globals.css`)
  both resolve to `var(--font-marketing-sans)`, with a system sans fallback.
- Headings render at Inter **Semibold (600)** with tight tracking.

### History (why not a serif)

Earlier iterations tried a tuned system serif, then Fraunces, then Newsreader for
display. The serif options were rejected (Fraunces's lowercase "f" has an inherent
descending tail; the serif look wasn't wanted), so the site moved to a clean
sans-serif. Body was always Inter.

---

# Self-hosted font assets (whole application)

**Scope from here down:** the entire application, not just the marketing surface.

## Why the fonts are vendored

`next/font/google` fetches the face from `fonts.googleapis.com` (CSS) and
`fonts.gstatic.com` (the `.woff2` files) **at build time**. When either host was
unreachable, `next build` failed outright:

```
app/_components/marketing/fonts.ts
`next/font` error: Failed to fetch `Inter` from Google Fonts.
app/layout.tsx
`next/font` error: Failed to fetch `Fraunces` from Google Fonts.
```

Deterministic commits went red for reasons unrelated to the commit. This is the
long-standing `HNE-BLD-001` finding, and it is the reason
`docs/marketing/design-plan.md` §2 records `next/font/local` as a hard
requirement. The fonts are now self-hosted, so the build makes no font network
request at all.

**The CSP was already correct** — `lib/security/headers.ts` sets
`font-src 'self' data:` and needed no change. The defect was build-time only;
the browser was never fetching from Google at runtime.

Two known stale references, both deliberately left alone rather than missed:

- The comment above `fontSrc` in `lib/security/headers.ts` still says
  `next/font/google`. Its operative claim is still true (the assets are
  self-hosted under `/_next/static/media/`, so the browser never reaches
  `fonts.gstatic.com`) and the CSP itself is unchanged. Editing that file would
  reclassify this build-reliability change as a **T3 security-path** change and
  pull the security and database lanes into CI for a one-word comment, which is
  the ceremony CLAUDE.md warns against. Worth folding into the next change that
  legitimately touches that file.
- `docs/marketing/design-plan.md` §2 and `docs/marketing/baseline-audit.md` both
  describe the pre-self-hosting state. They are point-in-time gate/audit records
  of a marketing typography plan (Newsreader + Geist) that never shipped, so
  they are left as history. **This file is the canonical record for fonts.**

`app/opengraph-image.tsx` is **not** affected. It loads no custom font, but the
`next/og` runtime (`@vercel/og`, vendored inside Next) contains its own Noto
fallback that fetches from `fonts.googleapis.com` **at request time** for glyphs
its embedded font does not cover. That is a pre-existing, library-owned, runtime
path in an edge route with static generation disabled. It is not a build-time
dependency: the offline build described below passes with both hosts blocked.

## Provenance and licence

Both families are licensed under the **SIL Open Font License 1.1**, which permits
redistribution of the font files:

| Family | Copyright | Upstream | Licence file |
|---|---|---|---|
| Inter | Copyright (c) 2016 The Inter Project Authors | <https://github.com/rsms/inter> | `app/_fonts/LICENSE-Inter.txt` |
| Fraunces | Copyright 2018 The Fraunces Project Authors | <https://github.com/undercasetype/Fraunces> | `app/_fonts/LICENSE-Fraunces.txt` |

**Naming the licence is not enough — the notice has to travel with the files.**
OFL 1.1 clause 2 permits redistribution "provided that each copy contains the
above copyright notice and this license", and allows that to be satisfied by
"stand-alone text files". So the full upstream licence text for each family sits
next to the binaries in `app/_fonts/`, fetched verbatim from each project's own
repository (`rsms/inter/LICENSE.txt`, `undercasetype/Fraunces/OFL.txt`). Both are
the complete OFL 1.1 (Version 1.1 - 26 February 2007) carrying that family's own
copyright line; the two bodies differ only in known upstream formatting variants.

**If these fonts are ever moved, renamed or re-vendored, the two `LICENSE-*.txt`
files must move with them.** `tests/source-guards/self-hosted-fonts-guards.test.ts`
fails if either goes missing or stops being a real OFL 1.1 notice.

The vendored `.woff2` files in `app/_fonts/` are **the exact bytes the previous
`next/font/google` build downloaded from Google Fonts** and served from
`/_next/static/media/`. They were lifted from that build's output rather than
re-sourced, which is what makes this change visually a no-op instead of a
re-cut: the browser receives the identical binaries it received before.

## What is vendored

Google serves **one variable `.woff2` per unicode-range subset**, so a family is
several files. All 13 subsets the previous build downloaded are vendored, so
Cyrillic, Greek and Vietnamese client names keep rendering in Inter rather than
dropping to a fallback face.

The `weights` column is the union declared across loaders. The root layout
declares Inter **400/500 only**; the marketing surface declares 400/500/600/700.

| File | Family | Style | Subset | Weights | Bytes | Preloaded | sha256 |
|---|---|---|---|---|---|---|---|
| `fraunces-italic-latin-ext.woff2` | Fraunces | italic | latin-ext | 400, 700 | 40,560 | no | `7e701dc124492f7d0856fba4a07157d0cecc84e2b2b4615f08530c1e8bc112dd` |
| `fraunces-italic-latin.woff2` | Fraunces | italic | latin | 400, 700 | 45,624 | yes | `c9745ee907c02cdd46cc41a65bb711cd861432f679a76c18e3de204a18723040` |
| `fraunces-italic-vietnamese.woff2` | Fraunces | italic | vietnamese | 400, 700 | 12,956 | no | `d24c3502a91415f2ec44f107807673255b696c379b3995543270921c27863e32` |
| `fraunces-latin-ext.woff2` | Fraunces | normal | latin-ext | 400, 700 | 33,640 | no | `f1451edd6434085c4f9f3a8b4a674182dd7d6acccf53bfced19fd167f0705a06` |
| `fraunces-latin.woff2` | Fraunces | normal | latin | 400, 700 | 36,560 | yes | `88e17be075f1be50ab67b057b99e3701b828f44ed28f9452df6c02645bb0cba9` |
| `fraunces-vietnamese.woff2` | Fraunces | normal | vietnamese | 400, 700 | 11,536 | no | `250cc2966c658fb6d336731de9d82a8129025e9839c20c253bbc477852f6cf4f` |
| `inter-cyrillic-ext.woff2` | Inter | normal | cyrillic-ext | 400, 500, 600, 700 | 25,844 | no | `fccca918fea40089dacadc7045861314d1a6bc91f1f323cc1eeb22ebcdb321b5` |
| `inter-cyrillic.woff2` | Inter | normal | cyrillic | 400, 500, 600, 700 | 18,744 | no | `aebf2ab4a4ce6810d73c1ac7be7cafb4e5ec4cee2d6db5fb3e09691747ec4bd6` |
| `inter-greek-ext.woff2` | Inter | normal | greek-ext | 400, 500, 600, 700 | 11,272 | no | `a2e2c783ca6f9c20486e81e72a279203e86730bbf8f01ff6a5ee9dbd09e1c271` |
| `inter-greek.woff2` | Inter | normal | greek | 400, 500, 600, 700 | 19,044 | no | `46dd4cdca58c26ae87cc6927657bf83b2e8abfc39ffd0ab176e301a8d28d22bf` |
| `inter-latin-ext.woff2` | Inter | normal | latin-ext | 400, 500, 600, 700 | 85,272 | no | `a28eb6d3ccb534ae0c94ca999371df024aab60b08c3c8a5720ee9e32fa0faaa2` |
| `inter-latin.woff2` | Inter | normal | latin | 400, 500, 600, 700 | 48,432 | yes | `c940764593d0fe5d596be327ca7558855e018039fb78509aa21921fd3644c3e4` |
| `inter-vietnamese.woff2` | Inter | normal | vietnamese | 400, 500, 600, 700 | 10,280 | no | `8db00ff46c67b22cda8bed865acf7077651cac8d2841d5b40980556b48961931` |

Total: **399,764 bytes**. Only the three latin files are preloaded, exactly as
before; the rest are fetched on demand when a page actually contains those
codepoints.

## How the loaders are shaped, and why

`app/_fonts/app-fonts.ts` (root layout) and `app/_fonts/marketing-fonts.ts`
(marketing surface) are **separate modules on purpose**, mirroring the
code-splitting the two `next/font/google` call sites had. Three constraints
drove the shape, and each one is a way this could have silently drifted:

1. **One `localFont()` call per subset.** `next/font/local` applies
   `declarations` to every `src` entry in a call, so one call cannot give two
   files different `unicode-range`s. Each call declares the same `font-family`
   (`Inter` / `Fraunces`), so the faces compose into a single family exactly as
   the Google-served CSS did. Only the latin call of each family carries the CSS
   variable, the preload and the metric-adjusted fallback.

2. **Weights are declared one per `src` entry, never as a range.** Writing
   `weight: "400 700"` against a variable font looks like a tidy simplification
   and is not equivalent. The root layout loads Inter 400/500 only, so an
   authenticated-app element asking for 700 matches the 500 face and the browser
   **synthesises** bold. A range would start rendering a true 700 there — a
   visual change smuggled in under a build fix.

3. **The marketing module is never imported by the root layout.** Merging them
   would put Inter 600/700 on every authenticated route, with the same
   consequence as (2).

The metric-adjusted fallback pairing is preserved: Inter falls back to **Arial**,
Fraunces to **Times New Roman** (`adjustFontFallback`), matching what
`next/font/google` generated from its own metrics table.

## Pre-existing defect found while verifying: Fraunces never actually renders

Found by inspecting the running app; **not caused by this change and not fixed
by it.** Recorded here so it is not rediscovered as a regression.

Roughly 40 surfaces (login, portal, booking, intake, reschedule, cancel,
dashboard, policy pages) ask for the display face with the Tailwind class
`font-[var(--font-fraunces)]`. In **Tailwind v4, `font-[…]` means font-WEIGHT,
not font-family** — setting a family needs `font-[family-name:…]`. So that class
compiles to:

```css
.font-\[var\(--font-fraunces\)\]{--tw-font-weight:var(--font-fraunces);font-weight:var(--font-fraunces)}
```

`font-weight: "Fraunces", "Fraunces Fallback"` is not a valid weight, so the
browser drops the declaration and never sets `font-family`. Those headings
inherit Inter from the `html, body` rule. Verified in the browser: on `/login`
the `<h1>` computes to `Inter` and every Fraunces face reports `unloaded`, while
`--font-fraunces` itself resolves correctly to `"Fraunces","Fraunces Fallback"`.
`font-[var(--font-inter)]` has the same defect, but is harmless because Inter is
already the inherited body face.

Consequences, all of which predate this change:

- The intended serif display face has never shipped; those headings are Inter.
- Fraunces is still **preloaded on every page** (2 files, ~82KB) for glyphs that
  are never painted.

Deliberately out of scope here. This is a build-reliability change, and
"correcting" the class would restyle ~40 surfaces from sans to serif — a visible
product decision, and one that runs against the recorded product-owner direction
above that rejected the serif look. It needs its own change and its own sign-off.
The marketing surface is unaffected: it sets its face through an inline
`style={{ fontFamily }}` (`MK_FONT_DISPLAY`), which works correctly — its
headings render Inter 600 as intended.

`tests/source-guards/self-hosted-fonts-guards.test.ts` pins all of the above and
fails if a `next/font/google` import reappears anywhere in the source.

## Re-verifying

To prove the build has no Google Fonts dependency, block the hosts and build:

```js
// block-google-fonts.cjs — patches node:https, which is what next/font uses
const BLOCKED = /(^|\.)fonts\.(googleapis|gstatic)\.com$/i;
for (const mod of ["node:http", "node:https"]) {
  const m = require(mod);
  for (const method of ["request", "get"]) {
    const original = m[method];
    m[method] = function (...args) {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.href ?? "";
      let host = "";
      try { host = new URL(url).hostname; } catch {}
      if (BLOCKED.test(host)) throw new Error(`BLOCKED ${host}`);
      return original.apply(this, args);
    };
  }
}
```

```bash
rm -rf .next
NODE_OPTIONS="--require ./block-google-fonts.cjs" npm run build
```

`NODE_OPTIONS` propagates into the child processes and worker threads
`next build` spawns, so the block covers the webpack loaders where the fetch
actually happened. Run it against a commit that still uses `next/font/google` to
confirm the gate itself works — it should fail there and pass here.
