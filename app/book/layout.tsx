import { SafeAnalytics } from "@/app/_components/SafeAnalytics";

// PR #142. Public-booking tree layout. The /book/[slug] page is
// public and slug-based (the slug is the studio's public booking
// identifier, not a bearer token), so analytics is safe here.
// Mounting in this segment-level layout rather than the root layout
// keeps analytics OUT of every other public + token route tree.

export default function BookLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      {children}
      <SafeAnalytics />
    </>
  );
}
