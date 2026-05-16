import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";
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
    default: "Hone. Charting software for electrolysis and laser practitioners.",
    template: "%s · Hone",
  },
  description:
    "Software for the two minute window between clients. Type a name, see last session, log this one, move on.",
  metadataBase: new URL("https://hone.care"),
  applicationName: "Hone",
  authors: [{ name: "Saltkiln" }],
  keywords: [
    "electrolysis charting",
    "laser hair removal software",
    "practitioner notes",
    "hair removal charting",
    "electrologist software",
  ],
  openGraph: {
    type: "website",
    title: "Hone. Charting software for electrolysis and laser practitioners.",
    description:
      "Software for the two minute window between clients. Built for the way practitioners actually chart.",
    url: "https://hone.care",
    siteName: "Hone",
    locale: "en_CA",
  },
  twitter: {
    card: "summary_large_image",
    title: "Hone",
    description: "Charting software for electrolysis and laser practitioners.",
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
