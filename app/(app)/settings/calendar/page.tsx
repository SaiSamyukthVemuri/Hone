import { redirect } from "next/navigation";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";

// Breaks & blocks were consolidated into the Availability settings page
// (recurring breaks + one-off timed blocks now live alongside weekly hours and
// whole-day blockouts). This route is kept only so existing bookmarks / deep
// links to /settings/calendar resolve safely: it redirects to the new home.
export default async function CalendarSettingsRedirect() {
  // Identity first, like every authenticated page (SENTRY-IDENTITY-01): the
  // settings layout's guard does not run on a soft navigation, so a removed
  // practitioner lands on /no-access rather than being forwarded onward.
  await requirePractitionerWithStudio();
  redirect("/settings/availability");
}
