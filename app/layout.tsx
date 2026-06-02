import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";

const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["400", "700"],
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-fraunces",
});

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-inter",
});

// Title and description tightened for early access positioning. The
// homepage now leads with the category (Electrolysis Practice Software)
// and the concrete surfaces the product covers, so the SERP snippet
// reads like a YC company page rather than a product tagline. The
// previous "practice memory" tagline still appears in the marketing
// footer; this just clarifies what Hone is for crawlers and AI search.
export const metadata: Metadata = {
  title: {
    default: "Hone | Electrolysis Practice Software",
    template: "%s · Hone",
  },
  description:
    "Booking, intake, treatment plans, session charting, client history, and postcare software for electrolysis and permanent hair removal studios.",
  metadataBase: new URL("https://hone.care"),
  applicationName: "Hone",
  authors: [{ name: "Hone" }],
  keywords: [
    "electrolysis practice software",
    "electrolysis booking software",
    "electrolysis charting software",
    "electrologist software",
    "electrolysis treatment plans",
    "electrolysis intake form",
    "electrolysis postcare",
    "laser hair removal software",
    "permanent hair removal software",
  ],
  openGraph: {
    type: "website",
    title: "Hone | Electrolysis Practice Software",
    description:
      "Booking, intake, treatment plans, session charting, client history, and postcare software for electrolysis and permanent hair removal studios.",
    url: "https://hone.care",
    siteName: "Hone",
    locale: "en_CA",
  },
  twitter: {
    card: "summary_large_image",
    title: "Hone | Electrolysis Practice Software",
    description:
      "Booking, intake, treatment plans, session charting, client history, and postcare software for electrolysis and permanent hair removal studios.",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${fraunces.variable} ${inter.variable}`}>
      <body>
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
