import { redirect } from "next/navigation";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { GoogleCalendarCard } from "../profile/GoogleCalendarCard";
import { getOwnConnectionReadiness } from "@/lib/google-calendar/connection";

// Settings → Integrations. Owner-only surface for connecting the studio to outside
// services. Today: Google Calendar (connection + status only). This page REUSES
// the audited Google Calendar OAuth/connection engine (lib/google-calendar/*) and
// the existing GoogleCalendarCard — it adds no event sync and touches no worker,
// outbound flag, outbox, or calendar link. Synchronization stays OFF.
//
// Authorization is server-derived and defense-in-depth: this page redirects
// non-owners, the nav entry is owner-only, and every underlying server action
// re-authorizes (active practitioner + studio flag) and never trusts a browser id.

export default async function IntegrationsSettingsPage() {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();

  // Owner-only. Non-owners are sent to their profile (where the per-practitioner
  // connection card lives). Direct-URL access by a non-owner never renders here.
  if (practitioner.role !== "owner") redirect("/settings/profile");

  // The card renders ONLY when the studio connection flag is on; when it's off the
  // card is hidden and the server actions reject anyway.
  const googleEnabled = studio.google_calendar_connection_enabled === true;
  const google = googleEnabled
    ? await getOwnConnectionReadiness(studio.id, practitioner.id)
    : { metadata: null, readiness: "disconnected" as const };

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-medium">Integrations</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Connect {studio.name} to outside services. Only the studio owner can
          manage these connections.
        </p>
      </div>

      {/* Dormancy banner — synchronization is OFF. Do not imply appointments sync. */}
      <div
        role="note"
        data-testid="integrations-sync-off"
        className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
      >
        Calendar synchronization is currently off. Connecting does not create or
        change calendar events.
      </div>

      {googleEnabled ? (
        <GoogleCalendarCard
          connection={google.metadata}
          readiness={google.readiness}
          isOwner
          returnPath="/settings/integrations"
        />
      ) : (
        <div className="rounded-lg border border-neutral-300 p-5 dark:border-neutral-700">
          <h3 className="text-sm font-semibold">Google Calendar</h3>
          <p className="mt-1 text-sm text-neutral-500">
            The Google Calendar integration is not enabled for this studio yet.
          </p>
        </div>
      )}
    </section>
  );
}
