import { redirect } from "next/navigation";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { resolveTimeFormat } from "@/lib/booking/tz";
import {
  SettingsViewHeading,
  STUDIO_WIDE_SCOPE,
} from "@/components/settings/view-heading";
import { StudioDisplayPreferencesForm } from "../StudioDisplayPreferencesForm";

// Calendar > Display preferences: studio-wide and OWNER-ONLY (the whole studio
// sees these times and birthday colours). The rail hides it from a
// practitioner; this is the access gate.
export default async function CalendarDisplayPage() {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") redirect("/settings/profile");

  return (
    <section className="flex flex-col gap-8">
      <SettingsViewHeading
        title="Display preferences"
        scope={STUDIO_WIDE_SCOPE}
      >
        How your team sees times and birthday reminders. Only a studio owner can
        change these.
      </SettingsViewHeading>
      <StudioDisplayPreferencesForm
        initialBirthdayColor={studio.birthday_reminder_color}
        initialTimeFormat={resolveTimeFormat(studio)}
      />
    </section>
  );
}
