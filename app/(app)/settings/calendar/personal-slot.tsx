import type { ReactNode } from "react";
import type { Practitioner, Studio } from "@/lib/types/database";
import type { SettingsNavSection } from "@/lib/settings/nav";
import { getPractitionersForStudio } from "@/lib/supabase/queries";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import { colourOptions, shouldSuggestColour, suggestDistinctColour } from "@/lib/calendar/colour-assignment";
import { resolvePractitionerColor } from "@/lib/practitioner-colors";
import { ColorPicker } from "./color/ColorPicker";
import { CalendarFeedCard } from "./feed/CalendarFeedCard";

// THE ONE SLOT on the Calendar page for per-practitioner sections (Calendar
// colour, Calendar feed). The shell (General) owns calendar/page.tsx; Willow
// (WS-C) owns THIS file and everything it imports. See
// general/SETTINGS-CALENDAR-SLOT.md.
//
// With a slot set, the page also renders for a practitioner, showing ONLY the
// slot; Display preferences stay owner-only whatever the slot says.

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

export const personalCalendarSlot: PersonalCalendarSlot | null = {
  sections: [
    { id: "calendar-color", label: "Calendar colour" },
    { id: "calendar-feed", label: "Calendar feed" },
  ],
  Content: PersonalCalendarContent,
};


// The signed-in practitioner's own calendar colour and calendar feed, the same
// for every role. Server component rendered by the Calendar page's slot. Each
// section root carries its rail id and scroll-mt-24.
export async function PersonalCalendarContent({ practitioner, studio }: PersonalCalendarSlotProps) {
  // The same active-practitioner read the calendar sidebar uses: colours are information for the
  // picker, never a gate on saving anything.
  const holders = await getPractitionersForStudio(studio.id);
  const others = holders.filter((h) => h.id !== practitioner.id && h.display_name);
  const options = colourOptions(holders, practitioner.id);
  const suggestion = shouldSuggestColour(practitioner.color) ? suggestDistinctColour(holders, practitioner.id) : null;

  return (
    <>
      <div id="calendar-color" className="flex scroll-mt-24 flex-col gap-6">
        <div>
          <h2 className="text-xl font-medium">Calendar colour</h2>
          <p data-testid="scope-tag" className="mt-1 text-xs font-medium text-neutral-500">
            Shared calendar identity: your colour is how your team sees your appointments.
          </p>
        </div>
        <ColorPicker initialColor={practitioner.color} options={options} suggestion={suggestion} />
        {others.length > 0 && (
          <div data-testid="other-calendars" className="flex flex-col gap-2">
            <span className="text-sm font-medium">Other practitioner calendars</span>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {others.map((o) => (
                <li key={o.id} className="flex items-center gap-1.5">
                  <span aria-hidden className={`inline-block h-2.5 w-2.5 rounded-full ${resolvePractitionerColor(o.color).bg}`} />
                  {o.display_name}
                </li>
              ))}
            </ul>
            <p className="text-xs text-neutral-500">Their colours are never changed from here. A new practitioner is offered a colour nobody else uses.</p>
          </div>
        )}
      </div>
      <div id="calendar-feed" className="scroll-mt-24">
        <CalendarFeedCard appOrigin={getRequiredAppOrigin()} initialActive={!!practitioner.calendar_feed_token_hash} />
      </div>
    </>
  );
}
