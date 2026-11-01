import type { ReactNode } from "react";
import type { Practitioner, Studio } from "@/lib/types/database";
import type { SettingsNavSection } from "@/lib/settings/nav";

// THE ONE SLOT on the Calendar page for per-practitioner sections (Calendar
// colour, Calendar feed). The shell (General) owns calendar/page.tsx; Willow
// (WS-C) owns THIS file and everything it imports. See
// general/SETTINGS-CALENDAR-SLOT.md.
//
// `null` means "no per-practitioner sections yet": the page is then owner-only
// (it holds the owner-only Display preferences) and a practitioner is sent to
// Profile. When Willow replaces `null` with a slot, the page also renders for a
// practitioner, showing ONLY the slot, and Display preferences stay owner-only.

export type PersonalCalendarSlotProps = {
  practitioner: Practitioner;
  studio: Studio;
};

export type PersonalCalendarSlot = {
  /** Rail subsections for these sections (each `id` is the element id on the page). */
  sections: ReadonlyArray<SettingsNavSection>;
  /** Server component rendered below Display preferences (or alone for a practitioner). */
  Content: (props: PersonalCalendarSlotProps) => Promise<ReactNode> | ReactNode;
};

export const personalCalendarSlot: PersonalCalendarSlot | null = null;
