import { redirect } from "next/navigation";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { personalCalendarSlot } from "./personal-slot";

// /settings/calendar is only a doorway: each Calendar view is its own route.
// Owners land on Display preferences; a practitioner on the first
// per-practitioner view, or Profile when there is none. The view routes keep
// their own gates (the rail hides entries; it never grants access).
export default async function CalendarSettingsIndex() {
  const { practitioner } = await requirePractitionerWithStudio();
  if (practitioner.role === "owner") redirect("/settings/calendar/display");
  const first = personalCalendarSlot?.views[0];
  redirect(first ? `/settings/calendar/${first.slug}` : "/settings/profile");
}
