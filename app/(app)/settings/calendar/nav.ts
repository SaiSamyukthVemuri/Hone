import type { SettingsNavEntry } from "@/lib/settings/nav";

// Calendar rail entry. Every practitioner sees Calendar colour and Calendar feed;
// Display preferences are studio-wide and OWNER-ONLY, kept so through `sectionRoles`.
export const calendarNav: ReadonlyArray<SettingsNavEntry> = [
  {
    id: "calendar",
    group: "personal",
    label: "Calendar",
    href: "/settings/calendar",
    roles: ["owner", "practitioner"],
    sections: [
      { id: "display-preferences", label: "Display preferences" },
      { id: "calendar-color", label: "Calendar colour" },
      { id: "calendar-feed", label: "Calendar feed" },
    ],
    sectionRoles: { "display-preferences": ["owner"] },
    order: 20,
  },
];
