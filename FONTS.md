# Fonts — Hone marketing site

**Scope:** the public marketing surface (pages wrapped in `.marketing-surface`).

## Decision: Instrument Sans throughout the marketing surface

Per the product owner's direction (MKT-02A), the public marketing surface uses
**Instrument Sans for both headings and body** — a clean, modern sans-serif with
no serif letterforms. Weights: **400** body, **500** UI/nav/buttons, **600**
headings, **700** rare emphasis. Default styling; no stylistic sets are enabled.

It replaced **Inter**, which the marketing surface used previously and which the
**authenticated app still uses** — this decision was marketing-only and
`app/_fonts/app-fonts.ts` is untouched.

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

| Family | Copyright | Upstream | Licence file | Served at |
|---|---|---|---|---|
| Inter | Copyright (c) 2016 The Inter Project Authors | <https://github.com/rsms/inter> | `public/fonts/LICENSE-Inter.txt` | `/fonts/LICENSE-Inter.txt` |
| Fraunces | Copyright 2018 The Fraunces Project Authors | <https://github.com/undercasetype/Fraunces> | `public/fonts/LICENSE-Fraunces.txt` | `/fonts/LICENSE-Fraunces.txt` |
| Instrument Sans | Copyright 2022 The Instrument Sans Project Authors | <https://github.com/Instrument/instrument-sans> | `public/fonts/LICENSE-InstrumentSans.txt` | `/fonts/LICENSE-InstrumentSans.txt` |

### Instrument Sans — exact provenance (MKT-02A)

Fetched from the upstream project at a **pinned commit**, not from a package
registry, a CDN, or Google Fonts:

| | |
|---|---|
| Upstream | `https://github.com/Instrument/instrument-sans` |
| Commit | `7fa22308a3d0c94ee2b3cd537a1196b65db34a3e` (2023-06-14) |
| Path | `fonts/webfonts/InstrumentSans-{Regular,Medium,SemiBold,Bold}.woff2` |
| Licence source | `OFL.txt` at the repository root, same commit |
| Licence | SIL Open Font License 1.1 |
| Retrieved | 2026-09-24 |

The commit is recorded because "the upstream repo" is not a reproducible
reference — `HEAD` moves. Re-verifying means fetching the same four paths at that
SHA and comparing against the sha256 values in the table below.

**These binaries are NOT Google-subsetted, and that changes the licence picture
in our favour.** Google's subsetting strips name ID 13, the full licence body,
which is why the Inter and Fraunces notices exist as separate files. Upstream's
own webfonts retain **name ID 13 alongside ID 0 (copyright) and ID 14 (licence
URL)**, so each served Instrument Sans file carries the complete OFL internally.
`public/fonts/LICENSE-InstrumentSans.txt` is still vendored and still served: the
internal copy satisfies OFL clause 2 for the binary, and the served text file
means a human can read the terms without a font inspector. Both are pinned by
`tests/source-guards/self-hosted-fonts-guards.test.ts`.

**Naming the licence is not enough, and neither is a copy in the source tree.**
OFL 1.1 clause 2 permits redistribution "provided that each copy contains the
above copyright notice and this license". The copies that matter are the ones a
**browser** receives, and `next/font/local` emits only the `.woff2` into
`.next/static/media/` — it copies no sibling text file. The notices therefore
live under `public/`, which Next serves verbatim, so they are reachable in the
deployed app at the URLs above.

Both files were fetched verbatim from each project's own repository
(`rsms/inter/LICENSE.txt`, `undercasetype/Fraunces/OFL.txt`) and are the complete
OFL 1.1 (Version 1.1 - 26 February 2007) carrying that family's own copyright
line; the two bodies differ only in known upstream formatting variants.

**There is deliberately exactly ONE copy of each notice.** Keeping a second copy
beside the binaries in `app/_fonts/` would satisfy both "next to the fonts" and
"served to the browser", and is precisely how one of them silently stops matching
upstream. `tests/source-guards/self-hosted-fonts-guards.test.ts` fails if a
notice goes missing, if it is replaced by a stub that merely names the licence,
or if a second copy reappears under `app/_fonts/`.

> **Putting a file in `public/` does not mean it is served.** The first attempt
> at this did exactly that and the notices were still unreachable: the Supabase
> session middleware in `middleware.ts` matches every path it does not
> explicitly exclude, so `GET /fonts/LICENSE-Inter.txt` answered
> **307 → /login**.
>
> **The fix for that was itself wrong, in a way worth recording.** Excluding the
> whole `fonts/` **prefix** made the notices reachable and opened an auth hole:
> Next **route groups do not appear in the URL**, so
> `app/(app)/fonts/private/page.tsx` serves `/fonts/private` — a genuine
> authenticated route that the prefix exempted from `updateSession`. Nothing
> named `app/fonts/…` would exist, so a guard watching that directory stays
> green while the route answers anonymously. Found by review, not by tests.
>
> `middleware.ts` therefore excludes **exactly two paths**, anchored with `$`:
> `fonts/LICENSE-Inter.txt` and `fonts/LICENSE-Fraunces.txt`. Nothing else under
> `/fonts/` is exempt, and the `.woff2` assets need no exemption at all — Next
> emits them under `/_next/static/media`, already covered by `_next/static`.
>
> Verified against a real `next start`, unauthenticated: both notices **200**
> with bytes identical to the repository; `/fonts/private`, `/fonts/anything`,
> `/fonts/LICENSE-Inter.txt/extra` and `/fonts` all **307 → /login**; every
> traversal, encoded-traversal and prefix-confusion variant **307**; the
> authenticated app **307**; public marketing routes **200**.
>
> The security boundary is the **matcher**, and the guard pins it in both
> directions. The separate "`app/fonts/` must not exist" check is **namespace
> hygiene only** — it is explicitly not the protection, because chasing route
> groups, parallel routes, interception routes and dynamic segments with a
> filesystem guard would mean reimplementing Next's route resolution and being
> wrong about any one of them would reopen the hole silently.

### What the BROWSER receives

The served `.woff2` files carry part of the notice themselves. Clause 2 accepts
the notice "in the appropriate machine-readable metadata fields within text or
binary files", and these subsets populate some of those fields. Read out of the
shipped binaries:

| name ID | Field | Inter | Fraunces |
|---|---|---|---|
| 0 | Copyright | `Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)` | `Copyright 2020 The Fraunces Project Authors (github.com/undercasetype/Fraunces)` |
| 14 | License Info URL | `https://openfontlicense.org` | `https://scripts.sil.org/OFL` |
| 13 | License Description | **absent** | **absent** |

So every served copy carries its own **copyright notice** (name ID 0) and a
**pointer** to the licence (name ID 14) — but name ID 13, the field that would
carry the licence *body*, is stripped by Google's subsetting.

**A pointer is not the licence.** Clause 2 requires each copy to contain the
copyright notice *and this license*, so the metadata alone does not satisfy it.
That is the reason the full text is served from `public/fonts/LICENSE-*.txt`
rather than only kept in the source tree: together, the binary's own copyright
field and the served licence text cover both halves of the clause.

Embedding the licence body into name ID 13 would also satisfy it, and was
rejected: it would mean rewriting every `.woff2`, which would break the property
this whole change rests on — that the bytes are exactly what `next/font/google`
served, verified by the sha256 values above.

For context, the deployed-notice position was **worse before self-hosting**:
`next/font/google` downloaded and served these same subsetted bytes with no
licence text anywhere in the repository at all.

The guard asserts name IDs 0, 1 and 14 on **every** vendored `.woff2` by parsing
the WOFF2 name table (`tests/source-guards/woff2-name-table.ts`), so a future
re-vendor that produced binaries stripped of their copyright would fail rather
than quietly shipping an unattributed face.

The vendored `.woff2` files in `app/_fonts/` are **the exact bytes the previous
`next/font/google` build downloaded from Google Fonts** and served from
`/_next/static/media/`. They were lifted from that build's output rather than
re-sourced, which is what makes this change visually a no-op instead of a
re-cut: the browser receives the identical binaries it received before.

## What is vendored

**TWO SURFACES, TWO FAMILIES — read this table with that split in mind.**

| Surface | Family | Weights | Loader |
|---|---|---|---|
| Authenticated app (root layout) | **Inter** | 400, 500 | `app/_fonts/app-fonts.ts` |
| Authenticated app (serif accents) | **Fraunces** | 400, 700 + italics | `app/_fonts/app-fonts.ts` |
| Public marketing surface | **Instrument Sans** | 400, 500, 600, 700 | `app/_fonts/marketing-fonts.ts` |

Google serves **one variable `.woff2` per unicode-range subset**, so Inter and
Fraunces are several files each; all 13 of those subsets are vendored, so
Cyrillic, Greek and Vietnamese **client names in the authenticated app** keep
rendering in Inter rather than dropping to a fallback face. Instrument Sans is
not subsetted — see below.

**The `Weights` column is per family, and Inter's is now 400/500 — no longer a
union across two loaders.** It read 400/500/600/700 while the marketing surface
also loaded Inter at heading weights. Since MKT-02A the marketing surface loads
Instrument Sans instead, so **nothing declares Inter 600 or 700 anywhere**: the
root layout never did, and an authenticated element asking for bold still gets a
browser-synthesised one from the 500 face. Reading 600/700 beside the Inter rows
would now imply a face this application does not ship.

| File | Family | Style | Subset | Weights | Bytes | Preloaded | sha256 |
|---|---|---|---|---|---|---|---|
| `fraunces-italic-latin-ext.woff2` | Fraunces | italic | latin-ext | 400, 700 | 40,560 | no | `7e701dc124492f7d0856fba4a07157d0cecc84e2b2b4615f08530c1e8bc112dd` |
| `fraunces-italic-latin.woff2` | Fraunces | italic | latin | 400, 700 | 45,624 | yes | `c9745ee907c02cdd46cc41a65bb711cd861432f679a76c18e3de204a18723040` |
| `fraunces-italic-vietnamese.woff2` | Fraunces | italic | vietnamese | 400, 700 | 12,956 | no | `d24c3502a91415f2ec44f107807673255b696c379b3995543270921c27863e32` |
| `fraunces-latin-ext.woff2` | Fraunces | normal | latin-ext | 400, 700 | 33,640 | no | `f1451edd6434085c4f9f3a8b4a674182dd7d6acccf53bfced19fd167f0705a06` |
| `fraunces-latin.woff2` | Fraunces | normal | latin | 400, 700 | 36,560 | yes | `88e17be075f1be50ab67b057b99e3701b828f44ed28f9452df6c02645bb0cba9` |
| `fraunces-vietnamese.woff2` | Fraunces | normal | vietnamese | 400, 700 | 11,536 | no | `250cc2966c658fb6d336731de9d82a8129025e9839c20c253bbc477852f6cf4f` |
| `inter-cyrillic-ext.woff2` | Inter | normal | cyrillic-ext | 400, 500 | 25,844 | no | `fccca918fea40089dacadc7045861314d1a6bc91f1f323cc1eeb22ebcdb321b5` |
| `inter-cyrillic.woff2` | Inter | normal | cyrillic | 400, 500 | 18,744 | no | `aebf2ab4a4ce6810d73c1ac7be7cafb4e5ec4cee2d6db5fb3e09691747ec4bd6` |
| `inter-greek-ext.woff2` | Inter | normal | greek-ext | 400, 500 | 11,272 | no | `a2e2c783ca6f9c20486e81e72a279203e86730bbf8f01ff6a5ee9dbd09e1c271` |
| `inter-greek.woff2` | Inter | normal | greek | 400, 500 | 19,044 | no | `46dd4cdca58c26ae87cc6927657bf83b2e8abfc39ffd0ab176e301a8d28d22bf` |
| `inter-latin-ext.woff2` | Inter | normal | latin-ext | 400, 500 | 85,272 | no | `a28eb6d3ccb534ae0c94ca999371df024aab60b08c3c8a5720ee9e32fa0faaa2` |
| `inter-latin.woff2` | Inter | normal | latin | 400, 500 | 48,432 | yes | `c940764593d0fe5d596be327ca7558855e018039fb78509aa21921fd3644c3e4` |
| `inter-vietnamese.woff2` | Inter | normal | vietnamese | 400, 500 | 10,280 | no | `8db00ff46c67b22cda8bed865acf7077651cac8d2841d5b40980556b48961931` |
| `instrument-sans-400.woff2` | Instrument Sans | normal | *(none — full charset)* | 400 | 34,628 | yes | `f28af62faa9eec1e5482cf6e2a3e06bc865fa2fa6937bd56c14d2be23c9b4c46` |
| `instrument-sans-500.woff2` | Instrument Sans | normal | *(none — full charset)* | 500 | 35,580 | no | `65d25fc111c40fd6b481d9db860af365730752228dfd8a246e79648d8a01f02a` |
| `instrument-sans-600.woff2` | Instrument Sans | normal | *(none — full charset)* | 600 | 35,812 | yes | `04235f235483213906d69cafb7a87ee197adaffacb081c8a7f809d00f9b353cd` |
| `instrument-sans-700.woff2` | Instrument Sans | normal | *(none — full charset)* | 700 | 35,352 | no | `3e67cdb08813ada42a8a58190c2082f60862ec84bf3d2a5033002d8475efc8da` |

Licence file: `public/fonts/LICENSE-InstrumentSans.txt`, 4,403 bytes, sha256
`9e27a72ed30eb49a08678f6a5d6ed98ec7ba5368f541637ee0683ec9134ef966`.

Total: **541,136 bytes**. The preloaded set is the three latin files plus
Instrument Sans **400 and 600**; everything else is fetched on demand.

### Why Instrument Sans has no unicode-range subsets

A real difference from the other two families, and not an oversight. Inter and
Fraunces arrived here as many files because Google's API had already split them
per unicode-range. Upstream Instrument Sans publishes **one full-charset webfont
per weight** and ships no subsets, so there is nothing to vendor per range.
Generating them locally was rejected: it would mean re-deriving the family with
our own tooling, which changes the bytes and destroys the provenance the pinned
commit and sha256 values above establish.

The practical consequence is honest to state: a marketing page in a language
outside Instrument Sans' charset falls back to the system sans, where Inter
covered Cyrillic, Greek and Vietnamese. The marketing site is English-language,
so no current page is affected — but a future translated marketing page is, and
this is where that decision was made.

### Why four static weights and not the variable font

Upstream ships both. `InstrumentSans[wdth,wght].woff2` is **88,784 bytes in one
file**; the four statics are 141,372 across four. The variable font was rejected
for two reasons:

1. It carries a `wdth` axis this design never varies, so every visitor would
   download width data to render exactly one width.
2. This repository's guard forbids declaring a weight RANGE, for a reason that
   still applies: the root layout deliberately loads Inter 400/500 only, and a
   range would let an authenticated element match a weight the root never
   intended to serve. Four files with one discrete `weight:` each cannot do that.

On the critical path the statics also win: 400 + 600 preloaded is **70,440
bytes**, against 88,784 for the variable file.

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

   **The marketing module now uses the same technique for a different reason.**
   Instrument Sans has no unicode-range subsets to split, but it does have four
   separate static weight files, and `preload` is per-call — so it is four calls
   that each declare `font-family: Instrument Sans` and compose into one family,
   with only the 400 carrying the CSS variable and the metric-adjusted fallback,
   and 400 + 600 preloaded.

2. **Weights are declared one per `src` entry, never as a range.** Writing
   `weight: "400 700"` against a variable font looks like a tidy simplification
   and is not equivalent. The root layout loads Inter 400/500 only, so an
   authenticated-app element asking for 700 matches the 500 face and the browser
   **synthesises** bold. A range would start rendering a true 700 there — a
   visual change smuggled in under a build fix.

3. **The marketing module is never imported by the root layout.** Merging them
   would put the marketing heading weights into every authenticated route's own
   CSS, with the
   same consequence as (2) even on a direct load.

   **Separation is not isolation** — see the pre-existing defect recorded below.
   It controls which CSS a route loads initially; it does not stop marketing's
   600/700 from participating in font matching once that stylesheet is in the
   document.

The metric-adjusted fallback pairing is preserved: Inter falls back to **Arial**,
Fraunces to **Times New Roman** (`adjustFontFallback`), matching what
`next/font/google` generated from its own metrics table.

## RESOLVED by MKT-02A: marketing weights could reach authenticated routes

**This section is kept as the record of a defect that is now closed**, because
the reasoning explains why the families must stay distinct.

**The defect.** Both loaders declared the same CSS family identity,
`font-family: Inter` — as they did under `next/font/google`, where
`--font-inter` and `--font-marketing-sans` both resolved to
`"Inter","Inter Fallback"`. Module separation therefore governed which CSS a
route loads *initially*, not which faces could participate in matching once
loaded.

**The fix, and why it was a side effect rather than a refactor.** The section
below previously recorded that "giving marketing its own family identity is a
real typography change and belongs in its own PR". MKT-02A is that PR: the
marketing surface now declares `font-family: Instrument Sans`, a family the root
layout does not load, so marketing's 600/700 can no longer be matched by an
authenticated route under any navigation order. The product decision closed the
defect; no separate change was needed.

**What must stay true.** If marketing and the authenticated app are ever given
the same family again, this defect returns with it.
`tests/source-guards/self-hosted-fonts-guards.test.ts` pins that `app-fonts.ts`
contains no Instrument Sans and that the marketing module contains no Inter.

The original analysis follows.

App Router **client navigation retains** the marketing stylesheet. So:

| Route to `/login` | Faces available under `Inter` | `<h1>` renders |
|---|---|---|
| direct load | 400, 500 | synthesised bold from 500 |
| client nav from a marketing page | 400, 500, **600, 700** | **real 700** |

Measured on this branch: after clicking the marketing footer's "Sign in",
`document.fonts` reports `Inter/700` **loaded** and the login `<h1>` computes
`700`. The same mechanism exists on the production base — the pre-self-hosting
build emitted one shared `Inter` family across both loaders, and the
inconsistency reproduces there too.

**Why it is not fixed in this change.** Giving marketing a distinct family is a
deliberate typography change: `/login` reached via marketing would stop
rendering real 700. That is almost certainly the original intent, but this
change's contract is to remove the Google Fonts build dependency while
preserving rendering, and diverging from production here would undo the point of
proving equivalence. It is deferred to a dedicated PR:

> **fix(fonts): isolate marketing Inter faces from authenticated routes** —
> give marketing its own family identity, preserve marketing 400/500/600/700 and
> authenticated 400/500 + synthesised bold, and prove `/login` renders
> identically whether loaded directly or reached by client navigation, with a
> browser-level negative control showing the shared-family version leaks.

**No test pins the current behaviour**, deliberately: it is a defect, not an
invariant, and pinning it would obstruct the fix.

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

---

# Fonts — receipt PDF (server-side)

**Scope:** the payment receipt PDF attached to the receipt email
(`lib/billing/receipt-pdf.ts`). Nothing here reaches a browser; these are
server-side rendering assets, entirely separate from the marketing web fonts
above.

## Faces

`lib/billing/fonts/` — **DejaVu 2.37**, four faces:

| File | Role |
|---|---|
| `DejaVuSans.ttf` | body text, detail values |
| `DejaVuSans-Bold.ttf` | detail labels |
| `DejaVuSerif-Bold.ttf` | "Hone" wordmark, headline |
| `DejaVuSansMono.ttf` | Stripe ids in the test-mode receipt |

**Licence:** Bitstream Vera, reproduced verbatim in
`lib/billing/fonts/LICENSE.txt`. It permits redistribution, including inside a
derived work. The file's trailing whitespace is upstream's and is preserved —
see `.gitattributes`.

## Why bundled, and why these

A serverless runtime's font set is not a contract. Reading whatever the base
image ships makes a receipt's appearance — and, with a coverage check, whether
it renders at all — depend on an image that can change under us.

They are **force-included in the deployment trace** via
`outputFileTracingIncludes` in `next.config.ts`. Next traces server
dependencies statically and cannot see a `readFileSync` path, so without that
entry the fonts are absent in production while every local test passes.

**No runtime downloads and no external rendering service.** Files are read from
disk; nothing is fetched. Glyphs are **subset at embed time**, so a receipt
carries only the glyphs it uses — ~28KB per PDF against 2.1MB of bundled faces.

## Supported coverage

Faithfully rendered:

- Basic Latin, Latin-1 Supplement
- Latin Extended-A and Extended-B
- Combining Diacritical Marks (U+0300–U+036F)
- Greek, Cyrillic
- General Punctuation, Currency Symbols

**Not covered:** CJK, Korean, most Indic scripts, emoji.

## What happens outside coverage

**Nothing is substituted.** An earlier implementation replaced unsupported
characters with `?`, which silently corrupted the client and studio names a
receipt exists to identify.

A character with no glyph now raises `UnsupportedReceiptCharacterError`, and the
sender takes the pre-provider preparation-failure path: **no PDF, no email, no
partial receipt** — and the payment itself is untouched, with the receipt claim
released so a practitioner can still send manually.

Extending coverage to CJK means bundling a CJK face: **16MB+ per weight**
against these four faces' 2.1MB combined. That is a deployment-size decision
and is deliberately not made here.
