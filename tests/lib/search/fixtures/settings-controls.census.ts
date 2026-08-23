// Settings CONTROL census — the audited list behind Global Search V2-A.1.
//
// WHY THIS FILE EXISTS
// V2-A shipped a route-level coverage tripwire: every authenticated page had to
// carry an explicit searchability decision. It passed, and search was still
// incomplete — Sam typed the literal visible label "Booking horizon" in
// production and got nothing, because the Booking PAGE was registered while six
// of its eight controls were not. Route coverage answers "can I find this
// page?". It cannot answer "can I find the exact setting I am looking at?".
//
// This census is the second contract. Every row is a control a practitioner can
// actually see and act on, transcribed from the rendered source, and carries an
// explicit decision: it is either searchable (and names the registry entry that
// makes it so) or excluded (and says why).
//
// tests/lib/search/settings-control-coverage.test.ts enforces three things
// against it:
//   1. every `searchable` row resolves — its exact visible label finds its
//      registry entry, and that entry points at the right page;
//   2. every row is still REAL — the visible label string still exists in the
//      page's source tree, so a renamed or deleted control fails here loudly
//      instead of silently becoming unfindable;
//   3. nothing new slipped in — a structural sweep of the label-bearing files
//      must not surface a control this census has never heard of.
//
// Adding a Settings control? Add a row here. That is the whole ceremony.

export type ControlDecision = "searchable" | "excluded";

export type SettingsControl = {
  /** Route the control lives on. */
  page: string;
  /** The EXACT visible label, transcribed from source. Not a paraphrase. */
  label: string;
  /** Short helper/description copy shown near it, where there is one. */
  helper?: string;
  /** Who can see it, matching the page's own gate. */
  role: "practitioner" | "owner";
  /** Studio feature flag the control depends on, if any. */
  flag?: "googleCalendar";
  decision: ControlDecision;
  /** For `searchable`: the NAV_ENTRIES id that must resolve this label. */
  entryId?: string;
  /** For `excluded`: why search deliberately does not advertise it. */
  reason?: string;
};

export const SETTINGS_CONTROLS: readonly SettingsControl[] = [
  // --------------------------------------------------------------- waitlist
  // WAIT-02's operator queue. It configures nothing: it lists people waiting
  // and offers one terminal action per row. There is no setting here to find,
  // and the route itself carries an explicit NON_SEARCHABLE_ROUTES decision
  // because the surface is pilot-gated per studio.
  {
    page: "/settings/waitlist",
    label: "Remove",
    role: "owner",
    decision: "excluded",
    reason:
      "Per-row operational action on the new-client waitlist queue, not a configurable setting. It appears once per waiting person, so it has no single destination to advertise, and the page it lives on is deliberately not advertised either while the capability is pilot-gated per studio (NON_SEARCHABLE_ROUTES).",
  },

  // ---------------------------------------------------------------- profile
  {
    page: "/settings/profile",
    label: "Your name",
    helper: "How you show up to your team and in session logs",
    role: "practitioner",
    decision: "searchable",
    entryId: "settings-your-name",
  },
  {
    page: "/settings/profile",
    label: "Email",
    role: "practitioner",
    decision: "excluded",
    reason:
      "Read-only display of the signed-in account address; there is nothing to configure, and the Profile page entry already covers reaching it.",
  },
  {
    page: "/settings/profile",
    label: "Calendar color",
    helper: "Your appointments will appear in this color on the calendar",
    role: "practitioner",
    decision: "searchable",
    entryId: "settings-calendar-color",
  },
  {
    page: "/settings/profile",
    label: "Calendar feed",
    helper: "Subscribe to this private calendar URL",
    role: "practitioner",
    decision: "searchable",
    entryId: "settings-calendar-feed",
  },
  {
    page: "/settings/profile",
    label: "Google Calendar",
    role: "practitioner",
    flag: "googleCalendar",
    decision: "searchable",
    entryId: "settings-google-calendar-own",
  },

  // ----------------------------------------------------------------- studio
  {
    page: "/settings/studio",
    label: "Studio name",
    role: "owner",
    decision: "searchable",
    entryId: "settings-studio-name",
  },
  {
    page: "/settings/studio",
    label: "Legal entity name",
    helper: "If different from studio name",
    role: "owner",
    decision: "searchable",
    entryId: "settings-legal-entity",
  },
  {
    page: "/settings/studio",
    label: "Owner email",
    role: "owner",
    decision: "excluded",
    reason:
      "Read-only display of the studio owner's address; not configurable here, and the Studio page entry already covers reaching it.",
  },
  {
    page: "/settings/studio",
    label: "Birthday reminder color",
    helper: "Choose the accent color used for birthday reminders",
    role: "owner",
    decision: "searchable",
    entryId: "settings-birthday-color",
  },
  {
    page: "/settings/studio",
    label: "Time format",
    helper: "How times are shown on your calendar, dashboard, and availability",
    role: "owner",
    decision: "searchable",
    entryId: "settings-time-format",
  },
  {
    page: "/settings/studio",
    label: "Email notifications",
    helper: "All emails are sent from hello@hone.care",
    role: "owner",
    decision: "searchable",
    entryId: "settings-reminders",
  },
  {
    page: "/settings/studio",
    label: "Send 24-hour reminders",
    role: "owner",
    decision: "searchable",
    entryId: "settings-reminders",
  },
  {
    page: "/settings/studio",
    label: "Send 2-hour reminders",
    role: "owner",
    decision: "searchable",
    entryId: "settings-reminders",
  },
  {
    page: "/settings/studio",
    label: "Send confirmation emails when appointments are booked",
    role: "owner",
    decision: "searchable",
    entryId: "settings-reminders",
  },
  {
    page: "/settings/studio",
    label: "Email me when a new booking is created",
    role: "owner",
    decision: "searchable",
    entryId: "settings-reminders",
  },
  {
    page: "/settings/studio",
    label: "Automatically mark no-shows",
    role: "owner",
    decision: "searchable",
    entryId: "settings-reminders",
  },
  {
    page: "/settings/studio",
    label: "Send follow-up email to no-shows",
    role: "owner",
    decision: "searchable",
    entryId: "settings-reminders",
  },
  {
    page: "/settings/studio",
    label: "Show treatment time to clients in emails",
    role: "owner",
    decision: "searchable",
    entryId: "settings-reminders",
  },

  // ---------------------------------------------------------------- booking
  // The page at the heart of the reported failure. All eight controls.
  {
    page: "/settings/booking",
    label: "Your booking link",
    role: "owner",
    decision: "searchable",
    entryId: "settings-booking-link",
  },
  {
    page: "/settings/booking",
    label: "Booking URL slug",
    helper: "Lowercase letters, numbers, and dashes",
    role: "owner",
    decision: "searchable",
    entryId: "settings-booking-slug",
  },
  {
    page: "/settings/booking",
    label: "Timezone",
    role: "owner",
    decision: "searchable",
    entryId: "settings-timezone",
  },
  {
    page: "/settings/booking",
    label: "Default duration (min)",
    role: "owner",
    decision: "searchable",
    entryId: "settings-default-duration",
  },
  {
    page: "/settings/booking",
    label: "Time between appointments",
    helper: "Automatically blocks time after each appointment",
    role: "owner",
    decision: "searchable",
    entryId: "settings-buffer",
  },
  {
    page: "/settings/booking",
    label: "Booking horizon",
    helper: "Choose how far ahead clients can book online",
    role: "owner",
    decision: "searchable",
    entryId: "settings-booking-horizon",
  },
  {
    page: "/settings/booking",
    label: "Public address (shown on your booking page)",
    helper: "For home-based studios, leave this blank",
    role: "owner",
    decision: "searchable",
    entryId: "settings-public-address",
  },
  {
    page: "/settings/booking",
    label: "Booking page intro",
    role: "owner",
    decision: "searchable",
    entryId: "settings-booking-intro",
  },

  // ----------------------------------------------------------- availability
  {
    page: "/settings/availability",
    label: "Weekly hours",
    role: "owner",
    decision: "searchable",
    entryId: "settings-weekly-hours",
  },
  {
    page: "/settings/availability",
    label: "Special hours",
    role: "owner",
    decision: "searchable",
    entryId: "settings-special-hours",
  },
  {
    page: "/settings/availability",
    label: "Blocked time",
    role: "owner",
    decision: "searchable",
    entryId: "settings-blocked-time",
  },
  {
    page: "/settings/availability",
    label: "Repeating breaks",
    role: "owner",
    decision: "searchable",
    entryId: "settings-repeating-breaks",
  },
  {
    page: "/settings/availability",
    label: "Block time",
    role: "owner",
    decision: "searchable",
    entryId: "settings-block-time",
  },

  // --------------------------------------------------------------- services
  {
    page: "/settings/services",
    label: "Service menu order",
    helper: "The order visible services appear in",
    role: "owner",
    decision: "searchable",
    entryId: "settings-service-order",
  },
  // The per-service editor fields live inside a repeated, collapsed accordion
  // row — one instance per service — so they have no stable anchor to land on
  // and a row per field would collapse under href dedupe anyway. Their
  // vocabulary is carried by the Services entry instead, which is the correct
  // destination for all of them.
  {
    page: "/settings/services",
    label: "Service name",
    role: "owner",
    decision: "excluded",
    reason:
      "Per-service editor field inside a repeated accordion row; no stable anchor exists. Reached via the Services entry, whose keywords carry this vocabulary.",
  },
  {
    page: "/settings/services",
    label: "Modality",
    role: "owner",
    decision: "excluded",
    reason:
      "Per-service editor field inside a repeated accordion row; no stable anchor exists. Reached via the Services entry, whose keywords carry this vocabulary.",
  },
  {
    page: "/settings/services",
    label: "Duration",
    role: "owner",
    decision: "excluded",
    reason:
      "Per-service editor field inside a repeated accordion row; no stable anchor exists. Reached via the Services entry, whose keywords carry this vocabulary.",
  },
  {
    page: "/settings/services",
    label: "Price",
    helper: "Shown to clients when booking",
    role: "owner",
    decision: "excluded",
    reason:
      "Per-service editor field inside a repeated accordion row; no stable anchor exists. Reached via the Services entry, whose keywords carry this vocabulary.",
  },
  {
    page: "/settings/services",
    label: "Description",
    role: "owner",
    decision: "excluded",
    reason:
      "Per-service editor field inside a repeated accordion row; no stable anchor exists. Reached via the Services entry, whose keywords carry this vocabulary.",
  },
  {
    page: "/settings/services",
    label: "Pre-appointment instructions",
    helper: "Shown in client confirmation and reminder emails",
    role: "owner",
    decision: "excluded",
    reason:
      "Per-service editor field inside a repeated accordion row; no stable anchor exists. Reached via the Services entry, whose keywords carry this vocabulary.",
  },

  // ------------------------------------------------------------------- team
  {
    page: "/settings/team",
    label: "Invite a practitioner",
    role: "owner",
    decision: "searchable",
    entryId: "settings-invite-practitioner",
  },
  {
    page: "/settings/team",
    label: "Practitioners",
    role: "owner",
    decision: "searchable",
    entryId: "settings-practitioners-list",
  },
  {
    page: "/settings/team",
    label: "Pending invitations",
    role: "owner",
    decision: "searchable",
    entryId: "settings-pending-invitations",
  },

  // ---------------------------------------------------------------- consent
  {
    page: "/settings/consent",
    label: "Consent forms",
    role: "owner",
    decision: "searchable",
    entryId: "settings-consent",
  },

  // -------------------------------------------------------- forms & postcare
  {
    page: "/settings/intake",
    label: "Intake form preview",
    helper: "This is the current health intake form",
    role: "practitioner",
    decision: "searchable",
    entryId: "settings-intake-preview",
  },
  {
    page: "/settings/intake",
    label: "Postcare",
    role: "owner",
    decision: "searchable",
    entryId: "settings-postcare",
  },
  {
    page: "/settings/intake",
    label: "Aftercare instructions",
    role: "owner",
    decision: "searchable",
    entryId: "settings-aftercare",
  },
  {
    page: "/settings/intake",
    label: "Postcare contact email",
    role: "owner",
    decision: "searchable",
    entryId: "settings-postcare-contact",
  },
  {
    page: "/settings/intake",
    label: "Cancellation and no-show policy",
    role: "owner",
    decision: "searchable",
    entryId: "settings-policies",
  },
  {
    page: "/settings/intake",
    label: "Warning signs / when to contact you",
    role: "owner",
    decision: "excluded",
    reason:
      "A field within the Postcare email editor; the Postcare and Aftercare instructions entries both land on that editor, so a third row would duplicate the same destination.",
  },
  {
    page: "/settings/intake",
    label: "Product recommendations",
    role: "owner",
    decision: "excluded",
    reason:
      "A field within the Postcare email editor; reached by the Postcare entry, which anchors at that editor.",
  },
  {
    page: "/settings/intake",
    label: "Review link (optional)",
    role: "owner",
    decision: "excluded",
    reason:
      "An optional field within the Postcare email editor; reached by the Postcare entry, which anchors at that editor.",
  },
  {
    page: "/settings/intake",
    label: "Review prompt wording (optional)",
    role: "owner",
    decision: "excluded",
    reason:
      "An optional field within the Postcare email editor; reached by the Postcare entry, which anchors at that editor.",
  },

  // --------------------------------------------------------------- payments
  // No anchors are added on this page: its files are payment runtime, owned by
  // a parallel track, and this change must not touch them. Every payment
  // control therefore resolves to the page-level Payments entry.
  {
    page: "/settings/payments",
    label: "Stripe connection",
    role: "owner",
    decision: "searchable",
    entryId: "settings-payments",
  },
  {
    page: "/settings/payments",
    label: "Card-on-file readiness",
    role: "owner",
    decision: "searchable",
    entryId: "settings-payments",
  },
  {
    page: "/settings/payments",
    label: "Cancellation and no-show fee amounts",
    role: "owner",
    decision: "searchable",
    entryId: "settings-payments",
  },
  {
    page: "/settings/payments",
    label: "Late cancellation fee",
    role: "owner",
    decision: "searchable",
    entryId: "settings-payments",
  },
  {
    page: "/settings/payments",
    label: "No-show fee",
    role: "owner",
    decision: "searchable",
    entryId: "settings-payments",
  },

  // ----------------------------------------------------------- integrations
  {
    page: "/settings/integrations",
    label: "Google Calendar",
    role: "owner",
    decision: "searchable",
    entryId: "settings-google-calendar",
  },

  // --------------------------------------------------------------- tracking
  {
    page: "/settings/tracking",
    label: "Provider",
    role: "owner",
    decision: "searchable",
    entryId: "settings-tracking",
  },
  {
    page: "/settings/tracking",
    label: "Pixel / Dataset ID",
    role: "owner",
    decision: "excluded",
    reason:
      "Credential entry field. Search must not advertise credential inputs, and the registry payload is guarded against credential vocabulary. Reached via Marketing & analytics.",
  },
  {
    page: "/settings/tracking",
    label: "Test event code (optional)",
    role: "owner",
    decision: "excluded",
    reason:
      "Credential-adjacent provider debugging field. Reached via Marketing & analytics; not worth its own advertised row.",
  },

  // ----------------------------------------------------------------- import
  // IMPORT-01 retitled the page (and its registry entry) from "Quick import":
  // execution is operator-assisted, so the destination must not be named after
  // a self-service run the server refuses.
  {
    page: "/settings/import",
    label: "Import clients and history",
    role: "owner",
    decision: "searchable",
    entryId: "settings-import",
  },
  {
    page: "/settings/import",
    label: "Contact support",
    role: "owner",
    decision: "excluded",
    reason:
      "A mailto: link to Hone, not a studio setting, and it shares the page's href — a second searchable row would collapse into the page entry under dedupe and hide one of the two. The page entry's own description already says the model is operator-assisted.",
  },

  // ------------------------------------------------------------------- data
  {
    page: "/settings/data",
    label: "Export your data",
    role: "owner",
    decision: "searchable",
    entryId: "settings-data-export",
  },
  {
    page: "/settings/data",
    label: "Import clients from CSV",
    role: "owner",
    decision: "searchable",
    entryId: "settings-data-import-csv",
  },
  {
    page: "/settings/data",
    label: "How importing works",
    role: "owner",
    decision: "excluded",
    reason:
      "IMPORT-01. Cross-link from the Data page's import card to /settings/import, which search already resolves on its own entry. Advertising it separately would put two rows in front of one destination.",
  },
  {
    page: "/settings/data",
    label: "Delete all studio data",
    role: "owner",
    decision: "searchable",
    entryId: "settings-data-delete",
  },

  // ----------------------------------------------------------------- launch
  {
    page: "/settings/launch",
    label: "Ready for booking checklist",
    role: "practitioner",
    decision: "searchable",
    entryId: "settings-launch",
  },
];

/**
 * Files whose visible control labels are swept STRUCTURALLY, so a newly-added
 * control cannot slip past the census unnoticed.
 *
 * Deliberately NOT "parse every <label> in the React tree" — that is brittle
 * and would rot. This is a declared list of files that use one of two verified
 * label idioms, each with the number of labels it must keep yielding. If a file
 * stops matching (idiom changed, file restructured), `minLabels` fails and the
 * sweep is fixed rather than silently returning nothing.
 */
export const STRUCTURAL_LABEL_SOURCES: ReadonlyArray<{
  file: string;
  page: string;
  minLabels: number;
}> = [
  {
    file: "app/(app)/settings/booking/page.tsx",
    page: "/settings/booking",
    minLabels: 7,
  },
  {
    file: "app/(app)/settings/studio/StudioSettingsForm.tsx",
    page: "/settings/studio",
    minLabels: 5,
  },
  {
    file: "app/(app)/settings/profile/ProfileForm.tsx",
    page: "/settings/profile",
    minLabels: 2,
  },
  {
    file: "app/(app)/settings/profile/ColorPicker.tsx",
    page: "/settings/profile",
    minLabels: 1,
  },
];
