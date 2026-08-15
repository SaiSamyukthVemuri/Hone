import type { Metadata } from "next";
import { fraunces, inter } from "./_fonts/app-fonts";
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

// Fraunces (--font-fraunces) and Inter (--font-inter) are self-hosted in
// app/_fonts. They used to be next/font/google calls here, which made every
// build depend on reaching fonts.googleapis.com; the CSS variable contract and
// the rendered faces are unchanged. See app/_fonts/app-fonts.ts and FONTS.md.

// Title and description lead with the public category phrase
// ("Treatment Memory for Electrologists") and the concrete surfaces
// the product covers, so the SERP snippet reads like a focused company
// page rather than a product tagline. PR #244 aligns the description
// with the rewritten, electrologist-first homepage voice. No
// overclaimed AI phrasing in the SERP/OG snippet.
export const metadata: Metadata = {
  title: {
    default: "Hone | Treatment Memory for Electrologists",
    template: "%s · Hone",
  },
  description:
    "Hone helps electrologists prepare for returning clients, chart treatment details, and keep cleaner procedure records.",
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
      "Hone helps electrologists prepare for returning clients, chart treatment details, and keep cleaner procedure records.",
    url: "https://hone.care",
    siteName: "Hone",
    locale: "en_CA",
  },
  twitter: {
    card: "summary_large_image",
    title: "Hone | Treatment Memory for Electrologists",
    description:
      "Hone helps electrologists prepare for returning clients, chart treatment details, and keep cleaner procedure records.",
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
