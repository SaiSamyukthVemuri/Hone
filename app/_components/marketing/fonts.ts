import { Inter } from "next/font/google";

// Marketing uses a clean sans-serif throughout (product-owner choice): Inter for
// both headings and body, no serif letterforms. Loaded here with the heading
// weights (600) the app's base Inter doesn't include, and scoped to the marketing
// surface via `.variable` on the MarketingSurface wrapper so the authenticated
// app is untouched.
export const marketingSans = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-marketing-sans",
  display: "swap",
});
