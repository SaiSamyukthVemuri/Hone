import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hone",
  description: "Charting for independent electrologists and laser hair removal practitioners.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
