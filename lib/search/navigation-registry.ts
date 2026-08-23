import "server-only";

// Global Search V2-A, the canonical searchable navigation/settings registry.
//
// WHY THIS EXISTS
// Search V1 shipped six hard-coded page shortcuts, one of which was a single
// generic "Settings" row. Chloe's ask ("everything in Hone should be
// searchable, doesn't matter what") is not satisfied by a shortcut to the
// settings *index*: an individual setting (the booking buffer, the 24-hour
// reminder toggle, photo consent) was undiscoverable unless you already knew
// which of the fifteen settings tabs owned it.
//
// This module is the ONE place that answers "what can a practitioner navigate
// to, what is it called, what would someone type to find it, and who is
// allowed to see that it exists".
//
// SECURITY POSTURE: search is discovery over existing authority, never
// authority itself:
//   * Every entry carries an explicit `visibility`. `owner` entries are
//     filtered out for a non-owner BEFORE matching, so an owner-only surface
//     is never advertised, not even as a "no permission" row.
//   * `import "server-only"` keeps this module out of the browser bundle
//     entirely. Filtering owner entries out of the RESULTS would still have
//     shipped their titles to every practitioner's browser as dead code; the
//     registry is only ever read inside the server action.
//   * Nothing here queries a database, so there is no client/appointment/
//     clinical data in this module at all, and no way for it to widen a row's
//     visibility. It is static product metadata.
//   * Every href is an app-internal path. No tokens, no ids, no secrets, no
//     query values carrying identifiers: pinned by
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
   * "hours" find Availability and "buffer" find Booking: the page titles
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
    keywords: ["profile", "my account", "account", "personal", "me", "my details"],
    visibility: "practitioner",
    priority: 200,
  },
  {
    id: "settings-calendar-feed",
    title: "Calendar feed",
    category: "Settings",
    href: "/settings/profile#calendar-feed",
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
    keywords: ["ready for booking checklist", "launch", "go live", "ready", "readiness", "checklist", "before booking", "first booking", "setup checklist"],
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
    href: "/settings/profile#google-calendar",
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
    keywords: ["studio", "my studio", "studio settings", "business"],
    visibility: "owner",
    priority: 300,
  },
  {
    id: "settings-reminders",
    title: "Appointment reminders",
    category: "Settings",
    href: "/settings/studio#email-notifications",
    description: "Confirmation messages, 24-hour and 2-hour reminders, and no-show follow-ups",
    // The seven toggle labels are carried VERBATIM. The control census proved
    // they were unreachable otherwise: "Send 24-hour reminders" is the exact
    // string on screen, and none of the shorter aliases matched it.
    keywords: ["reminder", "reminders", "sms", "text message", "texts", "messaging", "email notifications", "notification settings", "confirmation email", "24 hour reminder", "2 hour reminder", "no show follow up", "remind", "send confirmation emails when appointments are booked", "send confirmation emails", "email me when a new booking is created", "notify me of new bookings", "send 24 hour reminders", "send 2 hour reminders", "automatically mark no shows", "auto no show", "send follow up email to no shows", "no show follow up email", "show treatment time to clients in emails", "treatment time in emails"],
    visibility: "owner",
    priority: 310,
  },
  {
    id: "settings-booking",
    title: "Booking",
    category: "Settings",
    href: "/settings/booking",
    description: "Public booking page, timezone, and default appointment length",
    keywords: ["booking", "book online", "online booking", "public page", "booking settings", "booking preferences"],
    visibility: "owner",
    priority: 320,
  },
  {
    id: "settings-booking-link",
    title: "Booking link",
    category: "Settings",
    href: "/settings/booking#booking-link",
    description: "The public link clients use to book with you",
    keywords: ["your booking link", "booking link", "book link", "share link", "public link", "public url", "website link", "my link", "launch link"],
    visibility: "owner",
    priority: 330,
  },
  {
    id: "settings-buffer",
    title: "Time between appointments",
    category: "Settings",
    href: "/settings/booking#buffer",
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
    keywords: ["availability", "hours", "opening hours", "working hours", "business hours", "schedule", "when i work", "my hours"],
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
    // Exact visible labels from the page are carried verbatim; this page gets
    // no anchors because its files are payment runtime owned by a parallel
    // track, so every payment control resolves to the page itself.
    keywords: ["payments", "payment", "pay", "stripe", "stripe connection", "card", "card on file", "card on file readiness", "card authorization", "checkout", "fees", "fee", "fee amounts", "cancellation and no show fee amounts", "late cancellation fee", "cancellation fee", "no show fee", "deposit", "billing", "payout", "invoice"],
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
    keywords: ["marketing", "analytics", "tracking", "provider", "pixel", "meta", "facebook", "ads", "advertising", "conversions", "measurement"],
    visibility: "owner",
    priority: 440,
  },
  // IMPORT-01. Still searchable: an owner looking for "import" needs to find
  // the one page that tells them how to actually get their records moved. What
  // changed is the promise: the title no longer implies a self-service run the
  // server will refuse, and the description states the operator-assisted model
  // in the result row itself, before the click. Deliberate search EXCLUSION was
  // the alternative and is worse: it hides the only route to migration help.
  {
    id: "settings-import",
    title: "Import clients and history",
    category: "Settings",
    href: "/settings/import",
    description: "Operator-assisted: Hone brings your existing records over for you",
    keywords: ["quick import", "import", "csv", "spreadsheet", "migrate", "migration", "upload clients", "bring data", "transfer", "operator assisted", "assisted import", "migration help", "help importing", "move my clients"],
    visibility: "owner",
    priority: 450,
  },
  {
    id: "settings-data",
    title: "Data",
    category: "Settings",
    href: "/settings/data",
    description: "Export a portable copy of your studio records",
    keywords: ["data", "my data", "your data", "portable", "privacy"],
    visibility: "owner",
    priority: 460,
  },

  // --- Settings CONTROLS -------------------------------------------------
  //
  // V2-A.1. A page entry answers "can I find this page?"; these answer "can I
  // find the exact setting I am looking at?". Sam searched the literal visible
  // label "Booking horizon" in production and got NOTHING, because V2-A
  // registered Booking / Booking link / Time between appointments and no other
  // control on that page. Route coverage was complete; control coverage was
  // not.
  //
  // Every entry below is anchored (`#id`) at the control it names, so href
  // dedupe keeps sibling controls on one page distinct and a click lands on
  // the control rather than the top of a long form. Each is audited in
  // tests/lib/search/fixtures/settings-controls.census.ts, which fails if the
  // visible label it claims to match stops existing in the page source.

  // Profile
  {
    id: "settings-your-name",
    title: "Your name",
    category: "Settings",
    href: "/settings/profile#your-name",
    description: "The display name your team and session logs see",
    keywords: ["your name", "my name", "display name", "rename me", "change my name", "practitioner name"],
    visibility: "practitioner",
    priority: 202,
  },
  {
    id: "settings-calendar-color",
    title: "Calendar color",
    category: "Settings",
    href: "/settings/profile#calendar-color",
    description: "The colour your appointments appear in on the calendar",
    keywords: ["calendar color", "calendar colour", "my color", "my colour", "appointment color", "appointment colour", "colour", "color"],
    visibility: "practitioner",
    priority: 204,
  },

  // Studio
  {
    id: "settings-studio-name",
    title: "Studio name",
    category: "Settings",
    href: "/settings/studio#studio-name",
    description: "The studio name clients and your team see",
    keywords: ["studio name", "business name", "rename studio", "change studio name", "practice name"],
    visibility: "owner",
    priority: 301,
  },
  {
    id: "settings-legal-entity",
    title: "Legal entity name",
    category: "Settings",
    href: "/settings/studio#legal-entity",
    description: "Your registered business name, if different from the studio name",
    keywords: ["legal entity", "legal entity name", "registered name", "company name", "incorporated", "business entity"],
    visibility: "owner",
    priority: 302,
  },
  {
    id: "settings-birthday-color",
    title: "Birthday reminder color",
    category: "Settings",
    href: "/settings/studio#birthday-color",
    description: "The accent colour used for birthday reminders",
    keywords: ["birthday", "birthday reminder", "birthday color", "birthday colour", "birthdays"],
    visibility: "owner",
    priority: 303,
  },
  {
    id: "settings-time-format",
    title: "Time format",
    category: "Settings",
    href: "/settings/studio#time-format",
    description: "Whether times show as 12-hour or 24-hour inside Hone",
    keywords: ["time format", "24 hour", "24 hour clock", "12 hour", "am pm", "military time", "clock"],
    visibility: "owner",
    priority: 304,
  },

  // Booking
  {
    id: "settings-booking-slug",
    title: "Booking URL slug",
    category: "Settings",
    href: "/settings/booking#booking-slug",
    description: "The address of your public booking page",
    keywords: ["slug", "booking url", "url", "web address", "link name", "change my url", "custom url", "vanity url"],
    visibility: "owner",
    priority: 332,
  },
  {
    id: "settings-timezone",
    title: "Timezone",
    category: "Settings",
    href: "/settings/booking#timezone",
    description: "The timezone your studio schedules in",
    keywords: ["timezone", "time zone", "tz", "local time", "region", "utc", "daylight saving"],
    visibility: "owner",
    priority: 334,
  },
  {
    id: "settings-default-duration",
    title: "Default duration (min)",
    category: "Settings",
    href: "/settings/booking#default-duration",
    description: "Default appointment length when none is set by the service",
    keywords: ["default duration", "default length", "appointment length", "default appointment length", "how long", "minutes", "default minutes"],
    visibility: "owner",
    priority: 336,
  },
  {
    id: "settings-booking-horizon",
    title: "Booking horizon",
    category: "Settings",
    href: "/settings/booking#booking-horizon",
    description: "Choose how far ahead clients can book online",
    keywords: ["booking horizon", "horizon", "booking window", "advance booking", "advance booking window", "how far ahead", "how far ahead can clients book", "how far in advance", "months ahead", "future booking", "online booking horizon", "booking months", "booking range", "how far out", "book ahead", "lead time"],
    visibility: "owner",
    priority: 342,
  },
  {
    id: "settings-public-address",
    title: "Public address",
    category: "Settings",
    href: "/settings/booking#public-address",
    description: "The address shown on your public booking page",
    keywords: ["public address", "address", "shown on your booking page", "location", "studio address", "where i am", "street address", "directions"],
    visibility: "owner",
    priority: 344,
  },
  {
    id: "settings-booking-intro",
    title: "Booking page intro",
    category: "Settings",
    href: "/settings/booking#booking-intro",
    description: "The short description clients read on your booking page",
    keywords: ["booking page intro", "intro", "introduction", "booking description", "description", "blurb", "about", "welcome text"],
    visibility: "owner",
    priority: 346,
  },

  // Availability
  {
    id: "settings-weekly-hours",
    title: "Weekly hours",
    category: "Settings",
    href: "/settings/availability#weekly-hours",
    description: "The hours you work each day of the week",
    keywords: ["weekly hours", "week", "monday", "daily hours", "regular hours", "standard hours", "open"],
    visibility: "owner",
    priority: 351,
  },
  {
    id: "settings-special-hours",
    title: "Special hours",
    category: "Settings",
    href: "/settings/availability#special-hours",
    description: "One-off date overrides to your normal weekly hours",
    keywords: ["special hours", "override", "one off hours", "different hours", "exception", "holiday hours"],
    visibility: "owner",
    priority: 352,
  },
  {
    id: "settings-blocked-time",
    title: "Blocked time",
    category: "Settings",
    href: "/settings/availability#blocked-time",
    description: "Whole days you are unavailable, such as vacation",
    keywords: ["blocked time", "blocked dates", "vacation", "holiday", "day off", "days off", "time off", "away", "closed", "out of office"],
    visibility: "owner",
    priority: 353,
  },
  {
    id: "settings-repeating-breaks",
    title: "Repeating breaks",
    category: "Settings",
    href: "/settings/availability#repeating-breaks",
    description: "A regular daily lunch, dinner, or admin window",
    keywords: ["repeating breaks", "break", "breaks", "lunch", "dinner", "recurring break", "admin time", "daily break"],
    visibility: "owner",
    priority: 354,
  },
  {
    id: "settings-block-time",
    title: "Block time",
    category: "Settings",
    href: "/settings/availability#block-time",
    description: "A single appointment, meeting, or part-day interruption",
    keywords: ["block time", "one off block", "timed block", "meeting", "appointment block", "part day", "busy"],
    visibility: "owner",
    priority: 355,
  },

  // Services
  {
    id: "settings-service-order",
    title: "Service menu order",
    category: "Settings",
    href: "/settings/services#service-order",
    description: "The order your services appear in when clients book",
    keywords: ["service menu order", "service order", "order", "reorder", "sort services", "rearrange", "move up", "move down"],
    visibility: "owner",
    priority: 361,
  },

  // Team
  {
    id: "settings-invite-practitioner",
    title: "Invite a practitioner",
    category: "Settings",
    href: "/settings/team#invite-practitioner",
    description: "Send an invitation so a colleague can join your studio",
    keywords: ["invite", "invite a practitioner", "add practitioner", "add someone", "new practitioner", "invitation", "join", "add staff"],
    visibility: "owner",
    priority: 371,
  },
  {
    id: "settings-practitioners-list",
    title: "Practitioners",
    category: "Settings",
    href: "/settings/team#practitioners",
    description: "Everyone with access to your studio, and their role",
    keywords: ["practitioners", "who has access", "roles", "role", "deactivate", "remove practitioner", "colleagues"],
    visibility: "owner",
    priority: 372,
  },
  {
    id: "settings-pending-invitations",
    title: "Pending invitations",
    category: "Settings",
    href: "/settings/team#pending-invitations",
    description: "Invitations that have been sent but not yet accepted",
    keywords: ["pending invitations", "pending", "invitation", "not accepted", "resend invite", "outstanding invite"],
    visibility: "owner",
    priority: 373,
  },

  // Forms & Postcare
  {
    id: "settings-aftercare",
    title: "Aftercare instructions",
    category: "Settings",
    href: "/settings/intake#aftercare",
    description: "The aftercare text clients receive after an appointment",
    keywords: ["aftercare instructions", "aftercare", "after care", "care instructions", "what to do after", "post treatment"],
    visibility: "owner",
    priority: 392,
  },
  {
    id: "settings-postcare-contact",
    title: "Postcare contact email",
    category: "Settings",
    href: "/settings/intake#postcare-contact",
    description: "The address clients reply to after a postcare message",
    keywords: ["postcare contact email", "postcare email", "reply to", "contact email", "who do they email"],
    visibility: "owner",
    priority: 394,
  },
  {
    id: "settings-intake-preview",
    title: "Intake form preview",
    category: "Settings",
    href: "/settings/intake#intake-preview",
    description: "Step through the health intake form exactly as a client sees it",
    keywords: ["intake form preview", "preview intake", "see the intake", "intake questions", "health form", "questionnaire", "what do clients fill in"],
    visibility: "practitioner",
    priority: 232,
  },

  // Data
  {
    id: "settings-data-export",
    title: "Export your data",
    category: "Settings",
    href: "/settings/data#export-data",
    description: "Download a portable ZIP of your studio records",
    keywords: ["export", "export your data", "data export", "download", "download my data", "backup", "zip", "take my data", "copy of my data"],
    visibility: "owner",
    priority: 462,
  },
  {
    id: "settings-data-import-csv",
    title: "Import clients from CSV",
    category: "Settings",
    href: "/settings/data#import-csv",
    description: "Bring existing client records in from a spreadsheet",
    keywords: ["import clients from csv", "import clients", "csv import", "spreadsheet import"],
    visibility: "owner",
    priority: 464,
  },
  {
    id: "settings-data-delete",
    title: "Delete all studio data",
    category: "Settings",
    href: "/settings/data#delete-data",
    description: "Permanently remove every client, session, and entry",
    keywords: ["delete all studio data", "delete everything", "delete my data", "wipe", "erase", "start over", "remove all data", "close my account"],
    visibility: "owner",
    priority: 466,
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
// Deliberate exclusions: the other half of the coverage decision
// ---------------------------------------------------------------------------
//
// Every authenticated destination is either IN NAV_ENTRIES or listed here with
// a reason. tests/lib/search/navigation-registry.test.ts walks the app router
// and fails when a route appears in neither, so a newly-added Settings page
// cannot silently become undiscoverable: nor silently discoverable.

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
    route: "/settings/waitlist",
    reason:
      "WAIT-02 operator queue for the new-client waitlist. Its Settings tab appears only for a studio whose durable waitlist is switched on, so advertising it in search would resolve to an empty surface for every studio that has not been enabled. Revisit when the capability is generally available rather than pilot-gated.",
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
    reason: "Platform audit surface: raw change payloads, cross-studio.",
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
 * (/records) IS searchable. It is this section of it that is withheld.
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
