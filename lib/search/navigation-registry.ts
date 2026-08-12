import "server-only";

// Global Search V2-A — the canonical searchable navigation/settings registry.
//
// WHY THIS EXISTS
// Search V1 shipped six hard-coded page shortcuts, one of which was a single
// generic "Settings" row. Chloe's ask ("everything in Hone should be
// searchable, doesn't matter what") is not satisfied by a shortcut to the
// settings *index*: an individual setting — the booking buffer, the 24-hour
// reminder toggle, photo consent — was undiscoverable unless you already knew
// which of the fifteen settings tabs owned it.
//
// This module is the ONE place that answers "what can a practitioner navigate
// to, what is it called, what would someone type to find it, and who is
// allowed to see that it exists".
//
// SECURITY POSTURE — search is discovery over existing authority, never
// authority itself:
//   * Every entry carries an explicit `visibility`. `owner` entries are
//     filtered out for a non-owner BEFORE matching, so an owner-only surface
//     is never advertised — not even as a "no permission" row.
//   * `import "server-only"` keeps this module out of the browser bundle
//     entirely. Filtering owner entries out of the RESULTS would still have
//     shipped their titles to every practitioner's browser as dead code; the
//     registry is only ever read inside the server action.
//   * Nothing here queries a database, so there is no client/appointment/
//     clinical data in this module at all, and no way for it to widen a row's
//     visibility. It is static product metadata.
//   * Every href is an app-internal path. No tokens, no ids, no secrets, no
//     query values carrying identifiers — pinned by
//     tests/lib/search/navigation-registry.test.ts.
//   * Deliberately EXCLUDED destinations are recorded in NON_SEARCHABLE_ROUTES
//     with a reason rather than omitted silently, so the coverage tripwire can
//     force an explicit decision when a new destination appears.
//
// No AI, no embeddings, no external search service, no migration, no index.
// Matching is a bounded pass over ~35 static rows.

export type NavCategory =
  | "Navigation"
  | "Record Keeping"
  | "Settings"
  | "Legal";

/** Who is allowed to be told this destination exists. */
export type NavVisibility = "practitioner" | "owner";

/**
 * Studio feature flags that gate whether a destination renders anything
 * useful. Advertising a surface that resolves to an empty card is a dead end,
 * so a flag-gated entry stays hidden until the flag is on.
 */
export type NavFeatureFlag = "googleCalendar";

export type NavEntry = {
  /** Stable id. Never reused, never renumbered; results key off it. */
  id: string;
  /** Human title, shown as the result title. */
  title: string;
  category: NavCategory;
  /** App-internal path. May carry a query and/or a fragment. */
  href: string;
  /** One line shown under the title. Must read as a destination, not a value. */
  description: string;
  /**
   * Terminology a practitioner would actually type. These are what make
   * "hours" find Availability and "buffer" find Booking — the page titles
   * contain neither word.
   */
  keywords: readonly string[];
  visibility: NavVisibility;
  requiresFlag?: NavFeatureFlag;
  /** Lower sorts first among equally-good matches, and in the empty state. */
  priority: number;
  /** Part of the six-row empty-state shortcut list inherited from V1. */
  defaultShortcut?: true;
};

export type NavSearchContext = {
  isOwner: boolean;
  googleCalendarEnabled: boolean;
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------
//
// Ordering here is the empty-state / tie-break order. The first six
// `defaultShortcut` rows reproduce Search V1's shortcut list exactly
// (Dashboard, Clients, Calendar, Records, Settings, Getting Started) so the
// pre-typing state of the dropdown is unchanged.

export const NAV_ENTRIES: readonly NavEntry[] = [
  {
    id: "dashboard",
    title: "Dashboard",
    category: "Navigation",
    href: "/dashboard",
    description: "Today's appointments, alerts, and what needs attention",
    keywords: ["home", "today", "overview", "start", "agenda", "practice"],
    visibility: "practitioner",
    priority: 10,
    defaultShortcut: true,
  },
  {
    id: "clients",
    title: "Clients",
    category: "Navigation",
    href: "/clients",
    description: "Every client in your studio",
    keywords: ["client list", "people", "contacts", "directory", "patients", "customers"],
    visibility: "practitioner",
    priority: 20,
    defaultShortcut: true,
  },
  {
    id: "calendar",
    title: "Calendar",
    category: "Navigation",
    href: "/calendar",
    description: "Your appointment calendar",
    keywords: ["schedule", "appointments", "bookings", "diary", "week", "day"],
    visibility: "practitioner",
    priority: 30,
    defaultShortcut: true,
  },
  {
    id: "records",
    title: "Record Keeping",
    category: "Record Keeping",
    href: "/records",
    description: "Sterile items, disinfectants, and procedure records",
    keywords: ["records", "record keeping", "logbook", "log book", "inspection", "health inspection", "compliance"],
    visibility: "practitioner",
    priority: 40,
    defaultShortcut: true,
  },
  {
    id: "settings",
    title: "Settings",
    category: "Settings",
    href: "/settings/profile",
    description: "Everything you can configure in Hone",
    keywords: ["preferences", "configuration", "options", "setup", "config"],
    visibility: "practitioner",
    priority: 50,
    defaultShortcut: true,
  },
  {
    id: "getting-started",
    title: "Getting Started",
    category: "Navigation",
    href: "/getting-started",
    description: "Setup and readiness checklist for your studio",
    keywords: ["onboarding", "checklist", "help", "tutorial", "start here", "guide", "learn"],
    visibility: "practitioner",
    priority: 60,
    defaultShortcut: true,
  },

  // --- Remaining primary navigation -------------------------------------
  {
    id: "clients-new",
    title: "Add a client",
    category: "Navigation",
    href: "/clients/new",
    description: "Create a new client record",
    keywords: ["new client", "add client", "create client", "register client", "intake new"],
    visibility: "practitioner",
    priority: 70,
  },
  {
    id: "calendar-upcoming",
    title: "Upcoming appointments",
    category: "Navigation",
    href: "/calendar/upcoming",
    description: "The next scheduled appointments across the studio",
    keywords: ["upcoming", "next appointments", "whats next", "coming up", "future bookings"],
    visibility: "practitioner",
    priority: 80,
  },
  {
    id: "notifications",
    title: "Notifications",
    category: "Navigation",
    href: "/notifications",
    description: "Operational alerts, new bookings, cancellations, and reschedules",
    keywords: ["alerts", "bell", "unread", "inbox", "activity", "notification centre", "notification center"],
    visibility: "practitioner",
    priority: 90,
  },

  // --- Record Keeping sections ------------------------------------------
  // Exposure Incidents is deliberately absent; see NON_SEARCHABLE_ROUTES.
  {
    id: "records-sterile",
    title: "Sterile Items",
    category: "Record Keeping",
    href: "/records?section=sterile",
    description: "Sterile supply purchases and lot numbers",
    keywords: ["sterile", "sterile items", "supplies", "autoclave", "lot", "lot number", "needles", "probes purchased"],
    visibility: "practitioner",
    priority: 100,
  },
  {
    id: "records-disinfectants",
    title: "Disinfectants",
    category: "Record Keeping",
    href: "/records?section=disinfectants",
    description: "Disinfectant preparation log and replacement alerts",
    keywords: ["disinfectant", "disinfection", "solution", "prepared", "replace", "expiry", "sanitiser", "sanitizer"],
    visibility: "practitioner",
    priority: 110,
  },
  {
    id: "records-procedures",
    title: "Procedure records",
    category: "Record Keeping",
    href: "/records?section=procedures",
    description: "Client Record for Invasive Procedures, generated from charted treatments",
    keywords: ["procedure", "procedures", "invasive", "invasive procedures", "client record", "inspection record", "print record"],
    visibility: "practitioner",
    priority: 120,
  },

  // --- Settings: available to every practitioner -------------------------
  {
    id: "settings-profile",
    title: "Profile",
    category: "Settings",
    href: "/settings/profile",
    description: "Your display name, email, and calendar colour",
    keywords: ["profile", "my account", "account", "display name", "my name", "colour", "color", "calendar colour", "calendar color", "personal"],
    visibility: "practitioner",
    priority: 200,
  },
  {
    id: "settings-calendar-feed",
    title: "Calendar feed",
    category: "Settings",
    href: "/settings/profile",
    description: "Subscribe to your Hone appointments from Apple Calendar, Google Calendar, or Outlook",
    keywords: ["calendar feed", "feed", "ics", "ical", "subscribe", "apple calendar", "outlook", "export calendar"],
    visibility: "practitioner",
    priority: 210,
  },
  {
    id: "settings-launch",
    title: "Launch",
    category: "Settings",
    href: "/settings/launch",
    description: "Ready-for-booking checklist before your first real client",
    keywords: ["launch", "go live", "ready", "readiness", "checklist", "before booking", "first booking", "setup checklist"],
    visibility: "practitioner",
    priority: 220,
  },
  {
    id: "settings-intake",
    title: "Forms & Postcare",
    category: "Settings",
    href: "/settings/intake",
    description: "Preview the client health intake form step by step",
    keywords: ["intake", "intake form", "forms", "health form", "questionnaire", "medical history", "preview form", "fitzpatrick"],
    visibility: "practitioner",
    priority: 230,
  },
  {
    id: "settings-google-calendar-own",
    title: "Google Calendar (your connection)",
    category: "Settings",
    href: "/settings/profile",
    description: "Connect your own Google Calendar to Hone",
    keywords: ["google", "google calendar", "gcal", "calendar sync", "sync", "connect google"],
    visibility: "practitioner",
    requiresFlag: "googleCalendar",
    // Deliberately sorted just BELOW the owner-facing Integrations entry
    // (430): when an owner has the flag on, both rows match "google", and the
    // studio-level connection is the one they mean. A non-owner only ever
    // sees this one, so the ordering costs them nothing.
    priority: 435,
  },

  // --- Settings: owner only ---------------------------------------------
  {
    id: "settings-studio",
    title: "Studio",
    category: "Settings",
    href: "/settings/studio",
    description: "Studio name, legal entity, time format, and birthday colour",
    keywords: ["studio", "business name", "studio name", "legal entity", "company", "time format", "24 hour clock", "birthday"],
    visibility: "owner",
    priority: 300,
  },
  {
    id: "settings-reminders",
    title: "Appointment reminders",
    category: "Settings",
    href: "/settings/studio#email-notifications",
    description: "Confirmation messages, 24-hour and 2-hour reminders, and no-show follow-ups",
    keywords: ["reminder", "reminders", "sms", "text message", "texts", "messaging", "email notifications", "notification settings", "confirmation email", "24 hour reminder", "2 hour reminder", "no show follow up", "remind"],
    visibility: "owner",
    priority: 310,
  },
  {
    id: "settings-booking",
    title: "Booking",
    category: "Settings",
    href: "/settings/booking",
    description: "Public booking page, timezone, and default appointment length",
    keywords: ["booking", "book online", "public page", "slug", "url", "timezone", "time zone", "default duration", "appointment length"],
    visibility: "owner",
    priority: 320,
  },
  {
    id: "settings-booking-link",
    title: "Booking link",
    category: "Settings",
    href: "/settings/booking",
    description: "The public link clients use to book with you",
    keywords: ["booking link", "book link", "share link", "public link", "public url", "website link", "my link", "launch link"],
    visibility: "owner",
    priority: 330,
  },
  {
    id: "settings-buffer",
    title: "Time between appointments",
    category: "Settings",
    href: "/settings/booking",
    description: "Buffer left between back-to-back appointments",
    keywords: ["buffer", "booking buffer", "gap", "padding", "turnaround", "cleanup time", "time between appointments", "spacing"],
    visibility: "owner",
    priority: 340,
  },
  {
    id: "settings-availability",
    title: "Availability",
    category: "Settings",
    href: "/settings/availability",
    description: "Weekly hours, special hours, repeating breaks, and blocked time",
    keywords: ["availability", "hours", "opening hours", "weekly hours", "working hours", "business hours", "schedule", "days off", "day off", "time off", "vacation", "holiday", "blocked time", "block time", "breaks", "lunch", "closed", "special hours"],
    visibility: "owner",
    priority: 350,
  },
  {
    id: "settings-services",
    title: "Services",
    category: "Settings",
    href: "/settings/services",
    description: "Treatments you offer, with duration, price, and colour",
    keywords: ["services", "service", "treatments", "price", "prices", "pricing", "cost", "duration", "consultation", "menu", "offerings"],
    visibility: "owner",
    priority: 360,
  },
  {
    id: "settings-team",
    title: "Team",
    category: "Settings",
    href: "/settings/team",
    description: "Invite practitioners, manage access, and track pending invitations",
    keywords: ["team", "practitioner", "practitioners", "staff", "invite", "invitation", "users", "colleague", "employee", "access", "members", "add practitioner"],
    visibility: "owner",
    priority: 370,
  },
  {
    id: "settings-consent",
    title: "Consent forms",
    category: "Settings",
    href: "/settings/consent",
    description: "Treatment consent, photo consent, policy acknowledgement, and card-on-file authorization templates",
    keywords: ["consent", "consent form", "consent forms", "photo consent", "photo release", "photos", "treatment consent", "waiver", "signature", "sign", "policy acknowledgement", "template", "templates", "card authorization"],
    visibility: "owner",
    priority: 380,
  },
  {
    id: "settings-postcare",
    title: "Postcare",
    category: "Settings",
    href: "/settings/intake#postcare",
    description: "Aftercare instructions and the postcare message sent after appointments",
    keywords: ["postcare", "post care", "aftercare", "after care", "warning signs", "product recommendations", "review link", "follow up"],
    visibility: "owner",
    priority: 390,
  },
  {
    id: "settings-policies",
    title: "Cancellation and no-show policy",
    category: "Settings",
    href: "/settings/intake#policies",
    description: "The policies clients agree to when they book",
    keywords: ["policy", "policies", "cancellation", "cancellation policy", "no show", "no-show policy", "rules", "late", "terms"],
    visibility: "owner",
    priority: 400,
  },
  {
    id: "settings-payments",
    title: "Payments",
    category: "Settings",
    href: "/settings/payments",
    description: "Payment account connection, payment mode, and fee amounts",
    keywords: ["payments", "payment", "pay", "stripe", "card", "card on file", "checkout", "fees", "fee", "cancellation fee", "no show fee", "deposit", "billing", "payout", "invoice"],
    visibility: "owner",
    priority: 410,
  },
  {
    id: "settings-integrations",
    title: "Integrations",
    category: "Settings",
    href: "/settings/integrations",
    description: "Connect your studio to outside services",
    keywords: ["integrations", "integration", "connect", "apps", "third party", "external"],
    visibility: "owner",
    priority: 420,
  },
  {
    id: "settings-google-calendar",
    title: "Google Calendar",
    category: "Settings",
    href: "/settings/integrations",
    description: "Connect your studio to Google Calendar",
    keywords: ["google", "google calendar", "gcal", "calendar sync", "sync calendar", "sync", "connect google"],
    visibility: "owner",
    priority: 430,
  },
  {
    id: "settings-tracking",
    title: "Marketing & analytics",
    category: "Settings",
    href: "/settings/tracking",
    description: "Connect your own marketing and analytics providers",
    keywords: ["marketing", "analytics", "tracking", "pixel", "meta", "facebook", "ads", "advertising", "conversions", "measurement"],
    visibility: "owner",
    priority: 440,
  },
  {
    id: "settings-import",
    title: "Quick import",
    category: "Settings",
    href: "/settings/import",
    description: "Bring existing clients and treatment history in from CSV",
    keywords: ["import", "csv", "spreadsheet", "migrate", "migration", "upload clients", "bring data", "transfer"],
    visibility: "owner",
    priority: 450,
  },
  {
    id: "settings-data",
    title: "Data",
    category: "Settings",
    href: "/settings/data",
    description: "Export a portable copy of your studio records",
    keywords: ["data", "export", "data export", "download", "backup", "zip", "portable", "my data", "delete data", "privacy"],
    visibility: "owner",
    priority: 460,
  },

  // --- Legal --------------------------------------------------------------
  {
    id: "privacy-policy",
    title: "Privacy Policy",
    category: "Legal",
    href: "/privacy",
    description: "How Hone handles studio and client data",
    keywords: ["privacy", "privacy policy", "data protection", "subprocessors", "hosting", "gdpr", "pipeda"],
    visibility: "practitioner",
    priority: 500,
  },
  {
    id: "terms",
    title: "Terms of Service",
    category: "Legal",
    href: "/terms",
    description: "The agreement covering your use of Hone",
    keywords: ["terms", "terms of service", "tos", "agreement", "legal", "contract"],
    visibility: "practitioner",
    priority: 510,
  },
];

// ---------------------------------------------------------------------------
// Deliberate exclusions — the other half of the coverage decision
// ---------------------------------------------------------------------------
//
// Every authenticated destination is either IN NAV_ENTRIES or listed here with
// a reason. tests/lib/search/navigation-registry.test.ts walks the app router
// and fails when a route appears in neither, so a newly-added Settings page
// cannot silently become undiscoverable — nor silently discoverable.

export const NON_SEARCHABLE_ROUTES: ReadonlyArray<{
  route: string;
  reason: string;
}> = [
  {
    route: "/records/print",
    reason:
      "Print/export view of whichever Records section you are already in. Not a destination on its own; reached from /records.",
  },
  {
    route: "/settings/calendar",
    reason:
      "Redirect-only alias kept for old bookmarks; breaks & blocks were consolidated into /settings/availability, which is what search advertises.",
  },
  {
    route: "/settings/payments/refresh",
    reason:
      "Payment-provider onboarding callback landing page, not a navigable setting.",
  },
  {
    route: "/settings/payments/return",
    reason:
      "Payment-provider onboarding callback landing page, not a navigable setting.",
  },
  {
    route: "/admin",
    reason:
      "Platform administration, authorized by an email allowlist and scoped ACROSS studios. Out of scope for studio search, which is deliberately single-studio.",
  },
  {
    route: "/admin/audit",
    reason: "Platform audit surface — raw change payloads, cross-studio.",
  },
  {
    route: "/admin/ops-alerts",
    reason: "Platform operations surface, cross-studio.",
  },
  {
    route: "/admin/payments/manual-review",
    reason: "Platform payment review surface, cross-studio.",
  },
  {
    route: "/admin/studios/new",
    reason: "Platform studio provisioning, cross-studio.",
  },
];

/**
 * Record Keeping sections that exist but are deliberately NOT advertised.
 * Kept separate from NON_SEARCHABLE_ROUTES because the underlying ROUTE
 * (/records) IS searchable — it is this section of it that is withheld.
 */
export const NON_SEARCHABLE_RECORD_SECTIONS: ReadonlyArray<{
  section: string;
  reason: string;
}> = [
  {
    section: "incidents",
    reason:
      "Exposure Incidents. The history is owner-only (RLS-enforced) and the content is personal information about an exposed person. V1 deliberately kept it out of search advertising and V2-A does not change that posture.",
  },
];

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Fold a title / keyword / query down to comparable text: lowercase, accents
 * stripped, every run of punctuation or whitespace collapsed to one space.
 * "Marketing & analytics" and "marketing analytics" compare equal; so do
 * "no-show" and "no show", which is exactly how Chloe types them.
 */
export function normalizeNavText(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isVisible(entry: NavEntry, ctx: NavSearchContext): boolean {
  if (entry.visibility === "owner" && !ctx.isOwner) return false;
  if (entry.requiresFlag === "googleCalendar" && !ctx.googleCalendarEnabled) {
    return false;
  }
  return true;
}

/**
 * Match rank, lower is better. `null` means no match at all.
 *
 * The tiers exist so an exact title beats a keyword substring: typing
 * "booking" must put "Booking" above "Booking link", while typing
 * "booking link" must invert that. Everything below tier 5 is a whole-query
 * comparison; tier 6 is the multi-word fallback where every word of the query
 * has to appear somewhere in the entry, which is what makes "photo consent"
 * and "calendar sync" resolve without a bespoke rule per phrase.
 */
function rankEntry(
  entry: NavEntry,
  query: string,
  tokens: readonly string[],
): number | null {
  const title = normalizeNavText(entry.title);
  const keywords = entry.keywords.map(normalizeNavText);

  if (title === query) return 0;
  if (title.startsWith(query)) return 1;
  if (keywords.some((k) => k === query)) return 2;
  if (keywords.some((k) => k.startsWith(query))) return 3;
  if (title.includes(query)) return 4;
  if (keywords.some((k) => k.includes(query))) return 5;

  const haystack = `${title} ${keywords.join(" ")} ${normalizeNavText(entry.category)}`;
  if (tokens.length > 0 && tokens.every((t) => haystack.includes(t))) return 6;

  return null;
}

export type NavMatch = {
  entry: NavEntry;
  rank: number;
};

/**
 * Rank every VISIBLE entry against the query.
 *
 * Deterministic by construction: rank, then the entry's declared priority,
 * then id. Two runs of the same query in the same context always produce the
 * same list in the same order, which is what makes the cap meaningful.
 *
 * Entries that share an href are collapsed to the best-ranked one. Several
 * rows deliberately point at the same page ("Booking", "Booking link",
 * "Time between appointments" are all /settings/booking) so that each concept
 * is findable by its own vocabulary; the practitioner should still only ever
 * see one row per destination, titled by whichever concept they searched for.
 */
export function matchNavEntries(
  rawQuery: string,
  ctx: NavSearchContext,
): NavMatch[] {
  const query = normalizeNavText(rawQuery);
  const visible = NAV_ENTRIES.filter((e) => isVisible(e, ctx));

  if (query.length === 0) {
    return visible
      .filter((e) => e.defaultShortcut === true)
      .sort((a, b) => a.priority - b.priority)
      .map((entry) => ({ entry, rank: 0 }));
  }

  const tokens = query.split(" ").filter(Boolean);
  const matches: NavMatch[] = [];
  for (const entry of visible) {
    const rank = rankEntry(entry, query, tokens);
    if (rank !== null) matches.push({ entry, rank });
  }

  matches.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.entry.priority - b.entry.priority ||
      (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0),
  );

  const byHref = new Set<string>();
  const deduped: NavMatch[] = [];
  for (const match of matches) {
    if (byHref.has(match.entry.href)) continue;
    byHref.add(match.entry.href);
    deduped.push(match);
  }
  return deduped;
}
