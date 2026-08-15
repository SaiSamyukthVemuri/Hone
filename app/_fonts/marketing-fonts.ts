import localFont from "next/font/local";

// Marketing surface face: Inter 400/500/600/700, exposed as
// --font-marketing-sans and scoped to .marketing-surface by the
// MarketingSurface wrapper. Headings render at 600, a weight the root
// layout deliberately does not load.
//
// This is a SEPARATE module from app-fonts.ts on purpose: importing these faces
// from the root layout would put Inter 600/700 into every authenticated
// route's CSS, where bold is otherwise synthesised from the 500 face.
//
// SEPARATION IS NOT ISOLATION, and it is worth being precise about what it does
// buy. These faces declare the SAME `font-family: Inter` as the root loader -
// as they did under next/font/google - so once the marketing stylesheet is in
// the document its 600/700 join root-family matching. On a client-side
// navigation (marketing footer -> /login) the App Router retains that
// stylesheet, and /login's heading then resolves to a REAL 700 instead of the
// synthesised bold it gets on a direct load.
//
// Measured, not theorised: after clicking through from /, family Inter reports
// weights 400/500/600/700 present with Inter/700 actually LOADED, and the login
// <h1> computes 700, where a direct load synthesises bold from 500.
//
// PRE-EXISTING and reproduced on the production base too: the previous
// next/font/google build emitted the same single `Inter` family for both
// loaders (--font-inter and --font-marketing-sans both resolved to
// "Inter","Inter Fallback"). This change neither causes nor worsens it, and
// deliberately does not fix it - giving marketing its own family identity is a
// real typography change and belongs in its own PR. See FONTS.md.
//
// See app-fonts.ts for the full rationale and licence pointer.


export const marketingInterLatin = localFont({
  src: [
    { path: "./inter-latin.woff2", weight: "400", style: "normal" },
    { path: "./inter-latin.woff2", weight: "500", style: "normal" },
    { path: "./inter-latin.woff2", weight: "600", style: "normal" },
    { path: "./inter-latin.woff2", weight: "700", style: "normal" },
  ],
  display: "swap",
  variable: "--font-marketing-sans",
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

export const marketingInterLatinExt = localFont({
  src: [
    { path: "./inter-latin-ext.woff2", weight: "400", style: "normal" },
    { path: "./inter-latin-ext.woff2", weight: "500", style: "normal" },
    { path: "./inter-latin-ext.woff2", weight: "600", style: "normal" },
    { path: "./inter-latin-ext.woff2", weight: "700", style: "normal" },
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

export const marketingInterVietnamese = localFont({
  src: [
    { path: "./inter-vietnamese.woff2", weight: "400", style: "normal" },
    { path: "./inter-vietnamese.woff2", weight: "500", style: "normal" },
    { path: "./inter-vietnamese.woff2", weight: "600", style: "normal" },
    { path: "./inter-vietnamese.woff2", weight: "700", style: "normal" },
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

export const marketingInterCyrillic = localFont({
  src: [
    { path: "./inter-cyrillic.woff2", weight: "400", style: "normal" },
    { path: "./inter-cyrillic.woff2", weight: "500", style: "normal" },
    { path: "./inter-cyrillic.woff2", weight: "600", style: "normal" },
    { path: "./inter-cyrillic.woff2", weight: "700", style: "normal" },
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

export const marketingInterCyrillicExt = localFont({
  src: [
    { path: "./inter-cyrillic-ext.woff2", weight: "400", style: "normal" },
    { path: "./inter-cyrillic-ext.woff2", weight: "500", style: "normal" },
    { path: "./inter-cyrillic-ext.woff2", weight: "600", style: "normal" },
    { path: "./inter-cyrillic-ext.woff2", weight: "700", style: "normal" },
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

export const marketingInterGreek = localFont({
  src: [
    { path: "./inter-greek.woff2", weight: "400", style: "normal" },
    { path: "./inter-greek.woff2", weight: "500", style: "normal" },
    { path: "./inter-greek.woff2", weight: "600", style: "normal" },
    { path: "./inter-greek.woff2", weight: "700", style: "normal" },
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

export const marketingInterGreekExt = localFont({
  src: [
    { path: "./inter-greek-ext.woff2", weight: "400", style: "normal" },
    { path: "./inter-greek-ext.woff2", weight: "500", style: "normal" },
    { path: "./inter-greek-ext.woff2", weight: "600", style: "normal" },
    { path: "./inter-greek-ext.woff2", weight: "700", style: "normal" },
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

/** Inter 400/500/600/700. Exposes --font-marketing-sans. */
export const marketingSans = marketingInterLatin;
