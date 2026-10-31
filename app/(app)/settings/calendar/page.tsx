import { requirePractitionerWithStudio, getPractitionersForStudio } from "@/lib/supabase/queries";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import { colourOptions, shouldSuggestColour, suggestDistinctColour } from "@/lib/calendar/colour-assignment";
import { resolvePractitionerColor } from "@/lib/practitioner-colors";
import { ColorPicker } from "./ColorPicker";
import { CalendarFeedCard } from "./CalendarFeedCard";

// Settings > Calendar (WS-C): the signed-in practitioner's own calendar colour and calendar feed, the
// same for every role. Display preferences (studio-wide, owner-only) are a separate page owned by the
// shell workstream; nothing studio-wide is written from here.
export default async function CalendarSettingsPage() {
  // Identity first, like every authenticated page (SENTRY-IDENTITY-01).
  const { practitioner, studio } = await requirePractitionerWithStudio();

  // The same active-practitioner read the calendar sidebar uses: colours are information for the
  // picker, never a gate on saving anything.
  const holders = await getPractitionersForStudio(studio.id);
  const others = holders.filter((h) => h.id !== practitioner.id && h.display_name);
  const options = colourOptions(holders, practitioner.id);
  const suggestion = shouldSuggestColour(practitioner.color) ? suggestDistinctColour(holders, practitioner.id) : null;

  return (
    <section className="flex flex-col gap-8">
      <div>
        <h2 className="text-xl font-medium">Calendar</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Your calendar colour and your calendar feed.
        </p>
      </div>
      <p data-testid="scope-tag" className="-mt-4 text-xs font-medium text-neutral-500">
        Shared calendar identity: your colour is how your team sees your appointments.
      </p>
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
      <CalendarFeedCard appOrigin={getRequiredAppOrigin()} initialActive={!!practitioner.calendar_feed_token_hash} />
    </section>
  );
}
