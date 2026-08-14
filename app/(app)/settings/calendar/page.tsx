import { redirect } from "next/navigation";

// Breaks & blocks were consolidated into the Availability settings page
// (recurring breaks + one-off timed blocks now live alongside weekly hours and
// whole-day blockouts). This route is kept only so existing bookmarks / deep
// links to /settings/calendar resolve safely: it redirects to the new home.
export default function CalendarSettingsRedirect() {
  redirect("/settings/availability");
}
