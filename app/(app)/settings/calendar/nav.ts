import type { SettingsNavEntry } from "@/lib/settings/nav";
import { personalCalendarSlot } from "./personal-slot";

// Calendar rail group. Display preferences are studio-wide and OWNER-ONLY, so
// they are an owner-only child; every per-practitioner view Willow adds through
// personal-slot.tsx is a child for every role. With no slot the group has no
// visible child for a practitioner and is hidden for them.
export const calendarNav: ReadonlyArray<SettingsNavEntry> = [
  {
    id: "calendar",
    group: "personal",
    label: "Calendar",
    href: "/settings/calendar",
    roles: ["owner", "practitioner"],
    children: [
      {
        id: "calendar-display",
        label: "Display preferences",
        href: "/settings/calendar/display",
        roles: ["owner"],
      },
      ...(personalCalendarSlot?.views ?? []).map((v) => ({
        id: `calendar-${v.slug}`,
        label: v.label,
        href: `/settings/calendar/${v.slug}`,
      })),
    ],
    order: 20,
  },
];
