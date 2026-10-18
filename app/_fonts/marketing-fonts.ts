import localFont from "next/font/local";

// ===========================================================================
// MARKETING SURFACE FACE — Instrument Sans 400/500/600/700
// ===========================================================================
//
// Exposed as `--font-marketing-sans` and scoped to `.marketing-surface` by the
// MarketingSurface wrapper. `--font-marketing-display` and
// `--font-marketing-text` both derive from that one variable in globals.css, so
// this module is the single place the public site's typeface is decided.
//
// WHY THIS IS A SEPARATE MODULE FROM app-fonts.ts, unchanged in intent: loading
// these faces from the root layout would put marketing's heading weights into
// every authenticated route's CSS.
//
// -------------------------------------------------------------------------
// THIS SWAP ALSO CLOSES A PRE-EXISTING DEFECT, AND THAT IS WORTH STATING.
// -------------------------------------------------------------------------
// The previous marketing faces declared `font-family: Inter` — the SAME family
// the root layout loads. FONTS.md recorded the consequence: once the marketing
// stylesheet was in the document, its 600/700 joined root-family matching, so a
// client-side navigation from the marketing footer to /login rendered a REAL 700
// where a direct load synthesises bold from 500. FONTS.md said giving marketing
// its own family identity "is a real typography change and belongs in its own
// PR".
//
// This is that change. `Instrument Sans` is a family the root layout does not
// load, so marketing's weights can no longer be matched by an authenticated
// route under any navigation order. The fix is a side effect of the product
// decision, not a smuggled refactor, and the authenticated app's own typography
// is untouched: app-fonts.ts is not modified by this change.
//
// -------------------------------------------------------------------------
// FOUR STATIC FACES, NOT THE VARIABLE FONT, AND NOT SUBSETTED.
// -------------------------------------------------------------------------
// Upstream ships both. The variable `InstrumentSans[wdth,wght].woff2` is 88,784
// bytes in ONE file; the four static weights are 141,372 across four. The
// variable file was rejected for two reasons: it carries a `wdth` axis this
// design never varies, so every visitor would download width data to render one
// width; and a discrete `weight:` per `src` is what this repository's guard
// requires — a declared RANGE would let an authenticated element match a weight
// the root layout deliberately does not load.
//
// PRELOAD IS SELECTIVE, for the same reason it is on the Inter subsets: 400 and
// 600 are the body and heading weights and both appear above the fold, so both
// are preloaded (70,440 bytes). 500 and 700 are nav/UI and rare emphasis, and
// load on demand rather than blocking first paint.
//
// NO UNICODE-RANGE SUBSETS, which is a real difference from the Inter
// arrangement and is not a mistake. Inter arrived here as 7 files because
// Google's API had already split it per unicode-range. Upstream Instrument Sans
// publishes one full-charset webfont per weight and no subsets exist to vendor;
// producing them would mean re-generating the family locally, which changes the
// bytes and the provenance this PR pins. So each weight is one file, and the
// `unicode-range` declarations the Inter loaders carried are absent because
// there is nothing to divide. See FONTS.md.
//
// See app-fonts.ts for the authenticated app's faces and the licence pointer.
// ===========================================================================

/** Body. Carries the CSS variable and is preloaded. */
export const marketingInstrumentSans = localFont({
  src: [{ path: "./instrument-sans-400.woff2", weight: "400", style: "normal" }],
  display: "swap",
  variable: "--font-marketing-sans",
  preload: true,
  adjustFontFallback: "Arial",
  declarations: [{ prop: "font-family", value: "Instrument Sans" }],
});

/**
 * Nav, buttons and other UI text.
 *
 * ONE `localFont` CALL PER WEIGHT, and the `declarations` entry is what makes
 * them one family rather than four. `next/font/local` mints a unique internal
 * family per call; declaring `font-family: Instrument Sans` on each joins them,
 * exactly as the seven Inter subsets joined into one `Inter`. Per-call granularity
 * is also the only way to preload some weights and not others.
 */
export const marketingInstrumentSansMedium = localFont({
  src: [{ path: "./instrument-sans-500.woff2", weight: "500", style: "normal" }],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: "font-family", value: "Instrument Sans" }],
});

/** Headings. Above the fold, so preloaded. */
export const marketingInstrumentSansSemiBold = localFont({
  src: [{ path: "./instrument-sans-600.woff2", weight: "600", style: "normal" }],
  display: "swap",
  preload: true,
  adjustFontFallback: false,
  declarations: [{ prop: "font-family", value: "Instrument Sans" }],
});

/** Rare emphasis. */
export const marketingInstrumentSansBold = localFont({
  src: [{ path: "./instrument-sans-700.woff2", weight: "700", style: "normal" }],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: "font-family", value: "Instrument Sans" }],
});

/** Instrument Sans 400/500/600/700. Exposes --font-marketing-sans. */
export const marketingSans = marketingInstrumentSans;
