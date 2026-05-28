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

export const metadata: Metadata = {
  title: {
    default: "Hone. The practice memory system for permanent hair removal.",
    template: "%s · Hone",
  },
  description:
    "Never wonder what you did last session. Type a name, see exactly what worked last time: settings, areas, what they tolerated, what to avoid. Practice software for electrolysis and laser.",
  metadataBase: new URL("https://hone.care"),
  applicationName: "Hone",
  authors: [{ name: "Hone" }],
  keywords: [
    "electrolysis charting",
    "laser hair removal software",
    "practitioner notes",
    "hair removal charting",
    "electrologist software",
    "practice memory",
    "permanent hair removal software",
  ],
  openGraph: {
    type: "website",
    title: "Hone. The practice memory system for permanent hair removal.",
    description:
      "Never wonder what you did last session. A faithful, fast, structured memory of what you did with each client, across every session.",
    url: "https://hone.care",
    siteName: "Hone",
    locale: "en_CA",
  },
  twitter: {
    card: "summary_large_image",
    title: "Hone. The practice memory system for permanent hair removal.",
    description:
      "Never wonder what you did last session. Practice software for electrolysis and laser.",
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
