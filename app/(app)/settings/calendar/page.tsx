import { redirect } from "next/navigation";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { resolveTimeFormat } from "@/lib/booking/tz";
import { StudioDisplayPreferencesForm } from "./StudioDisplayPreferencesForm";
import { personalCalendarSlot } from "./personal-slot";

// Calendar settings. First release: the studio-wide Display preferences only,
// OWNER-ONLY. They moved here from Studio (a save of studio details no longer
// touches them). Calendar colour and the calendar feed join this page in WS-C.
//
// This route used to redirect to /settings/availability (breaks and blocks were
// consolidated there). It is now a page; Availability keeps its own route and
// every internal link that meant Availability points at it directly.
export default async function CalendarSettingsPage() {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  const isOwner = practitioner.role === "owner";
  // Navigation hides this page from a practitioner; this is the access gate. A
  // practitioner may open it only when per-practitioner sections exist (the slot).
  if (!isOwner && !personalCalendarSlot) redirect("/settings/profile");

  return (
    <section className="flex flex-col gap-10">
      {isOwner && (
        <>
          <div id="display-preferences" className="scroll-mt-24">
            <h2 className="text-xl font-medium">Display preferences</h2>
            <p className="mt-1 text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Applies to the whole studio.
            </p>
            <p className="mt-1 text-sm text-neutral-500">
              How your team sees times and birthday reminders. Only a studio
              owner can change these.
            </p>
          </div>
          <StudioDisplayPreferencesForm
            initialBirthdayColor={studio.birthday_reminder_color}
            initialTimeFormat={resolveTimeFormat(studio)}
          />
        </>
      )}
      {personalCalendarSlot && (
        <personalCalendarSlot.Content
          practitioner={practitioner}
          studio={studio}
        />
      )}
    </section>
  );
}
