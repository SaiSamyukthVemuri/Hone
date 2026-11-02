import type { ReactNode } from "react";
import type { Practitioner, Studio } from "@/lib/types/database";

// THE ONE SLOT for per-practitioner Calendar views (Calendar colour, Calendar
// feed). Each view is its OWN route, /settings/calendar/<slug>, shown by itself
// (R2). The shell (General) owns the routing and the rail; Willow (WS-C) owns
// THIS file and everything it imports. See general/SETTINGS-CALENDAR-SLOT.md.
//
// `null` means "no per-practitioner views yet": the Calendar group then holds
// only the owner-only Display preferences, and a practitioner has no Calendar
// entry. No placeholder views.

export type PersonalCalendarViewProps = {
  practitioner: Practitioner;
  studio: Studio;
};

export type PersonalCalendarView = {
  /** The route segment: /settings/calendar/<slug>. Lowercase letters and hyphens. */
  slug: string;
  /** The rail label and the view heading. */
  label: string;
  /** Server component rendered as the whole view body, below the heading. */
  Content: (props: PersonalCalendarViewProps) => Promise<ReactNode> | ReactNode;
};

export type PersonalCalendarSlot = {
  views: ReadonlyArray<PersonalCalendarView>;
};

export const personalCalendarSlot: PersonalCalendarSlot | null = null;
