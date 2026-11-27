// HON-124 item 15. The REAL revision date of each maintained marketing page, shown to visitors as "Last updated".
//
// A constant per page, changed by the person who changes that page's content: never the build date, never "today". The first values were taken
// from git (the date of each page file's last content change); a page's date moves only when its content does. tests/lib/marketing/page-revisions
// pins the shape: valid ISO dates, none in the future, every dated page renders its date from HERE, and no page derives a date from the clock.
//
// NOT here: /privacy, /terms and /sms-terms keep their own reviewed "Effective date" and "Last updated" constants (a legal decision, see
// app/privacy/page.tsx), and the resource articles keep dateModified in lib/marketing/resources.ts.
export const PAGE_REVISIONS = {
  "/pricing": "2026-11-27", // FAQ answers about booking added
  "/features/booking-calendar": "2026-10-11",
  "/features/charting-records": "2026-10-11",
  "/features/treatment-memory": "2026-10-11",
} as const satisfies Record<string, `${number}-${number}-${number}`>;

export type RevisedPagePath = keyof typeof PAGE_REVISIONS;
