// HON-46 — the layout for clinical-records export routes.
//
// DELIBERATELY NOT UNDER app/(app). That layout mounts SafeAnalytics (Vercel
// Analytics + Speed Insights) and server-side analytics identification, and an
// export URL carries a client id plus a session id or clinical dates
// (/clients/<uuid>/records/export?scope=...). #828 G-26 forbids those reaching
// any third party, and SafeAnalytics' own header records why a pathname
// denylist is too weak: a script already loaded in the session keeps
// reporting. So the export lives in a tree that never mounts any analytics, a
// structural guarantee (Codex P1 4301165382). It must only ever be entered by
// a FULL document load (typed URL or a plain <a>), never a client-side
// next/link navigation from an analytics-enabled page; a source guard
// (tests/app/clinical-records-export-contract.test.ts) forbids such a Link.
//
// No app chrome either: this is a print document. Authentication and studio
// authority are the page's own (requirePractitionerWithStudio + owner gate).

export default function RecordsExportLayout({ children }: { children: React.ReactNode }) {
  return <main className="min-h-screen bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">{children}</main>;
}
