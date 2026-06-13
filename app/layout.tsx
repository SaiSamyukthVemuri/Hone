import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";
import "./globals.css";

// PR #142. Vercel Analytics + SpeedInsights are NOT mounted in the
// root layout. Bearer-token routes (/portal/verify/[token],
// /cancel/[token], /reschedule/[token], /manage/[token],
// /intake/[token], /calendar-feed/[token]) inherit this root layout,
// and tokens in the URL must not be exposed to analytics providers
// or session-wide tracking scripts. Safe routes opt INTO analytics
// via the SafeAnalytics wrapper in app/_components/SafeAnalytics.tsx
// (mounted by the (app) layout, admin layout, book layout, and
// marketing leaf pages). See PR #142 for the audit + structural
// reasoning.

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
// PR #242: metadata leads with the category (treatment memory) rather
// than booking software, matching the homepage overhaul. No
// overclaimed AI phrasing in the SERP/OG snippet.
export const metadata: Metadata = {
  title: {
    default: "Hone | Treatment Memory for Electrologists",
    template: "%s · Hone",
  },
  description:
    "Hone helps permanent hair removal studios prepare for appointments, chart treatment details, and keep procedure records clean.",
  metadataBase: new URL("https://hone.care"),
  applicationName: "Hone",
  authors: [{ name: "Hone" }],
  keywords: [
    "treatment memory for electrologists",
    "electrolysis treatment memory",
    "electrolysis charting software",
    "electrologist software",
    "electrolysis procedure records",
    "electrolysis practice software",
    "electrolysis treatment plans",
    "permanent hair removal software",
    "laser hair removal software",
  ],
  openGraph: {
    type: "website",
    title: "Hone | Treatment Memory for Electrologists",
    description:
      "Hone helps permanent hair removal studios prepare for appointments, chart treatment details, and keep procedure records clean.",
    url: "https://hone.care",
    siteName: "Hone",
    locale: "en_CA",
  },
  twitter: {
    card: "summary_large_image",
    title: "Hone | Treatment Memory for Electrologists",
    description:
      "Hone helps permanent hair removal studios prepare for appointments, chart treatment details, and keep procedure records clean.",
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
      <body>{children}</body>
    </html>
  );
}
