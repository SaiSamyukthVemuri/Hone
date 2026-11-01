import type { SettingsNavEntry } from "@/lib/settings/nav";

// Calendar rail entry. First release: only the studio-wide Display preferences
// exist here, and they are OWNER-ONLY, so the entry is owner-only too. Willow
// (WS-C) owns this file from here on: adding Calendar colour and Calendar feed
// for every practitioner is a `roles` change plus two `sections` entries, with
// `display-preferences` kept owner-only through `sectionRoles`.
export const calendarNav: ReadonlyArray<SettingsNavEntry> = [
  {
    id: "calendar",
    group: "personal",
    label: "Calendar",
    href: "/settings/calendar",
    roles: ["owner"],
    sections: [{ id: "display-preferences", label: "Display preferences" }],
    order: 20,
  },
];
