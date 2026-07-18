import { Newsreader } from "next/font/google";

// Marketing display face: Newsreader — a warm, editorial serif with conventional
// letterforms (a normal lowercase "f", unlike Fraunces's descending "f"). Scoped
// to the marketing surface via `.variable` on the MarketingSurface wrapper, so
// it never affects the authenticated app. Body text stays Inter.
export const newsreader = Newsreader({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-newsreader",
  display: "swap",
});
