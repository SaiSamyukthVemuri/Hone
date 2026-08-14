// Marketing uses a clean sans-serif throughout (product-owner choice): Inter for
// both headings and body, no serif letterforms. Loaded with the heading
// weights (600) the app's base Inter doesn't include, and scoped to the marketing
// surface via `.variable` on the MarketingSurface wrapper so the authenticated
// app is untouched.
//
// The face is self-hosted in app/_fonts rather than fetched from Google Fonts at
// build time. Re-exported here so this module stays the marketing surface's
// single font entry point. See app/_fonts/marketing-fonts.ts and FONTS.md.
export { marketingSans } from "@/app/_fonts/marketing-fonts";
