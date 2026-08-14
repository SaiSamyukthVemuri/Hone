import localFont from "next/font/local";

// SELF-HOSTED FONTS. These modules replace the three `next/font/google`
// calls that made `next build` depend on a live fetch from
// fonts.googleapis.com / fonts.gstatic.com. That fetch failed often enough in
// CI to produce repeated false reds on deterministic commits.
//
// The .woff2 files in this directory are the EXACT bytes the previous
// next/font/google build downloaded and served from /_next/static/media, so
// rendering is unchanged rather than merely similar. Provenance, licence and
// per-file sha256 are recorded in FONTS.md.
//
// WHY ONE CALL PER SUBSET: Google serves one variable .woff2 per
// unicode-range subset, and `next/font/local` applies `declarations` to
// every `src` entry of a call, so a single call cannot give two files
// different unicode-ranges. Every call here declares the SAME `font-family`,
// so the faces compose into one family exactly as the Google-served CSS did.
// Only the latin call of each family carries the CSS variable, the preload and
// the metric-adjusted fallback; the rest contribute @font-face rules only.
//
// WEIGHTS ARE DELIBERATELY NOT A RANGE. The root layout declares Inter
// 400/500 only while the marketing surface declares 400/500/600/700.
// Collapsing to a "400 700" variable range would start rendering TRUE 600 and
// 700 in the authenticated app, where the browser currently matches the 500
// face and synthesises bold. That would be a visual change.


// --------------------------------------------------------------------------
// Inter 400 + 500 - the app-wide body/UI face, exposed as --font-inter.
// --------------------------------------------------------------------------
export const interLatin = localFont({
  src: [
    { path: "./inter-latin.woff2", weight: "400", style: "normal" },
    { path: "./inter-latin.woff2", weight: "500", style: "normal" },
  ],
  display: "swap",
  variable: "--font-inter",
  preload: true,
  adjustFontFallback: "Arial",
  declarations: [
    { prop: "font-family", value: "Inter" },
    {
      prop: "unicode-range",
      value:
        "u+00??,u+0131,u+0152-0153,u+02bb-02bc,u+02c6,u+02da,u+02dc,u+0304,u+0308,u+0329,u+2000-206f,u+20ac,u+2122,u+2191,u+2193,u+2212,u+2215,u+feff,u+fffd",
    },
  ],
});

export const interLatinExt = localFont({
  src: [
    { path: "./inter-latin-ext.woff2", weight: "400", style: "normal" },
    { path: "./inter-latin-ext.woff2", weight: "500", style: "normal" },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "Inter" },
    {
      prop: "unicode-range",
      value:
        "u+0100-02ba,u+02bd-02c5,u+02c7-02cc,u+02ce-02d7,u+02dd-02ff,u+0304,u+0308,u+0329,u+1d00-1dbf,u+1e00-1e9f,u+1ef2-1eff,u+2020,u+20a0-20ab,u+20ad-20c0,u+2113,u+2c60-2c7f,u+a720-a7ff",
    },
  ],
});

export const interVietnamese = localFont({
  src: [
    { path: "./inter-vietnamese.woff2", weight: "400", style: "normal" },
    { path: "./inter-vietnamese.woff2", weight: "500", style: "normal" },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "Inter" },
    {
      prop: "unicode-range",
      value:
        "u+0102-0103,u+0110-0111,u+0128-0129,u+0168-0169,u+01a0-01a1,u+01af-01b0,u+0300-0301,u+0303-0304,u+0308-0309,u+0323,u+0329,u+1ea0-1ef9,u+20ab",
    },
  ],
});

export const interCyrillic = localFont({
  src: [
    { path: "./inter-cyrillic.woff2", weight: "400", style: "normal" },
    { path: "./inter-cyrillic.woff2", weight: "500", style: "normal" },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "Inter" },
    {
      prop: "unicode-range",
      value:
        "u+0301,u+0400-045f,u+0490-0491,u+04b0-04b1,u+2116",
    },
  ],
});

export const interCyrillicExt = localFont({
  src: [
    { path: "./inter-cyrillic-ext.woff2", weight: "400", style: "normal" },
    { path: "./inter-cyrillic-ext.woff2", weight: "500", style: "normal" },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "Inter" },
    {
      prop: "unicode-range",
      value:
        "u+0460-052f,u+1c80-1c8a,u+20b4,u+2de0-2dff,u+a640-a69f,u+fe2e-fe2f",
    },
  ],
});

export const interGreek = localFont({
  src: [
    { path: "./inter-greek.woff2", weight: "400", style: "normal" },
    { path: "./inter-greek.woff2", weight: "500", style: "normal" },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "Inter" },
    {
      prop: "unicode-range",
      value:
        "u+0370-0377,u+037a-037f,u+0384-038a,u+038c,u+038e-03a1,u+03a3-03ff",
    },
  ],
});

export const interGreekExt = localFont({
  src: [
    { path: "./inter-greek-ext.woff2", weight: "400", style: "normal" },
    { path: "./inter-greek-ext.woff2", weight: "500", style: "normal" },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "Inter" },
    {
      prop: "unicode-range",
      value:
        "u+1f??",
    },
  ],
});

// --------------------------------------------------------------------------
// Fraunces 400 + 700, normal AND italic - the display face, exposed as
// --font-fraunces. Google paired Fraunces with a Times New Roman metric
// fallback, not Arial, so that pairing is preserved here.
//
// NOTE: roughly 40 surfaces ASK for this face via `font-[var(--font-fraunces)]`
// and none of them get it, on this branch or on production. Tailwind v4 reads
// `font-[...]` as font-WEIGHT, so that class compiles to
// `font-weight: var(--font-fraunces)` - an invalid weight, silently dropped -
// and never sets font-family. The face is loaded and preloaded but never
// rendered. That is a pre-existing defect, unchanged by self-hosting, and
// deliberately NOT fixed here: fixing it would restyle ~40 surfaces from sans
// to serif, which is a product decision, not a build fix. See FONTS.md.
// --------------------------------------------------------------------------
export const frauncesLatin = localFont({
  src: [
    { path: "./fraunces-latin.woff2", weight: "400", style: "normal" },
    { path: "./fraunces-latin.woff2", weight: "700", style: "normal" },
  ],
  display: "swap",
  variable: "--font-fraunces",
  preload: true,
  adjustFontFallback: "Times New Roman",
  declarations: [
    { prop: "font-family", value: "Fraunces" },
    {
      prop: "unicode-range",
      value:
        "u+00??,u+0131,u+0152-0153,u+02bb-02bc,u+02c6,u+02da,u+02dc,u+0304,u+0308,u+0329,u+2000-206f,u+20ac,u+2122,u+2191,u+2193,u+2212,u+2215,u+feff,u+fffd",
    },
  ],
});

export const frauncesLatinExt = localFont({
  src: [
    { path: "./fraunces-latin-ext.woff2", weight: "400", style: "normal" },
    { path: "./fraunces-latin-ext.woff2", weight: "700", style: "normal" },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "Fraunces" },
    {
      prop: "unicode-range",
      value:
        "u+0100-02ba,u+02bd-02c5,u+02c7-02cc,u+02ce-02d7,u+02dd-02ff,u+0304,u+0308,u+0329,u+1d00-1dbf,u+1e00-1e9f,u+1ef2-1eff,u+2020,u+20a0-20ab,u+20ad-20c0,u+2113,u+2c60-2c7f,u+a720-a7ff",
    },
  ],
});

export const frauncesVietnamese = localFont({
  src: [
    { path: "./fraunces-vietnamese.woff2", weight: "400", style: "normal" },
    { path: "./fraunces-vietnamese.woff2", weight: "700", style: "normal" },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "Fraunces" },
    {
      prop: "unicode-range",
      value:
        "u+0102-0103,u+0110-0111,u+0128-0129,u+0168-0169,u+01a0-01a1,u+01af-01b0,u+0300-0301,u+0303-0304,u+0308-0309,u+0323,u+0329,u+1ea0-1ef9,u+20ab",
    },
  ],
});

export const frauncesItalicLatin = localFont({
  src: [
    { path: "./fraunces-italic-latin.woff2", weight: "400", style: "italic" },
    { path: "./fraunces-italic-latin.woff2", weight: "700", style: "italic" },
  ],
  display: "swap",
  preload: true,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "Fraunces" },
    {
      prop: "unicode-range",
      value:
        "u+00??,u+0131,u+0152-0153,u+02bb-02bc,u+02c6,u+02da,u+02dc,u+0304,u+0308,u+0329,u+2000-206f,u+20ac,u+2122,u+2191,u+2193,u+2212,u+2215,u+feff,u+fffd",
    },
  ],
});

export const frauncesItalicLatinExt = localFont({
  src: [
    { path: "./fraunces-italic-latin-ext.woff2", weight: "400", style: "italic" },
    { path: "./fraunces-italic-latin-ext.woff2", weight: "700", style: "italic" },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "Fraunces" },
    {
      prop: "unicode-range",
      value:
        "u+0100-02ba,u+02bd-02c5,u+02c7-02cc,u+02ce-02d7,u+02dd-02ff,u+0304,u+0308,u+0329,u+1d00-1dbf,u+1e00-1e9f,u+1ef2-1eff,u+2020,u+20a0-20ab,u+20ad-20c0,u+2113,u+2c60-2c7f,u+a720-a7ff",
    },
  ],
});

export const frauncesItalicVietnamese = localFont({
  src: [
    { path: "./fraunces-italic-vietnamese.woff2", weight: "400", style: "italic" },
    { path: "./fraunces-italic-vietnamese.woff2", weight: "700", style: "italic" },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "Fraunces" },
    {
      prop: "unicode-range",
      value:
        "u+0102-0103,u+0110-0111,u+0128-0129,u+0168-0169,u+01a0-01a1,u+01af-01b0,u+0300-0301,u+0303-0304,u+0308-0309,u+0323,u+0329,u+1ea0-1ef9,u+20ab",
    },
  ],
});

/** Inter 400/500. Exposes --font-inter. */
export const inter = interLatin;

/** Fraunces 400/700 normal+italic. Exposes --font-fraunces. */
export const fraunces = frauncesLatin;
